// Cloud sync (free, via Supabase REST). Each counter pushes its new rows to one
// shared `records` table and pulls everyone else's. Stock is kept correct by
// replaying stock-move events, so two counters selling at once never overwrite
// each other. Billing never waits for this — it runs in the background.
import { db, SYNC_TABLES, getSettings, setSyncCounter, isSharedSetting, settingsDirty, clearSettingsDirty, markSettingsDirty } from '../db.js';
import { uid } from './util.js';
import SETUP_SQL_TEXT from '../../supabase/setup.sql?raw';

// Who is logged in on this counter (shown in the owner app).
let syncUser = '';
export const setSyncUser = name => { syncUser = name || ''; };
let lastBeat = 0;

const r3 = n => Math.round((Number(n) || 0) * 1000) / 1000;

let timer = null, running = false, listeners = [];
const status = { enabled: false, online: navigator.onLine, lastSync: 0, pending: 0, error: '', busy: false, step: '' };

export const onSyncStatus = fn => { listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; };
const emit = () => listeners.forEach(fn => { try { fn({ ...status }); } catch { /* ignore */ } });
export const getStatus = () => ({ ...status });
// For support and tests: the sync state can be read from the browser console.
if (typeof window !== 'undefined') window.__dfrSyncStatus = getStatus;

// Shop key: when many shops share one Supabase project, each shop's rows carry its own key and the
// database only shows a shop its own rows (row-level security on the x-shop-key header, see setup.sql).
// Row ids get a short tag from the key so two shops' "SKU1001" never collide. No key = one shop per project.
let tagCache = { key: '', tag: '' };
async function shopTag(shop) {
  if (!shop) return '';
  if (tagCache.key === shop) return tagCache.tag;
  const { sha256 } = await import('./util.js');
  const tag = (await sha256('dfr-shop:' + shop)).slice(0, 10);
  tagCache = { key: shop, tag };
  return tag;
}
export const newShopKey = () => {
  const a = new Uint8Array(18); crypto.getRandomValues(a);
  return 'shop_' + Array.from(a, b => b.toString(36).padStart(2, '0')).join('').slice(0, 28);
};

async function cfg() {
  const s = await getSettings();
  const shop = s.shopKey || '';
  return {
    url: (s.syncUrl || '').replace(/\/+$/, ''),
    key: s.syncKey || '',
    shop, tag: await shopTag(shop),
    enabled: !!s.syncEnabled,
    store: s.currentStore || 'S1',
    counter: s.terminal || 'T1',
    phone: s.deviceMode === 'mobile',
  };
}
const rid = (c, id) => (c.tag ? `${c.tag}~${id}` : String(id));

function headers(key, shop = '') {
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', ...(shop ? { 'x-shop-key': shop } : {}) };
}
const hdr = c => headers(c.key, c.shop);

// Rows changed on this device since the last push — read through the updatedAt index (fast on big data).
const changedSince = (t, cur) => db[t].where('updatedAt').above(cur).filter(r => !r._oc);

// Check the keys and that the table exists. Returns a friendly message.
export async function testConnection() {
  const c = await cfg();
  if (!c.url || !c.key) return { ok: false, msg: 'Paste your Project URL and anon key first.' };
  try {
    const res = await fetch(`${c.url}/rest/v1/records?select=id&limit=1`, { headers: hdr(c) });
    if (res.status === 200) return { ok: true, msg: 'Connected. Sync is ready.' };
    if (res.status === 404) return { ok: false, msg: 'Connected, but the "records" table is missing. Run the setup SQL (below) in Supabase once.' };
    if (res.status === 401) return { ok: false, msg: 'Key not accepted. Copy the anon public key again.' };
    return { ok: false, msg: `Supabase replied ${res.status}. Check the URL and key.` };
  } catch (e) {
    return { ok: false, msg: 'Could not reach Supabase. Check the URL and the internet.' };
  }
}

const metaGet = async k => (await db.syncMeta.get(k))?.v ?? 0;
const metaSet = (k, v) => db.syncMeta.put({ key: k, v });

