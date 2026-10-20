// GST Saathi engine — plain code only. Builds the month's GSTR-1 tables and file, the GSTR-3B
// summary, checks before filing, the GSTR-2B match, due dates and the rule book.
// AI is never used here: it never files a return and never sets a GST rate.
import { r2, sum, groupBy, localISO, validGSTIN } from './util.js';

// ---------- Rule book (the person approves every change) ----------
// Category I states file quarterly GSTR-3B by the 22nd, Category II by the 24th.
const CAT1 = ['22', '23', '24', '26', '27', '29', '30', '31', '32', '33', '34', '35', '36', '37', '97'];
export const DEFAULT_RULES = {
  version: '2026.10.1',
  updated: '2026-10-20',
  slabs: [0, 5, 18, 40],
  hsnMinDigits: 4,                 // up to ₹5 crore turnover; 6 above
  due: {
    gstr1Monthly: 11, iffQrmp: 13, gstr1Qrmp: 13,
    gstr3bMonthly: 20, gstr3bQrmpCat1: 22, gstr3bQrmpCat2: 24, pmt06: 25,
    gstr9: '12-31',
  },
  notes: [],                       // e.g. "Due date for Sep 2026 GSTR-3B extended to 25 Oct (Notification …)"
  extensions: {},                  // { 'gstr3b:2026-09': '2026-10-25' }
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
export function dueDates(key, { qrmp = false, stateCode = '', rules = DEFAULT_RULES } = {}) {
  const { y, m } = monthRange(key);
  const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
  const D = rules.due, ext = rules.extensions || {};
  const pick = (id, date) => ext[`${id}:${key}`] || date;
  const list = [];
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
/** purchases already filtered to the month; itcSafe = tax on bills found in GSTR-2B (null = 2B not loaded). */
export function gstr3bData({ sales, purchases, suppliers, journal, settings, itcSafe = null }) {
  const home = String(settings.stateCode || '').padStart(2, '0');
  const T = k => r2(sum(sales, s => sg(s) * (s.totals[k] || 0)));
  const allLines = sales.flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s) })));
  const nil = r2(sum(allLines.filter(l => l.gst === 0), l => l.sg * l.taxable));
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  let iIgst = 0, iCgst = 0, iSgst = 0;
  for (const p of purchases) {
    const inter = (sm[p.supplierId]?.gstin || '').slice(0, 2) && sm[p.supplierId].gstin.slice(0, 2) !== home;
    if (inter) iIgst += p.tax; else { iCgst += p.tax / 2; iSgst += p.tax / 2; }
  }
  // ITC given back on stock written off (expired, damaged, stolen) — section 17(5)(h).
  const wo = journal.filter(j => j.type === 'writeoff');
  const rCgst = r2(sum(wo, j => sum(j.lines.filter(l => l.acc === 'in_cgst'), l => l.cr || 0)));
  const rSgst = r2(sum(wo, j => sum(j.lines.filter(l => l.acc === 'in_sgst'), l => l.cr || 0)));
  const rIgst = r2(sum(wo, j => sum(j.lines.filter(l => l.acc === 'in_igst'), l => l.cr || 0)));
  const itcBooks = r2(iIgst + iCgst + iSgst);
  const out = { igst: T('igst'), cgst: T('cgst'), sgst: T('sgst') };
  const outTax = r2(out.igst + out.cgst + out.sgst);
  const reversal = r2(rIgst + rCgst + rSgst);
  // With 2B loaded, claim what 2B shows (it can include older bills the supplier filed late).
  const itcClaim = r2((itcSafe == null ? itcBooks : itcSafe) - reversal);
  return {
    t31a: { txval: r2(T('taxable') - nil), ...out }, t31c: { txval: nil },
    t4a5: { igst: r2(iIgst), cgst: r2(iCgst), sgst: r2(iSgst), total: itcBooks },
    t4b1: { igst: rIgst, cgst: rCgst, sgst: rSgst, total: reversal, count: wo.length },
    itcSafe, itcClaim, outTax, cash: r2(Math.max(0, outTax - Math.max(0, itcClaim))),
  };
}

