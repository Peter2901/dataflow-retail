// Saving a bill: number it, chain it (tamper-proof), move stock by batch, update loyalty,
// post the accounts, and queue it for cloud sync.
import { db, syncCounter, getSettings } from '../db.js';
import { uid, sha256, fyOf, r2, sum } from './util.js';
import { invoiceNumber } from './billing.js';
import { saleEntry } from './accounts.js';
import { touchDay } from './daysums.js';

export const TIERS = [
  { key: 'Silver', min: 0, mult: 1 },
  { key: 'Gold', min: 25000, mult: 1.25 },
  { key: 'Platinum', min: 75000, mult: 1.5 },
];
export const tierFor = spend => [...TIERS].reverse().find(t => spend >= t.min) || TIERS[0];

// One thing at a time: bills (and audit entries) are numbered and chained under a lock, so two quick
// presses, two open tabs or a background job can never take the same number or fork a chain.
const queues = {};
export function withLock(name, fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) return navigator.locks.request('dfr-' + name, fn);
  const run = (queues[name] || Promise.resolve()).then(fn, fn);
  queues[name] = run.catch(() => {});
  return run;
}

// Each device keeps its own tamper-proof chain (rows synced from other devices carry _oc).
// Times only go forward, so two entries in the same millisecond still sort in chain order.
async function nextAuditRow(action, detail, user) {
  const last = await db.audit.orderBy('ts').reverse().filter(a => !a._oc).first();
  const ts = Math.max(Date.now(), (last?.ts || 0) + 1);
  const prev = last?.hash || 'GENESIS';
  const hash = await sha256(prev + '|' + ts + '|' + action + '|' + JSON.stringify(detail || {}));
  return { id: uid('a_'), ts, action, detail, userId: user?.id || 'system', userName: user?.name || 'System', dev: syncCounter(), prevHash: prev, hash };
}
export function audit(action, detail, user) {
  return withLock('audit', async () => { await db.audit.add(await nextAuditRow(action, detail, user)); });
}

// Invoice numbers never repeat in a financial year: the next number is above both the saved
// counter and the highest bill of this counter already on the device (e.g. after a PC was replaced
// and its old bills came back from the cloud).
// (Saved together with the bill, in saveSaleNow.)
async function nextInvoiceNo(settings, ts) {
  const fy = fyOf(new Date(ts));
  const key = `seq_${settings.storeCode}${settings.terminal}_${fy.short}`;
  const prefix = invoiceNumber(settings.storeCode, settings.terminal, fy.short, 0).replace(/0+$/, '');
  const last = await db.sales.where('no').startsWith(prefix).last();
  const fromBills = last ? Number(String(last.no).slice(prefix.length)) || 0 : 0;
  const cur = Math.max(Number(settings[key] || 0), fromBills) + 1;
  return invoiceNumber(settings.storeCode, settings.terminal, fy.short, cur);
}

// Bills are chained in the order they were saved (not by bill time), per counter.
// The counter is the bill-number prefix (e.g. "S1T2"), so synced bills from other
// counters sit in their own chains and never break this one.
export const chainKey = s => String(s.no || '').split('/')[0];

// The newest bill of this counter's chain = its highest bill number (indexed), so saving a bill
// never reads every bill, and nothing can go stale (restores, bills coming back from the cloud).
export async function chainHead(storeId, key) {
  const last = await db.sales.where('no').startsWith(key + '/').reverse().filter(s => s.storeId === storeId && chainKey(s) === key).first();
  return last ? { hash: last.hash, chainSeq: last.chainSeq || 0 } : { hash: 'GENESIS', chainSeq: 0 };
}
export async function lastSaleHash(storeId, key) { return (await chainHead(storeId, key)).hash; }

export const chainInput = s => [s.prevHash, s.chainSeq, s.no, s.ts, s.totals.payable, s.lines.length, sum(s.lines, l => l.taxable).toFixed(2)].join('|');

/**
 * bill: result of computeBill; payments: [{mode, amount, ref}]
 */
// ── Loyalty points, spend and visits are worked out from the customer's bills, so every counter
// arrives at the same numbers whatever order the bills sync in. `base` holds what came from before
// (opening points, old spend) that no bill on record explains.
const billEffect = list => list.reduce((a, s) => {
  const sign = s.type === 'return' ? -1 : 1;
  a.points += (s.pointsEarned || 0) - (s.pointsUsed || 0); a.spend = r2(a.spend + sign * (s.totals?.payable || 0));
  a.visits += s.type === 'sale' ? 1 : 0; a.last = Math.max(a.last, s.ts || 0); return a;
}, { points: 0, spend: 0, visits: 0, last: 0 });

/** Make sure the customer has `base` (call before a new bill of theirs is stored). Worked out only on a
 *  device that owns the row: a copy from the cloud may count bills this device has not received yet. */
export async function ensureCustomerBase(id, { force = false } = {}) {
  const c = await db.customers.get(id);
  if (!c || c.base || (c._oc && !force)) return c;
  const e = billEffect(await db.sales.where('customerId').equals(id).toArray());
  const base = { points: (c.points || 0) - e.points, yearSpend: r2((c.yearSpend || 0) - e.spend), lifeSpend: r2((c.lifeSpend || 0) - e.spend), visits: (c.visits || 0) - e.visits };
  await db.customers.update(id, { base });
  return { ...c, base };
}

