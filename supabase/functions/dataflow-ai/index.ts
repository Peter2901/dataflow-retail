// Supabase Edge Function "dataflow-ai": the ONE place the store app talks to an AI model.
// The app always tries plain code first; it calls this only when code could not solve it.
// Tasks: bill (bill photos), pack (product pack photo), khata (credit-book photo),
//        voice (spoken purchase line), hsn (HSN/GST hint for new items), route (which report answers a question).
// The AI key stays here in Supabase secrets — never in the app, never on the counters.
//
// Secrets (Supabase › Edge Functions › Secrets):
//   AI_PROVIDER   xai | anthropic | gemini | openai        (default xai)
//   AI_MODEL      model name from that provider's console  (e.g. grok-4.3)
//   XAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY  (only the one you use)
//   SCAN_KEY      optional: the app must send this in "x-scan-key" (Settings › Smart Scan)
// Deploy with "Verify JWT" OFF (the counters use the publishable key).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-scan-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const DEFAULT_MODEL: Record<string, string> = { xai: 'grok-4.3', anthropic: 'claude-haiku-5-5', gemini: 'gemini-3.1-flash-lite', openai: 'gpt-5.6-luna' };

function billPrompt(storeGstin: string) {
  return `You read Indian GST purchase invoices (a distributor's bill to a supermarket). Return ONLY one JSON object, no other text:
{"supplierName": string|null, "supplierGstin": string|null, "billNo": string|null, "date": "YYYY-MM-DD"|null,
 "taxType": "cgst_sgst"|"igst"|null, "total": number|null,
 "lines": [{"text": string, "hsn": string|null, "batchNo": string|null, "expiry": "YYYY-MM-DD"|null, "mfg": "YYYY-MM-DD"|null,
            "mrp": number|null, "unit": string|null, "pack": number|null, "qty": number|null, "free": number|null,
            "rate": number|null, "disc": number|null, "gst": number|null, "amount": number|null}]}
Rules:
- One entry in "lines" for every item row, on every page, in printed order. Skip totals, tax summary and HSN summary rows.
- "text": the item name exactly as printed (with size/pack text). "unit": the billing unit as printed (PCS, CS, BOX, KG…). "pack": pieces in one unit only if printed.
- "qty": billed quantity in that unit, WITHOUT free goods. "free": free/scheme quantity (0 if none).
- "rate": price per unit BEFORE GST and BEFORE discount. "disc": trade/scheme discount as a percent of qty × rate (convert an amount to %; 0 if none).
- "gst": the total GST percent for the line (CGST% + SGST%, or IGST%). "amount": the line amount exactly as printed.
- "mrp": MRP per piece. "expiry"/"mfg": if only month/year is printed, use the last/first day of that month.
- "total": the final amount payable on the bill (after round-off).
- The buyer is the store${storeGstin ? ` (GSTIN ${storeGstin})` : ''}; "supplierGstin" is the seller's GSTIN, not the buyer's.
- Never guess: use null for anything you cannot read clearly. Numbers as plain numbers (no commas, no ₹).`;
}

const PROMPTS: Record<string, (b: Record<string, unknown>) => string> = {
  bill: b => billPrompt(String(b.storeGstin || '').slice(0, 15)),
  pack: () => `This is a photo of a retail product pack sold in India. Return ONLY JSON:
{"name": string|null (brand + product + variant + size, as a shopper would say it, e.g. "Parle-G Biscuits 100 g"), "brand": string|null,
 "netQty": number|null, "unit": "g"|"kg"|"ml"|"l"|"pc"|null, "mrp": number|null (MRP incl. all taxes, per pack),
 "barcode": string|null (digits under the barcode), "fssai": string|null, "category": string|null (e.g. Biscuits, Dairy, Home Care)}
Use null for anything not printed clearly. Never guess the MRP.`,
  khata: () => `This is a photo of a shop's handwritten credit book (khata / udhaar register) in India, possibly in Hindi, Odia or English.
Return ONLY JSON: {"rows": [{"name": string, "phone": string|null, "amount": number, "date": "YYYY-MM-DD"|null}]}
One row per customer balance that is written. "amount" = the money the customer owes (positive). Skip crossed-out rows. Use null if unsure; never invent names or amounts.`,
  voice: b => `A supermarket owner in India spoke this purchase line (Hindi, Odia, English or mixed): "${String(b.text || '').slice(0, 300)}".
Return ONLY JSON: {"items": [{"text": string (product words only), "qty": number|null, "unit": string|null, "rate": number|null, "free": number|null}]}
"rate" is the price per unit if spoken ("52 rupaye" = 52). Convert number words (बीस=20, kodie=20, ek=1) to digits.`,
  hsn: b => `For these products sold in an Indian supermarket, suggest the HSN code (4 or 6 digits) and the GST rate under the current GST slabs (0, 5, 18 or 40).
Products: ${JSON.stringify((b.names as string[] || []).slice(0, 30))}
Return ONLY JSON: {"items": [{"name": string, "hsn": string|null, "gst": number|null, "sure": boolean}]}. Set "sure": false when it depends on packing or brand. These are hints that a person will confirm.`,
  route: b => `You route a shop owner's question to ONE report of their store app. Question: "${String(b.question || '').slice(0, 300)}"
Reports (id: what it answers): ${JSON.stringify(b.reports || [])}
Return ONLY JSON: {"report": string (one id from the list, or "none"), "params": {"days": number|null, "query": string|null, "limit": number|null}}`,
};

