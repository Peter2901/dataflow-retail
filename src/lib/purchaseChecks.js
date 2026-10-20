// Free checks on a purchase bill, run while it is being entered (typed, scanned or read from a photo).
// They catch reading mistakes and supplier tricks: wrong totals, wrong GST type, rate hikes,
// missing schemes, short-expiry stock, a cheaper supplier, selling at a loss.
import { db } from '../db.js';
import { r2, sum, validGSTIN, daysBetween, fmtDate } from './util.js';
import { GST_SLABS } from './billing.js';
import { stockMap, daysLeft } from './stock.js';
import { isCaseUnit } from './match.js';

const n = v => Number(v) || 0;

/** Line maths. qty and free are in the supplier's unit; pack = pieces in one unit. */
export function lineCalc(l) {
  const qty = n(l.qty), free = n(l.free), pack = n(l.pack) || 1, rate = n(l.rate), disc = n(l.disc), gst = n(l.gst);
  const gross = r2(qty * rate);
  const taxable = r2(gross * (1 - disc / 100));
  const tax = r2((taxable * gst) / 100);
  const pieces = r2((qty + free) * pack);
  const landing = pieces > 0 ? taxable / pieces : 0;            // per piece, before GST
  return { qty, free, pack, rate, disc, gst, gross, taxable, tax, total: r2(taxable + tax), pieces, landing, landingInc: landing * (1 + gst / 100) };
}

export function billCalc(lines) {
  const c = lines.filter(l => n(l.qty) > 0).map(lineCalc);
  const taxable = r2(sum(c, x => x.taxable)), tax = r2(sum(c, x => x.tax));
  return { taxable, tax, total: r2(taxable + tax), rounded: Math.round(taxable + tax) };
}

/** Everything the checks need from history: past purchase costs, sales speed, stock. */
export async function loadPurchaseContext(storeId) {
  const settings = Object.fromEntries((await db.settings.toArray()).map(r => [r.key, r.value]));
  const purchases = (await db.purchases.toArray()).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const history = {};   // productId -> newest first
  for (const p of purchases) for (const l of p.lines || []) {
    const c = lineCalc(l);
    (history[l.productId] = history[l.productId] || []).push({ purchaseId: p.id, supplierId: p.supplierId, date: p.date, landing: c.landing, free: c.free, disc: c.disc, pack: c.pack, rate: c.rate });
  }
  const since = Date.now() - 30 * 86400000;
  const sold = {};
  (await db.sales.where('storeId').equals(storeId).toArray()).filter(s => s.ts >= since && s.type === 'sale' && s.status !== 'void')
    .forEach(s => s.lines.forEach(l => (sold[l.productId] = (sold[l.productId] || 0) + n(l.qty))));
  const daily = Object.fromEntries(Object.entries(sold).map(([k, v]) => [k, v / 30]));
  return { settings, purchases, history, daily, stock: await stockMap(storeId) };
}

