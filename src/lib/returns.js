// Returns (credit notes). A return is worked out line by line from the original bill, so:
// - the same item on two lines (two weighings of tomatoes) is returned from the right line;
// - stock goes back to the batches it was sold from;
// - all the returns of a bill together never refund more money, tax or quantity than the bill had;
// - a business (GSTIN) bill's return stays a business credit note in GSTR-1 (table 9B), not table 7;
// - loyalty points earned on the returned part are taken back.
import { db } from '../db.js';
import { r2 } from './util.js';
import { saveSale, withLock } from './sales.js';

const r3 = v => Math.round((Number(v) || 0) * 1000) / 1000;
const P = v => Math.round((Number(v) || 0) * 100);           // paise
const K = ['gross', 'lineDisc', 'billDisc', 'taxable', 'cgst', 'sgst', 'igst', 'total'];

/** What earlier returns of this bill already took back: per line (qty and money), per batch, points, refund. */
export async function returnedSoFar(sale) {
  // Bill numbers never repeat (store + counter + year), so every return of this bill counts — also one made at another branch.
  const earlier = (await db.sales.where('origNo').equals(sale.no).toArray()).filter(x => x.type === 'return');
  const qty = sale.lines.map(() => 0);
  const amt = sale.lines.map(() => Object.fromEntries(K.map(k => [k, 0])));
  const batch = {};                                            // `${line}|${batchId}` → qty given back
  let points = 0, refund = 0;
  for (const r of earlier) {
    points += Math.max(0, -(r.pointsEarned || 0));
    refund = r2(refund + (r.totals?.payable || 0));
    for (const l of r.lines) {
      let i = Number.isInteger(l.origLine) && sale.lines[l.origLine]?.productId === l.productId ? l.origLine : -1;
      if (i < 0) {
        // Returns saved before lines were tracked: fill this product's lines in order.
        i = sale.lines.findIndex((sl, j) => sl.productId === l.productId && qty[j] + 1e-9 < sl.qty);
        if (i < 0) i = sale.lines.findIndex(sl => sl.productId === l.productId);
        if (i < 0) continue;
      }
      qty[i] = r3(qty[i] + l.qty);
      K.forEach(k => { amt[i][k] = r2(amt[i][k] + (l[k] || 0)); });
      for (const b of l.batches || []) { const key = `${i}|${b.batchId}`; batch[key] = r3((batch[key] || 0) + b.qty); }
    }
  }
  return { qty, amt, batch, points, refund, count: earlier.length };
}

/** How much of each line can still be returned. */
export const returnLeft = (sale, done) => sale.lines.map((l, i) => Math.max(0, r3(l.qty - (done.qty[i] || 0))));

/**
 * The return bill for `want` (array: quantity per original line, in the line's own base unit).
 * Returns { lines, billDiscounts, totals, pointsBack } — the same shape as computeBill.
 */
