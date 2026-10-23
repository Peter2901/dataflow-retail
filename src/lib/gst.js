// GST Saathi engine — plain code only. Builds the month's GSTR-1 tables and file, the GSTR-3B
// summary, checks before filing, the GSTR-2B match, due dates and the rule book.
// AI is never used here: it never files a return and never sets a GST rate.
import { r2, sum, groupBy, localISO, validGSTIN } from './util.js';

// ---------- Rule book (the person approves every change) ----------
// Category I states file quarterly GSTR-3B by the 22nd, Category II by the 24th.
const CAT1 = ['22', '23', '24', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37', '97'];
export const DEFAULT_RULES = {
  version: '2026.10.2',
  updated: '2026-10-23',
  slabs: [0, 5, 18, 40],
  hsnMinDigits: 4,                 // up to ₹5 crore turnover; 6 above
  due: {
    gstr1Monthly: 11, iffQrmp: 13, gstr1Qrmp: 13,
    gstr3bMonthly: 20, gstr3bQrmpCat1: 22, gstr3bQrmpCat2: 24, pmt06: 25,
    gstr9: '12-31',
  },
  notes: [],                       // e.g. "Due date for Sep 2026 GSTR-3B extended to 25 Oct (Notification …)"
  extensions: {},                  // { 'gstr3b:2026-09': '2026-10-25' }
  // Late fee per day (CGST + SGST together) and the cap by last year's turnover (Notifications 19/2021, 20/2021).
  lateFee: { perDay: 50, perDayNil: 20, capNil: 500, caps: [[15000000, 2000], [50000000, 5000], [null, 10000]] },
  interestPct: 18,                 // section 50(1): on tax paid late in cash, per day
  limits: {
    hsn6Above: 50000000,           // turnover above ₹5 crore → 6-digit HSN, B2C HSN needed too
    einvoiceAbove: 50000000,       // e-invoice (IRN) for business bills once turnover crossed ₹5 crore in any year since 2017-18
    gstr9Above: 20000000,          // GSTR-9 optional up to ₹2 crore
    gstr9cAbove: 50000000,         // GSTR-9C (reconciliation) above ₹5 crore
    qrmpUpTo: 50000000,            // quarterly (QRMP) allowed up to ₹5 crore
    compositionUpTo: 15000000,     // composition for traders up to ₹1.5 crore (₹75 lakh in special category states)
  },
  rule37Days: 180,                 // pay the supplier within 180 days or give the credit back (Rule 37)
  itcLastDate: '11-30',            // section 16(4): credit for a year can be taken until 30 Nov after it
  composition: { ratePct: 1, cmp08Day: 18, gstr4: '06-30' },
};
export const RULES_URL = 'https://peter2901.github.io/dataflow-retail/gst-rules.json';

/** What changed between the saved rule book and a new one, in plain words. */
export function rulesDiff(cur, next) {
  const out = [];
  const a = cur || DEFAULT_RULES;
  if (String(a.slabs) !== String(next.slabs)) out.push({ important: true, text: `GST rates change from ${a.slabs.join(', ')}% to ${next.slabs.join(', ')}%` });
  if (a.hsnMinDigits !== next.hsnMinDigits) out.push({ important: true, text: `HSN digits needed: ${a.hsnMinDigits} → ${next.hsnMinDigits}` });
  for (const k of Object.keys(next.due || {})) if (String(a.due?.[k]) !== String(next.due[k])) out.push({ text: `Due date rule "${k}": ${a.due?.[k] ?? '—'} → ${next.due[k]}` });
  for (const [k, v] of Object.entries(next.extensions || {})) if (a.extensions?.[k] !== v) out.push({ text: `Extension: ${k} now due ${v}` });
  if (JSON.stringify(a.lateFee || null) !== JSON.stringify(next.lateFee || null) && next.lateFee) out.push({ text: `Late fee rules: ₹${next.lateFee.perDay}/day (nil ₹${next.lateFee.perDayNil}/day)` });
  if ((a.interestPct ?? 18) !== (next.interestPct ?? 18)) out.push({ important: true, text: `Interest on late tax: ${a.interestPct ?? 18}% → ${next.interestPct}% a year` });
  for (const [k, v] of Object.entries(next.limits || {})) if ((a.limits || {})[k] !== v) out.push({ text: `Limit "${k}": ₹${Number((a.limits || {})[k] || 0).toLocaleString('en-IN')} → ₹${Number(v).toLocaleString('en-IN')}` });
  for (const n of next.notes || []) if (!(a.notes || []).includes(n)) out.push({ text: n });
  return out;
}

// ---------- Periods ----------
export const monthKey = d => localISO(d).slice(0, 7);                  // '2026-09'
export function monthRange(key) {
  const [y, m] = key.split('-').map(Number);
  return { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 0, 23, 59, 59, 999).getTime(), y, m };
}
/** The months a return covers: a quarter for quarterly filers in the quarter's last month. */
export function periodFor(key, qrmp) {
  const { y, m } = monthRange(key);
  if (!qrmp || m % 3 !== 0) return { keys: [key], kind: qrmp ? 'iff' : 'month' };
  const keys = [m - 2, m - 1, m].map(x => `${y}-${String(x).padStart(2, '0')}`);
  return { keys, kind: 'quarter' };
}
export const monthLabel = key => { const { y, m } = monthRange(key); return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }); };
const isQuarterEnd = m => m % 3 === 0;
const ymd = (y, m, d) => localISO(new Date(y, m - 1, d));

