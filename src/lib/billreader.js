// Smart Scan: reads supplier bill photos into purchase lines.
// Cheapest first: 1) e-invoice QR (header), 2) free offline reading (OCR) + checks,
// 3) only if that fails (and the store has AI on): AI through the store's own Supabase function.
// A person always checks the result before saving.
import jsQR from 'jsqr';
import { db, getSettings } from '../db.js';
import { validGSTIN } from './util.js';
import { GST_SLABS } from './billing.js';
import { matchLine, loadAliases, packHint, isCaseUnit } from './match.js';
import { checkBill } from './purchaseChecks.js';

// ---------- images
async function toCanvas(file, maxSide) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}
const canvasJpeg = (c, q = 0.82) => c.toDataURL('image/jpeg', q);

// ---------- 1) e-invoice QR: signed by the GST portal, so the header is exact.
export function readEinvoiceQR(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
  if (!qr?.data) return null;
  return parseEinvoicePayload(qr.data);
}

export function parseEinvoicePayload(text) {
  try {
    const parts = String(text).split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4)))));
    const d = typeof json.data === 'string' ? JSON.parse(json.data) : (json.data || json);
    if (!d.SellerGstin && !d.DocNo) return null;
    const [dd, mm, yy] = String(d.DocDt || '').split('/');
    return { supplierGstin: d.SellerGstin || null, buyerGstin: d.BuyerGstin || null, billNo: d.DocNo || null, date: yy ? `${yy}-${mm}-${dd}` : null, total: Number(d.TotInvVal) || null, itemCount: Number(d.ItemCnt) || null, irn: d.Irn || null, mainHsn: d.MainHsnCode || null, source: 'qr' };
  } catch { return null; }
}

