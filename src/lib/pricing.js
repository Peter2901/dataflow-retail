// Selling the same product in different units and at different price levels.
//
// A product is stocked in its base unit (pieces, or kg for loose items). It can also have packs:
//   packs: [{ name: 'BAG', qty: 10, price: 490, wholesale: 475, godown: 470, barcode: '' }]
// and price levels per base unit: prices: { wholesale: 47.5, godown: 47 } (Retail = product.price).
// A bill line keeps qty in the base unit (so stock, GST and reports stay in pieces) and,
// when sold by the pack, `sell: { unit, size, count, price }` — the pack price is charged exactly.

export const LEVELS = [
  { value: 'retail', label: 'Retail', short: 'R' },
  { value: 'wholesale', label: 'Wholesale', short: 'W' },
  { value: 'godown', label: 'Godown', short: 'G' },
];
export const levelLabel = v => (LEVELS.find(l => l.value === v) || LEVELS[0]).label;

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

export const baseUnitName = p => (p?.uom === 'KG' ? 'kg' : (p?.uom || 'PCS').toLowerCase() === 'pcs' ? 'pcs' : String(p?.uom || 'pcs').toLowerCase());

/** Units the product can be sold in: [{ idx: null, name: 'pcs', size: 1 }, { idx: 0, name: 'BAG', size: 10 }] */
export function unitsOf(p) {
  const out = [{ idx: null, name: baseUnitName(p), size: 1 }];
  (p?.packs || []).forEach((k, i) => { if (Number(k.qty) > 1) out.push({ idx: i, name: k.name || 'PACK', size: Number(k.qty) }); });
  return out;
}

/** Price of one base unit at a level (falls back to Retail). */
export function basePrice(p, level = 'retail') {
  if (level !== 'retail') { const v = Number(p?.prices?.[level]); if (v > 0) return v; }
  return Number(p?.price) || 0;
}

/**
 * Price of one chosen unit (a piece, or a whole pack) at a level, never above MRP per piece.
 * Pack: the pack's own rate for that level, else the pack's retail rate scaled for wholesale, else piece price × size.
 */
export function unitPrice(p, level = 'retail', idx = null) {
  const pack = idx != null ? p?.packs?.[idx] : null;
  const mrp = Number(p?.mrp) || 0;
  if (!pack) { const v = basePrice(p, level); return mrp > 0 ? Math.min(v, mrp) : v; }
  const size = Number(pack.qty) || 1;
  let v = Number(pack[level === 'retail' ? 'price' : level]) || 0;
  if (!(v > 0)) v = basePrice(p, level) * size;
  if (mrp > 0 && v > mrp * size) v = mrp * size;
  return r2(v);
}

/** A product + chosen unit + count → the fields a bill line needs (qty in base units). */
export function lineQty(p, { count, idx = null, level = 'retail', price = null }) {
  const pack = idx != null ? p?.packs?.[idx] : null;
  const size = pack ? Number(pack.qty) || 1 : 1;
  const per = price != null ? Number(price) : unitPrice(p, level, idx);
  const n = Number(count) || 0;
  return {
    qty: r3(n * size),
    unitPrice: pack ? Math.round((per / size) * 10000) / 10000 : per,
    sell: pack ? { unit: pack.name || 'PACK', size, count: n, price: per } : null,
  };
}

/** Find a product (and which pack) by a scanned code: product barcode, pack barcode, SKU or PLU. */
export function findByCode(products, code) {
  const q = String(code || '').trim();
  if (!q) return null;
  const lower = q.toLowerCase();
  for (const p of products) {
    if (p.barcode === q || (p.plu && p.plu === q) || String(p.id).toLowerCase() === lower) return { product: p, idx: null };
  }
  for (const p of products) {
    const i = (p.packs || []).findIndex(k => k.barcode && k.barcode === q);
    if (i >= 0) return { product: p, idx: i };
  }
  return null;
}

/** "2 BAG×10" / "3 pcs" / "1.25 kg" for receipts and screens. */
export function qtyText(l) {
  if (l?.sell) return `${l.sell.count} ${l.sell.unit}×${l.sell.size}`;
  const kg = l?.uom === 'KG';
  return `${kg ? r3(l?.qty) : l?.qty}${kg ? ' kg' : ''}`;
}

/** Clean packs / prices typed in a form: numbers, drop empty packs. */
export function cleanPricing(p) {
  const prices = {};
  for (const l of ['wholesale', 'godown']) { const v = Number(p?.prices?.[l]); if (v > 0) prices[l] = r2(v); }
  const packs = (p?.packs || []).map(k => {
    const out = { name: String(k.name || 'PACK').trim().toUpperCase() || 'PACK', qty: Number(k.qty) || 0 };
    for (const f of ['price', 'wholesale', 'godown']) { const v = Number(k[f]); if (v > 0) out[f] = r2(v); }
    if (k.barcode) out.barcode = String(k.barcode).trim();
    return out;
  }).filter(k => k.qty > 1);
  return { prices, packs };
}

/** Problems with packs / levels that stop saving. */
export function pricingErrors(p) {
  const errs = [];
  const mrp = Number(p.mrp) || 0;
  for (const l of ['wholesale', 'godown']) {
    const v = Number(p.prices?.[l]);
    if (v > 0 && mrp > 0 && v > mrp) errs.push(`${levelLabel(l)} price cannot be above MRP.`);
  }
  (p.packs || []).forEach(k => {
    const q = Number(k.qty);
    if (!(q > 1)) return;
    for (const f of ['price', 'wholesale', 'godown']) {
      const v = Number(k[f]);
      if (v > 0 && mrp > 0 && v / q > mrp + 0.001) errs.push(`${k.name || 'Pack'} ${f === 'price' ? 'retail' : f} price works out above MRP per piece.`);
    }
  });
  return errs;
}
