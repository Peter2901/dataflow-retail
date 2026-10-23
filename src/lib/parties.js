// Money owed by customers (udhaar) and owed to suppliers, worked out from the books.
import { db } from '../db.js';
import { r2, daysBetween } from './util.js';

export async function partyBalances(kind) {
  // Only the entries that touch a customer / supplier account (indexed), not the whole books.
  const keys = [...new Set(await db.journal.where('accs').startsWith(kind + ':').primaryKeys())];
  const j = (await db.journal.bulkGet(keys)).filter(Boolean);
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
  const acc = 'cust:' + id;
  const j = await db.journal.where('accs').equals(acc).toArray();
  let v = 0;
  j.forEach(e => e.lines.forEach(l => { if (l.acc === acc) v += (l.dr || 0) - (l.cr || 0); }));
  return r2(v);
}

// Ageing: oldest unpaid credit bills first (payments settle the oldest bills).
export async function customerAgeing() {
  const bal = await partyBalances('cust');
  const ids = Object.entries(bal).filter(([, d]) => d > 0.5).map(([id]) => id);
  const credit = (ids.length ? await db.sales.where('customerId').anyOf(ids).toArray() : []).filter(s => s.payments.some(p => p.mode === 'credit')).sort((a, b) => b.ts - a.ts);
  const byCust = {};
  for (const s of credit) (byCust[s.customerId] = byCust[s.customerId] || []).push(s);   // grouped once, newest first
  const out = {};
  for (const [cid, due] of Object.entries(bal)) {
    if (due <= 0.5) continue;
    let left = due;
    const buckets = { b0: 0, b30: 0, b60: 0, b90: 0 };
    let oldest = null;
    for (const s of byCust[cid] || []) {
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
