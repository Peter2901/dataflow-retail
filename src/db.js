// Local database (IndexedDB via Dexie). Every counter keeps its own full copy,
// so billing works with no internet. Changes also carry an `updatedAt` stamp and
// (for stock moves) a global `sid`, which the cloud sync in lib/sync.js uses.
import Dexie from 'dexie';
import { seedDemo } from './seed.js';
import { uid } from './lib/util.js';

export const db = new Dexie('dataflow_retail');

// Which counter this device is. Set from Settings after load (see lib/sync.js).
let COUNTER = 'T1';
export const setSyncCounter = c => { COUNTER = c || 'T1'; };
export const syncCounter = () => COUNTER;

db.version(2).stores({
  settings: 'key',
  users: 'id, role',
  stores: 'id',
  products: 'id, barcode, name, category, brand, vendorId, updatedAt',
  batches: 'id, productId, storeId, expiry, status, updatedAt',
  stockMoves: '++id, ts, productId, batchId, storeId, type, ref, sid, updatedAt',
  customers: 'id, phone, name, updatedAt',
  loyaltyTx: '++id, customerId, ts, updatedAt',
  followups: 'id, customerId, due, done',
  suppliers: 'id, name, gstin, updatedAt',
  purchases: 'id, no, supplierId, date, storeId, updatedAt',
  debitNotes: 'id, no, supplierId, date',
  purchaseOrders: 'id, no, supplierId, date, status',
  sales: 'id, no, ts, storeId, customerId, shiftId, type, status, updatedAt',
  held: 'id, ts',
  shifts: 'id, userId, storeId, openedAt, closedAt',
  orders: 'id, no, customerId, status, createdAt, updatedAt',
  offers: 'id, type, active, updatedAt',
  accounts: 'id, group, name',
  journal: 'id, ts, ref, type, updatedAt',
  bankLines: 'id, date, matched',
  employees: 'id, name',
  attendance: 'id, empId, date',
  payroll: 'id, empId, month',
  audit: 'id, ts, action',
  reportsSaved: 'id',
  outbox: '++id, ts, kind, synced',
  syncMeta: 'key',
  appliedMoves: 'sid',
});

// Tables that sync to the cloud. Append-only logs and shared master data only;
// local-only things (settings, users, shifts, held, bank lines) stay on the device.
export const SYNC_TABLES = ['products', 'batches', 'stockMoves', 'customers', 'suppliers', 'purchases', 'sales', 'orders', 'offers', 'journal'];

// Auto-stamp every create/update so the sync knows what is new. Rows that arrived
// from another counter carry `_oc` (origin counter) and are never pushed back.
for (const t of SYNC_TABLES) {
  db[t].hook('creating', (primKey, obj) => {
    if (!obj.updatedAt) obj.updatedAt = Date.now();
    if (t === 'stockMoves' && !obj.sid) obj.sid = COUNTER + ':' + uid();
  });
  db[t].hook('updating', (mods, primKey, obj) => {
    // If this change isn't just the sync writing an incoming row, bump the stamp.
    if (!('_oc' in mods)) return { updatedAt: Date.now() };
  });
}

export async function ensureSeeded() {
  const n = await db.settings.count();
  if (n === 0) await seedDemo(db);
}

export async function getSettings() {
  const rows = await db.settings.toArray();
  const s = {};
  rows.forEach(r => (s[r.key] = r.value));
  return s;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
}

export async function resetAll() {
  await db.delete();
  await db.open();
}
