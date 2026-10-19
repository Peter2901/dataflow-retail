// Local database (IndexedDB via Dexie). Every counter keeps its own full copy,
// so billing works with no internet.
import Dexie from 'dexie';
import { seedDemo } from './seed.js';

export const db = new Dexie('dataflow_retail');

db.version(1).stores({
  settings: 'key',
  users: 'id, role',
  stores: 'id',
  products: 'id, barcode, name, category, brand, vendorId',
  batches: 'id, productId, storeId, expiry, status',
  stockMoves: '++id, ts, productId, batchId, storeId, type, ref',
  customers: 'id, phone, name',
  loyaltyTx: '++id, customerId, ts',
  followups: 'id, customerId, due, done',
  suppliers: 'id, name, gstin',
  purchases: 'id, no, supplierId, date, storeId',
  debitNotes: 'id, no, supplierId, date',
  purchaseOrders: 'id, no, supplierId, date, status',
  sales: 'id, no, ts, storeId, customerId, shiftId, type, status',
  held: 'id, ts',
  shifts: 'id, userId, storeId, openedAt, closedAt',
  orders: 'id, no, customerId, status, createdAt',
  offers: 'id, type, active',
  accounts: 'id, group, name',
  journal: 'id, ts, ref, type',
  bankLines: 'id, date, matched',
  employees: 'id, name',
  attendance: 'id, empId, date',
  payroll: 'id, empId, month',
  audit: 'id, ts, action',
  reportsSaved: 'id',
  outbox: '++id, ts, kind, synced',
});

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
