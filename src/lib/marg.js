// Reader for billing-software item masters like Sameer's sheet (Marg-style columns:
// Product*, Packing, Unit-1*, Unit-2, Conversion, unit-1/unit-2 qty, HSN/SAC Code*,
// Tax Category*, Company*, M.R.P., Purchase Rate, Retail, wholesale, Godown Rate, Exp. Date).
//
// How the prices in these sheets work (checked on Sameer's 1,753 items):
// - Items with Conversion 1 (or none): every price is for one piece.
// - Items sold in a bigger unit (1*12 PACK, 1*10 BAG …): MRP is for one piece, but Retail /
//   wholesale / purchase are usually for the whole pack. A piece can never be sold above MRP,
//   so a Retail price above MRP must be the pack price. Each other rate is read the same way.
// - Loose items (Unit-1 GRAM, Unit-2 KG, "Unit In Decimal" = YES): all prices per kg, stock in kg.
// Anything doubtful is loaded but listed for checking, nothing is dropped silently.

const up = s => String(s ?? '').trim().toUpperCase().replace(/\s+/g, ' ');
const key = s => up(s).replace(/[^A-Z0-9]/g, '');

// Header names (letters and digits only) → our field.
const COLS = {
  code: ['ITEMCODE'], barcode: ['BARCODE'], name: ['PRODUCT', 'ITEMNAME', 'PRINTNAME'], packing: ['PACKING'],
  unit1: ['UNIT1'], unit2: ['UNIT2', 'KG'], conversion: ['CONVERSION'], qty1: ['UNIT1QTY'], qty2: ['UNIT2QTY'],
  decimal: ['UNITINDECIMAL'], hsn: ['HSNSACCODE', 'HSN', 'HSNCODE'], tax: ['TAXCATEGORY', 'GST', 'TAX'], brand: ['COMPANY', 'AGENCY'],
  category: ['CATEGORY'], rack: ['RACK'], mrp: ['MRP'], purchase: ['PURCHASERATE'], cost: ['COST'],
  retail: ['RETAIL', 'RATEA', 'SALERATE'], wholesale: ['WHOLESALE', 'RATEB'], godown: ['GODOWNRATE', 'GODOWN'], expiry: ['EXPDATE', 'EXPIRY', 'EXPIRYDATE'],
};

/** True when the sheet looks like a billing-software item master (Product* / Unit-1* / Conversion). */
export function isMargSheet(headers) {
  const ks = headers.map(key);
  return ks.includes('PRODUCT') && ks.some(k => k === 'UNIT1') && (ks.includes('CONVERSION') || ks.includes('PACKING'));
}

function columnsOf(headers) {
  const out = {};
  for (const [f, names] of Object.entries(COLS)) {
    const h = headers.find(h => names.includes(key(h)));
    if (h) out[f] = h;
  }
  return out;
}

export const numOf = v => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').trim();
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
};

const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** "GST Sale - 5%", "GST SALE-NILL", "GST Sale-Exempt", 0, 0.05, 18 → 5, 0, 0, 0, 5, 18 */
export function taxRate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v > 0 && v < 1 ? Math.round(v * 100) : v;
  const s = up(v);
  const m = s.match(/(\d+(?:\.\d+)?)\s*%?/);
  if (/NIL|EXEMPT|ZERO/.test(s) && !m) return 0;
  if (m) { const n = Number(m[1]); return n > 0 && n < 1 ? Math.round(n * 100) : n; }
  if (/NIL|EXEMPT/.test(s)) return 0;
  return null;
}

/** HSN as text with the leading zero Excel removed (401 → 0401). "1234" is a placeholder → ''. */
export function hsnOf(v) {
  const d = String(v ?? '').replace(/\.0+$/, '').replace(/\D/g, '');
  if (!d || /^0+$/.test(d) || d === '1234' || d === '123456' || d === '12345678') return '';
  if (d.length % 2 === 1 && d.length <= 7) return '0' + d;
  return d;
}

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 };
const monthOf = t => { const u = up(t); for (const [k, n] of Object.entries(MONTHS)) if (u.startsWith(k)) return n; return null; };
const lastDay = (y, m) => new Date(y, m, 0).getDate();
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * Expiry dates as people type them: 05.12.26, 07.01.2027, 22.1.2027, 29-03-2027, 30/10/27, 04 2027,
 * 4.2027 (month.year), SEP.2027, 03.JUNE.2027, 29.DEC, Excel dates. Month-only dates mean the end of that month.
 * Returns { date: 'YYYY-MM-DD' | null, note: '' | 'why it was guessed' }.
 */
