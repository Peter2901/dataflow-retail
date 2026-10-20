// Up to 3 units for one product, biggest to smallest. Example: 1 Bag = 30 Kg, 1 Kg = 1000 Gram.
//
//   p.units = { names: ['Bag', 'Kg', 'Gram'], c12: 30, c23: 1000, base: 1 }
//
// "base" is the unit that stock, price, MRP and purchase rate are kept in (here: Kg).
// Every quantity inside the app stays in the base unit; units only change how a number is
// typed in and shown. So bills, stock and GST work exactly as before.

const clean = v => String(v ?? '').trim();
const num = v => Number(v) || 0;

// The chosen "stock is kept in" unit, or a sensible one when nothing was chosen yet.
function chooseBase(u, k) {
  const b = u.base;
  if (b === undefined || b === null || b === '') return defaultBase((u.names || []).slice(0, k));
  return Math.min(Math.max(Number(b) || 0, 0), k - 1);
}

/** How many of each unit are used: 0 (none), 2 or 3. Unit 1 and 2 are needed; unit 3 is optional. */
export function unitCount(p) {
  const u = p?.units; if (!u) return 0;
  const n = (u.names || []).map(clean);
  if (!n[0] || !n[1]) return 0;
  return n[2] ? 3 : 2;
}

/** [{ i, name, factor }] — factor = how many base units are in one of this unit. [] when the product has one unit. */
export function unitList(p) {
  const k = unitCount(p); if (!k) return [];
  const u = p.units, c12 = num(u.c12), c23 = num(u.c23);
  if (!(c12 > 0) || (k === 3 && !(c23 > 0))) return [];
  const m = k === 3 ? [c12 * c23, c23, 1] : [c12, 1];        // each unit measured in the smallest unit
  const base = chooseBase(u, k);
  return m.map((v, i) => ({ i, name: clean(u.names[i]), factor: v / m[base], base: i === base }));
}

export const baseUnit = p => unitList(p).find(x => x.base) || null;

/** Quantity typed in unit `i` → quantity in the base unit (rounded to 1/10000 to hide float noise). */
export const toBase = (p, i, qty) => {
  const f = unitList(p)[i]?.factor ?? 1;
  return Math.round(num(qty) * f * 1e4) / 1e4;
};
/** Base quantity → quantity in unit `i`. */
export const fromBase = (p, i, qty) => {
  const f = unitList(p)[i]?.factor ?? 1;
  return Math.round((num(qty) / f) * 1e4) / 1e4;
};

/** "2 Bag 5 Kg 200 Gram" for a stock figure kept in the base unit. */
export function breakdown(p, baseQty) {
  const L = unitList(p); if (!L.length) return '';
  const small = L[L.length - 1].factor;                       // smallest unit, in base units
  let rest = Math.round(num(baseQty) / small + 1e-9);         // whole smallest units
  const neg = rest < 0; rest = Math.abs(rest);
  const out = [];
  for (let i = 0; i < L.length; i++) {
    const per = Math.round(L[i].factor / small);
    if (i === L.length - 1) { if (rest) out.push(`${rest} ${L[i].name}`); break; }
    const q = Math.floor(rest / per); rest -= q * per;
    if (q) out.push(`${q} ${L[i].name}`);
  }
  if (!out.length) out.push(`0 ${L[L.length - 1].name}`);
  return (neg ? '−' : '') + out.join(' ');
}

/** Shows a number without trailing zeros: 0.5, 12, 3.25 */
export const plain = (v, dec = 3) => String(Number((Number(v) || 0).toFixed(dec)));

// The old code checks the unit code (KG, PCS…). Turn what the owner typed into that code.
export function uomCode(name) {
  const s = clean(name).toLowerCase();
  if (/^(kg|kgs|kilo|kilos|kilogram|kilograms)$/.test(s)) return 'KG';
  if (/^(g|gm|gms|gram|grams)$/.test(s)) return 'GM';
  if (/^(pc|pcs|piece|pieces|nos)$/.test(s)) return 'PCS';
  if (/^(l|ltr|litre|liter|litres|liters)$/.test(s)) return 'LTR';
  if (/^(ml|millilitre|milliliter)$/.test(s)) return 'ML';
  if (/^(pack|packet|packets)$/.test(s)) return 'PACK';
  return clean(name).toUpperCase().slice(0, 12);
}

/** A sensible "stock is kept in" choice: the smallest unit, unless that is Gram/ML — then the one above. */
export function defaultBase(names) {
  const used = names.map(clean).filter(Boolean);
  const k = used.length;
  if (k < 2) return 0;
  return /^(g|gm|gms|gram|grams|ml)$/i.test(used[k - 1]) ? k - 2 : k - 1;
}