/** Due dates for the return of month `key`. qrmp = quarterly filer. */
export function dueDates(key, { qrmp = false, composition = false, stateCode = '', rules = DEFAULT_RULES } = {}) {
  const { y, m } = monthRange(key);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const D = rules.due, ext = rules.extensions || {};
  const pick = (id, date) => ext[`${id}:${key}`] || date;
  const list = [];
  if (composition) {
    // Composition: CMP-08 (pay tax) once a quarter, GSTR-4 once a year.
    const C = rules.composition || DEFAULT_RULES.composition;
    if (isQuarterEnd(m)) list.push({ id: 'cmp08', label: 'CMP-08 (pay the quarter’s tax)', date: pick('cmp08', ymd(ny, nm, C.cmp08Day)) });
    if (m === 3) { const [mm, dd] = C.gstr4.split('-').map(Number); list.push({ id: 'gstr4', label: `GSTR-4 annual return for FY ${y - 1}-${String(y).slice(2)}`, date: ymd(y, mm, dd) }); }
    return list;
  }
  if (!qrmp) {
    list.push({ id: 'gstr1', label: 'GSTR-1 (sales)', date: pick('gstr1', ymd(ny, nm, D.gstr1Monthly)) });
    list.push({ id: 'gstr3b', label: 'GSTR-3B (pay tax)', date: pick('gstr3b', ymd(ny, nm, D.gstr3bMonthly)) });
  } else if (!isQuarterEnd(m)) {
    list.push({ id: 'iff', label: 'IFF — business (B2B) bills, optional', date: pick('iff', ymd(ny, nm, D.iffQrmp)) });
    list.push({ id: 'pmt06', label: 'PMT-06 (pay this month’s tax)', date: pick('pmt06', ymd(ny, nm, D.pmt06)) });
  } else {
    const cat1 = CAT1.includes(String(stateCode).padStart(2, '0'));
    list.push({ id: 'gstr1', label: 'GSTR-1 for the quarter', date: pick('gstr1', ymd(ny, nm, D.gstr1Qrmp)) });
    list.push({ id: 'gstr3b', label: 'GSTR-3B for the quarter', date: pick('gstr3b', ymd(ny, nm, cat1 ? D.gstr3bQrmpCat1 : D.gstr3bQrmpCat2)) });
  }
  if (m === 3) { const [mm, dd] = D.gstr9.split('-').map(Number); list.push({ id: 'gstr9', label: `GSTR-9 annual return for FY ${y - 1}-${String(y).slice(2)}`, date: ymd(y, mm, dd) }); }
  return list;
}
export const daysTo = date => Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);

// ---------- GSTR-1 tables ----------
const sg = s => (s.type === 'return' ? -1 : 1);
const uqc = l => (l.uom === 'KG' ? 'KGS' : l.uom === 'L' || l.uom === 'LTR' ? 'LTR' : 'NOS');
const ddmmyyyy = ts => { const d = new Date(ts); return `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`; };
const rateRows = lines => Object.entries(groupBy(lines, l => String(l.gst))).map(([rt, ls]) => ({
  rt: Number(rt), txval: r2(sum(ls, l => l.taxable)), iamt: r2(sum(ls, l => l.igst || 0)), camt: r2(sum(ls, l => l.cgst || 0)), samt: r2(sum(ls, l => l.sgst || 0)),
}));
const hsnRows = lines => Object.entries(groupBy(lines, l => `${l.hsn || ''}|${l.gst}|${uqc(l)}`)).map(([k, ls]) => {
  const [hsn, rt, u] = k.split('|');
  return { hsn, rt: Number(rt), uqc: u, desc: ls[0].name || '', qty: r2(sum(ls, l => l.sg * l.qty)), txval: r2(sum(ls, l => l.sg * l.taxable)),
    iamt: r2(sum(ls, l => l.sg * (l.igst || 0))), camt: r2(sum(ls, l => l.sg * (l.cgst || 0))), samt: r2(sum(ls, l => l.sg * (l.sgst || 0))) };
}).sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rt - b.rt);

export function gstr1Data(sales, settings) {
  const home = String(settings.stateCode || '').padStart(2, '0');
  const isB2B = s => !!s.b2b?.gstin;
  const sold = sales.filter(s => s.type === 'sale');
  const b2b = sold.filter(isB2B).map(s => ({ no: s.no, ts: s.ts, gstin: s.b2b.gstin.toUpperCase(), name: s.b2b.name || '', pos: s.b2b.gstin.slice(0, 2), value: s.totals.payable, items: rateRows(s.lines), taxable: s.totals.taxable }));
  const cdnr = sales.filter(s => s.type === 'return' && isB2B(s)).map(s => ({ no: s.no, ts: s.ts, against: s.origNo, gstin: s.b2b.gstin.toUpperCase(), pos: s.b2b.gstin.slice(0, 2), value: s.totals.payable, items: rateRows(s.lines), taxable: s.totals.taxable }));
  // Shop sales to people without GSTIN (and their returns) go in Table 7, net, by rate and state.
  const b2cLines = sales.filter(s => !isB2B(s)).flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s), pos: home })));
  const b2cs = Object.entries(groupBy(b2cLines.filter(l => l.gst > 0), l => `${l.pos}|${l.gst}`)).map(([k, ls]) => ({ pos: k.split('|')[0], rt: Number(k.split('|')[1]),
    txval: r2(sum(ls, l => l.sg * l.taxable)), iamt: r2(sum(ls, l => l.sg * (l.igst || 0))), camt: r2(sum(ls, l => l.sg * (l.cgst || 0))), samt: r2(sum(ls, l => l.sg * (l.sgst || 0))) })).filter(r => r.txval !== 0).sort((a, b) => a.rt - b.rt);
  // Table 8: nil-rated / exempt supplies.
  const nilLines = sales.flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s), b2b: isB2B(s) }))).filter(l => l.gst === 0);
  const nil = { b2b: r2(sum(nilLines.filter(l => l.b2b), l => l.sg * l.taxable)), b2c: r2(sum(nilLines.filter(l => !l.b2b), l => l.sg * l.taxable)) };
  // Table 12 is split into B2B and B2C.
  const lines = s => s.lines.map(l => ({ ...l, sg: sg(s) }));
  const hsnB2B = hsnRows(sales.filter(isB2B).flatMap(lines));
  const hsnB2C = hsnRows(sales.filter(s => !isB2B(s)).flatMap(lines));
  // Table 13: each counter is its own invoice series.
  const series = (list, label) => Object.entries(groupBy(list, s => String(s.no).replace(/\d+$/, ''))).map(([pre, ss]) => {
    const nos = ss.map(s => Number(String(s.no).match(/(\d+)$/)?.[1] || 0)).sort((a, b) => a - b);
    const sorted = [...ss].sort((a, b) => a.ts - b.ts);
    const missing = nos.length ? (nos[nos.length - 1] - nos[0] + 1) - new Set(nos).size : 0;
    return { kind: label, prefix: pre, from: sorted[0].no, to: sorted[sorted.length - 1].no, total: ss.length, cancel: 0, missing };
  });
  const docs = [...series(sold, 'Invoices'), ...series(sales.filter(s => s.type === 'return'), 'Credit notes')];
  return { b2b, cdnr, b2cs, nil, hsnB2B, hsnB2C, docs };
}