function parseJSON(text: string) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('The AI did not return a bill.');
  return JSON.parse(text.slice(a, b + 1));
}

const b64 = (dataUrl: string) => dataUrl.replace(/^data:[^;]+;base64,/, '');

async function callAI(provider: string, model: string, images: string[], p: string) {
  if (provider === 'xai' || provider === 'openai') {
    const key = Deno.env.get(provider === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY');
    if (!key) throw new Error(`Secret ${provider === 'xai' ? 'XAI_API_KEY' : 'OPENAI_API_KEY'} is not set in Supabase.`);
    const url = provider === 'xai' ? 'https://api.x.ai/v1/chat/completions' : 'https://api.openai.com/v1/chat/completions';
    const res = await fetch(url, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text', text: p }, ...images.map(u => ({ type: 'image_url', image_url: { url: u, detail: 'high' } }))] }] }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || j?.error || `${provider} error ${res.status}`);
    return { text: j.choices?.[0]?.message?.content || '', input: j.usage?.prompt_tokens || 0, output: j.usage?.completion_tokens || 0 };
  }
  if (provider === 'anthropic') {
    const key = Deno.env.get('ANTHROPIC_API_KEY');
    if (!key) throw new Error('Secret ANTHROPIC_API_KEY is not set in Supabase.');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 8000, temperature: 0, messages: [{ role: 'user', content: [...images.map(u => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64(u) } })), { type: 'text', text: p }] }] }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `anthropic error ${res.status}`);
    return { text: (j.content || []).map((c: { text?: string }) => c.text || '').join(''), input: j.usage?.input_tokens || 0, output: j.usage?.output_tokens || 0 };
  }
  if (provider === 'gemini') {
    const key = Deno.env.get('GEMINI_API_KEY');
    if (!key) throw new Error('Secret GEMINI_API_KEY is not set in Supabase.');
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST', headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: p }, ...images.map(u => ({ inline_data: { mime_type: 'image/jpeg', data: b64(u) } }))] }], generationConfig: { temperature: 0, responseMimeType: 'application/json' } }),
    });
    const j = await res.json();
    if (!res.ok) throw new Error(j?.error?.message || `gemini error ${res.status}`);
    return { text: (j.candidates?.[0]?.content?.parts || []).map((x: { text?: string }) => x.text || '').join(''), input: j.usageMetadata?.promptTokenCount || 0, output: j.usageMetadata?.candidatesTokenCount || 0 };
  }
  throw new Error(`Unknown AI_PROVIDER "${provider}". Use xai, anthropic, gemini or openai.`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return reply(405, { ok: false, error: 'POST only' });
  const need = Deno.env.get('SCAN_KEY');
  if (need && req.headers.get('x-scan-key') !== need) return reply(401, { ok: false, error: 'Smart Scan key is wrong. Check Settings › Smart Scan.' });
  let body: { task?: string; images?: string[]; [k: string]: unknown };
  try { body = await req.json(); } catch { return reply(400, { ok: false, error: 'Bad request' }); }
  const task = String(body.task || 'bill');
  if (!PROMPTS[task]) return reply(400, { ok: false, error: `Unknown task ${task}` });
  const images = (body.images || []).filter(x => typeof x === 'string' && x.startsWith('data:image/')).slice(0, 4);
  if (['bill', 'pack', 'khata'].includes(task) && !images.length) return reply(400, { ok: false, error: 'No photo received.' });
  if (images.some(x => x.length > 6_000_000)) return reply(413, { ok: false, error: 'Photo is too large.' });
  const provider = (Deno.env.get('AI_PROVIDER') || 'xai').toLowerCase();
  const model = Deno.env.get('AI_MODEL') || DEFAULT_MODEL[provider];
  try {
    const r = await callAI(provider, model, images, PROMPTS[task](body));
    const data = parseJSON(r.text);
    if (task === 'bill' && !Array.isArray(data.lines)) data.lines = [];
    return reply(200, { ok: true, task, data, usage: { input: r.input, output: r.output }, provider, model });
  } catch (e) {
    return reply(502, { ok: false, error: (e as Error).message || 'AI reading failed.' });
  }
});
