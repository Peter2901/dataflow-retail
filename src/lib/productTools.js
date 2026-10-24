// Product helpers: duplicate finder + merge, HSN/GST hints, and "fill from pack photo".
// Code first; AI only when code can't tell (and only if the store has AI on).
import { db } from '../db.js';
import { simProfile, simScore } from './match.js';
import { askAI, aiOn, photoToCanvas, canvasJpeg } from './smartai.js';
import { ocrCanvas } from './billreader.js';
import { audit } from './sales.js';
import { validEAN } from './util.js';

// ───────────── Duplicates
// Before: every product against every other (25,000 products = 31 crore comparisons, the page froze).
// Now: same barcode through one lookup; names only against products of the same size that share a word —
// two names can only be 86 % alike if they share words, so the answer is the same, just instant.
export function findDuplicates(products) {
  const act = products.filter(p => p.active !== false);
  const pairs = [], seen = new Set();
  const add = (a, b, why) => { const k = a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id; if (seen.has(k)) return; seen.add(k); pairs.push({ a, b, why }); };
  const byCode = new Map();
  for (const p of act) if (p.barcode) { const l = byCode.get(p.barcode); if (l) l.push(p); else byCode.set(p.barcode, [p]); }
  for (const l of byCode.values()) for (let i = 0; i < l.length; i++) for (let j = i + 1; j < l.length; j++) add(l[i], l[j], 'Same barcode');
  const prof = act.map(p => simProfile(p.name));
  const buckets = new Map();
  act.forEach((p, i) => { const sz = prof[i].size || ''; for (const t of prof[i].tok) { const k = sz + '|' + t; const l = buckets.get(k); if (l) l.push(i); else buckets.set(k, [i]); } });
  const done = new Set();
  const t0 = Date.now();
  // Never freeze the screen: at most the first 500 pairs (merge those, then look again).
  const full = () => pairs.length >= 500 || Date.now() - t0 > 1500;
  scan: for (const [k, l] of buckets) {
    if (l.length < 2 || l.length > 400) continue;       // a word in hundreds of names (a brand, a size) says nothing on its own
    if (/\|\d+$/.test(k)) continue;                     // a bare number ("#12") is not a name
    for (let x = 0; x < l.length; x++) {
      for (let y = x + 1; y < l.length; y++) {
        const i = l[x], j = l[y], key = i * act.length + j;
        if (done.has(key)) continue;
        done.add(key);
        const sc = simScore(prof[i], prof[j]);
        if (sc >= 0.86) add(act[i], act[j], `Names ${Math.round(sc * 100)}% alike`);
      }
      if (full()) break scan;
    }
  }
  if (full()) { pairs.length = Math.min(pairs.length, 500); pairs.more = true; }
  return pairs;
}

/** Moves everything of `dropId` (stock, batches, history, supplier memory, offers) onto `keepId`, then hides `dropId`. */
export async function mergeProducts(keepId, dropId, user) {
  if (keepId === dropId) return;
  const keep = await db.products.get(keepId), drop = await db.products.get(dropId);
  if (!keep || !drop) throw new Error('Product not found.');
  await db.transaction('rw', db.batches, db.stockMoves, db.purchases, db.itemAliases, db.offers, db.purchaseOrders, db.orders, db.products, async () => {
    await db.batches.where('productId').equals(dropId).modify({ productId: keepId });
    await db.stockMoves.where('productId').equals(dropId).modify({ productId: keepId });
    await db.itemAliases.where('productId').equals(dropId).modify({ productId: keepId });
    for (const p of await db.purchases.toArray()) if (p.lines.some(l => l.productId === dropId)) await db.purchases.update(p.id, { lines: p.lines.map(l => (l.productId === dropId ? { ...l, productId: keepId } : l)) });
    for (const p of await db.purchaseOrders.toArray()) if (p.lines.some(l => l.productId === dropId)) await db.purchaseOrders.update(p.id, { lines: p.lines.map(l => (l.productId === dropId ? { ...l, productId: keepId } : l)) });
    for (const o of await db.orders.toArray()) if ((o.items || []).some(l => l.productId === dropId)) await db.orders.update(o.id, { items: o.items.map(l => (l.productId === dropId ? { ...l, productId: keepId } : l)) });
    for (const o of await db.offers.toArray()) {
      const upd = {};
      if (o.productId === dropId) upd.productId = keepId;
      if (o.productIds?.includes(dropId)) upd.productIds = o.productIds.map(x => (x === dropId ? keepId : x));
      if (Object.keys(upd).length) await db.offers.update(o.id, upd);
    }
    await db.products.update(dropId, { active: false, mergedInto: keepId, barcode: drop.barcode === keep.barcode ? '' : drop.barcode });
    if (!keep.barcode && drop.barcode) await db.products.update(keepId, { barcode: drop.barcode });
  });
  await audit('product_merge', { keep: keep.name, removed: drop.name }, user);
}

