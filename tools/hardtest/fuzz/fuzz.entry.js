// Fuzz test of the pure maths: bills, returns, offers, units, scale codes, GSTIN, search, GST tables.
import { computeBill, parseScaleBarcode, invoiceNumber } from '/home/claude/dataflow-retail/src/lib/billing.js';
import { applyOffers, offerErrors } from '/home/claude/dataflow-retail/src/lib/offers.js';
import { unitList, toBase, fromBase, priceFor, unitErrors, cleanUnits } from '/home/claude/dataflow-retail/src/lib/units.js';
import { validGSTIN, eanCheckDigit, validEAN, inr } from '/home/claude/dataflow-retail/src/lib/util.js';
import { smartSearch } from '/home/claude/dataflow-retail/src/lib/search.js';
import { buildReturn, returnLeft } from '/home/claude/dataflow-retail/src/lib/returns.js';
import { gstr1Data, setOff, lateFeeFor, interestFor } from '/home/claude/dataflow-retail/src/lib/gst.js';

let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = a => a[Math.floor(rnd() * a.length)];
const P = v => Math.round(v * 100);
const r3 = v => Math.round(v * 1000) / 1000;
const fails = {};
const bad = (k, d) => { fails[k] = (fails[k] || 0) + 1; if (fails[k] <= 2) console.log('FAIL', k, JSON.stringify(d).slice(0, 300)); };
const t0 = Date.now();

// ---- 1. Bills: 60,000 random bills
let nb = 0;
for (let n = 0; n < 60000; n++) {
  const lines = Array.from({ length: 1 + Math.floor(rnd() * 40) }, (_, i) => {
    const price = rnd() < 0.1 ? Math.round(rnd() * 400000) / 100 : rnd() < 0.2 ? Math.round(rnd() * 1e6) / 1e4 : Math.round(rnd() * 50000) / 100;
    const qty = rnd() < 0.3 ? r3(rnd() * 5) : 1 + Math.floor(rnd() * 12);
    return { productId: 'P' + i, name: 'x', gst: pick([0, 5, 18, 40]), qty, unitPrice: price, mrp: price * 1.1, cost: price * 0.8, lineDisc: rnd() < 0.2 ? Math.round(rnd() * price * qty * 50) / 100 : 0 };
  });
  const bd = rnd() < 0.2 ? [{ label: 'b', amount: Math.round(rnd() * 50000) / 100 }] : [];
  const inter = rnd() < 0.1;
  const b = computeBill(lines, bd, inter);
  nb++;
  const t = b.totals;
  const sumLines = b.lines.reduce((a, l) => a + P(l.total), 0);
  if (sumLines !== P(t.exact)) bad('lines ≠ exact', t);
  if (P(t.payable) % 100 !== 0) bad('payable not whole rupees', t.payable);
  if (Math.abs(P(t.payable) - P(t.exact)) > 50) bad('round off > 50 paise', t);
  for (const l of b.lines) {
    if (P(l.taxable) + P(l.cgst) + P(l.sgst) + P(l.igst) !== P(l.total)) bad('tax split', l);
    if (l.total < 0 || l.taxable < 0 || Number.isNaN(l.total)) bad('negative or NaN line', l);
    if (inter && (l.cgst || l.sgst)) bad('CGST on inter-state', l);
    if (!inter && Math.abs(P(l.cgst) - P(l.sgst)) > 1) bad('CGST ≠ SGST', l);
    if (l.gst === 0 && (l.cgst || l.sgst || l.igst)) bad('tax on 0%', l);
  }
  if (P(t.billDisc) > lines.reduce((a, l) => a + P(l.unitPrice * l.qty), 0) + 1) bad('bill discount > bill', t);
}