// The portal's GSTR-1 JSON. Field names follow the GST offline tool format; if the portal ever
// changes them, only this function needs a change. Always check the portal's preview before filing.
export function gstr1Json(d, settings, key) {
  const { y, m } = monthRange(key);
  const itm = items => items.map((i, n) => ({ num: n + 1, itm_det: { rt: i.rt, txval: i.txval, iamt: i.iamt, camt: i.camt, samt: i.samt, csamt: 0 } }));
  const home = String(settings.stateCode || '').padStart(2, '0');
  const byParty = list => Object.entries(groupBy(list, x => x.gstin)).map(([ctin, xs]) => ({ ctin, xs }));
  const hsn = rows => rows.map((h, n) => ({ num: n + 1, hsn_sc: h.hsn, desc: h.desc.slice(0, 30), uqc: h.uqc, qty: h.qty, rt: h.rt, txval: h.txval, iamt: h.iamt, camt: h.camt, samt: h.samt, csamt: 0 }));
  const out = {
    gstin: (settings.gstin || '').toUpperCase(), fp: `${String(m).padStart(2, '0')}${y}`, version: 'GST3.2', hash: 'hash',
    b2b: byParty(d.b2b).map(({ ctin, xs }) => ({ ctin, inv: xs.map(x => ({ inum: x.no, idt: ddmmyyyy(x.ts), val: x.value, pos: x.pos, rchrg: 'N', inv_typ: 'R', itms: itm(x.items) })) })),
    cdnr: byParty(d.cdnr).map(({ ctin, xs }) => ({ ctin, nt: xs.map(x => ({ ntty: 'C', nt_num: x.no, nt_dt: ddmmyyyy(x.ts), val: x.value, pos: x.pos, rchrg: 'N', inv_typ: 'R', itms: itm(x.items) })) })),
    b2cs: d.b2cs.map(r => ({ sply_ty: r.pos === home ? 'INTRA' : 'INTER', rt: r.rt, typ: 'OE', pos: r.pos, txval: r.txval, iamt: r.iamt, camt: r.camt, samt: r.samt, csamt: 0 })),
    nil: { inv: [{ sply_ty: 'INTRAB2B', nil_amt: d.nil.b2b, expt_amt: 0, ngsup_amt: 0 }, { sply_ty: 'INTRAB2C', nil_amt: d.nil.b2c, expt_amt: 0, ngsup_amt: 0 }] },
    hsn: { hsn_b2b: hsn(d.hsnB2B), hsn_b2c: hsn(d.hsnB2C) },
    doc_issue: { doc_det: [
      { doc_num: 1, docs: d.docs.filter(x => x.kind === 'Invoices').map((x, n) => ({ num: n + 1, from: x.from, to: x.to, totnum: x.total, cancel: 0, net_issue: x.total })) },
      { doc_num: 5, docs: d.docs.filter(x => x.kind === 'Credit notes').map((x, n) => ({ num: n + 1, from: x.from, to: x.to, totnum: x.total, cancel: 0, net_issue: x.total })) },
    ].filter(x => x.docs.length) },
  };
  for (const k of ['b2b', 'cdnr', 'b2cs']) if (!out[k].length) delete out[k];
  return out;
}

// ---------- GSTR-3B ----------
/**
 * purchases already filtered to the month. itcSafe = credit on bills found in GSTR-2B (null = 2B not loaded),
 * itcSafeHeads = the same split into IGST/CGST/SGST. r37 = rule37() result. opening = credit ledger balance
 * brought forward from last month (unused credit carries forward).
 */