// ───────────── HSN / GST hints
const HSN = [
  [['biscuit', 'cookie', 'rusk', 'bread', 'cake', 'toast'], '1905'], [['salt', 'namak'], '2501'], [['sugar', 'jaggery', 'gud'], '1701'],
  [['basmati', 'rice', 'chawal'], '1006'], [['poha', 'chuda', 'cornflakes', 'flakes', 'muesli'], '1904'], [['atta', 'wheat flour', 'maida'], '1101'],
  [['suji', 'sooji', 'rava', 'semolina', 'dalia'], '1103'], [['besan', 'gram flour'], '1106'], [['dal', 'lentil', 'toor', 'moong', 'masoor', 'urad', 'chana', 'rajma'], '0713'],
  [['sunflower oil'], '1512'], [['mustard oil'], '1514'], [['groundnut oil'], '1508'], [['soybean oil', 'soya oil'], '1507'], [['palm oil'], '1511'],
  [['ghee', 'butter'], '0405'], [['milk'], '0401'], [['curd', 'dahi', 'yogurt', 'lassi', 'buttermilk'], '0403'], [['paneer', 'cheese'], '0406'],
  [['tea'], '0902'], [['coffee'], '0901'], [['soap'], '3401'], [['detergent', 'washing powder', 'dishwash'], '3402'], [['shampoo', 'hair oil'], '3305'],
  [['toothpaste', 'tooth paste'], '3306'], [['chocolate', 'cocoa'], '1806'], [['namkeen', 'bhujia', 'mixture'], '2106'], [['noodles', 'pasta', 'vermicelli', 'sewai'], '1902'],
  [['chilli', 'pepper'], '0904'], [['turmeric', 'haldi', 'masala', 'spice'], '0910'], [['cumin', 'jeera', 'coriander', 'dhaniya'], '0909'], [['honey'], '0409'],
  [['juice'], '2009'], [['soft drink', 'cola', 'soda'], '2202'], [['mineral water', 'packaged water'], '2201'], [['cashew', 'kaju'], '0801'], [['almond', 'badam'], '0802'],
  [['raisin', 'kishmish'], '0806'], [['egg'], '0407'], [['ketchup', 'sauce'], '2103'], [['pickle', 'achar'], '2001'], [['jam'], '2007'], [['agarbatti', 'incense', 'dhoop'], '3307'],
  [['matchbox', 'machis'], '3605'], [['candle'], '3406'], [['tissue', 'napkin'], '4818'], [['diaper', 'sanitary pad'], '9619'], [['chips', 'wafers'], '2005'],
  [['peanut', 'groundnut', 'moongfali'], '1202'], [['sabudana', 'tapioca'], '1903'], [['oats'], '1104'],
];

/**
 * Suggests HSN and GST for a new item name. 1) your own most similar product (HSN + GST),
 * 2) the built-in HSN list (HSN only — GST must be chosen by a person), 3) AI if on and asked.
 */