/** Problems with the unit set-up, in simple words. Empty list = fine (or no units used). */
export function unitErrors(p) {
  const u = p?.units; if (!u) return [];
  const names = (u.names || []).map(clean);
  if (!names.some(Boolean)) return [];
  const errs = [];
  if (!names[0] || !names[1]) errs.push('Units: fill Unit 1 and Unit 2 (Unit 3 is optional).');
  if (names[2] && !names[1]) errs.push('Units: Unit 3 needs Unit 2 first.');
  const used = names.filter(Boolean).map(x => x.toLowerCase());
  if (new Set(used).size !== used.length) errs.push('Units: each unit needs a different name.');
  if (names[0] && names[1] && !(num(u.c12) > 0)) errs.push(`Units: how many ${names[1]} are in 1 ${names[0]}?`);
  if (names[2] && !(num(u.c23) > 0)) errs.push(`Units: how many ${names[2]} are in 1 ${names[1]}?`);
  return errs;
}

/** Tidy the units before saving. Returns the product with `units` removed when it is not used. */
export function cleanUnits(p) {
  const u = p.units;
  const names = (u?.names || []).map(clean);
  if (!u || !names[0] || !names[1]) { const { units, ...rest } = p; return rest; }   // eslint-disable-line no-unused-vars
  const k = names[2] ? 3 : 2;
  const base = chooseBase({ ...u, names }, k);
  const units = { names: [names[0], names[1], k === 3 ? names[2] : ''], c12: num(u.c12), c23: k === 3 ? num(u.c23) : 0, base };
  return { ...p, units, uom: uomCode(names[base]) };
}

// ---------------------------------------------------------------------------------------------
// Retail and wholesale price lists.
//   p.price            retail price per base unit (the "Selling price" field)
//   p.prices.r[0..1]   retail price per Unit 1 and per Unit 2 (blank = price × units in it)
//   p.prices.w[0..2]   wholesale price per Unit 1, 2 and 3 (blank = the retail price for that unit)
//   p.wholesale        wholesale price when the product has only one unit
// All prices include GST, like the selling price. Prices are per ONE of that unit (₹ per Bag, ₹ per Kg…).
// ---------------------------------------------------------------------------------------------
const pos = v => (Number(v) > 0 ? Number(v) : 0);
const round6 = v => Math.round(v * 1e6) / 1e6;

/** Retail price of one unit `i` (₹, incl. GST). Without units: the selling price. */
export function retailUnitPrice(p, i) {
  const L = unitList(p);
  if (!L.length) return pos(p.price);
  const u = L[i] || L.find(x => x.base);
  if (u.base) return pos(p.price);
  const own = u.i < 2 ? pos(p.prices?.r?.[u.i]) : 0;
  return own || pos(p.price) * u.factor;
}

/** Wholesale price of one unit `i`; falls back to the retail price when none is set. */
export function wholesaleUnitPrice(p, i) {
  const L = unitList(p);
  if (!L.length) return pos(p.wholesale) || pos(p.price);
  const u = L[i] || L.find(x => x.base);
  return pos(p.prices?.w?.[u.i]) || retailUnitPrice(p, u.i);
}

/** The price per BASE unit to charge when quantity is counted in unit `i` ('retail' or 'wholesale'). */
export function priceFor(p, i, mode = 'retail') {
  const L = unitList(p);
  if (!L.length) return mode === 'wholesale' ? wholesaleUnitPrice(p) : pos(p.price);
  const u = L[i] || L.find(x => x.base);
  const per = mode === 'wholesale' ? wholesaleUnitPrice(p, u.i) : retailUnitPrice(p, u.i);
  return round6(per / u.factor);
}

/** Price checks: never above MRP, wholesale never below the purchase rate. */
export function priceErrors(p) {
  const errs = [];
  const mrp = pos(p.mrp), cost = pos(p.cost);
  const L = unitList(p);
  const rows = L.length ? L : [{ i: 0, name: 'unit', factor: 1 }];
  for (const u of rows) {
    const r = retailUnitPrice(p, u.i), w = wholesaleUnitPrice(p, u.i);
    const nm = L.length ? ` per ${u.name}` : '';
    if (mrp && r > mrp * u.factor + 0.005) errs.push(`Retail price${nm} ₹${plain(r, 2)} is above MRP ₹${plain(mrp * u.factor, 2)}.`);
    if (mrp && w > mrp * u.factor + 0.005) errs.push(`Wholesale price${nm} ₹${plain(w, 2)} is above MRP ₹${plain(mrp * u.factor, 2)}.`);
    if (cost && w < cost * u.factor - 0.005) errs.push(`Wholesale price${nm} ₹${plain(w, 2)} is below the purchase rate ₹${plain(cost * u.factor, 2)}.`);
  }
  return [...new Set(errs)];
}

/** Tidy the price lists before saving (numbers only, drop what is empty). */
export function cleanPrices(p) {
  const k = unitList(p).length;
  const { prices, wholesale, ...rest } = p; // eslint-disable-line no-unused-vars
  const out = { ...rest };
  if (!k) {
    if (pos(wholesale)) out.wholesale = pos(wholesale);
    return out;
  }
  const r = [pos(prices?.r?.[0]), pos(prices?.r?.[1])];
  const w = [pos(prices?.w?.[0]), pos(prices?.w?.[1]), pos(prices?.w?.[2])];
  if (r.some(Boolean) || w.some(Boolean)) out.prices = { r, w };
  return out;
}