// Send this device's changed rows of one table, a page at a time (a big store's first upload has lakhs
// of rows — never all in memory at once). The cursor only moves past rows that were really sent.
const PAGE = 2000;
async function pushRows(c, t, rows) {
  // Stock moves made before sync existed have no global id yet: give them one.
  if (t === 'stockMoves') {
    for (const r of rows) if (!r.sid) { r.sid = c.counter + ':' + uid(); await db.stockMoves.update(r.id, { sid: r.sid }); }
  }
  // One row per (table, id) — the cloud refuses the same row twice in one request.
  const byId = new Map();
  for (const r of rows) {
    const id = t === 'stockMoves' ? r.sid : String(r.id);
    if (!id || id === 'undefined') continue;
    byId.set(id, { table_name: t, id: rid(c, id), store_id: r.storeId || c.store, counter: c.counter, data: r, updated_at: r.updatedAt || Date.now() });
  }
  const out = [...byId.values()];
  for (let i = 0; i < out.length; i += 400) {
    const res = await fetch(`${c.url}/rest/v1/records?on_conflict=table_name,id`, {
      method: 'POST',
      headers: { ...hdr(c), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(out.slice(i, i + 400)),
    });
    if (!res.ok) {
      let why = ''; try { why = (await res.json()).message || ''; } catch { /* ignore */ }
      throw new Error(`push ${t} ${res.status}${why ? ' — ' + why : ''}`);
    }
  }
  return out.length;
}

async function pushTable(c, t) {
  let cur = await metaGet('push:' + t), sent = 0;
  const save = async v => { if (v > cur) { cur = v; await metaSet('push:' + t, cur); } };
  for (;;) {
    const page = await changedSince(t, cur).limit(PAGE).toArray();
    if (!page.length) break;
    const lastTs = page[page.length - 1].updatedAt || 0;
    if (page.length < PAGE) { sent += await pushRows(c, t, page); await save(lastTs); break; }
    // A full page: send the rows before the last time stamp (the rest come next round, so none is skipped).
    const before = page.filter(r => (r.updatedAt || 0) < lastTs);
    if (before.length) { sent += await pushRows(c, t, before); await save(before[before.length - 1].updatedAt || 0); continue; }
    // The whole page has one time stamp ("send everything"): send that stamp's rows page by page.
    for (let o = 0; ; o += PAGE) {
      const grp = await db[t].where('updatedAt').equals(lastTs).filter(r => !r._oc).offset(o).limit(PAGE).toArray();
      if (!grp.length) break;
      sent += await pushRows(c, t, grp);
      if (grp.length < PAGE) break;
    }
    await save(lastTs);
  }
  // Nothing of ours is left to send: move the cursor past the rows that came from other devices, so later
  // rounds do not read them again (only up to 5 s ago by this device's clock — our own new rows are newer).
  const top = await db[t].orderBy('updatedAt').lastKey();
  if (top) await save(Math.min(top, Date.now() - 5000));
  return sent;
}

// Store settings (name, GSTIN, rules…) as one shared row, sent when someone saves them.
async function pushSettings(c) {
  const at = settingsDirty();
  if (!at) return;
  const values = Object.fromEntries((await db.settings.toArray()).filter(r => isSharedSetting(r.key)).map(r => [r.key, r.value]));
  const res = await fetch(`${c.url}/rest/v1/records?on_conflict=table_name,id`, {
    method: 'POST', headers: { ...hdr(c), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ table_name: 'storeSettings', id: rid(c, c.store), store_id: c.store, counter: c.counter, data: { values, at }, updated_at: at }]),
  });
  if (!res.ok) throw new Error('push settings ' + res.status);
  clearSettingsDirty(at);
}