// ---------- 2) free offline reading
let workerP = null;
async function ocrWorker() {
  if (!workerP) workerP = (async () => {
    const { createWorker } = await import('tesseract.js');
    const base = new URL('ocr/', document.baseURI).href;
    const w = await createWorker('eng', 1, { workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true, workerBlobURL: false });
    // Automatic page layout reads table rows (with small cells like "2" or "CS") far better than the default single block.
    await w.setParameters({ tessedit_pageseg_mode: '3', preserve_interword_spaces: '1' });
    return w;
  })();
  return workerP;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const pad = x => String(x).padStart(2, '0');
const endOfMonth = (y, m) => `${y}-${pad(m)}-${pad(new Date(y, m, 0).getDate())}`;
const fullYear = y => (String(y).length === 2 ? 2000 + Number(y) : Number(y));
const NUM = /^\(?-?₹?\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\)?$|^-?₹?\d+(?:\.\d+)?%?$/;
const toNum = t => Number(String(t).replace(/[₹,%()]/g, ''));

function findDate(s) {
  let m = s.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
  if (m && Number(m[2]) <= 12) return `${fullYear(m[3])}-${pad(m[2])}-${pad(m[1])}`;
  m = s.match(/\b(\d{1,2})[\s\-]?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-,']*(\d{2,4})\b/i);
  if (m) return `${fullYear(m[3])}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(m[1])}`;
  return null;
}
function findExpiry(s) {
  let m = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[\s\-\/']*(\d{2,4})\b/i);
  if (m) return endOfMonth(fullYear(m[2]), MONTHS[m[1].toLowerCase()]);
  m = s.match(/\b(0?[1-9]|1[0-2])[\/\-.](20\d{2}|\d{2})\b(?![\/\-.]\d)/);
  if (m) return endOfMonth(fullYear(m[2]), Number(m[1]));
  return null;
}

// OCR often confuses 0/O, 1/I, 5/S, 8/B, 2/Z in a GSTIN. Every position has a fixed type,
// so wrong-type characters can be put right; position 14 is always "Z".
const TO_DIGIT = { O: '0', D: '0', Q: '0', I: '1', L: '1', S: '5', B: '8', Z: '2', G: '6', T: '7' };
const TO_LETTER = { 0: 'O', 1: 'I', 5: 'S', 8: 'B', 2: 'Z', 6: 'G', 7: 'T', 4: 'A' };
export function fixGstin(c) {
  const a = String(c).toUpperCase().split('');
  if (a.length !== 15) return c;
  [0, 1, 7, 8, 9, 10].forEach(i => { if (TO_DIGIT[a[i]]) a[i] = TO_DIGIT[a[i]]; });
  [2, 3, 4, 5, 6, 11].forEach(i => { if (TO_LETTER[a[i]]) a[i] = TO_LETTER[a[i]]; });
  a[13] = 'Z';
  return a.join('');
}
const diff = (a, b) => { let d = 0; for (let i = 0; i < 15; i++) if (a[i] !== b[i]) d++; return d; };
/** The supplier whose GSTIN is on the bill — allowing up to 2 misread characters. */
export function supplierByGstin(gstin, suppliers) {
  if (!gstin) return null;
  const g = fixGstin(gstin);
  return suppliers.find(s => s.gstin === g) || suppliers.filter(s => s.gstin && s.gstin.length === 15).map(s => ({ s, d: diff(s.gstin, g) })).filter(x => x.d <= 2).sort((a, b) => a.d - b.d)[0]?.s || null;
}

/** Header fields from the whole text. */
export function parseHeader(text, storeGstin) {
  const up = text.toUpperCase().replace(/[|]/g, 'I');
  const all = [...up.matchAll(/\b[0-9OISZ]{2}[A-Z0-9]{13}\b/g)].map(m => fixGstin(m[0])).filter(g => /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g) && g !== storeGstin);
  const gstins = [...all.filter(validGSTIN), ...all.filter(g => !validGSTIN(g))];
  const no = text.match(/\b(?:invoice|inv|bill|tax\s*invoice)\s*(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\/\-]{1,20})/i);
  const dateLine = text.split('\n').find(l => /date/i.test(l) && findDate(l));
  let total = null;
  for (const l of text.split('\n')) {
    if (/(grand\s*total|net\s*(?:amount|amt|payable|value)|invoice\s*(?:total|value|amount)|total\s*amount|bill\s*amount|amount\s*payable)/i.test(l)) {
      const nums = l.split(/\s+/).filter(t => NUM.test(t)).map(toNum).filter(x => x > 0);
      if (nums.length) total = nums[nums.length - 1];
    }
  }
  const taxType = /\bIGST\b/.test(up) && !/\bCGST\b/.test(up) ? 'igst' : /\bCGST\b/.test(up) && /\b(SGST|UTGST)\b/.test(up) ? 'cgst_sgst' : null;
  return { supplierGstin: gstins[0] || null, billNo: no ? no[1] : null, date: dateLine ? findDate(dateLine) : findDate(text), total, taxType };
}

/**
 * Item lines from text. A line counts as an item when three of its numbers fit
 * qty × rate (− discount) = amount (amount with or without GST).
 */
export function parseItemLines(text) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (line.length < 6 || /(total|subtotal|round|cgst|sgst|igst|amount in words|taxable value|bank|ifsc|declaration)/i.test(line)) continue;
    const toks = line.split(' ');
    const numIdx = toks.map((t, i) => (NUM.test(t) ? i : -1)).filter(i => i >= 0);
    if (numIdx.length < 3) continue;
    const vals = numIdx.map(i => toNum(toks[i]));
    // Try every qty/rate/amount combination; keep the most believable one.
    let best = null;
    const SIZE = /^(g|gm|gms|grm|kg|kgs|ml|l|lt|ltr|ltrs)$/i;
    for (let k = vals.length - 1; k >= 2; k--) {
      const a = vals[k];
      if (!(a > 0)) continue;
      for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) {
        const q = vals[i], r = vals[j];
        if (!(q > 0 && q <= 100000 && Math.abs(q - Math.round(q)) < 0.001 && r > 0)) continue;
        const base = q * r;
        const tol = Math.max(0.6, a * 0.003);
        const tries = [{ disc: 0 }];
        vals.slice(j + 1, k).forEach(d => { if (d > 0 && d < 60) tries.push({ disc: d }); });
        for (const t of [...tries]) for (const g of GST_SLABS) if (g > 0) tries.push({ ...t, g });
        for (const t of tries) {
          const tx = base * (1 - t.disc / 100);
          const v = t.g ? tx * (1 + t.g / 100) : tx;
          if (Math.abs(v - a) > tol) continue;
          const qTok = toks[numIdx[i]], rTok = toks[numIdx[j]];
          let score = 0;
          if (!t.disc) score += 2;
          if (/\./.test(rTok)) score += 1;
          if (SIZE.test(toks[numIdx[i] + 1] || '')) score -= 5;      // "100 G" is a pack size, not a quantity
          if (/^0\d/.test(qTok) || /^\d{4,8}$/.test(qTok)) score -= 5;  // HSN code, not a quantity
          if (k === vals.length - 1) score += 1;                        // amount is usually the last number
          if (!best || score > best.score) best = { score, qi: i, ri: j, ai: k, qty: q, rate: r, amount: a, disc: t.disc, gstIn: t.g || null };
          break;
        }
      }
    }
    if (!best) continue;
    // Name: words before the first number, minus a leading serial number.
    let nameToks = toks.slice(0, numIdx[best.qi]);
    if (/^\d{1,3}\.?$/.test(nameToks[0] || '')) nameToks = nameToks.slice(1);
    const hsnTok = nameToks.slice().reverse().find(t => /^\d{4,8}$/.test(t));
    const name = nameToks.filter(t => t !== hsnTok).join(' ').replace(/[^\w\s.*\/\-&()]/g, '').trim();
    if (name.length < 3) continue;
    const rest = toks.slice(numIdx[best.qi] + 1).join(' ');
    const half = [2.5, 9, 20];
    const pcts = toks.filter(t => /%$/.test(t)).map(toNum);
    let gst = best.gstIn ?? (pcts.find(x => GST_SLABS.includes(x) && x > 0) ?? (pcts.find(x => half.includes(x)) ? pcts.find(x => half.includes(x)) * 2 : null));
    const unitTok = toks.slice(numIdx[best.qi] + 1, numIdx[best.ri]).find(t => /^[A-Za-z]{2,6}$/.test(t));
    out.push({ text: name, hsn: hsnTok || '', qty: best.qty, rate: best.rate, disc: best.disc, gst, amount: best.amount, unit: unitTok || '', expiry: findExpiry(rest) || '' });
  }
  return out;
}