export function buildReturn(sale, want, done) {
  const left = returnLeft(sale, done);
  const lines = [];
  sale.lines.forEach((l, i) => {
    const q = Math.min(r3(want[i] || 0), left[i]);
    if (!(q > 0)) return;
    const rest = Math.abs(q - left[i]) < 1e-9;                 // the last of this line: give back exactly what is left
    const f = q / l.qty;
    const v = {};
    for (const k of ['gross', 'lineDisc', 'billDisc', 'taxable', 'total']) v[k] = rest ? r2((l[k] || 0) - done.amt[i][k]) : r2((l[k] || 0) * f);
    // Tax = total − taxable, split the way the bill split it (so the paise always add up).
    const taxP = P(v.total) - P(v.taxable);
    if (rest) { v.igst = r2((l.igst || 0) - done.amt[i].igst); v.cgst = r2((l.cgst || 0) - done.amt[i].cgst); v.sgst = r2(v.total - v.taxable - v.igst - v.cgst); }
    else if ((l.igst || 0) > 0 && !(l.cgst || 0)) { v.igst = taxP / 100; v.cgst = 0; v.sgst = 0; }
    else { const c = Math.round(taxP / 2); v.cgst = c / 100; v.sgst = (taxP - c) / 100; v.igst = 0; }
    // Stock goes back to the batches this line was sold from (not already given back).
    let need = q; const batches = [];
    for (const b of l.batches || []) {
      if (need <= 1e-9) break;
      const room = Math.max(0, r3(b.qty - (done.batch[`${i}|${b.batchId}`] || 0)));
      const t = Math.min(need, room);
      if (t > 0) { batches.push({ batchId: b.batchId || null, batchNo: b.batchNo, qty: r3(t) }); need = r3(need - t); }
    }
    if (need > 1e-9) { const b = (l.batches || []).at(-1) || {}; batches.push({ batchId: b.batchId || null, batchNo: b.batchNo, qty: r3(need) }); }
    lines.push({ ...l, ...v, qty: q, origLine: i, batches });
  });
  const T = k => r2(lines.reduce((a, l) => a + P(l[k]) / 100, 0));
  const exact = T('total');
  const allBack = lines.length && sale.lines.every((l, i) => left[i] <= 1e-9 || lines.some(x => x.origLine === i && Math.abs(x.qty - left[i]) < 1e-9));
  const maxRefund = r2((sale.totals?.payable || 0) - done.refund);
  let payable = allBack ? maxRefund : Math.min(Math.round(exact), maxRefund);
  payable = Math.max(0, payable);
  // Points earned on what comes back are taken back (in step with the money).
  const backTotal = r2(sale.lines.reduce((a, l, i) => a + done.amt[i].total, 0) + exact);
  const fullTotal = sale.totals?.exact || r2(sale.lines.reduce((a, l) => a + (l.total || 0), 0));
  const earned = sale.pointsEarned || 0;
  const pointsBack = earned > 0 && fullTotal > 0 ? Math.max(0, Math.min(earned, Math.floor((earned * backTotal) / fullTotal + 1e-9)) - done.points) : 0;
  return {
    lines, billDiscounts: [], pointsBack, doneCount: done.count,          // how many returns this was worked out after
    totals: { gross: T('gross'), lineDisc: T('lineDisc'), billDisc: T('billDisc'), taxable: T('taxable'), cgst: T('cgst'), sgst: T('sgst'), igst: T('igst'), exact, roundOff: r2(payable - exact), payable, mrpTotal: 0, savings: 0, items: lines.length, qty: r3(lines.reduce((a, l) => a + l.qty, 0)) },
  };
}

/** Save the return. Refund to customer credit (udhaar) only when the bill had a customer. */
export function saveReturn(args) {
  // One return at a time, checked again just before saving: two returns of the same bill at the same
  // moment (two windows, a double press) can never give back more than the bill had.
  return withLock('return', () => saveReturnNow(args));
}
async function saveReturnNow({ sale, bill, mode = 'cash', user, shiftId, storeId }) {
  const customer = sale.customerId ? await db.customers.get(sale.customerId) : null;
  if (mode === 'credit' && !customer) throw new Error('This bill has no customer, so the refund cannot go to customer credit.');
  const done = await returnedSoFar(sale);
  const left = returnLeft(sale, done);
  if ((bill.doneCount != null && done.count !== bill.doneCount) || bill.lines.some(l => l.qty > (left[l.origLine] ?? 0) + 1e-6)) {
    throw new Error('Part of this bill was returned a moment ago. Open the bill again.');
  }
  return saveSale({
    bill, payments: [{ mode, amount: bill.totals.payable }], customer, user, shiftId, storeId, type: 'return', origNo: sale.no,
    b2b: sale.b2b?.gstin ? { gstin: sale.b2b.gstin, inter: !!sale.b2b.inter, ...(sale.b2b.name ? { name: sale.b2b.name } : {}) } : null,
    priceMode: sale.priceMode || 'retail', composition: !!sale.composition, pointsBack: bill.pointsBack || 0,
  });
}