const pct = x => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%';
const rs = x => '₹' + (Math.round(x * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const schemeText = h => [h.free ? `free goods` : '', h.disc ? `${h.disc}% off` : ''].filter(Boolean).join(' + ');

/**
 * ctx from loadPurchaseContext. bill = { supplier, billNo, date, lines, printed: { total, tax, taxType }, editingId }
 * Returns { line: { [key]: issue[] }, bill: issue[], bad, warn, totalsMatch, linesOk }
 * issue = { tone: 'bad'|'warn'|'info'|'ok', text }
 */
export function checkBill(ctx, { supplier, billNo, date, lines, printed = {}, products, suppliers = [], editingId }) {
  const pm = Object.fromEntries(products.map(p => [p.id, p]));
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const out = { line: {}, bill: [], bad: 0, warn: 0, totalsMatch: null, linesOk: true };
  const add = (arr, tone, text) => { arr.push({ tone, text }); if (tone === 'bad') out.bad++; if (tone === 'warn') out.warn++; };
  const B = out.bill;
  const used = lines.filter(l => n(l.qty) > 0 || l.productId || l.text);

  // ---- Bill level
  if (!supplier) add(B, 'bad', 'Choose the supplier.');
  else {
    if (supplier.gstin && !validGSTIN(supplier.gstin)) add(B, 'warn', `Supplier GSTIN ${supplier.gstin} fails the check — confirm it from the bill.`);
    const key = s => String(s || '').replace(/\s/g, '').toUpperCase();
    if (billNo && ctx.purchases.some(p => p.id !== editingId && p.supplierId === supplier.id && key(p.billNo) === key(billNo))) add(B, 'bad', `Bill ${billNo} from ${supplier.name} is already entered. Same bill twice would double the stock and GST credit.`);
  }
  if (!billNo) add(B, 'warn', 'Enter the supplier’s bill number (needed for the GST credit match).');
  if (date) {
    const age = daysBetween(new Date(date), new Date());
    if (age < 0) add(B, 'bad', 'Bill date is in the future.');
    else if (age > 180) add(B, 'warn', `Bill date is ${age} days old — check the date.`);
  }
  const calc = billCalc(used);
  if (n(printed.total) > 0) {
    const diff = r2(n(printed.total) - calc.total);
    if (Math.abs(diff) <= 1.01) { out.totalsMatch = true; add(B, 'ok', `Lines add up to the bill total ${rs(printed.total)}.`); }
    else { out.totalsMatch = false; add(B, 'bad', `Bill total is ${rs(printed.total)} but the lines add up to ${rs(calc.total)} (difference ${rs(diff)}). A line is missing or misread.`); }
  }
  if (n(printed.tax) > 0 && Math.abs(n(printed.tax) - calc.tax) > 1.01) add(B, 'warn', `GST on the bill is ${rs(printed.tax)}, lines give ${rs(calc.tax)}.`);
  const myState = ctx.settings.stateCode;
  const theirState = supplier?.gstin ? supplier.gstin.slice(0, 2) : supplier?.stateCode;
  if (printed.taxType && myState && theirState) {
    const same = myState === theirState;
    if (same && printed.taxType === 'igst') add(B, 'bad', 'Supplier is in your state but charged IGST. It should be CGST + SGST — ask for a corrected bill, or the GST credit is at risk.');
    if (!same && printed.taxType === 'cgst_sgst') add(B, 'bad', 'Supplier is in another state but charged CGST + SGST. It should be IGST — ask for a corrected bill.');
  }

  // ---- Line level
  for (const l of used) {
    const I = (out.line[l.key] = []);
    const c = lineCalc(l);
    const p = pm[l.productId];
    if (!p) { add(I, 'bad', l.text ? `“${l.text}” is not matched to a product. Pick it, or quick-add it.` : 'Pick the product.'); out.linesOk = false; continue; }
    if (l.match === 'check' && l.text) add(I, 'warn', `Please check: “${l.text}” matched to ${p.name}.`);
    if (c.qty <= 0) add(I, 'bad', 'Quantity is missing.');
    if (c.rate <= 0) add(I, 'bad', 'Rate is missing.');
    if (!GST_SLABS.includes(c.gst)) add(I, 'bad', `GST ${c.gst}% is not a valid rate.`);
    else if (p.gst !== undefined && Number(p.gst) !== c.gst) add(I, 'warn', `Your product list says GST ${p.gst}%, this bill says ${c.gst}%. One of them is wrong.`);
    if (isCaseUnit(l.unit) && c.pack <= 1) add(I, 'warn', `Bill unit is “${l.unit}”. How many pieces in one? Set “Pcs/unit”.`);
    if (n(l.amount) > 0) {
      const a = n(l.amount);
      const fits = [c.taxable, c.total, c.gross].some(v => Math.abs(v - a) <= Math.max(1.01, a * 0.002));
      if (!fits) { add(I, 'bad', `Amount on the bill is ${rs(a)}, but qty × rate gives ${rs(c.taxable)} (${rs(c.total)} with GST).`); out.linesOk = false; }
    }

    const hist = (ctx.history[p.id] || []).filter(h => h.purchaseId !== editingId);
    const sameSup = hist.filter(h => h.supplierId === supplier?.id);
    const last = sameSup[0] || hist[0];
    if (last && last.landing > 0 && c.landing > 0) {
      const ch = (c.landing - last.landing) / last.landing;
      const who = last.supplierId === supplier?.id ? '' : ` from ${sm[last.supplierId]?.name || 'another supplier'}`;
      if (ch > 0.02 && c.landing - last.landing >= 0.25) add(I, 'warn', `Cost up ${pct(ch)}: ${rs(last.landing)} → ${rs(c.landing)} per piece since ${fmtDate(last.date)}${who}.`);
      else if (ch < -0.05) add(I, 'info', `Cost down ${pct(ch)}: ${rs(last.landing)} → ${rs(c.landing)} per piece.`);
    }
    const last3 = sameSup.slice(0, 3);
    if (last3.length >= 2 && last3.filter(h => h.free > 0 || h.disc > 0).length >= 2 && !c.free && !c.disc) {
      const h = last3.find(x => x.free > 0 || x.disc > 0);
      add(I, 'warn', `Last bills had a scheme (${schemeText(h)}). This bill has none — ask the supplier.`);
    }
    const since90 = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const others = hist.filter(h => h.supplierId !== supplier?.id && h.date >= since90 && h.landing > 0).sort((a, b) => a.landing - b.landing);
    if (others[0] && c.landing > 0 && others[0].landing < c.landing * 0.98 && c.landing - others[0].landing >= 0.25) {
      add(I, 'info', `Cheaper at ${sm[others[0].supplierId]?.name || 'another supplier'}: ${rs(others[0].landing)} per piece on ${fmtDate(others[0].date)} (you save ${rs((c.landing - others[0].landing) * c.pieces)} on this line).`);
    }

    const mrp = n(l.mrp);
    if (mrp > 0 && p.mrp && Math.abs(mrp - p.mrp) >= 0.5) add(I, 'info', `New MRP ${rs(mrp)} (was ${rs(p.mrp)}).`);
    if (mrp > 0 && p.price > mrp + 0.001) add(I, 'warn', `Your selling price ${rs(p.price)} is above this pack’s MRP ${rs(mrp)}. It is lowered to the MRP when you save.`);
    const sell = mrp > 0 && p.price > mrp ? mrp : p.price;
    if (sell > 0 && c.landingInc > 0) {
      const m = (sell - c.landingInc) / sell;
      if (m <= 0) add(I, 'bad', `Cost ${rs(c.landingInc)} with GST is above your selling price ${rs(sell)} — you will sell at a loss.`);
      else if (m < 0.05) add(I, 'warn', `Very thin margin: cost ${rs(c.landingInc)} with GST, selling at ${rs(sell)} (${(m * 100).toFixed(1)}%).`);
    }

    if (l.expiry) {
      const dl = daysLeft(l.expiry);
      if (dl < 0) add(I, 'bad', 'This batch is already expired. Do not accept it.');
      else {
        if (l.mfg) {
          const life = daysBetween(new Date(l.mfg), new Date(l.expiry));
          if (life > 0 && dl / life < 0.6) add(I, 'warn', `Only ${Math.round((dl / life) * 100)}% of the shelf life is left (${dl} days).`);
        }
        const d = ctx.daily[p.id] || 0;
        const onHand = Math.max(0, ctx.stock[p.id] || 0);
        if (d > 0) {
          const left = Math.round(onHand + c.pieces - d * dl);
          if (left > 0 && left >= c.pieces * 0.1) add(I, 'warn', `Expires in ${dl} days. At ~${r2(d)} sold a day, about ${Math.min(left, c.pieces)} of these ${c.pieces} will be unsold at expiry. Take fewer or ask for a return promise.`);
        } else if (dl <= 45) add(I, 'warn', `Expires in ${dl} days and this item has no sales in the last 30 days.`);
      }
    } else if (p.batchTracked !== false && !p.loose) add(I, 'info', 'Add the expiry date from the pack.');
  }
  if (!used.length) { add(B, 'bad', 'The bill has no lines.'); out.linesOk = false; }
  return out;
}