// ---------- 3) AI fallback through the store's Supabase function
export async function smartScanConfig() {
  const s = await getSettings();
  const ss = s.smartScan || {};
  return { url: (s.syncUrl || '').replace(/\/+$/, ''), key: s.syncKey || '', ai: ss.ai || 'off', scanKey: ss.scanKey || '', storeGstin: s.gstin || '', storeName: s.storeName || '' };
}

export async function readWithAI(canvases, conf) {
  if (!conf.url || !conf.key) throw new Error('AI reading needs the cloud set up (Settings › Cloud sync).');
  const res = await fetch(`${conf.url}/functions/v1/read-bill`, {
    method: 'POST',
    headers: { apikey: conf.key, Authorization: 'Bearer ' + conf.key, 'Content-Type': 'application/json', ...(conf.scanKey ? { 'x-scan-key': conf.scanKey } : {}) },
    body: JSON.stringify({ images: canvases.map(c => canvasJpeg(c)), storeGstin: conf.storeGstin }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `AI reading failed (${res.status}).`);
  return body;   // { ok, data, usage: { input, output }, model, provider }
}

// ---------- the whole pipeline
const g5 = g => (GST_SLABS.includes(Number(g)) ? Number(g) : null);

/** Turns raw lines (from OCR or AI) into draft purchase lines matched to products. */
export function toDraftLines(raw, { supplierId, products, aliases, uid }) {
  const pm = Object.fromEntries(products.map(p => [p.id, p]));
  return raw.map(r => {
    const m = matchLine(r.text, { supplierId, products, aliases });
    const p = pm[m.productId];
    let pack = Number(r.pack) || m.pack || 1;
    if (!m.learned && pack === 1 && isCaseUnit(r.unit)) pack = packHint(r.text) || p?.casePack || 1;
    return {
      key: uid('pl'), productId: m.productId || '', name: p?.name || '', text: r.text, match: m.match, hsn: r.hsn || '', unit: r.unit || '',
      qty: Number(r.qty) || '', free: Number(r.free) || 0, pack, rate: Number(r.rate) || '', disc: Number(r.disc) || 0,
      gst: g5(r.gst) ?? p?.gst ?? 5, mrp: Number(r.mrp) || '', batchNo: r.batchNo || '', expiry: r.expiry || '', mfg: r.mfg || '', amount: Number(r.amount) || '',
    };
  });
}

/**
 * files: photos of one bill (1+ pages). onStep(text) reports progress.
 * Returns { header, lines, method: 'free'|'ai', checks, freeTried, aiError, usage, model }
 */
export async function scanBill(files, { products, suppliers, storeId, ctx, uid, onStep = () => {}, forceAI = false }) {
  const conf = await smartScanConfig();
  const aliases = await loadAliases(db);
  onStep('Preparing the photo…');
  const big = [], small = [];
  for (const f of files) { big.push(await toCanvas(f, 2400)); }
  for (const c of big) { small.push(await toCanvas(await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9)), 1600)); }

  onStep('Looking for the e-invoice QR code…');
  let qr = null;
  for (const c of big) { qr = readEinvoiceQR(c); if (qr) break; }

  const supplierOf = h => supplierByGstin(h.supplierGstin, suppliers);
  const evaluate = (header, lines) => {
    const sup = supplierOf(header);
    return checkBill(ctx, { supplier: sup, billNo: header.billNo, date: header.date, lines, printed: { total: header.total, taxType: header.taxType }, products, suppliers });
  };

  let free = null;
  const skipFree = (forceAI || conf.ai === 'always') && conf.ai !== 'off';
  if (!skipFree) {
    try {
      onStep('Reading the bill on this device (free)…');
      let text = '';
      if (window.dfrDesktop?.ocr) for (const c of big) text += (await window.dfrDesktop.ocr(canvasJpeg(c, 0.92))) + '\n';
      else { const w = await ocrWorker(); for (const c of big) text += (await w.recognize(c)).data.text + '\n'; }
      try { if (localStorage.getItem('dfr-debug')) console.log('[ocr]\n' + text); } catch { /* ignore */ }
      const header = { ...parseHeader(text, conf.storeGstin), ...Object.fromEntries(Object.entries(qr || {}).filter(([, v]) => v)) };
      const sup = supplierOf(header);
      const lines = toDraftLines(parseItemLines(text), { supplierId: sup?.id, products, aliases, uid });
      const checks = evaluate(header, lines);
      const matched = lines.filter(l => l.productId).length;
      const passed = lines.length > 0 && checks.totalsMatch === true && checks.linesOk && matched / lines.length >= 0.9 && (!qr?.itemCount || qr.itemCount === lines.length);
      free = { header, lines, checks, passed, text };
      if (passed) return { ...free, method: 'free', freeTried: true };
    } catch (e) { free = { error: e.message || String(e) }; }
  }

  if (conf.ai === 'off') {
    if (free?.lines) return { ...free, method: 'free', freeTried: true, aiOff: true };
    throw new Error('Could not read the bill on this device. ' + (free?.error || ''));
  }
  try {
    onStep(free ? 'Free reading was not sure — reading with AI…' : 'Reading with AI…');
    const ai = await readWithAI(small, conf);
    const d = ai.data || {};
    const header = { supplierGstin: d.supplierGstin || null, supplierName: d.supplierName || null, billNo: d.billNo || null, date: d.date || null, total: Number(d.total) || null, taxType: d.taxType || null };
    Object.entries(qr || {}).forEach(([k, v]) => { if (v && k in header) header[k] = v; });   // QR is exact: it wins
    const sup = supplierOf(header);
    const lines = toDraftLines(d.lines || [], { supplierId: sup?.id, products, aliases, uid });
    return { header, lines, checks: evaluate(header, lines), method: 'ai', freeTried: !!free, usage: ai.usage, model: ai.model, provider: ai.provider };
  } catch (e) {
    if (free?.lines?.length) return { ...free, method: 'free', freeTried: true, aiError: e.message };
    throw e;
  }
}

export async function scanUsageThisMonth() {
  const month = new Date().toISOString().slice(0, 7);
  const ps = (await db.purchases.toArray()).filter(p => p.scan && String(p.date || '').slice(0, 7) === month);
  return { bills: ps.length, free: ps.filter(p => p.scan.method === 'free').length, ai: ps.filter(p => p.scan.method === 'ai').length,
    tokens: ps.reduce((a, p) => a + (p.scan.usage?.input || 0) + (p.scan.usage?.output || 0), 0) };
}