async function applyRow(c, row) {
  if (row.counter === c.counter) return;          // our own row coming back
  const d = row.data || {};
  if (row.table_name === 'storeSettings') {
    for (const [k, v] of Object.entries(d.values || {})) if (isSharedSetting(k)) await db.settings.put({ key: k, value: v });
    return;
  }
  if (row.table_name === 'stockMoves') {
    const sid = row.id;
    if (await db.appliedMoves.get(sid)) return;
    if (d.batchId) {
      const b = await db.batches.get(d.batchId);
      if (b) await db.batches.update(d.batchId, { qty: r3(b.qty + d.qty), _mv: row.seq });
    }
    // The sender's local row number (id) means nothing here — two counters both number their own moves 1, 2, 3…
    // Keeping it made the second counter's moves clash ("Key already exists") and stopped the sync. sid is the real id.
    const { id: _localId, ...move } = d;   // eslint-disable-line no-unused-vars
    await db.stockMoves.add({ ...move, _oc: row.counter, _seq: row.seq });
    await db.appliedMoves.put({ sid });
    return;
  }
  const table = db[row.table_name];
  if (!table) return;
  const existing = await table.get(d.id);
  if (existing && existing._seq === row.seq) return;    // this exact version is already here
  if (row.table_name === 'batches') {
    // Quantity always comes from stock moves, never from another counter's copy.
    const qty = existing ? existing.qty
      : r3((await db.stockMoves.where('batchId').equals(d.id).toArray()).reduce((a, m) => a + (Number(m.qty) || 0), 0));
    await db.batches.put({ ...d, qty, _oc: row.counter, _seq: row.seq });
    return;
  }
  await table.put({ ...d, _oc: row.counter, _seq: row.seq });
}

// Pull by the server's row number (seq), not by anyone's clock, so a counter that
// was offline for hours still delivers every bill when it reconnects. Each tick
// re-reads the previous tick's rows once, to catch a save that was still in flight.
async function pull(c) {
  const prevHi = await metaGet('pullPrevHi');
  let cur = await metaGet('pullCur');
  let hi = Math.max(prevHi, cur), pages = 0, more = false, n = 0;
  while (pages < 10) {
    const url = `${c.url}/rest/v1/records?store_id=eq.${encodeURIComponent(c.store)}&table_name=neq.counter_status&seq=gt.${cur}&order=seq.asc&limit=1000&select=table_name,id,counter,data,seq`;
    const res = await fetch(url, { headers: hdr(c) });
    if (!res.ok) throw new Error('pull ' + res.status);
    const rows = await res.json();
    // One transaction per page: much faster, and screens refresh once per page instead of once per row.
    status.step = `receive ${rows.length} rows`;
    await db.transaction('rw', db.tables, async () => {
      for (const row of rows) { await applyRow(c, row); if (row.seq > hi) hi = row.seq; }
    });
    n += rows.length; pages++;
    if (rows.length < 1000) { more = false; break; }
    more = true; cur = rows[rows.length - 1].seq;
  }
  const nextCur = more ? hi : (prevHi === 0 ? hi : prevHi);
  await metaSet('pullCur', nextCur);
  await metaSet('pullPrevHi', hi);
  return n;
}

// Every 30 s: "this counter is alive", so the owner app can show online/offline
// even when no bills are being made. Counters never download these rows.
async function heartbeat(c, force = false) {
  if (!force && Date.now() - lastBeat < 30000) return;
  lastBeat = Date.now();
  await fetch(`${c.url}/rest/v1/records?on_conflict=table_name,id`, {
    method: 'POST',
    headers: { ...hdr(c), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ table_name: 'counter_status', id: rid(c, `${c.store}:${c.counter}`), store_id: c.store, counter: c.counter,
      updated_at: Date.now(), data: { counter: c.counter, user: syncUser, pending: status.pending, at: Date.now() } }]),
  });
}

async function countPending(c) {
  let n = 0;
  for (const t of SYNC_TABLES) {
    const cur = await metaGet('push:' + t);
    n += await changedSince(t, cur).count();
  }
  return n;
}

export async function syncOnce() {
  const c = await cfg();
  status.enabled = c.enabled; status.online = navigator.onLine;
  if (!c.enabled || !c.url || !c.key || !navigator.onLine || running) { emit(); return; }
  running = true; status.busy = true; emit();
  try {
    setSyncCounter(c.counter);
    status.step = 'settings'; await pushSettings(c);
    for (const t of SYNC_TABLES) { status.step = 'send ' + t; await pushTable(c, t); }
    status.step = 'receive'; await pull(c);
    status.step = 'count'; status.pending = await countPending(c);
    status.step = 'heartbeat'; if (!c.phone) await heartbeat(c);          // phones are not counters
    status.step = '';
    status.lastSync = Date.now(); status.error = '';
  } catch (e) {
    status.error = String(e.message || e);
  } finally {
    running = false; status.busy = false; emit();
  }
}

