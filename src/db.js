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

// v3: supplier memory — what each supplier calls an item on their bill, and how many
// pieces are in their unit (e.g. "PARLE G 100G*12" from Shree Agency = Parle-G 100 g, 1 case = 12).
db.version(3).stores({
  itemAliases: 'id, supplierId, productId, updatedAt',
});

// v4 (stress-tested for busy stores): every synced table gets an updatedAt index, so the
// background sync reads only what changed instead of whole tables; journal entries are indexed
// by account (*accs), so one customer's udhaar is read without loading all the books.
db.version(4).stores({
  users: 'id, role, updatedAt',
  shifts: 'id, userId, storeId, openedAt, closedAt, updatedAt',
  audit: 'id, ts, action, updatedAt',
  debitNotes: 'id, no, supplierId, date, updatedAt',
  purchaseOrders: 'id, no, supplierId, date, status, updatedAt',
  followups: 'id, customerId, due, done, updatedAt',
  employees: 'id, name, updatedAt',
  attendance: 'id, empId, date, updatedAt',
  payroll: 'id, empId, month, updatedAt',
  stores: 'id, updatedAt',
  accounts: 'id, group, name, updatedAt',
  bankLines: 'id, date, matched, updatedAt',
  journal: 'id, ts, ref, type, updatedAt, *accs',
}).upgrade(tx => tx.table('journal').toCollection().modify(j => { j.accs = journalAccs(j); }));

// v5: per-day sales summaries for the smart features (this device only, rebuilt when needed).
db.version(5).stores({ daySums: 'id, storeId, day' });

// v6: origNo — the returns of a bill are found without reading every bill.
db.version(6).stores({ sales: 'id, no, ts, storeId, customerId, shiftId, type, status, updatedAt, origNo' });

export function journalAccs(j) { return [...new Set((j.lines || []).map(l => l.acc).filter(Boolean))]; }

// Tables that sync to the cloud. Append-only logs and shared master data only;
// local-only things (settings, users, shifts, held, bank lines) stay on the device.
// Since v1.1 the phone app is a full copy of the store (everything except billing), so staff,
// users (hashed PINs), shifts, the audit log and the rest sync too.
export const SYNC_TABLES = ['products', 'batches', 'stockMoves', 'customers', 'suppliers', 'purchases', 'sales', 'orders', 'offers', 'journal', 'itemAliases',
  'users', 'shifts', 'audit', 'debitNotes', 'purchaseOrders', 'followups', 'employees', 'attendance', 'payroll', 'stores', 'accounts', 'bankLines'];

// Settings that belong to one device and are never shared with the others.
export const DEVICE_KEYS = new Set(['syncUrl', 'syncKey', 'syncEnabled', 'terminal', 'deviceMode', 'theme', 'sampleData', 'lang', 'currentStore', 'shopKey', 'backupAt', 'backupAuto']);
export const isSharedSetting = k => !DEVICE_KEYS.has(k) && !/^(seq_|chain_|_)/.test(k);

// When a person saves a shared setting here (setSetting), the sync sends the store settings to the
// other devices. Seeding, "start fresh" and settings arriving from the cloud never trigger this,
// so a new device can never overwrite the real store's settings with sample ones.
export const markSettingsDirty = () => { try { localStorage.setItem('dfr_settings_dirty', String(Date.now())); } catch { /* ignore */ } };
export const settingsDirty = () => { try { return Number(localStorage.getItem('dfr_settings_dirty') || 0); } catch { return 0; } };
export const clearSettingsDirty = at => { try { if (settingsDirty() <= at) localStorage.removeItem('dfr_settings_dirty'); } catch { /* ignore */ } };

// Auto-stamp every create/update so the sync knows what is new.
// Rows written by the sync carry `_oc` (the counter they came from) and `_seq`
// (the server version) and are not sent back. As soon as THIS counter changes such
// a row (e.g. a customer's points after a sale here), `_oc` is cleared, so the
// change is sent to the other counters too.
for (const t of SYNC_TABLES) {
  db[t].hook('creating', (primKey, obj) => {
    if (!obj.updatedAt) obj.updatedAt = Date.now();
    if (t === 'stockMoves' && !obj.sid) obj.sid = COUNTER + ':' + uid();
    if (t === 'journal') obj.accs = journalAccs(obj);
  });
  db[t].hook('updating', (mods) => {
    const extra = t === 'journal' && 'lines' in mods ? { accs: journalAccs({ lines: mods.lines }) } : null;
    const keys = Object.keys(mods);
    if (keys.length && keys.every(k => k === 'accs')) return;         // index upkeep only (an upgrade), not a real change — do not resend
    if ('_seq' in mods || '_mv' in mods) return extra || undefined;   // the sync itself is writing
    return { updatedAt: Date.now(), _oc: undefined, ...(extra || {}) };   // a change made on this counter
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
  if (isSharedSetting(key)) markSettingsDirty();
}

export async function resetAll() {
  await db.delete();
  await db.open();
}
