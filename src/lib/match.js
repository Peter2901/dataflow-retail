// Matching what a supplier prints on a bill ("PARLE G 100GM*12") to the store's own products.
// Order: 1) supplier memory (learned from past corrections), 2) barcode in the text, 3) fuzzy name match.

const UNIT = [
  [/(\d)\s*(?:grams?|grms?|gms?|gm|grm|g)\b/g, '$1g'],
  [/(\d)\s*(?:kgs?|kilos?|kilograms?)\b/g, '$1kg'],
  [/(\d)\s*(?:litres?|liters?|ltrs?|ltr|lt|l)\b/g, '$1l'],
  [/(\d)\s*(?:mls?|millilitres?)\b/g, '$1ml'],
  [/(\d)\s*(?:pcs?|nos?|pieces?)\b/g, '$1pc'],
];
const STOP = new Set(['new', 'pkt', 'pack', 'pouch', 'the', 'and', 'of', 'with', 'free', 'mrp', 'rs', 'offer', 'jar', 'bottle', 'btl', 'box', 'cs', 'case', 'ctn']);

export function norm(s) {
  let x = String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[–—_]/g, ' ');
  x = x.replace(/(\d),(\d)/g, '$1$2');
  for (const [re, to] of UNIT) x = x.replace(re, to);
  x = x.replace(/1000g\b/g, '1kg').replace(/1000ml\b/g, '1l');
  return x.replace(/[^a-z0-9.\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

const tokens = s => norm(s).split(' ').filter(t => t && !STOP.has(t) && !/^[x*]\d+$/.test(t));
const sizeOf = s => (norm(s).match(/\b\d+(?:\.\d+)?(?:g|kg|l|ml|pc)\b/) || [])[0] || null;

// "PARLE G 100G*12" / "x 24" / "24X1" → pieces in the supplier's unit (a hint only).
export function packHint(text) {
  const m = String(text || '').match(/[x*]\s*(\d{1,3})\b(?!\s*(?:g|gm|ml|kg|l)\b)/i);
  const n = m ? Number(m[1]) : 0;
  return n >= 2 && n <= 500 ? n : 0;
}

const CASE_UNITS = /^(cs|case|cases|ctn|carton|box|bx|bdl|bundle|dz|dozen|outer|jar|tray|strip)$/i;
export const isCaseUnit = u => CASE_UNITS.test(String(u || '').trim());

function trigrams(s) {
  const x = ' ' + s.replace(/\s/g, ' ') + ' ';
  const out = new Set();
  for (let i = 0; i < x.length - 2; i++) out.add(x.slice(i, i + 3));
  return out;
}
const dice = (a, b) => { if (!a.size || !b.size) return 0; let n = 0; a.forEach(x => b.has(x) && n++); return (2 * n) / (a.size + b.size); };

export function similarity(a, b) {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  const tok = dice(ta, tb);
  const tri = dice(trigrams(norm(a)), trigrams(norm(b)));
  let s = 0.45 * tok + 0.55 * tri;
  const sa = sizeOf(a), sb = sizeOf(b);
  if (sa && sb) s = sa === sb ? Math.min(1, s + 0.12) : s * 0.55;   // 100 g vs 200 g are different items
  return s;
}

export const aliasId = (supplierId, text) => `${supplierId || 'any'}|${norm(text)}`;

/**
 * Returns { productId, pack, match: 'ok'|'check'|'none', score, suggestion }.
 * 'ok' = sure (learned before or near-exact), 'check' = probably right, 'none' = pick by hand.
 */
export function matchLine(text, { supplierId, products, aliases }) {
  if (!text) return { productId: '', match: 'none', score: 0 };
  const a = aliases[aliasId(supplierId, text)] || aliases[aliasId('any', text)];
  if (a && products.some(p => p.id === a.productId)) return { productId: a.productId, pack: a.pack || 1, match: 'ok', score: 1, learned: true };
  const code = String(text).match(/\b\d{8}\b|\b\d{12,14}\b/);
  if (code) { const p = products.find(x => x.barcode === code[0]); if (p) return { productId: p.id, match: 'ok', score: 1 }; }
  let best = null, second = 0;
  for (const p of products) {
    if (p.active === false) continue;
    const s = similarity(text, p.name + (p.brand && !norm(p.name).includes(norm(p.brand)) ? ' ' + p.brand : ''));
    if (!best || s > best.score) { second = best?.score || 0; best = { p, score: s }; } else if (s > second) second = s;
  }
  if (!best || best.score < 0.42) return { productId: '', match: 'none', score: best?.score || 0, suggestion: best?.p.id };
  const sure = best.score >= 0.88 && best.score - second >= 0.08;
  return { productId: best.p.id, match: sure ? 'ok' : 'check', score: best.score };
}

export async function loadAliases(db) {
  return Object.fromEntries((await db.itemAliases.toArray()).map(a => [a.id, a]));
}