// ---------- GSTR-2B match ----------
const k2b = (g, n) => `${String(g || '').toUpperCase()}|${String(n || '').replace(/[\s/-]/g, '').toUpperCase()}`;
/** rows = [{gstin, inv, taxable, tax}] from the 2B file. books = purchases not matched in an earlier month. */
export function match2b(rows, books, suppliers, key) {
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
    res.push({ ...p, gstin, twoBTax: r.tax, status: Math.abs(diff) > 10 ? 'mismatch' : 'matched', note: Math.abs(diff) > 10 ? `GST differs by ₹${diff} — claim the lower amount, ask the supplier` : 'Safe to claim' });
  }
  for (const r of Object.values(twoB)) res.push({ id: 'x' + r.inv, billNo: r.inv, gstin: r.gstin, tax: r.tax, total: r2(r.taxable + r.tax), status: 'extra', note: 'In 2B but not in your books — enter the bill, or reject it in IMS if it is not yours' });
  const safe = r2(sum(res.filter(x => x.status === 'matched'), x => x.tax) + sum(res.filter(x => x.status === 'mismatch'), x => Math.min(x.tax, x.twoBTax)));
  return { rows: res, safe, matchedIds: res.filter(x => x.status === 'matched' || x.status === 'mismatch').map(x => x.id) };
}

/** Rows from a 2B download (portal JSON or Excel rows). */
export function read2bRows(data) {
  if (data.json) {
    const b2b = data.json?.data?.docdata?.b2b || data.json?.docdata?.b2b || [];
    return b2b.flatMap(s => (s.inv || []).map(i => ({ gstin: s.ctin, inv: String(i.inum), taxable: Number(i.txval) || 0, tax: (Number(i.igst) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) })));
  }
  const g = (r, ns) => { const k = Object.keys(r).find(h => ns.some(n => h.toUpperCase().includes(n))); return k ? r[k] : ''; };
  return data.rows.map(r => ({ gstin: String(g(r, ['GSTIN'])).trim(), inv: String(g(r, ['INVOICE NUMBER', 'INVOICE NO', 'INV'])).trim(), taxable: Number(g(r, ['TAXABLE'])) || 0,
    tax: (Number(g(r, ['INTEGRATED'])) || 0) + (Number(g(r, ['CENTRAL'])) || 0) + (Number(g(r, ['STATE'])) || 0) })).filter(r => r.gstin && r.inv);
}

// ---------- Checks before filing ----------
// level: 'stop' = fix before filing, 'warn' = look at it, 'ok' = fine.
export function preChecks({ sales, products, settings, rules = DEFAULT_RULES, d, threeB }) {
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
  const short = l => String(l.hsn || '').replace(/\D/g, '').length < rules.hsnMinDigits;
  const shortB2B = [...new Set(sales.filter(s => s.b2b?.gstin).flatMap(s => s.lines).filter(short).map(l => l.name))];
  const shortHsn = [...new Set(lines.filter(short).map(l => l.name))];
  if (shortB2B.length) add('stop', `${shortB2B.length} item(s) on business bills have no ${rules.hsnMinDigits}-digit HSN: ${shortB2B.slice(0, 4).join(', ')}${shortB2B.length > 4 ? '…' : ''}`, { page: 'products' });
  else if (shortHsn.length) add('warn', `${shortHsn.length} item(s) sold without a ${rules.hsnMinDigits}-digit HSN: ${shortHsn.slice(0, 4).join(', ')}${shortHsn.length > 4 ? '…' : ''}. The HSN table (Table 12) needs it.`, { page: 'products' });

  const noHsnProducts = products.filter(p => p.active !== false && String(p.hsn || '').replace(/\D/g, '').length < rules.hsnMinDigits).length;
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
  if (!out.some(x => x.level === 'stop')) add('ok', 'No blocking problems found in this month’s bills.');
  return out;
}