export function gstr3bData({ sales, purchases, suppliers, journal, settings, itcSafe = null, itcSafeHeads = null, r37 = null, opening = null }) {
  const home = String(settings.stateCode || '').padStart(2, '0');
  const T = k => r2(sum(sales, s => sg(s) * (s.totals[k] || 0)));
  const allLines = sales.flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s) })));
  const nil = r2(sum(allLines.filter(l => Number(l.gst) === 0), l => l.sg * l.taxable));
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const books = zero();
  for (const p of purchases) { const h = billHeads(p, sm[p.supplierId], home); H.forEach(k => { books[k] += h[k]; }); }
  // ITC given back on stock written off (expired, damaged, stolen) — section 17(5)(h) → 4(B)(1).
  const wo = journal.filter(j => j.type === 'writeoff');
  const rv = { cgst: 'in_cgst', sgst: 'in_sgst', igst: 'in_igst' };
  const b1 = r2h(Object.fromEntries(H.map(k => [k, sum(wo, j => sum(j.lines.filter(l => l.acc === rv[k]), l => l.cr || 0))])));
  const b2 = r37 ? r37.reverseHeads : zero();                      // Rule 37 (supplier not paid in 180 days) → 4(B)(2)
  const re = r37 ? r37.reclaimHeads : zero();                      // paid now → taken again in 4(A)(5), shown in 4(D)(1)
  const itcBooks = r2(books.igst + books.cgst + books.sgst);
  // With 2B loaded, claim what 2B shows (it can include older bills the supplier filed late).
  let base = books;
  if (itcSafe != null) {
    if (itcSafeHeads && Math.abs(itcSafeHeads.igst + itcSafeHeads.cgst + itcSafeHeads.sgst - itcSafe) < 1) base = itcSafeHeads;
    else { const k = itcBooks ? itcSafe / itcBooks : 0; base = itcBooks ? { igst: books.igst * k, cgst: books.cgst * k, sgst: books.sgst * k } : { igst: 0, cgst: itcSafe / 2, sgst: itcSafe / 2 }; }
  }
  const avail = r2h({ igst: base.igst + re.igst, cgst: base.cgst + re.cgst, sgst: base.sgst + re.sgst });
  const net = r2h({ igst: avail.igst - b1.igst - b2.igst, cgst: avail.cgst - b1.cgst - b2.cgst, sgst: avail.sgst - b1.sgst - b2.sgst });
  const out = { igst: T('igst'), cgst: T('cgst'), sgst: T('sgst') };
  const outTax = r2(out.igst + out.cgst + out.sgst);
  const reversal = r2(b1.igst + b1.cgst + b1.sgst + b2.igst + b2.cgst + b2.sgst);
  // Negative net credit (more given back than taken) becomes tax to pay in that head.
  const owe = { igst: out.igst + Math.max(0, -net.igst), cgst: out.cgst + Math.max(0, -net.cgst), sgst: out.sgst + Math.max(0, -net.sgst) };
  const so = setOff({ out: owe, itc: { igst: Math.max(0, net.igst), cgst: Math.max(0, net.cgst), sgst: Math.max(0, net.sgst) }, opening: opening || zero() });
  const itcClaim = r2(net.igst + net.cgst + net.sgst);
  return {
    t31a: { txval: r2(T('taxable') - nil), ...out }, t31c: { txval: nil },
    t4a5: { ...r2h(base), total: r2(base.igst + base.cgst + base.sgst), books: r2h(books), booksTotal: itcBooks, reclaim: r2h(re) },
    t4b1: { ...b1, total: r2(b1.igst + b1.cgst + b1.sgst), count: wo.length },
    t4b2: { ...b2, total: r2(b2.igst + b2.cgst + b2.sgst), count: r37 ? r37.reverse.length : 0 },
    t4d1: { ...re, total: r2(re.igst + re.cgst + re.sgst), count: r37 ? r37.reclaim.length : 0 },
    net, itcSafe, itcClaim, outTax, reversal, opening: opening || zero(), setOff: so,
    cash: so.cashTotal,
  };
}

// ---------- GSTR-2B match ----------
const k2b = (g, n) => `${String(g || '').toUpperCase()}|${String(n || '').replace(/[\s/-]/g, '').toUpperCase()}`;
/** rows = [{gstin, inv, taxable, tax}] from the 2B file. books = purchases not matched in an earlier month. */
export function match2b(rows, books, suppliers, key, homeState = '') {
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const { to, from } = monthRange(key);
  const twoB = Object.fromEntries(rows.map(r => [k2b(r.gstin, r.inv), r]));
  const res = [];
  for (const p of books) {
    const gstin = sm[p.supplierId]?.gstin;
    if (!gstin) continue;
    const t = new Date(p.date).getTime();
    if (t > to) continue;
    const r = twoB[k2b(gstin, p.billNo)];
    if (!r) { res.push({ ...p, gstin, status: 'missing', note: t >= from ? 'Not in 2B yet — claim in a later month when the supplier files' : 'Older bill still not filed — call the supplier, hold payment' }); continue; }
    delete twoB[k2b(gstin, p.billNo)];
    const diff = r2(r.tax - p.tax);
    res.push({ ...p, gstin, twoBTax: r.tax, twoBRow: r, inter: !!homeState && gstin.slice(0, 2) !== homeState, status: Math.abs(diff) > 10 ? 'mismatch' : 'matched', note: Math.abs(diff) > 10 ? `GST differs by ₹${diff} — claim the lower amount, ask the supplier` : 'Safe to claim' });
  }
  for (const r of Object.values(twoB)) res.push({ id: 'x' + r.inv, billNo: r.inv, gstin: r.gstin, tax: r.tax, total: r2(r.taxable + r.tax), status: 'extra', note: 'In 2B but not in your books — enter the bill, or reject it in IMS if it is not yours' });
  const safe = r2(sum(res.filter(x => x.status === 'matched'), x => x.tax) + sum(res.filter(x => x.status === 'mismatch'), x => Math.min(x.tax, x.twoBTax)));
  // Safe credit split into IGST / CGST / SGST (Rule 88A needs the heads). Uses the 2B row's own split
  // when the file has it, else the supplier's state (other state = IGST, same state = half and half).
  const heads = { igst: 0, cgst: 0, sgst: 0 };
  for (const x of res.filter(r => r.status === 'matched' || r.status === 'mismatch')) {
    const amt = x.status === 'matched' ? x.tax : Math.min(x.tax, x.twoBTax);
    const r = x.twoBRow;
    if (r && r.igst + r.cgst + r.sgst > 0) { const k = amt / (r.igst + r.cgst + r.sgst); heads.igst += r.igst * k; heads.cgst += r.cgst * k; heads.sgst += r.sgst * k; }
    else if (x.inter) heads.igst += amt; else { heads.cgst += amt / 2; heads.sgst += amt / 2; }
  }
  const safeHeads = { igst: r2(heads.igst), cgst: r2(heads.cgst), sgst: r2(heads.sgst) };
  res.forEach(r => { r.ims = imsAction(r); delete r.twoBRow; });
  return { rows: res, safe, safeHeads, matchedIds: res.filter(x => x.status === 'matched' || x.status === 'mismatch').map(x => x.id) };
}