// Stamp every local row as new so this counter seeds the shared database once.
export async function pushEverything() {
  markSettingsDirty();
  const now = Date.now();
  for (const t of SYNC_TABLES) {
    await db[t].toCollection().modify(r => { if (!r._oc) r.updatedAt = now; });
    await metaSet('push:' + t, 0);
  }
  await syncOnce();
}

export function startSync() {
  if (timer) return;
  const tick = () => syncOnce();
  window.addEventListener('online', () => { status.online = true; emit(); tick(); });
  window.addEventListener('offline', () => { status.online = false; emit(); });
  timer = setInterval(tick, 8000);
  tick();
}

export function stopSync() { if (timer) { clearInterval(timer); timer = null; } }

// SQL the user pastes once into Supabase (SQL editor). Kept in supabase/setup.sql.
export const SETUP_SQL = SETUP_SQL_TEXT;

// Owner phone app: where to get it, and a setup code (URL + key + store) so nothing
// has to be typed on the phone.
export const OWNER_WEB_URL = 'https://peter2901.github.io/dataflow-retail/owner.html';
export const OWNER_APK_URL = 'https://github.com/Peter2901/dataflow-retail/releases/download/owner-app/DataFlow-Owner.apk';

export async function ownerSetupCode() {
  const c = await cfg();
  if (!c.url || !c.key) return '';
  const s = await getSettings();
  const json = JSON.stringify({ u: c.url, k: c.key, s: c.store, n: s.storeName || '', ...(c.shop ? { h: c.shop } : {}) });
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'DFR1.' + b64;
}


// Before the first phone connects: the main counter sends everything once (users, staff,
// shifts, audit log, store settings…), so the phone app gets the full store.
export async function prepareForPhones() {
  const done = await metaGet('phonesReady');
  if (done) return false;
  await pushEverything();
  if (!status.error) await metaSet('phonesReady', Date.now());
  return true;
}

/**
 * Phone app (or a new device): wipe local data and connect to the store with the setup code.
 * Everything, including users and store settings, then comes down from the cloud.
 */
export async function connectDevice({ url, key, store, name, shop = '' }, { terminal = 'M1', deviceMode = 'mobile' } = {}) {
  const { resetAll } = await import('../db.js');
  await resetAll();
  const put = (k, v) => db.settings.put({ key: k, value: v });
  await put('syncUrl', url); await put('syncKey', key); await put('syncEnabled', true); if (shop) await put('shopKey', shop);
  await put('currentStore', store); await put('terminal', terminal); await put('deviceMode', deviceMode);
  await put('storeName', name || 'My store'); await put('sampleData', false); await put('stateCode', '');
  await syncOnce();
}

export async function pullUntilQuiet(maxRounds = 30, onRound) {
  for (let i = 0; i < maxRounds; i++) {
    const c = await cfg();
    const n = await pull(c);
    onRound?.(i, n);
    if (n < 1000) break;
  }
}

/** Which counters are online (heartbeat within 95 s). Empty when sync is off. */
export async function counterStatus() {
  const c = await cfg();
  if (!c.enabled || !c.url || !c.key || !navigator.onLine) return [];
  try {
    const res = await fetch(`${c.url}/rest/v1/records?store_id=eq.${encodeURIComponent(c.store)}&table_name=eq.counter_status&select=data,updated_at`, { headers: hdr(c) });
    if (!res.ok) return [];
    return (await res.json()).map(r => ({ counter: r.data?.counter, user: r.data?.user, online: Date.now() - Number(r.updated_at || r.data?.at || 0) < 95000 })).filter(x => x.counter).sort((a, b) => a.counter.localeCompare(b.counter));
  } catch { return []; }
}