// ---- 2. Returns: random partial returns until everything is back
let nr = 0;
for (let n = 0; n < 8000; n++) {
  const lines = Array.from({ length: 1 + Math.floor(rnd() * 8) }, (_, i) => ({ productId: 'P' + (rnd() < 0.2 ? 0 : i), name: 'x', gst: pick([0, 5, 18, 40]), qty: rnd() < 0.3 ? r3(0.1 + rnd() * 3) : 1 + Math.floor(rnd() * 6), unitPrice: Math.round(rnd() * 90000) / 100 + 1, mrp: 999, cost: 1,
    batches: [{ batchId: 'B1', qty: 0 }] }));
  lines.forEach(l => { const a = r3(l.qty * rnd()); l.batches = a > 0 && a < l.qty ? [{ batchId: 'B1', batchNo: 'b1', qty: a }, { batchId: 'B2', batchNo: 'b2', qty: r3(l.qty - a) }] : [{ batchId: 'B1', batchNo: 'b1', qty: l.qty }]; });
  const bill = computeBill(lines, rnd() < 0.3 ? [{ label: 'p', amount: 20 }] : [], rnd() < 0.1);
  const sale = { no: 'X', storeId: 'S1', lines: bill.lines, totals: bill.totals, pointsEarned: Math.floor(rnd() * 100), b2b: null };
  const rets = [];
  for (let k = 0; k < 12; k++) {
    const done = fold(sale, rets);
    const left = returnLeft(sale, done);
    if (left.every(v => v <= 1e-9)) break;
    const want = left.map(v => (rnd() < 0.5 ? (rnd() < 0.5 ? v : r3(v * rnd())) : 0));
    const r = buildReturn(sale, want, done);
    if (!r.lines.length) continue;
    nr++;
    rets.push(r);
    for (const l of r.lines) {
      if (P(l.taxable) + P(l.cgst) + P(l.sgst) + P(l.igst) !== P(l.total)) bad('return tax split', l);
      const bq = r3(l.batches.reduce((a, b) => a + b.qty, 0));
      if (Math.abs(bq - l.qty) > 0.001) bad('return batches ≠ qty', { bq, q: l.qty });
    }
  }
  // finish: return everything left
  const done = fold(sale, rets);
  const left = returnLeft(sale, done);
  if (left.some(v => v > 1e-9)) { const r = buildReturn(sale, left, done); if (r.lines.length) rets.push(r); }
  const tot = k => rets.reduce((a, r) => a + P(r.totals[k]), 0);
  const all = fold(sale, rets);
  if (returnLeft(sale, all).some(v => v > 1e-9)) bad('not all returned', returnLeft(sale, all));
  if (tot('payable') !== P(sale.totals.payable)) bad('all refunds ≠ bill', { refunds: tot('payable') / 100, bill: sale.totals.payable });
  for (const k of ['taxable', 'cgst', 'sgst', 'igst']) if (tot(k) !== P(sale.totals[k])) bad(`all returns ${k} ≠ bill`, { k, back: tot(k) / 100, bill: sale.totals[k] });
  const pts = rets.reduce((a, r) => a + r.pointsBack, 0);
  if (pts !== sale.pointsEarned) bad('points back ≠ earned', { pts, earned: sale.pointsEarned });
  for (const [bid, q] of Object.entries(all.batchTot)) { const sold = sale.lines.reduce((a, l) => a + l.batches.filter(b => b.batchId === bid).reduce((x, b) => x + b.qty, 0), 0); if (q > sold + 0.001) bad('more back to a batch than sold from it', { bid, q, sold }); }
}
function fold(sale, rets) {
  // the same shape returnedSoFar() builds from saved returns
  const qty = sale.lines.map(() => 0), amt = sale.lines.map(() => ({ gross: 0, lineDisc: 0, billDisc: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 })), batch = {}, batchTot = {};
  let points = 0, refund = 0;
  for (const r of rets) {
    points += r.pointsBack; refund = Math.round((refund + r.totals.payable) * 100) / 100;
    for (const l of r.lines) { const i = l.origLine; qty[i] = r3(qty[i] + l.qty); for (const k of Object.keys(amt[i])) amt[i][k] = Math.round((amt[i][k] + (l[k] || 0)) * 100) / 100; for (const b of l.batches) { batch[`${i}|${b.batchId}`] = r3((batch[`${i}|${b.batchId}`] || 0) + b.qty); batchTot[b.batchId] = r3((batchTot[b.batchId] || 0) + b.qty); } }
  }
  return { qty, amt, batch, batchTot, points, refund };
}

// ---- 3. Offers: never a discount above the line, never below cost (without override), junk offers ignored
for (let n = 0; n < 20000; n++) {
  const lines = Array.from({ length: 1 + Math.floor(rnd() * 10) }, (_, i) => ({ key: 'k' + i, productId: 'P' + Math.floor(rnd() * 5), category: pick(['A', 'B']), qty: 1 + Math.floor(rnd() * 6), unitPrice: 10 + Math.round(rnd() * 500), cost: rnd() < 0.5 ? 5 + Math.round(rnd() * 300) : 0, markdownDisc: 0 }));
  const offers = Array.from({ length: Math.floor(rnd() * 6) }, () => { const ty = pick(['qtySlab', 'bxgy', 'category', 'combo', 'billBuster']); return { type: ty, name: rnd() < 0.9 ? 'o' : '', active: true, productId: 'P' + Math.floor(rnd() * 5), slabs: [{ minQty: pick([2, 3, '', 0]), price: pick(['', 0, 5, 50, 300]) }], buy: pick([2, '', 0, undefined]), get: pick([1, '', undefined]), pct: pick([100, 50, '', undefined, 150]), category: pick(['A', 'B', '']), productIds: [pick(['P0', 'P1', '']), pick(['P1', 'P2', 'P1'])], off: pick([10, '', 0, 5000]), minAmount: pick([100, '', 0, 3000]) }; });
  const r = applyOffers(lines, offers);
  for (const l of lines) {
    const d = r.perLine[l.key].disc;
    if (!Number.isFinite(d) || d < 0) bad('offer NaN/negative', d);
    if (d > l.unitPrice * l.qty + 0.001) bad('offer above line value', { d, v: l.unitPrice * l.qty });
    if (l.cost > 0 && d > Math.max(0, (l.unitPrice - l.cost) * l.qty) + 0.01) bad('offer below cost', { d, l });
  }
  for (const b of r.billDiscounts) if (!(b.amount > 0)) bad('bill offer with no amount', b);
  void offerErrors;
}