/** Rows from a 2B download (portal JSON or Excel rows). */
export function read2bRows(data) {
  if (data.json) {
    const b2b = data.json?.data?.docdata?.b2b || data.json?.docdata?.b2b || [];
    return b2b.flatMap(s => (s.inv || []).map(i => ({ gstin: s.ctin, inv: String(i.inum), date: i.dt || '', taxable: Number(i.txval) || 0, igst: Number(i.igst) || 0, cgst: Number(i.cgst) || 0, sgst: Number(i.sgst) || 0, tax: (Number(i.igst) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) })));
  }
  const g = (r, ns) => { const k = Object.keys(r).find(h => ns.some(n => h.toUpperCase().includes(n))); return k ? r[k] : ''; };
  return data.rows.map(r => {
    const igst = Number(g(r, ['INTEGRATED'])) || 0, cgst = Number(g(r, ['CENTRAL'])) || 0, sgst = Number(g(r, ['STATE'])) || 0;
    return { gstin: String(g(r, ['GSTIN'])).trim(), inv: String(g(r, ['INVOICE NUMBER', 'INVOICE NO', 'INV'])).trim(), taxable: Number(g(r, ['TAXABLE'])) || 0, igst, cgst, sgst, tax: igst + cgst + sgst };
  }).filter(r => r.gstin && r.inv);
}

// ---------- Checks before filing ----------
// level: 'stop' = fix before filing, 'warn' = look at it, 'ok' = fine.
export function preChecks({ sales, products, settings, rules = DEFAULT_RULES, d, threeB, aato = 0, r37 = null, deadline = null, changes = null, composition = false }) {
  const out = [];
  const add = (level, text, fix) => out.push({ level, text, fix });
  const home = String(settings.stateCode || '').padStart(2, '0');
  if (!validGSTIN(settings.gstin)) add('stop', 'Store GSTIN is missing or not valid.', { page: 'settings', param: { tab: 'store' } });
  else if (settings.gstin.slice(0, 2) !== home) add('stop', `Store state code (${home}) does not match the GSTIN (${settings.gstin.slice(0, 2)}).`, { page: 'settings', param: { tab: 'store' } });

  const badGstin = d.b2b.filter(x => !validGSTIN(x.gstin));
  if (badGstin.length) add('stop', `${badGstin.length} business bill(s) have a wrong buyer GSTIN: ${badGstin.slice(0, 3).map(x => x.no).join(', ')}`, { page: 'reports', param: { tab: 'gstr1' } });

  const wrongSplit = sales.filter(s => s.b2b?.gstin && s.type === 'sale').filter(s => (s.b2b.gstin.slice(0, 2) !== home) !== ((s.totals.igst || 0) > 0) && s.totals.taxable > 0);
  if (wrongSplit.length) add('stop', `${wrongSplit.length} bill(s) charge CGST+SGST vs IGST wrongly for the buyer’s state: ${wrongSplit.slice(0, 3).map(s => s.no).join(', ')}`);

  const lines = sales.flatMap(s => s.lines);
  const badRate = [...new Set(lines.filter(l => !rules.slabs.includes(Number(l.gst))).map(l => `${l.name} (${l.gst}%)`))];
  if (badRate.length) add('stop', `Rate not in the current GST slabs: ${badRate.slice(0, 4).join(', ')}${badRate.length > 4 ? '…' : ''}`, { page: 'products' });

  // HSN: 4 digits must be on business (B2B) bills up to ₹5 crore turnover; shop (B2C) bills should have it too.
  const Lm = { ...DEFAULT_RULES.limits, ...(rules.limits || {}) };
  const big = aato > Lm.hsn6Above;
  const digits = big ? 6 : rules.hsnMinDigits;
  const short = l => String(l.hsn || '').replace(/\D/g, '').length < digits;
  const shortB2B = [...new Set(sales.filter(s => s.b2b?.gstin).flatMap(s => s.lines).filter(short).map(l => l.name))];
  const shortHsn = [...new Set(lines.filter(short).map(l => l.name))];
  if (shortB2B.length) add('stop', `${shortB2B.length} item(s) on business bills have no ${digits}-digit HSN: ${shortB2B.slice(0, 4).join(', ')}${shortB2B.length > 4 ? '…' : ''}`, { page: 'products' });
  else if (shortHsn.length) add(big ? 'stop' : 'warn', `${shortHsn.length} item(s) sold without a ${digits}-digit HSN: ${shortHsn.slice(0, 4).join(', ')}${shortHsn.length > 4 ? '…' : ''}. ${big ? ' Above ₹5 crore turnover, shop (B2C) bills need it too.' : ' For shop (B2C) bills it is optional at your turnover, but good to have.'}`, { page: 'products' });

  const noHsnProducts = products.filter(p => p.active !== false && String(p.hsn || '').replace(/\D/g, '').length < digits).length;
  if (noHsnProducts && !shortHsn.length) add('warn', `${noHsnProducts} product(s) in the list have no proper HSN yet (not sold this month).`, { page: 'products' });

  const longNo = sales.filter(s => String(s.no).length > 16);
  if (longNo.length) add('stop', `${longNo.length} bill number(s) are longer than 16 characters (Rule 46).`);
  const dupNo = Object.entries(groupBy(sales, s => s.no)).filter(([, ss]) => ss.length > 1).map(([n]) => n);
  if (dupNo.length) add('stop', `Same bill number used twice: ${dupNo.slice(0, 3).join(', ')}`, { page: 'audit' });
  const gaps = d.docs.filter(x => x.missing > 0);
  if (gaps.length) add('warn', `Bill numbers skip in ${gaps.map(x => `${x.prefix} (${x.missing})`).join(', ')}. A counter may not have synced yet, or bills were lost — check Security & audit before filing.`, { page: 'audit' });

  const orphanReturns = sales.filter(s => s.type === 'return' && !s.origNo);
  if (orphanReturns.length) add('warn', `${orphanReturns.length} return(s) not linked to an original bill.`);

  const negB2c = d.b2cs.filter(r => r.txval < 0);
  if (negB2c.length) add('warn', `Shop returns are more than shop sales at ${negB2c.map(r => r.rt + '%').join(', ')} this month — Table 7 cannot be negative. Ask your CA how to show it.`);

  const future = sales.filter(s => s.ts > Date.now() + 864e5);
  if (future.length) add('stop', `${future.length} bill(s) dated in the future — check the counter PC’s clock.`);

  if (threeB) {
    if (threeB.itcSafe == null) add('warn', 'GSTR-2B not loaded for this month — input credit is from your books only. Load 2B (step 4) before filing 3B.');
    else if (threeB.itcSafe + 1 < threeB.t4a5.total) add('warn', `Only ₹${threeB.itcSafe} of this month’s ₹${threeB.t4a5.total} input credit is in GSTR-2B. Claim only the 2B amount; the rest can be claimed when suppliers file.`);
    if (threeB.t4b1.total > 0) add('ok', `₹${threeB.t4b1.total} input credit given back for ${threeB.t4b1.count} write-off(s) — goes in 3B Table 4(B)(1).`);
  }
  // Composition: no tax on bills, no sales to other states.
  if (composition) {
    const taxed = sales.filter(s => s.type === 'sale' && ((s.totals.cgst || 0) + (s.totals.sgst || 0) + (s.totals.igst || 0)) > 0);
    if (taxed.length) add('stop', `${taxed.length} bill(s) charged GST, but a composition dealer cannot collect tax. Those bills were made before composition was switched on, or on a counter that has not synced the setting.`);
    const inter = sales.filter(s => s.b2b?.gstin && s.b2b.gstin.slice(0, 2) !== home);
    if (inter.length) add('stop', `${inter.length} bill(s) to buyers in another state — composition dealers cannot sell to other states.`);
  }
  // E-invoice: business bills need an IRN once turnover has crossed ₹5 crore.
  if (!composition && aato > Lm.einvoiceAbove && d.b2b.length) add('stop', `${d.b2b.length} business bill(s) this period need an e-invoice (IRN) — your turnover is above ₹5 crore. Generate IRNs on the e-invoice portal before filing.`);
  // Rule 37: supplier not paid in 180 days.
  if (r37?.reverse.length) add('warn', `${r37.reverse.length} supplier bill(s) are unpaid after 180 days — give back ₹${r37.reverseTotal} input credit in 3B Table 4(B)(2) (interest applies). You get it back when you pay.`, { page: 'purchases', param: { tab: 'suppliers' } });
  if (r37?.reclaim.length) add('ok', `${r37.reclaim.length} bill(s) now paid — take back ₹${r37.reclaimTotal} credit given back earlier (4(A)(5), shown in 4(D)(1)).`);
  // Section 16(4): last date to take last year's credit.
  if (deadline && deadline.bills && deadline.daysLeft >= 0 && deadline.daysLeft <= 75) add(deadline.daysLeft <= 20 ? 'stop' : 'warn', `₹${deadline.tax} credit on ${deadline.bills} supplier bill(s) from FY ${deadline.fy} is still not matched in 2B. Last date to take it: ${deadline.last} (${deadline.daysLeft} days). Ask those suppliers to file now.`, { page: 'purchases' });
  // Bills that arrived after GSTR-1 was marked filed (a counter synced late, or a return was entered later).
  if (changes) add('stop', `Since GSTR-1 was filed, ${changes.bills} bill(s) changed this period's totals by ₹${changes.taxable} taxable / ₹${changes.tax} GST. Correct it with GSTR-1A before filing GSTR-3B (3B tax is copied from GSTR-1/1A and cannot be edited).`);
  if (!out.some(x => x.level === 'stop')) add('ok', 'No blocking problems found in this month’s bills.');
  return out;
}

