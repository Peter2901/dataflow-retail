// GST engine. Shelf prices include GST (as in Indian retail), so tax is taken out of the price.
// All maths in paise; each line rounds half-up; the bill total rounds to the nearest rupee.
import { toPaise, fromPaise } from './util.js';

export const GST_SLABS = [0, 5, 18, 40];

/**
 * lines: [{ productId, name, hsn, gst, qty, unitPrice, lineDisc, mrp, cost, uom }]
 * billDiscounts: [{ label, amount }]  (bill-busters, points) — spread over lines before tax
 */
export function computeBill(lines, billDiscounts = [], interState = false) {
  const work = lines.map(l => {
    // A price per Kg worked out from a Bag price (₹4100 ÷ 30) has more than 2 decimals; do not round it to a paisa
    // before multiplying, or 1 Bag would come to ₹4100.10. Normal 2-decimal prices take the old path (same result as before).
    const cents = Number(l.unitPrice) * 100;
    const gross = Math.abs(cents - Math.round(cents)) < 1e-6 ? Math.round(toPaise(l.unitPrice) * Number(l.qty)) : Math.round(cents * Number(l.qty));
    const disc = Math.min(gross, toPaise(l.lineDisc || 0));
    return { ...l, _gross: gross, _afterLine: gross - disc, _lineDisc: disc };
  });
  const base = work.reduce((a, l) => a + l._afterLine, 0);
  const billDisc = Math.min(base, billDiscounts.reduce((a, d) => a + toPaise(d.amount), 0));
  let allocated = 0;
  work.forEach((l, i) => {
    let share = base ? Math.floor((billDisc * l._afterLine) / base) : 0;
    if (i === work.length - 1) share = billDisc - allocated;
    allocated += share;
    l._billDisc = share;
  });
  const out = work.map(l => {
    const net = l._afterLine - l._billDisc;
    const rate = Number(l.gst) || 0;
    const taxable = Math.round((net * 100) / (100 + rate));
    const tax = net - taxable;
    let cgst = 0, sgst = 0, igst = 0;
    if (interState) igst = tax; else { cgst = Math.round(tax / 2); sgst = tax - cgst; }
    return {
      productId: l.productId, name: l.name, hsn: l.hsn, gst: rate, qty: Number(l.qty), uom: l.uom,
      mrp: l.mrp, unitPrice: l.unitPrice, cost: l.cost || 0, batches: l.batches || [], offerNote: l.offerNote || '',
      ...(l.unitName ? { unitName: l.unitName, unitFactor: l.unitFactor } : {}),
      gross: fromPaise(l._gross), lineDisc: fromPaise(l._lineDisc), billDisc: fromPaise(l._billDisc),
      taxable: fromPaise(taxable), cgst: fromPaise(cgst), sgst: fromPaise(sgst), igst: fromPaise(igst),
      total: fromPaise(net),
    };
  });
  const tot = k => fromPaise(out.reduce((a, l) => a + toPaise(l[k]), 0));
  const exact = out.reduce((a, l) => a + toPaise(l.total), 0);
  const rounded = Math.round(exact / 100) * 100;
  const mrpTotal = fromPaise(out.reduce((a, l) => a + Math.round(toPaise(l.mrp || l.unitPrice) * l.qty), 0));
  return {
    lines: out,
    totals: {
      gross: tot('gross'), lineDisc: tot('lineDisc'), billDisc: fromPaise(billDisc),
      taxable: tot('taxable'), cgst: tot('cgst'), sgst: tot('sgst'), igst: tot('igst'),
      exact: fromPaise(exact), roundOff: fromPaise(rounded - exact), payable: fromPaise(rounded),
      mrpTotal, savings: fromPaise(Math.max(0, toPaise(mrpTotal) - rounded)),
      items: out.length, qty: out.reduce((a, l) => a + l.qty, 0),
    },
    billDiscounts,
  };
}

// Rule 46: invoice number, max 16 characters, unique per financial year, only letters, digits, - and /.
export function invoiceNumber(storeCode, terminal, fyShort, seq) {
  const no = `${storeCode}${terminal}/${fyShort}/${String(seq).padStart(6, '0')}`;
  return no.slice(0, 16);
}

// Weighed-item labels from the scale: EAN-13 starting 20–29 = prefix(2) + PLU(5) + weight in grams(5) + check.
export function parseScaleBarcode(code) {
  const s = String(code);
  if (!/^2[0-9]\d{11}$/.test(s)) return null;
  return { plu: s.slice(2, 7), grams: Number(s.slice(7, 12)) };
}
