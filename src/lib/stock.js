// Stock, batches and expiry. Every unit belongs to a batch with an expiry date.
import { db } from '../db.js';
import { daysBetween, uid } from './util.js';

export const DEFAULT_EXPIRY = {
  stopReorderDays: 90, frontDisplayDays: 60, returnWindowDays: 45,
  markdown30Pct: 15, markdown14Pct: 30, lastWeekDays: 7, lastWeekRule: 'discount', lastWeekPct: 50,
};

export function daysLeft(expiry) {
  if (!expiry) return 9999;
  return daysBetween(new Date(), new Date(expiry));
}

// Which step of the expiry plan a batch is in.
export function expiryZone(dl, cfg = DEFAULT_EXPIRY) {
  if (dl < 0) return { key: 'expired', label: 'Expired', tone: 'bad', markdown: 0, sellable: false };
  if (dl <= cfg.lastWeekDays) return cfg.lastWeekRule === 'block'
    ? { key: 'week', label: `${dl}d left · sale stopped`, tone: 'bad', markdown: 0, sellable: false }
    : { key: 'week', label: `${dl}d left · ${cfg.lastWeekPct}% off`, tone: 'bad', markdown: cfg.lastWeekPct, sellable: true };
  if (dl <= 14) return { key: 'd14', label: `${dl}d left · ${cfg.markdown14Pct}% off`, tone: 'warn', markdown: cfg.markdown14Pct, sellable: true };
  if (dl <= 30) return { key: 'd30', label: `${dl}d left · ${cfg.markdown30Pct}% off`, tone: 'warn', markdown: cfg.markdown30Pct, sellable: true };
  if (dl <= cfg.frontDisplayDays) return { key: 'd60', label: `${dl}d left · move to front`, tone: 'info', markdown: 0, sellable: true };
  if (dl <= cfg.stopReorderDays) return { key: 'd90', label: `${dl}d left · stop reordering`, tone: 'info', markdown: 0, sellable: true };
  return { key: 'ok', label: dl > 3000 ? 'No expiry' : `${dl}d left`, tone: 'ok', markdown: 0, sellable: true };
}

export async function batchesFor(productId, storeId) {
  const all = await db.batches.where('productId').equals(productId).toArray();
  return all.filter(b => b.storeId === storeId && b.status === 'active' && b.qty > 0.0001)
    .sort((a, b) => String(a.expiry || '9999').localeCompare(String(b.expiry || '9999')));
}

export async function stockMap(storeId) {
  const all = await db.batches.where('storeId').equals(storeId).toArray();
  const m = {};
  all.forEach(b => { if (b.status === 'active') m[b.productId] = (m[b.productId] || 0) + b.qty; });
  return m;
}

export async function reservedMap() {
  const orders = await db.orders.toArray();
  const m = {};
  orders.filter(o => ['new', 'packing', 'ready'].includes(o.status))
    .forEach(o => o.items.forEach(i => (m[i.productId] = (m[i.productId] || 0) + i.qty)));
  return m;
}

/**
 * First-Expired-First-Out allocation. Returns [{batchId, batchNo, expiry, qty, markdown, zone}].
 * Never sells expired stock. If the system count is short, the sale still goes through on the
 * newest batch (stock goes negative) and the manager is alerted — a customer is never turned away.
 */
export async function allocateFEFO(productId, qty, storeId, cfg = DEFAULT_EXPIRY) {
  const batches = await batchesFor(productId, storeId);
  let need = Number(qty);
  const alloc = [];
  const blocked = [];
  for (const b of batches) {
    if (need <= 0) break;
    const z = expiryZone(daysLeft(b.expiry), cfg);
    if (!z.sellable) { blocked.push({ ...b, zone: z }); continue; }
    const take = Math.min(need, b.qty);
    alloc.push({ batchId: b.id, batchNo: b.batchNo, expiry: b.expiry, qty: take, markdown: z.markdown, zone: z.key });
    need -= take;
  }
  let shortfall = 0;
  if (need > 0.0001) {
    shortfall = need;
    if (alloc.length) alloc[alloc.length - 1].qty += need;
    else if (!blocked.length || batches.some(b => expiryZone(daysLeft(b.expiry), cfg).sellable)) {
      alloc.push({ batchId: null, batchNo: 'NO-STOCK', expiry: null, qty: need, markdown: 0, zone: 'ok' });
    }
  }
  return { alloc, blocked, shortfall };
}

export async function moveStock({ batchId, productId, storeId, qty, type, ref, note }) {
  // Read-and-change in one step: a sync landing on the same batch at the same moment can't undo it.
  if (batchId) await db.batches.where('id').equals(batchId).modify(b => { b.qty = Math.round((b.qty + qty) * 1000) / 1000; });
  await db.stockMoves.add({ ts: Date.now(), productId, batchId, storeId, qty, type, ref, note: note || '' });
}

export async function addBatch({ productId, storeId, batchNo, mfg, expiry, qty, cost, ref, mrp }) {
  const id = uid('b_');
  await db.batches.add({ id, productId, storeId, batchNo: batchNo || 'B' + Date.now().toString().slice(-6), mfg: mfg || null, expiry: expiry || null, qty: 0, cost: Number(cost) || 0, mrp: Number(mrp) || null, status: 'active', receivedAt: Date.now() });
  await moveStock({ batchId: id, productId, storeId, qty: Number(qty), type: 'purchase', ref });
  return id;
}

// Weighted-average cost of what's on hand (used for margins and stock value).
export async function stockValue(storeId) {
  const all = await db.batches.where('storeId').equals(storeId).toArray();
  return all.filter(b => b.status === 'active' && b.qty > 0).reduce((a, b) => a + b.qty * b.cost, 0);
}
