// Saving a bill: number it, chain it (tamper-proof), move stock by batch, update loyalty,
// post the accounts, and queue it for cloud sync.
import { db, getSettings, setSetting } from '../db.js';
import { uid, sha256, fyOf, r2, sum } from './util.js';
import { invoiceNumber } from './billing.js';
import { moveStock } from './stock.js';
import { postSale } from './accounts.js';

export const TIERS = [
  { key: 'Silver', min: 0, mult: 1 },
  { key: 'Gold', min: 25000, mult: 1.25 },
  { key: 'Platinum', min: 75000, mult: 1.5 },
];
export const tierFor = spend => [...TIERS].reverse().find(t => spend >= t.min) || TIERS[0];

export async function audit(action, detail, user) {
  const last = await db.audit.orderBy('ts').last();
  const ts = Date.now();
  const prev = last?.hash || 'GENESIS';
  const hash = await sha256(prev + '|' + ts + '|' + action + '|' + JSON.stringify(detail || {}));
  await db.audit.add({ id: uid('a_'), ts, action, detail, userId: user?.id || 'system', userName: user?.name || 'System', prevHash: prev, hash });
}

async function nextInvoiceNo(settings, ts) {
  const fy = fyOf(new Date(ts));
  const key = `seq_${settings.storeCode}${settings.terminal}_${fy.short}`;
  const cur = Number(settings[key] || 0) + 1;
  await setSetting(key, cur);
  return invoiceNumber(settings.storeCode, settings.terminal, fy.short, cur);
}

// Bills are chained in the order they were saved (not by bill time), per store.
export async function lastSaleHash(storeId) {
  const all = await db.sales.where('storeId').equals(storeId).sortBy('chainSeq');
  return all.length ? all[all.length - 1].hash : 'GENESIS';
}

export const chainInput = s => [s.prevHash, s.chainSeq, s.no, s.ts, s.totals.payable, s.lines.length, sum(s.lines, l => l.taxable).toFixed(2)].join('|');

/**
 * bill: result of computeBill; payments: [{mode, amount, ref}]
 */
export async function saveSale({ bill, payments, customer, user, shiftId, storeId, type = 'sale', origNo = null, pointsUsed = 0, ts = Date.now(), orderId = null, b2b = null }) {
  const settings = await getSettings();
  const no = await nextInvoiceNo(settings, ts);
  const prevHash = await lastSaleHash(storeId);
  const chainSeq = Number(settings[`chain_${storeId}`] || 0) + 1;
  await setSetting(`chain_${storeId}`, chainSeq);
  const sale = {
    chainSeq,
    id: uid('s_'), no, ts, storeId, type, origNo, status: 'done', shiftId, orderId,
    cashierId: user?.id, cashierName: user?.name, customerId: customer?.id || null, customerName: customer?.name || '',
    customerPhone: customer?.phone || '', b2b, lines: bill.lines, totals: bill.totals, billDiscounts: bill.billDiscounts || [],
    payments, pointsUsed, pointsEarned: 0, prevHash,
  };
  // Loyalty: points on what was paid (not on points used), with tier multiplier.
  if (customer && type === 'sale') {
    const rate = Number(settings.pointsPer100 || 1);
    const tier = tierFor(customer.yearSpend || 0);
    const paid = sale.totals.payable - pointsUsed;
    sale.pointsEarned = Math.floor((paid / 100) * rate * tier.mult);
  }
  sale.hash = await sha256(chainInput(sale));
  await db.sales.add(sale);

  const sign = type === 'return' ? 1 : -1;
  for (const l of bill.lines) {
    for (const a of l.batches || []) {
      await moveStock({ batchId: a.batchId, productId: l.productId, storeId, qty: sign * a.qty, type, ref: no });
    }
  }
  if (customer) {
    const c = await db.customers.get(customer.id);
    const spendDelta = type === 'return' ? -sale.totals.payable : sale.totals.payable;
    const points = (c.points || 0) + sale.pointsEarned - pointsUsed;
    await db.customers.update(c.id, {
      points: Math.max(0, points), yearSpend: r2((c.yearSpend || 0) + spendDelta),
      lifeSpend: r2((c.lifeSpend || 0) + spendDelta), visits: (c.visits || 0) + (type === 'sale' ? 1 : 0), lastVisit: ts,
    });
    if (sale.pointsEarned) await db.loyaltyTx.add({ customerId: c.id, ts, type: 'earn', points: sale.pointsEarned, ref: no });
    if (pointsUsed) await db.loyaltyTx.add({ customerId: c.id, ts, type: 'redeem', points: -pointsUsed, ref: no });
  }
  await postSale(sale, customer);
  await db.outbox.add({ ts, kind: 'sale', ref: sale.id, synced: 0 });
  await audit(type === 'return' ? 'return' : 'bill', { no, amount: sale.totals.payable }, user);
  return sale;
}

// Re-checks every bill against the chain. Any deleted or edited bill breaks it.
export async function verifyChain(storeId) {
  const all = await db.sales.where('storeId').equals(storeId).sortBy('chainSeq');
  let prev = 'GENESIS';
  const problems = [];
  for (const s of all) {
    if (s.prevHash !== prev) problems.push({ no: s.no, issue: 'A bill before this one is missing or changed' });
    const h = await sha256(chainInput(s));
    if (h !== s.hash) problems.push({ no: s.no, issue: 'This bill was edited after saving' });
    prev = s.hash;
  }
  return { count: all.length, problems };
}
