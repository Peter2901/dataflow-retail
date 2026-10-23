// Per-day totals of the bills: sales per product, per customer and per cashier.
// Smart features (sales speed, dead stock, festivals, habits, reports) read these small rows instead
// of every bill, so they stay quick after years of D-Mart-size billing. A finished day is summed once
// and kept (table daySums, this device only); today is always summed fresh. A bill for a past day that
// arrives later (an offline counter catching up, a back-dated bill) removes that day's row, so it is
// summed again next time.
import { db } from '../db.js';
import { localISO } from './util.js';

const DAY = 864e5;
const r2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const r3 = n => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
const idOf = (storeId, day) => `${storeId}|${day}`;
const dayStartTs = day => new Date(day + 'T00:00:00').getTime();

/** Sum one day's bills. items: pid → [qty (returns minus), amount, qty sold (sales only), last sale ts]. */
export function summarize(storeId, day, bills) {
  const s = { id: idOf(storeId, day), storeId, day, bills: 0, returns: 0, total: 0, profit: 0, items: {}, custs: {}, custItems: {}, cashiers: {} };
  for (const b of bills) {
    if (b.storeId !== storeId || b.status === 'void') continue;
    const sg = b.type === 'return' ? -1 : 1;
    const pay = b.totals?.payable || 0;
    s.total = r2(s.total + sg * pay);
    if (sg > 0) s.bills++; else s.returns++;
    const who = b.cashierName || 'Unknown';
    const c = (s.cashiers[who] ||= [0, 0, 0]);
    if (sg > 0) c[0]++; else { c[1]++; c[2] = r2(c[2] + pay); }
    for (const l of b.lines || []) {
      const it = (s.items[l.productId] ||= [0, 0, 0, 0]);
      it[0] = r3(it[0] + sg * (l.qty || 0)); it[1] = r2(it[1] + sg * (l.total || 0));
      if (sg > 0) { it[2] = r3(it[2] + (l.qty || 0)); it[3] = Math.max(it[3], b.ts || 0); }
      s.profit = r2(s.profit + sg * ((l.taxable || 0) - (l.qty || 0) * (l.cost || 0)));
    }
    if (b.customerId && sg > 0) {
      const cu = (s.custs[b.customerId] ||= [0, 0, 0]);
      cu[0]++; cu[1] = r2(cu[1] + pay); cu[2] = Math.max(cu[2], b.ts || 0);
      const set = new Set(s.custItems[b.customerId] || []);
      (b.lines || []).forEach(l => set.add(l.productId));
      s.custItems[b.customerId] = [...set];
    }
  }
  return s;
}

async function billsOfDay(day) {
  const t0 = dayStartTs(day);
  return db.sales.where('ts').between(t0, t0 + DAY, true, false).toArray();
}

/** Summaries for every day from `fromDay` to `toDay` (YYYY-MM-DD, both included), oldest first. */
export async function daySumsBetween(storeId, fromDay, toDay) {
  const today = localISO(new Date());
  const days = [];
  for (let t = dayStartTs(fromDay); t <= dayStartTs(toDay); t += DAY) days.push(localISO(new Date(t + 12 * 3600e3)));
  const have = await db.daySums.bulkGet(days.map(d => idOf(storeId, d)));
  const out = [];
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    if (have[i] && d < today) { out.push(have[i]); continue; }
    const s = summarize(storeId, d, await billsOfDay(d));
    if (d < today) await db.daySums.put(s);                 // a finished day is kept
    out.push(s);
  }
  return out;
}

/** The last `n` days including today. */
export function lastDays(storeId, n) {
  const today = new Date();
  return daySumsBetween(storeId, localISO(new Date(today.getTime() - (n - 1) * DAY)), localISO(today));
}

/** A bill for a past day was added (late sync, back-dated): sum that day again next time. */
export async function touchDay(storeId, ts) {
  const d = localISO(new Date(ts));
  if (d < localISO(new Date())) await db.daySums.delete(idOf(storeId, d));
}

/** Add up several days: per product, per customer, per cashier. */
export function combine(sums) {
  const items = {}, custs = {}, cashiers = {};
  let total = 0, profit = 0, bills = 0, returns = 0;
  for (const s of sums) {
    total += s.total; profit += s.profit; bills += s.bills; returns += s.returns;
    for (const [pid, v] of Object.entries(s.items)) { const a = (items[pid] ||= [0, 0, 0, 0]); a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; a[3] = Math.max(a[3], v[3]); }
    for (const [cid, v] of Object.entries(s.custs)) { const a = (custs[cid] ||= [0, 0, 0]); a[0] += v[0]; a[1] += v[1]; a[2] = Math.max(a[2], v[2]); }
    for (const [who, v] of Object.entries(s.cashiers)) { const a = (cashiers[who] ||= [0, 0, 0]); a[0] += v[0]; a[1] += v[1]; a[2] += v[2]; }
  }
  return { items, custs, cashiers, total: r2(total), profit: r2(profit), bills, returns };
}
