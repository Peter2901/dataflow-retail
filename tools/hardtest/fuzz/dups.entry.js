import fs from 'fs';
import { findDuplicates } from '/home/claude/dataflow-retail/src/lib/productTools.js';
import { norm, similarity } from '/home/claude/dataflow-retail/src/lib/match.js';
const size = s => (norm(s).match(/\b\d+(?:\.\d+)?(?:g|kg|l|ml|pc)\b/) || [])[0] || '';
function oldFind(products) {
  const act = products.filter(p => p.active !== false); const pairs = []; const seen = new Set();
  for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
    const a = act[i], b = act[j]; let why = '';
    if (a.barcode && a.barcode === b.barcode) why = 'Same barcode';
    else { if (size(a.name) !== size(b.name)) continue; const sc = similarity(a.name, b.name); if (sc >= 0.86) why = `Names ${Math.round(sc * 100)}% alike`; }
    if (!why) continue; const k = [a.id, b.id].sort().join('|'); if (seen.has(k)) continue; seen.add(k); pairs.push({ a, b, why });
  }
  return pairs;
}
const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const rows = Array.isArray(raw) ? raw : (raw.__rows || raw.rows || Object.values(raw)[0]);
const products = rows.map((r, i) => ({ id: 'P' + i, name: String(r.ITEM_NAME || r.name || r['Product*'] || r.Product || Object.values(r)[1] || ''), barcode: String(r.BARCODE_EAN || r.barcode || '') || '' })).filter(p => p.name);
let t = Date.now(); const o = oldFind(products); const to = Date.now() - t;
t = Date.now(); const n = findDuplicates(products); const tn = Date.now() - t;
const key = x => [x.a.id, x.b.id].sort().join('|') + ' ' + x.why;
const so = new Set(o.map(key)), sn = new Set(n.map(key));
const miss = [...so].filter(k => !sn.has(k)), extra = [...sn].filter(k => !so.has(k));
console.log(JSON.stringify({ products: products.length, old: { pairs: o.length, ms: to }, now: { pairs: n.length, ms: tn }, missing: miss.length, extra: extra.length, sample: o.slice(0, 3).map(x => [x.a.name, x.b.name, x.why]) }));
// big: 25,000 names
const big = Array.from({ length: 25000 }, (_, i) => ({ ...products[i % products.length], id: 'B' + i, name: products[i % products.length].name + (i >= products.length ? ' v' + Math.floor(i / products.length) : '') }));
t = Date.now(); const nb = findDuplicates(big); console.log(JSON.stringify({ big: big.length, pairs: nb.length, ms: Date.now() - t }));