// =============================================================================================
// "Next level" GST Saathi: IMS actions, credit set-off by law, late fee and interest, the 180-day
// rule, the 30 November credit deadline, turnover limits, composition, the yearly summary and
// changes after filing. Plain code only; every number says where it comes from.
// =============================================================================================

/** What to do with a 2B row in IMS (Invoice Management System) on the portal. */
export function imsAction(r) {
  if (r.status === 'matched') return { act: 'Accept', why: 'Bill is in your books with the same GST.' };
  if (r.status === 'mismatch') return { act: 'Pending', why: 'GST differs from your bill. Keep pending and ask the supplier to correct it (pending is allowed for one return period).' };
  if (r.status === 'extra') return { act: 'Check', why: 'Not in your books. If you received these goods, enter the bill and Accept. If it is not yours, Reject.' };
  return { act: '—', why: 'Supplier has not filed it yet, so it is not in IMS. Call the supplier.' };
}

const H = ['igst', 'cgst', 'sgst'];
const zero = () => ({ igst: 0, cgst: 0, sgst: 0 });
const r2h = o => ({ igst: r2(o.igst), cgst: r2(o.cgst), sgst: r2(o.sgst) });

/**
 * Pay this month's tax from input credit in the order the law sets (section 49A, Rule 88A):
 * 1. IGST credit first: IGST tax, then CGST / SGST tax (we put it where own credit is short, so less cash).
 * 2. CGST credit: CGST tax, then IGST tax — never SGST.  3. SGST credit: SGST tax, then IGST tax — never CGST.
 * Unused credit carries forward to next month. Returns what each credit paid, cash per head and the closing credit.
 */
