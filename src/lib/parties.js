// Money owed by customers (udhaar) and owed to suppliers, worked out from the books.
import { db } from '../db.js';
import { r2, daysBetween } from './util.js';

export async function partyBalances(kind) {
  const j = await db.journal.toArray();
  const m = {};
  j.forEach(e => e.lines.forEach(l => {
    if (l.acc.startsWith(kind + ':')) {
      const id = l.acc.slice(kind.length + 1);
      m[id] = r2((m[id] || 0) + (l.dr || 0) - (l.cr || 0));
    }
  }));
  return m; // cust: positive = customer owes us; supp: negative = we owe supplier
}

export async function customerDue(id) {
  return (await partyBalances('cust'))[id] || 0;
}

// Ageing: oldest unpaid credit bills first (payments settle the oldest bills).
export async function customerAgeing() {
  const bal = await partyBalances('cust');
  const sales = (await db.sales.toArray()).filter(s => s.payments.some(p => p.mode === 'credit')).sort((a, b) => b.ts - a.ts);
  const out = {};
  for (const [cid, due] of Object.entries(bal)) {
    if (due <= 0.5) continue;
    let left = due;
    const buckets = { b0: 0, b30: 0, b60: 0, b90: 0 };
    let oldest = null;
    for (const s of sales.filter(x => x.customerId === cid)) {
      if (left <= 0) break;
      const amt = Math.min(left, s.payments.filter(p => p.mode === 'credit').reduce((a, p) => a + p.amount, 0));
      const age = daysBetween(new Date(s.ts), new Date());
      const k = age > 90 ? 'b90' : age > 60 ? 'b60' : age > 30 ? 'b30' : 'b0';
      buckets[k] = r2(buckets[k] + amt); left = r2(left - amt); oldest = s.ts;
    }
    if (left > 0) buckets.b90 = r2(buckets.b90 + left);
    out[cid] = { due, ...buckets, oldest };
  }
  return out;
}
