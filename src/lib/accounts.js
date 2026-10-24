// Double-entry books. Every bill, purchase, payment and salary posts balanced entries by itself.
import { db, writeSoon } from '../db.js';
import { uid, r2, sum } from './util.js';

export const GROUPS = { asset: 'Assets', liability: 'Liabilities', equity: 'Capital', income: 'Income', expense: 'Expenses' };

export const CHART = [
  ['cash', 'Cash in hand', 'asset'], ['bank', 'Bank account', 'asset'], ['upi', 'UPI to be settled', 'asset'],
  ['card', 'Card to be settled', 'asset'], ['inventory', 'Stock (inventory)', 'asset'],
  ['in_cgst', 'Input CGST', 'asset'], ['in_sgst', 'Input SGST', 'asset'], ['in_igst', 'Input IGST', 'asset'],
  ['out_cgst', 'Output CGST', 'liability'], ['out_sgst', 'Output SGST', 'liability'], ['out_igst', 'Output IGST', 'liability'],
  ['pf_payable', 'PF payable', 'liability'], ['esi_payable', 'ESI payable', 'liability'], ['pt_payable', 'Professional tax payable', 'liability'],
  ['salary_payable', 'Salary payable', 'liability'], ['loyalty', 'Loyalty points owed', 'liability'],
  ['capital', 'Owner capital', 'equity'],
  ['sales', 'Sales', 'income'], ['other_income', 'Other income', 'income'],
  ['cogs', 'Cost of goods sold', 'expense'], ['discount', 'Discounts given', 'expense'], ['roundoff', 'Round off', 'expense'],
  ['shrinkage', 'Damage, expiry & shrinkage', 'expense'], ['salary', 'Salaries', 'expense'], ['pf_er', 'Employer PF & ESI', 'expense'],
  ['rent', 'Rent', 'expense'], ['power', 'Electricity', 'expense'], ['bank_charges', 'Bank & card charges', 'expense'], ['misc', 'Other expenses', 'expense'],
];

export async function ensureChart() {
  const n = await db.accounts.count();
  if (n) return;
  await db.accounts.bulkAdd(CHART.map(([id, name, group]) => ({ id, name, group, system: true })));
}

export async function partyAccount(kind, party) {
  const id = `${kind}:${party.id}`;
  const ex = await db.accounts.get(id);
  if (!ex) await db.accounts.add({ id, name: party.name, group: kind === 'cust' ? 'asset' : 'liability', party: kind, partyId: party.id });
  return id;
}

/** A balanced journal entry (not saved yet). */
export function buildEntry({ ts = Date.now(), ref, type, narration, lines }) {
  const dr = r2(sum(lines, l => l.dr || 0));
  const cr = r2(sum(lines, l => l.cr || 0));
  const diff = r2(dr - cr);
  if (Math.abs(diff) >= 0.01) lines.push(diff > 0 ? { acc: 'roundoff', cr: diff } : { acc: 'roundoff', dr: -diff });
  return { id: uid('j_'), ts, ref, type, narration, lines: lines.filter(l => (l.dr || 0) !== 0 || (l.cr || 0) !== 0) };
}

export async function post(args) {
  const entry = buildEntry(args);
  await db.journal.add(entry);
  return entry;
}

const PAY_ACC = { cash: 'cash', upi: 'upi', card: 'card', bank: 'bank' };

/** The books entry for a bill. `custAcc` is the customer's account id when part is on credit. */
export function saleEntry(sale, custAcc) {
  const t = sale.totals;
  const sign = sale.type === 'return' ? -1 : 1;
  const lines = [];
  for (const p of sale.payments) {
    if (p.mode === 'credit') lines.push({ acc: custAcc, dr: p.amount * sign });
    else if (p.mode === 'points') lines.push({ acc: 'discount', dr: p.amount * sign });
    else lines.push({ acc: PAY_ACC[p.mode] || 'cash', dr: p.amount * sign });
  }
  lines.push({ acc: 'sales', cr: (t.taxable) * sign });
  lines.push({ acc: 'out_cgst', cr: t.cgst * sign }, { acc: 'out_sgst', cr: t.sgst * sign }, { acc: 'out_igst', cr: t.igst * sign });
  if (t.roundOff) lines.push(t.roundOff > 0 ? { acc: 'roundoff', cr: t.roundOff * sign } : { acc: 'roundoff', dr: -t.roundOff * sign });
  const cogs = r2(sum(sale.lines, l => l.qty * (l.cost || 0)));
  if (cogs) lines.push({ acc: 'cogs', dr: cogs * sign }, { acc: 'inventory', cr: cogs * sign });
  // Negative amounts flip side so every entry stays readable.
  const norm = lines.map(l => {
    if ((l.dr || 0) < 0) return { acc: l.acc, cr: -l.dr };
    if ((l.cr || 0) < 0) return { acc: l.acc, dr: -l.cr };
    return l;
  });
  return buildEntry({ ts: sale.ts, ref: sale.no, type: sale.type === 'return' ? 'credit_note' : 'sale', narration: `${sale.type === 'return' ? 'Return' : 'Sale'} ${sale.no}`, lines: norm });
}

