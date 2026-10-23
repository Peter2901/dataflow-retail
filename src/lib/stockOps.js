// Stock jobs done from the Stock and Expiry screens: write-offs, count corrections and moving stock
// to another branch. Kept outside the screens so the big tests run the same code.
import { db } from '../db.js';
import { r2, uid } from './util.js';
import { moveStock } from './stock.js';
import { post } from './accounts.js';
import { audit } from './sales.js';

export const REASONS = { damaged: 'Damaged / broken', expired: 'Expired', theft: 'Missing / theft', count: 'Count correction', sample: 'Free sample / own use' };

// Writing off goods: stock leaves the books, and GST input credit is reversed for lost,
// destroyed, expired or stolen goods (CGST Act s.17(5)(h)). Count corrections upward add stock back.
export async function writeOff({ batch, product, qty, reason, user, approvedBy }) {
  const value = r2(qty * batch.cost);
  await moveStock({ batchId: batch.id, productId: product.id, storeId: batch.storeId, qty: -qty, type: 'writeoff', ref: reason, note: approvedBy ? `approved by ${approvedBy}` : '' });
  const itc = reason === 'count' && qty < 0 ? 0 : r2((value * (product.gst || 0)) / 100);
  const lines = qty >= 0
    ? [{ acc: 'shrinkage', dr: r2(value + itc) }, { acc: 'inventory', cr: value }, ...(itc ? [{ acc: 'in_cgst', cr: r2(itc / 2) }, { acc: 'in_sgst', cr: r2(itc - r2(itc / 2)) }] : [])]
    : [{ acc: 'inventory', dr: -value }, { acc: 'shrinkage', cr: -value }];
  await post({ ref: 'WO-' + Date.now().toString().slice(-6), type: 'writeoff', narration: `${REASONS[reason] || reason}: ${product.name} × ${qty}`, lines });
  await audit('write_off', { product: product.name, batch: batch.batchNo, qty, value, reason, approvedBy }, user);
}

// Fields that say where a row came from in the cloud sync. A copied row must not carry them, or the
// sync would think the copy came from another counter and never send it.
const SYNC_FIELDS = ['updatedAt', '_oc', '_seq', '_mv'];
const fresh = row => { const r = { ...row }; SYNC_FIELDS.forEach(k => delete r[k]); return r; };

/** Move part of a batch to another branch. The batch number and expiry go with it. */
export async function transferStock({ batch, qty, to, user, productName = '' }) {
  const q = Number(qty);
  const cur = await db.batches.get(batch.id);
  if (!cur || !to || to === cur.storeId || !(q > 0) || q > cur.qty + 1e-9) throw new Error('Check the batch, branch and quantity.');
  const ref = 'STO-' + Date.now().toString().slice(-6);
  await moveStock({ batchId: cur.id, productId: cur.productId, storeId: cur.storeId, qty: -q, type: 'transfer_out', ref });
  const nid = uid('b_');
  await db.batches.add({ ...fresh(cur), id: nid, storeId: to, qty: 0, receivedAt: Date.now() });
  await moveStock({ batchId: nid, productId: cur.productId, storeId: to, qty: q, type: 'transfer_in', ref });
  await audit('transfer', { product: productName, qty: q, from: cur.storeId, to }, user);
  return { ref, batchId: nid };
}