export function setOff({ out, itc, opening = zero() }) {
  const L = { ...zero(), ...out }, C = { igst: (itc.igst || 0) + (opening.igst || 0), cgst: (itc.cgst || 0) + (opening.cgst || 0), sgst: (itc.sgst || 0) + (opening.sgst || 0) };
  const use = { igst: zero(), cgst: zero(), sgst: zero() };      // use[credit][tax]
  const pay = (cr, tx, amt) => { amt = Math.max(0, Math.min(amt, C[cr], L[tx])); C[cr] -= amt; L[tx] -= amt; use[cr][tx] += amt; };
  pay('igst', 'igst', L.igst);
  // IGST credit left: first where CGST / SGST credit cannot cover, then the rest (the law wants IGST used up first).
  pay('igst', 'cgst', Math.max(0, L.cgst - C.cgst));
  pay('igst', 'sgst', Math.max(0, L.sgst - C.sgst));
  const half = Math.min(C.igst, L.cgst + L.sgst) / 2;
  pay('igst', 'cgst', half); pay('igst', 'sgst', C.igst); pay('igst', 'cgst', C.igst);
  pay('cgst', 'cgst', L.cgst); pay('sgst', 'sgst', L.sgst);
  pay('cgst', 'igst', L.igst); pay('sgst', 'igst', L.igst);
  return {
    use: { igst: r2h(use.igst), cgst: r2h(use.cgst), sgst: r2h(use.sgst) },
    cash: r2h(L), cashTotal: r2(L.igst + L.cgst + L.sgst),
    closing: r2h(C), closingTotal: r2(C.igst + C.cgst + C.sgst),
  };
}

/** Late fee for a return filed `days` late. Nil return = lower fee. Caps by last year's turnover. */
export function lateFeeFor({ days, nil = false, aato = 0, rules = DEFAULT_RULES }) {
  const F = rules.lateFee || DEFAULT_RULES.lateFee;
  if (!(days > 0)) return { days: 0, fee: 0, cgst: 0, sgst: 0 };
  const cap = nil ? F.capNil : (F.caps.find(([upTo]) => upTo == null || aato <= upTo) || [null, 10000])[1];
  const fee = Math.min(days * (nil ? F.perDayNil : F.perDay), cap);
  return { days, fee, cgst: fee / 2, sgst: fee / 2, cap };
}
/** Interest at 18% a year on tax paid late in cash, counted per day (section 50). */
export function interestFor({ cash, days, rules = DEFAULT_RULES }) {
  if (!(days > 0) || !(cash > 0)) return 0;
  return r2(cash * ((rules.interestPct ?? 18) / 100) * days / 365);
}
export const daysLate = (due, on = new Date()) => Math.max(0, Math.round((new Date(on).setHours(0, 0, 0, 0) - new Date(due).setHours(0, 0, 0, 0)) / 864e5));

/** Split one purchase bill's GST into heads from the supplier's state. */
export function billHeads(p, supplier, homeState) {
  const g = String(supplier?.gstin || '').slice(0, 2);
  const inter = !!g && !!homeState && g !== String(homeState).padStart(2, '0');
  return inter ? { igst: p.tax, cgst: 0, sgst: 0 } : { igst: 0, cgst: p.tax / 2, sgst: p.tax / 2 };
}

/**
 * Rule 37: if a supplier is not paid within 180 days of the bill date, the credit on the unpaid part is given
 * back in GSTR-3B Table 4(B)(2) (with interest), and taken again in 4(A)(5) once paid (shown in 4(D)(1)).
 * `asOf` = last day of the return period.
 */
export function rule37({ purchases, suppliers, homeState, asOf, rules = DEFAULT_RULES }) {
  const days = rules.rule37Days || 180;
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const reverse = [], reclaim = [];
  for (const p of purchases) {
    if (!(p.tax > 0) || !sm[p.supplierId]?.gstin) continue;
    const unpaid = r2((p.total || 0) - (p.paid || 0));
    const limit = new Date(p.date); limit.setDate(limit.getDate() + days);
    const done = p.rule37 || null;
    if (!done && unpaid > 0.5 && limit.getTime() < asOf) {
      const share = Math.min(1, unpaid / (p.total || 1));
      const h = billHeads(p, sm[p.supplierId], homeState);
      reverse.push({ id: p.id, no: p.billNo || p.no, supplier: sm[p.supplierId].name, date: p.date, unpaid, overdueSince: localISO(limit), heads: r2h({ igst: h.igst * share, cgst: h.cgst * share, sgst: h.sgst * share }), amount: r2(p.tax * share) });
    } else if (done && !done.reclaimedIn && unpaid <= 0.5) {
      reclaim.push({ id: p.id, no: p.billNo || p.no, supplier: sm[p.supplierId].name, date: p.date, heads: done.heads, amount: done.amount });
    }
  }
  const tot = list => r2h(list.reduce((a, x) => ({ igst: a.igst + x.heads.igst, cgst: a.cgst + x.heads.cgst, sgst: a.sgst + x.heads.sgst }), zero()));
  return { reverse, reclaim, reverseHeads: tot(reverse), reclaimHeads: tot(reclaim), reverseTotal: r2(sum(reverse, x => x.amount)), reclaimTotal: r2(sum(reclaim, x => x.amount)) };
}

/** Financial year 'YYYY' (start year) of a date, and its last date for taking credit (30 Nov after it). */
export const fyStart = d => { const x = new Date(d); return x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1; };
export function itcDeadline({ purchases, suppliers, matchedIds, today = new Date(), rules = DEFAULT_RULES }) {
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const fy = fyStart(today) - 1;                                   // last financial year
  const [mm, dd] = (rules.itcLastDate || '11-30').split('-').map(Number);
  const last = new Date(fy + 1, mm - 1, dd);
  const open = purchases.filter(p => p.tax > 0 && sm[p.supplierId]?.gstin && fyStart(p.date) === fy && !matchedIds.has(p.id));
  return { fy: `${fy}-${String(fy + 1).slice(2)}`, last: localISO(last), daysLeft: Math.round((last - new Date(today).setHours(0, 0, 0, 0)) / 864e5), bills: open.length, tax: r2(sum(open, p => p.tax)), list: open };
}