export async function postSale(sale, customer) {
  const acc = sale.payments.some(p => p.mode === 'credit') ? await partyAccount('cust', customer) : null;
  const entry = saleEntry(sale, acc);
  await db.journal.add(entry);
  return entry;
}

export async function postPurchase(pur, supplier, interState) {
  const lines = [{ acc: 'inventory', dr: pur.taxable }];
  if (interState) lines.push({ acc: 'in_igst', dr: pur.tax });
  else lines.push({ acc: 'in_cgst', dr: r2(pur.tax / 2) }, { acc: 'in_sgst', dr: r2(pur.tax - r2(pur.tax / 2)) });
  lines.push({ acc: await partyAccount('supp', supplier), cr: pur.total });
  return post({ ts: new Date(pur.date).getTime(), ref: pur.no, type: 'purchase', narration: `Purchase ${pur.billNo || pur.no} from ${supplier.name}`, lines });
}

export async function postDebitNote(dn, supplier, interState) {
  const lines = [{ acc: await partyAccount('supp', supplier), dr: dn.total }, { acc: 'inventory', cr: dn.taxable }];
  if (interState) lines.push({ acc: 'in_igst', cr: dn.tax });
  else lines.push({ acc: 'in_cgst', cr: r2(dn.tax / 2) }, { acc: 'in_sgst', cr: r2(dn.tax - r2(dn.tax / 2)) });
  return post({ ts: new Date(dn.date).getTime(), ref: dn.no, type: 'debit_note', narration: `Debit note ${dn.no} to ${supplier.name}`, lines });
}

export async function postReceipt({ customer, amount, mode, ref, ts }) {
  return post({ ts, ref, type: 'receipt', narration: `Received from ${customer.name}`, lines: [{ acc: PAY_ACC[mode] || 'cash', dr: amount }, { acc: await partyAccount('cust', customer), cr: amount }] });
}

export async function postPayment({ supplier, amount, mode, ref, ts }) {
  return post({ ts, ref, type: 'payment', narration: `Paid to ${supplier.name}`, lines: [{ acc: await partyAccount('supp', supplier), dr: amount }, { acc: PAY_ACC[mode] || 'bank', cr: amount }] });
}

export async function postExpense({ acc, amount, mode, narration, ts }) {
  return post({ ts, ref: 'EXP', type: 'expense', narration, lines: [{ acc, dr: amount }, { acc: PAY_ACC[mode] || 'cash', cr: amount }] });
}

// Balances: positive = debit balance.
const addEntry = (b, e) => e.lines.forEach(l => (b[l.acc] = r2((b[l.acc] || 0) + (l.dr || 0) - (l.cr || 0))));

// All-time balances are kept as a saved total up to the start of today plus today's entries, so the
// Accounts screens do not re-add lakhs of entries each time. If any older entry was added since (a counter
// synced late), the count before the saved point changes and the total is worked out again from scratch.
async function allTimeBalances() {
  const cp = new Date().setHours(0, 0, 0, 0);
  const saved = (await db.syncMeta.get('bal:cp'))?.v;
  let b = null;
  if (saved && saved.cp <= cp && (await db.journal.where('ts').below(saved.cp).count()) === saved.n) {
    b = { ...saved.b };
    if (saved.cp < cp) await db.journal.where('ts').between(saved.cp, cp, true, false).each(e => addEntry(b, e));
  } else {
    b = {};
    await db.journal.where('ts').below(cp).each(e => addEntry(b, e));
  }
  if (!saved || saved.cp !== cp) {
    const v = { cp, n: await db.journal.where('ts').below(cp).count(), b: { ...b } };
    writeSoon(() => db.syncMeta.put({ key: 'bal:cp', v }));          // screens read this inside a live query: save a moment later
  }
  await db.journal.where('ts').aboveOrEqual(cp).each(e => addEntry(b, e));
  return b;
}