/** Points / spend / visits = base + every bill of this customer on this device. */
export async function recalcCustomer(id) {
  const c = await ensureCustomerBase(id);
  if (!c?.base) return;
  const e = billEffect(await db.sales.where('customerId').equals(id).toArray());
  const b = c.base;
  const next = { points: Math.max(0, b.points + e.points), yearSpend: r2(b.yearSpend + e.spend), lifeSpend: r2(b.lifeSpend + e.spend), visits: Math.max(0, b.visits + e.visits), lastVisit: Math.max(c.lastVisit || 0, e.last) || null };
  if (['points', 'yearSpend', 'lifeSpend', 'visits', 'lastVisit'].some(k => (c[k] ?? null) !== next[k])) await db.customers.update(id, next);
}

/** One new bill of this customer (here or from another counter): add just its effect — no re-reading. */
export async function addBillToCustomer(id, s) {
  const e = billEffect([s]);
  await db.customers.where('id').equals(id).modify(c => {
    if (!c.base) return;
    c.points = Math.max(0, (c.points || 0) + e.points); c.yearSpend = r2((c.yearSpend || 0) + e.spend); c.lifeSpend = r2((c.lifeSpend || 0) + e.spend);
    c.visits = Math.max(0, (c.visits || 0) + e.visits); if (e.last > (c.lastVisit || 0)) c.lastVisit = e.last;
  });
}

export function saveSale(args) {
  return withLock('sale', () => saveSaleNow(args));
}

// Everything a bill changes (bill, stock, customer, books, audit) is written in ONE database
// transaction: it is all saved or none of it (power cut, crash), and it is one disk write, not 25.
async function saveSaleNow({ bill, payments, customer, user, shiftId, storeId, type = 'sale', origNo = null, pointsUsed = 0, ts = Date.now(), orderId = null, b2b = null, priceMode = 'retail' }) {
  const settings = await getSettings();
  const no = await nextInvoiceNo(settings, ts);
  const key = chainKey({ no });
  const head = await chainHead(storeId, key);
  const chainSeq = Math.max(Number(settings[`chain_${storeId}`] || 0), head.chainSeq || 0) + 1;
  const sale = {
    chainSeq,
    id: uid('s_'), no, ts, storeId, type, origNo, status: 'done', shiftId, orderId,
    cashierId: user?.id, cashierName: user?.name, customerId: customer?.id || null, customerName: customer?.name || '',
    customerPhone: customer?.phone || '', b2b, lines: bill.lines, totals: bill.totals, billDiscounts: bill.billDiscounts || [],
    payments, pointsUsed, pointsEarned: 0, prevHash: head.hash, ...(priceMode === 'wholesale' ? { priceMode } : {}),
  };
  // Loyalty: points on what was paid (not on points used), with tier multiplier.
  if (customer && type === 'sale') {
    const rate = Number(settings.pointsPer100 || 1);
    const tier = tierFor(customer.yearSpend || 0);
    const paid = sale.totals.payable - pointsUsed;
    sale.pointsEarned = Math.floor((paid / 100) * rate * tier.mult);
  }
  sale.hash = await sha256(chainInput(sale));
  const custAcc = customer && payments.some(p => p.mode === 'credit') ? `cust:${customer.id}` : null;
  const entry = saleEntry(sale, custAcc);
  if (customer) await ensureCustomerBase(customer.id, { force: true });
  const sign = type === 'return' ? 1 : -1;
  const now = Date.now();
  await withLock('audit', async () => {
    const auditRow = await nextAuditRow(type === 'return' ? 'return' : 'bill', { no, amount: sale.totals.payable }, user);
    await db.transaction('rw', [db.sales, db.settings, db.batches, db.stockMoves, db.customers, db.loyaltyTx, db.journal, db.accounts, db.audit, db.daySums], async () => {
      await db.sales.add(sale);
      await db.settings.bulkPut([
        { key: `seq_${settings.storeCode}${settings.terminal}_${fyOf(new Date(ts)).short}`, value: Number(no.split('/').pop()) },
        { key: `chain_${storeId}`, value: chainSeq },
      ]);
      for (const l of bill.lines) {
        for (const a of l.batches || []) {
          if (a.batchId) await db.batches.where('id').equals(a.batchId).modify(b => { b.qty = Math.round((b.qty + sign * a.qty) * 1000) / 1000; });
          await db.stockMoves.add({ ts: now, productId: l.productId, batchId: a.batchId, storeId, qty: sign * a.qty, type, ref: no, note: '' });
        }
      }
      if (customer) {
        await addBillToCustomer(customer.id, sale);
        if (sale.pointsEarned) await db.loyaltyTx.add({ customerId: customer.id, ts, type: 'earn', points: sale.pointsEarned, ref: no });
        if (pointsUsed) await db.loyaltyTx.add({ customerId: customer.id, ts, type: 'redeem', points: -pointsUsed, ref: no });
        if (custAcc && !(await db.accounts.get(custAcc))) await db.accounts.add({ id: custAcc, name: customer.name, group: 'asset', party: 'cust', partyId: customer.id });
      }
      await db.journal.add(entry);
      await db.audit.add(auditRow);
      await touchDay(storeId, ts);          // a back-dated bill: that day's totals are summed again
    });
  });
  return sale;
}

// Re-checks every bill against the chain. Any deleted or edited bill breaks it.
export async function verifyChain(storeId) {
  const all = await db.sales.where('storeId').equals(storeId).sortBy('chainSeq');
  const chains = {};
  for (const s of all) (chains[chainKey(s)] ||= []).push(s);
  const problems = [];
  for (const list of Object.values(chains)) {
    let prev = 'GENESIS';
    for (const s of list) {
      if (s.prevHash !== prev) problems.push({ no: s.no, issue: 'A bill before this one is missing or changed' });
      const h = await sha256(chainInput(s));
      if (h !== s.hash) problems.push({ no: s.no, issue: 'This bill was edited after saving' });
      prev = s.hash;
    }
  }
  return { count: all.length, problems };
}