/** Turnover limits that change what the store must do. aato = last full year's turnover (all stores, same GSTIN). */
export function turnoverStatus({ aato = 0, ytd = 0, maxEver = 0, composition = false, rules = DEFAULT_RULES }) {
  const Lm = { ...DEFAULT_RULES.limits, ...(rules.limits || {}) };
  const cr = v => `₹${(v / 1e7).toFixed(v >= 1e7 ? 2 : 2)} crore`;
  const out = [];
  out.push({ id: 'hsn', tone: aato > Lm.hsn6Above ? 'warn' : 'ok', text: aato > Lm.hsn6Above ? `HSN: 6 digits on every bill (turnover above ${cr(Lm.hsn6Above)}).` : 'HSN: 4 digits needed on business bills; shop bills optional.' });
  out.push({ id: 'einv', tone: Math.max(aato, maxEver) > Lm.einvoiceAbove ? 'bad' : 'ok', text: Math.max(aato, maxEver) > Lm.einvoiceAbove ? `E-invoice (IRN) needed for business (B2B) bills — turnover crossed ${cr(Lm.einvoiceAbove)}.` : `E-invoice not needed (turnover below ${cr(Lm.einvoiceAbove)} in every year).` });
  out.push({ id: 'gstr9', tone: aato > Lm.gstr9Above ? 'warn' : 'ok', text: aato > Lm.gstr9Above ? `GSTR-9 annual return is compulsory${aato > Lm.gstr9cAbove ? ', and GSTR-9C too' : ''}.` : `GSTR-9 is optional (turnover up to ${cr(Lm.gstr9Above)}).` });
  if (composition) out.push({ id: 'comp', tone: ytd > Lm.compositionUpTo ? 'bad' : ytd > Lm.compositionUpTo * 0.85 ? 'warn' : 'ok', text: ytd > Lm.compositionUpTo ? `Turnover this year crossed ${cr(Lm.compositionUpTo)} — you must leave composition and register as a regular dealer (talk to your CA now).` : `Composition limit ${cr(Lm.compositionUpTo)}: this year ${cr(ytd)} so far.` });
  else out.push({ id: 'qrmp', tone: aato > Lm.qrmpUpTo ? 'warn' : 'ok', text: aato > Lm.qrmpUpTo ? 'Quarterly filing (QRMP) is not allowed above ₹5 crore — file monthly.' : 'Quarterly filing (QRMP) is allowed for you.' });
  return out;
}

/** Composition (CMP-08): tax = 1% of taxable sales (0.5% CGST + 0.5% SGST); no credit, no tax on bills. */
export function compositionData(sales, rules = DEFAULT_RULES) {
  const C = rules.composition || DEFAULT_RULES.composition;
  const lines = sales.flatMap(s => s.lines.map(l => ({ ...l, sg: s.type === 'return' ? -1 : 1 })));
  // A composition bill keeps the product's normal rate in `rateWas` (tax itself is 0). Exempt goods stay out of the 1%.
  const isExempt = l => Number(l.rateWas ?? l.gst) === 0;
  const turnover = r2(sum(lines, l => l.sg * (l.total ?? l.taxable)));
  const taxableTurnover = r2(sum(lines.filter(l => !isExempt(l)), l => l.sg * (l.total ?? l.taxable)));
  const tax = r2(taxableTurnover * C.ratePct / 100);
  const taxedBills = sales.filter(s => s.type === 'sale' && (s.totals.cgst || s.totals.sgst || s.totals.igst)).length;
  return { turnover, taxableTurnover, exempt: r2(turnover - taxableTurnover), tax, cgst: r2(tax / 2), sgst: r2(tax - r2(tax / 2)), taxedBills };
}

/** Sums of one month, small enough to keep (used for turnover limits and the yearly summary). */
export function monthSummary(sales) {
  const S = k => r2(sum(sales, s => sg(s) * (s.totals[k] || 0)));
  const nil = r2(sum(sales.flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s) }))).filter(l => Number(l.gst) === 0), l => l.sg * l.taxable));
  return { bills: sales.filter(s => s.type === 'sale').length, returns: sales.filter(s => s.type === 'return').length, value: S('payable'), taxable: S('taxable'), nil, igst: S('igst'), cgst: S('cgst'), sgst: S('sgst') };
}

/** A fingerprint of a period when a return is marked filed; later bills for that period show up as changes. */
export const snapshotOf = sm => ({ bills: sm.bills, returns: sm.returns, taxable: sm.taxable, tax: r2(sm.igst + sm.cgst + sm.sgst) });
export function changesSince(snap, now) {
  if (!snap) return null;
  const n = snapshotOf(now);
  const dBills = (n.bills + n.returns) - (snap.bills + snap.returns), dTax = r2(n.tax - snap.tax), dTaxable = r2(n.taxable - snap.taxable);
  if (!dBills && Math.abs(dTax) < 1 && Math.abs(dTaxable) < 1) return null;
  return { bills: dBills, tax: dTax, taxable: dTaxable };
}

/** Yearly (GSTR-9) table from month summaries: [{ key, sum, threeB }] in order April → March. */
export function yearRows(months) {
  const rows = months.map(m => ({ month: m.key, bills: m.sum.bills, taxable: m.sum.taxable, nil: m.sum.nil, igst: m.sum.igst, cgst: m.sum.cgst, sgst: m.sum.sgst,
    itc: m.threeB?.itcClaim ?? null, cashPaid: m.threeB?.cashTotal ?? null, filed3b: !!m.threeB }));
  const T = k => r2(sum(rows, r => r[k] || 0));
  return { rows, total: { month: 'Total', bills: T('bills'), taxable: T('taxable'), nil: T('nil'), igst: T('igst'), cgst: T('cgst'), sgst: T('sgst'), itc: T('itc'), cashPaid: T('cashPaid') } };
}
