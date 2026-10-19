// AI helpers. Inside claude.ai the page asks Claude through the `sample` capability
// (the viewer's own Claude account). The installed app can plug in its own AI key later;
// until then, the assistant answers common questions from built-in reports.
let samplePromise = null;
export function getSample() {
  if (!samplePromise) samplePromise = window.claude?.use ? window.claude.use('sample').catch(() => null) : Promise.resolve(null);
  return samplePromise;
}

export async function canReadImages() {
  const s = await getSample();
  if (!s) return false;
  const caps = await s.limits().catch(() => null);
  return !!caps?.images;
}

// Reads a photo of a supplier bill into lines. The person always checks the result before saving.
export async function readBillPhoto(file, products) {
  const s = await getSample();
  if (!s) throw new Error('Photo reading is not available here. Use “Import from file” or type the bill.');
  const catalog = products.slice(0, 400).map(p => `${p.id}|${p.name}|${p.barcode || ''}`).join('\n');
  const prompt = `This image is a supplier's GST purchase invoice for an Indian supermarket. Read it and return JSON only:
{"supplierName": string, "supplierGstin": string|null, "billNo": string|null, "date": "YYYY-MM-DD"|null,
 "lines": [{"name": string, "qty": number, "rate": number (per unit, before GST), "gst": number (percent), "batchNo": string|null, "expiry": "YYYY-MM-DD"|null, "productId": string|null}]}
Match each line to the store's product list below when you are confident (use its id), else productId null.
Do not guess numbers you cannot read; use null.
Product list (id|name|barcode):
${catalog}`;
  return s.json(prompt, { images: file, modelTier: 'default' });
}

export async function askAssistant({ question, history, tools, onText, signal }) {
  const s = await getSample();
  if (!s) return null;
  const turns = [
    ...history.slice(-6),
    { role: 'user', content: `You are the assistant inside a supermarket's billing and inventory app in India. Answer the store owner's question using the tools, which read the store's own live data. Be short and practical; use ₹ and Indian number style; suggest one next action when useful. If the data cannot answer it, say so.\n\nQuestion: ${question}` },
  ];
  const r = await s(turns, { tools, onText, signal, cache: false, modelTier: 'default' });
  return r.text;
}