export function expiryOf(v, today = new Date()) {
  if (v == null || String(v).trim() === '') return { date: null, note: '' };
  if (v instanceof Date && !isNaN(v)) return { date: iso(v.getFullYear(), v.getMonth() + 1, v.getDate()), note: '' };
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) { // Excel serial date
      const d = new Date(Math.round((v - 25569) * 86400000));
      return { date: iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), note: '' };
    }
    v = String(v); // 4.2027 or 6.27 = month.year
  }
  let s = up(v).replace(/,/g, '.').replace(/[\s./-]+/g, '.').replace(/^\.|\.$/g, '');
  const parts = s.split('.').filter(Boolean);
  let d = null, m = null, y = null, note = '';
  const year = t => { const n = Number(t); return t.length <= 2 ? 2000 + n : n; };
  const isNum = t => /^\d+$/.test(t);
  if (parts.length === 3) {
    const [a, b, c] = parts;
    m = isNum(b) ? Number(b) : monthOf(b);
    if (!isNum(c)) return { date: null, note: `Could not read expiry "${v}"` };
    y = year(c);
    if (!isNum(a)) return { date: null, note: `Could not read expiry "${v}"` };
    d = Number(a);
    if (d > 31) { d = Number(a.slice(-2)); note = `Expiry "${v}" read as ${d}`; }
  } else if (parts.length === 2) {
    const [a, b] = parts;
    if (isNum(a) && isNum(b)) {
      if (b.length === 4 || (Number(a) <= 12 && b.length === 2)) { m = Number(a); y = year(b); }
    } else if (!isNum(a) && isNum(b)) { m = monthOf(a); y = year(b); }
    else if (isNum(a) && !isNum(b)) { // 29.DEC — no year
      d = Number(a); m = monthOf(b);
      if (m) { y = today.getFullYear(); if (iso(y, m, Math.min(d, lastDay(y, m))) < iso(today.getFullYear(), today.getMonth() + 1, today.getDate())) y++; note = `Expiry "${v}" has no year — read as ${y}`; }
    }
  } else if (parts.length === 1 && !isNum(parts[0])) {
    const mm = parts[0].match(/^([A-Z]+)(\d{2,4})$/);
    if (mm) { m = monthOf(mm[1]); y = year(mm[2]); }
  }
  if (!m || !y || m < 1 || m > 12 || y < 2000 || y > 2100) return { date: null, note: `Could not read expiry "${v}"` };
  if (d == null) d = lastDay(y, m);
  if (d < 1 || d > lastDay(y, m)) { note = `Expiry "${v}" has a day that does not exist — used ${lastDay(y, m)}`; d = lastDay(y, m); }
  return { date: iso(y, m, d), note };
}

const BARCODE_CLEAN = v => String(v ?? '').replace(/\.0+$/, '').replace(/\s+/g, '').trim();
const titleUnit = u => { const x = up(u); return x === 'PCS' || x === 'NOS' || x === 'PC' ? 'PCS' : x; };

/**
 * Map rows (objects keyed by header, as from XLSX sheet_to_json) to products.
 * Each item: { row, name, barcode, brand, category, uom, loose, hsn, gst, mrp, price, cost,
 *   prices: { wholesale, godown }, packs: [{ name, qty, price, wholesale, godown }], casePack,
 *   openingStock, expiry, warnings: [], errors: [] }
 */