export async function balances(untilTs = Infinity, fromTs = -Infinity) {
  if (untilTs === Infinity && fromTs === -Infinity) return allTimeBalances();
  // "Up to now" (balance sheet, profit so far): the saved total, minus the few entries dated after `untilTs`.
  if (fromTs === -Infinity && untilTs >= new Date().setHours(0, 0, 0, 0)) {
    const b = await allTimeBalances();
    await db.journal.where('ts').above(untilTs).each(e => e.lines.forEach(l => (b[l.acc] = r2((b[l.acc] || 0) - (l.dr || 0) + (l.cr || 0)))));
    return b;
  }
  const b = {};
  const lo = fromTs === -Infinity ? -Infinity : fromTs, hi = untilTs === Infinity ? Infinity : untilTs;
  // Only the asked dates are read (ts index).
  await db.journal.where('ts').between(lo, hi, true, true).each(e => addEntry(b, e));
  return b;
}

export async function ledger(accId) {
  const j = await db.journal.where('accs').equals(accId).sortBy('ts');   // only entries of this account
  let run = 0;
  const rows = [];
  j.forEach(e => e.lines.filter(l => l.acc === accId).forEach(l => {
    run = r2(run + (l.dr || 0) - (l.cr || 0));
    rows.push({ ts: e.ts, ref: e.ref, narration: e.narration, dr: l.dr || 0, cr: l.cr || 0, bal: run });
  }));
  return rows;
}

export async function profitAndLoss(fromTs, toTs) {
  const b = await balances(toTs, fromTs);
  const accs = await db.accounts.toArray();
  const income = accs.filter(a => a.group === 'income').map(a => ({ ...a, amt: -(b[a.id] || 0) })).filter(a => a.amt);
  const expense = accs.filter(a => a.group === 'expense').map(a => ({ ...a, amt: b[a.id] || 0 })).filter(a => a.amt);
  const ti = r2(sum(income, a => a.amt)), te = r2(sum(expense, a => a.amt));
  return { income, expense, totalIncome: ti, totalExpense: te, profit: r2(ti - te) };
}

export async function balanceSheet(untilTs = Date.now()) {
  const b = await balances(untilTs);
  const accs = await db.accounts.toArray();
  // A customer's or supplier's account row can arrive from another counter after its entries do:
  // their money still belongs on the balance sheet.
  const known = new Set(accs.map(a => a.id));
  for (const id of Object.keys(b)) if (!known.has(id) && /^(cust|supp):/.test(id)) accs.push({ id, name: id, group: id.startsWith('cust:') ? 'asset' : 'liability', party: id.slice(0, 4) });
  const pl = await profitAndLoss(-Infinity, untilTs);
  const assets = accs.filter(a => a.group === 'asset').map(a => ({ ...a, amt: b[a.id] || 0 })).filter(a => Math.abs(a.amt) >= 0.01);
  const liabs = accs.filter(a => a.group === 'liability').map(a => ({ ...a, amt: -(b[a.id] || 0) })).filter(a => Math.abs(a.amt) >= 0.01);
  const equity = accs.filter(a => a.group === 'equity').map(a => ({ ...a, amt: -(b[a.id] || 0) }));
  equity.push({ id: 'pl', name: 'Profit so far', amt: pl.profit });
  return { assets, liabs, equity, totalAssets: r2(sum(assets, a => a.amt)), totalLiabs: r2(sum(liabs, a => a.amt) + sum(equity, a => a.amt)) };
}

// Tally Prime / ERP 9 import XML (vouchers). The accountant imports it via Gateway › Import › Vouchers.
export function tallyXML(entries, accNames, companyName) {
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const vtype = { sale: 'Sales', purchase: 'Purchase', receipt: 'Receipt', payment: 'Payment', credit_note: 'Credit Note', debit_note: 'Debit Note' };
  const v = entries.map(e => {
    const d = new Date(e.ts);
    const date = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const legs = e.lines.map(l => `
      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${esc(accNames[l.acc] || l.acc)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${l.dr ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
        <AMOUNT>${l.dr ? -l.dr : l.cr}</AMOUNT>
      </ALLLEDGERENTRIES.LIST>`).join('');
    return `
    <TALLYMESSAGE xmlns:UDF="TallyUDF">
      <VOUCHER VCHTYPE="${vtype[e.type] || 'Journal'}" ACTION="Create">
        <DATE>${date}</DATE>
        <VOUCHERTYPENAME>${vtype[e.type] || 'Journal'}</VOUCHERTYPENAME>
        <VOUCHERNUMBER>${esc(e.ref)}</VOUCHERNUMBER>
        <NARRATION>${esc(e.narration)}</NARRATION>${legs}
      </VOUCHER>
    </TALLYMESSAGE>`;
  }).join('');
  return `<ENVELOPE>
  <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
  <BODY><IMPORTDATA>
    <REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
    <REQUESTDATA>${v}
    </REQUESTDATA>
  </IMPORTDATA></BODY>
</ENVELOPE>`;
}