const hsnProf = new WeakMap();
export async function suggestHsnGst(name, products, { useAI = false } = {}) {
  const n = String(name || '').trim();
  if (n.length < 3) return null;
  let best = null;
  const qp = simProfile(n);
  for (const p of products) {
    if (!p.hsn || p.active === false) continue;
    let pp = hsnProf.get(p);
    if (!pp) { pp = simProfile(p.name + ' ' + (p.category || '')); hsnProf.set(p, pp); }   // worked out once per product
    const s = simScore(qp, pp);
    if (!best || s > best.s) best = { p, s };
  }
  if (best && best.s >= 0.55) return { hsn: best.p.hsn, gst: best.p.gst, category: best.p.category, source: `same as your “${best.p.name}”`, sure: best.s >= 0.75 };
  const low = n.toLowerCase();
  const hit = HSN.find(([keys]) => keys.some(k => low.includes(k)));
  if (hit) return { hsn: hit[1], gst: null, source: 'common HSN for this kind of item — choose the GST rate yourself', sure: false };
  if (useAI && await aiOn()) {
    const r = await askAI('hsn', { names: [n] });
    const it = r.data?.items?.[0];
    if (it?.hsn) return { hsn: String(it.hsn), gst: it.gst ?? null, source: 'AI hint — please confirm with your CA', sure: false };
  }
  return null;
}

// ───────────── Pack photo → product details
async function readBarcode(canvas) {
  try {
    if (!('BarcodeDetector' in window)) return null;
    const det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128'] });
    const codes = await det.detect(canvas);
    return codes[0]?.rawValue || null;
  } catch { return null; }
}

export function parsePackText(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const mrp = t.match(/M\.?\s?R\.?\s?P\.?[^0-9]{0,25}?(\d{1,5}(?:\.\d{1,2})?)/i);
  const qty = t.match(/(?:net\s*(?:wt|weight|qty|quantity|content|vol(?:ume)?)\.?\s*[:\-]?\s*)(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|grams?|ml|l|ltr|litre|liter)\b/i) || t.match(/\b(\d+(?:\.\d+)?)\s*(kg|g|gm|gms|ml|l|ltr)\b/i);
  const fssai = t.match(/\b(\d{14})\b/);
  const code = (t.match(/\b(\d{13}|\d{8})\b/g) || []).find(validEAN) || null;
  const unit = qty ? qty[2].toLowerCase().replace(/^(gm|gms|grams?)$/, 'g').replace(/^(ltr|litre|liter)$/, 'l') : null;
  return { mrp: mrp ? Number(mrp[1]) : null, netQty: qty ? Number(qty[1]) : null, unit, fssai: fssai ? fssai[1] : null, barcode: code };
}

/** Returns { name, brand, mrp, netQty, unit, barcode, fssai, method: 'free'|'ai' } — the person confirms. */
export async function readPackPhoto(file, onStep = () => {}) {
  onStep('Reading the pack…');
  const c = await photoToCanvas(file, 2000);
  const barcode = await readBarcode(c);
  const text = await ocrCanvas(c).catch(() => '');
  const free = parsePackText(text);
  const out = { name: '', brand: '', ...free, barcode: barcode || free.barcode, method: 'free' };
  // The product name is hard for plain code (big fancy letters): AI only for what is missing.
  if ((!out.name || !out.mrp) && await aiOn()) {
    try {
      onStep('Asking AI for the name…');
      const r = await askAI('pack', {}, [canvasJpeg(await photoToCanvas(file, 1400))]);
      const d = r.data || {};
      out.name = d.name || out.name; out.brand = d.brand || out.brand;
      out.mrp = out.mrp || d.mrp || null; out.netQty = out.netQty || d.netQty || null; out.unit = out.unit || d.unit || null;
      out.barcode = out.barcode || (d.barcode && validEAN(d.barcode) ? d.barcode : null); out.fssai = out.fssai || d.fssai || null;
      out.category = d.category || '';
      out.method = 'ai';
    } catch { /* keep the free result */ }
  }
  return out;
}