export function mapMargItems(raw, { today = new Date() } = {}) {
  if (!raw.length) return { mapped: [], columns: {} };
  const columns = columnsOf(Object.keys(raw[0]));
  const g = (r, f) => (columns[f] ? r[columns[f]] : '');
  const mapped = [];
  raw.forEach((r, i) => {
    const name = String(g(r, 'name') ?? '').replace(/\s+/g, ' ').trim();
    if (!name) return;
    const warnings = [], errors = [];
    const u1 = titleUnit(g(r, 'unit1')) || 'PCS';
    const u2 = titleUnit(g(r, 'unit2'));
    let conv = numOf(g(r, 'conversion'));
    const packM = String(g(r, 'packing') || '').match(/\*\s*(\d+)/);
    if (!(conv > 0)) conv = packM ? Number(packM[1]) : 1;
    const loose = u1 === 'GRAM' || /^Y/i.test(String(g(r, 'decimal') || '')) && conv === 1000;
    const mrp = numOf(g(r, 'mrp'));
    const retail = numOf(g(r, 'retail'));
    let purchase = numOf(g(r, 'purchase'));
    const costCol = numOf(g(r, 'cost'));
    let wholesale = numOf(g(r, 'wholesale'));
    let godown = numOf(g(r, 'godown'));
    if (String(g(r, 'purchase') || '').startsWith('#')) warnings.push(`Purchase rate cell shows ${g(r, 'purchase')} — fill it in`);
    const q1 = numOf(g(r, 'qty1')) || 0, q2 = numOf(g(r, 'qty2')) || 0;

    let uom = 'PCS', price, cost, packs = [], casePack = 1, openingStock;
    if (loose) {
      // Sold by weight: every rate is per kg, stock in kg.
      uom = 'KG'; price = retail; cost = costCol ?? purchase;
      openingStock = r2(q2 + q1 / 1000);
    } else {
      // A piece can't sell above MRP, so a Retail above MRP is the price of the whole pack.
      const perPack = conv > 1 && mrp > 0 && retail > mrp * 1.05;
      price = perPack ? retail / conv : retail;
      // The other rates are read the same way: a purchase rate at or above the piece selling
      // price, or a wholesale / godown rate above it, must be for the pack. → { piece, pack }
      const split = (v, isCost) => {
        if (v == null) return { piece: null, pack: null };
        if (conv <= 1) return { piece: v, pack: null };
        const ref = price ?? mrp;
        const forPack = ref > 0 && (isCost ? v >= ref : v > ref * 1.05);
        return forPack ? { piece: v / conv, pack: v } : { piece: v, pack: v * conv };
      };
      cost = costCol ?? split(purchase, true).piece;
      const w = split(wholesale), gd = split(godown);
      wholesale = w.piece; godown = gd.piece;
      if (conv > 1) {
        casePack = conv;
        packs = [{
          name: u2 && u2 !== u1 ? u2 : 'PACK', qty: conv, price: r2(perPack ? retail : (price || 0) * conv),
          ...(w.pack ? { wholesale: r2(w.pack) } : {}), ...(gd.pack ? { godown: r2(gd.pack) } : {}),
        }];
      }
      openingStock = q1 + q2 * conv;
    }
    price = price == null ? null : r2(price);
    cost = cost == null ? 0 : r2(cost);
    wholesale = wholesale == null ? null : r2(wholesale);
    godown = godown == null ? null : r2(godown);

    if (!(price > 0)) errors.push('Retail price missing');
    if (mrp > 0 && price > mrp + 0.001) {
      warnings.push(`Retail ₹${price} is above MRP ₹${mrp} — set to MRP (selling above MRP is not allowed)`);
      price = mrp;
      if (packs[0] && packs[0].price / packs[0].qty > mrp) packs[0].price = r2(mrp * packs[0].qty);
    }
    if (cost && price && cost >= price) warnings.push(`Purchase rate ₹${cost} is not below the selling price ₹${price} — check`);
    if (wholesale && price && wholesale > price + 0.001) warnings.push(`Wholesale ₹${wholesale} is above retail ₹${price} — check`);
    if (wholesale && cost && wholesale < cost) warnings.push(`Wholesale ₹${wholesale} is below purchase ₹${cost} — loss on wholesale`);

    const gst = taxRate(g(r, 'tax'));
    const hsnRaw = String(g(r, 'hsn') ?? '').trim();
    const hsn = hsnOf(hsnRaw);
    if (gst == null) errors.push('GST rate missing');
    if (!hsn) warnings.push(hsnRaw ? `HSN "${hsnRaw}" is a placeholder — add the real HSN${gst === 0 ? ' and check the GST (sheet says Nil)' : ''}` : 'HSN missing');
    // 3 or 7 digits = Excel dropped the leading 0 (401 → 0401), safe. 5 digits may be a typed-in placeholder.
    else if (hsn.length === 6 && hsnRaw.replace(/\D/g, '').length === 5) warnings.push(`HSN ${hsnRaw} has 5 digits — read as ${hsn}, please check`);

    const barcode = BARCODE_CLEAN(g(r, 'barcode'));
    if (!barcode && !loose) warnings.push('No barcode — cashier must search by name');
    const exp = expiryOf(g(r, 'expiry'), today);
    if (exp.note) warnings.push(exp.note);
    if (exp.date && exp.date < String(today.getFullYear() - 3)) warnings.push(`Expiry year ${exp.date.slice(0, 4)} looks like a typing mistake — check`);

    mapped.push({
      row: i + 2, id: String(g(r, 'code') || '').trim(), barcode, name,
      brand: String(g(r, 'brand') ?? '').trim().replace(/^(OTHER|0)$/i, ''),
      category: (String(g(r, 'category') ?? '').trim() || 'General').replace(/^Other$/i, 'General'),
      rack: String(g(r, 'rack') ?? '').trim().replace(/^Other$/i, ''),
      uom, loose, hsn, gst, mrp: mrp || price, price, cost,
      prices: { ...(wholesale ? { wholesale } : {}), ...(godown ? { godown } : {}) },
      packs, casePack, openingStock: Math.max(0, openingStock || 0), expiry: exp.date,
      packing: String(g(r, 'packing') || '').trim(), warnings, errors,
    });
  });
  // Same name twice in the file.
  const seen = {};
  mapped.forEach(p => { const k = up(p.name); if (seen[k]) p.warnings.push(`Same name as row ${seen[k]}`); else seen[k] = p.row; });
  return { mapped, columns };
}