// ---- 4. Units: conversions go there and back; prices per unit consistent
for (let n = 0; n < 20000; n++) {
  const names = pick([['Bag', 'Kg', 'Gram'], ['Case', 'Piece', ''], ['Box', 'Pack', 'Piece'], ['Kg', 'Gram', '']]);
  const p = { id: 'x', price: 1 + Math.round(rnd() * 20000) / 100, mrp: 999999, uom: 'PCS', units: { names, c12: pick([10, 12, 25, 30, 50]), c23: names[2] ? pick([1000, 10, 12]) : '', base: Math.floor(rnd() * (names[2] ? 3 : 2)) } };
  const cu = cleanUnits(p); const q = { ...p, ...cu };
  if (unitErrors(q).length) continue;
  for (const u of unitList(q)) {
    const v = Math.round(rnd() * 1000) / 10;
    const back = fromBase(q, u.i, toBase(q, u.i, v));
    if (Math.abs(back - v) > 1e-6 * Math.max(1, v)) bad('unit round trip', { u, v, back });
    const pr = priceFor(q, u.i, 'retail');
    if (!(pr > 0) || !Number.isFinite(pr)) bad('unit price', { u, pr });
  }
}

// ---- 5. Scale barcodes, EAN, GSTIN, invoice numbers
for (let n = 0; n < 50000; n++) {
  const s = String(Math.floor(rnd() * 1e13)).padStart(13, '0');
  const sc = parseScaleBarcode(s);
  if (sc && !(sc.plu.length === 5 && sc.grams >= 0)) bad('scale code', s);
  const e12 = s.slice(0, 12); if (!validEAN(e12 + eanCheckDigit(e12))) bad('EAN check digit', e12);
  validGSTIN(s + 'ZZ');
  const no = invoiceNumber(pick(['S1', 'S12', 'STORE9']), pick(['T1', 'T12', 'P7QX']), '2627', Math.floor(rnd() * 1e7));
  if (no.length > 16 || !/^[A-Za-z0-9/-]+$/.test(no)) bad('invoice no', no);
}

// ---- 6. Search never breaks on odd typing
const prods = Array.from({ length: 3000 }, (_, i) => ({ id: 'SKU' + i, name: pick(['Atta', 'Rice', 'Dal', 'Ghee', 'Parle-G', 'Amul Butter', 'ଚିନି', 'चीनी']) + ' ' + i + 'g', brand: 'B', category: 'C', barcode: String(890000000000 + i), price: 10 }));
const junk = ['', ' ', '(', '[[', '\\', '*', '.*', '😀😀', 'a'.repeat(5000), '%$#@!', '0000000000000', 'atta(', 'rice\n', 'ଚି', 'ची', '?', '+++'];
const ts = Date.now();
for (const q of junk) { try { const r = smartSearch(q, prods, 8); if (!Array.isArray(r)) bad('search result', q); } catch (e) { bad('search threw', q + ' ' + e.message); } }
const searchMs = Date.now() - ts;

// ---- 7. GST maths
for (let n = 0; n < 20000; n++) {
  const out = { igst: Math.round(rnd() * 1e6) / 100, cgst: Math.round(rnd() * 1e6) / 100, sgst: Math.round(rnd() * 1e6) / 100 };
  const itc = { igst: Math.round(rnd() * 1e6) / 100, cgst: Math.round(rnd() * 1e6) / 100, sgst: Math.round(rnd() * 1e6) / 100 };
  const so = setOff({ out, itc, opening: { igst: 0, cgst: 0, sgst: 0 } });
  const cash = so.cash || {};
  if (Object.values(cash).some(v => v < -0.001)) bad('negative cash', cash);
  const paid = ['igst', 'cgst', 'sgst'].reduce((a, k) => a + (cash[k] || 0), 0);
  const owed = Math.max(0, out.igst + out.cgst + out.sgst - (itc.igst + itc.cgst + itc.sgst));
  if (paid + 0.05 < owed) bad('set-off pays less than owed', { paid, owed });
  const f = lateFeeFor({ days: Math.floor(rnd() * 400), nil: rnd() < 0.3, aato: rnd() * 1e8 }).fee;
  if (!(f >= 0) || f > 10000 * 2 + 1) bad('late fee', f);
  if (interestFor({ cash: Math.max(0, paid), days: Math.floor(rnd() * 100) }) < 0) bad('interest', paid);
}
void gstr1Data; void inr;

console.log(JSON.stringify({ bills: nb, returns: nr, ms: Date.now() - t0, searchJunkMs: searchMs }));
console.log(Object.keys(fails).length ? 'FUZZ: FAIL ' + JSON.stringify(fails) : 'FUZZ: PASS');
