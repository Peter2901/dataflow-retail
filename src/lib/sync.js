// Cloud sync (free, via Supabase REST). Each counter pushes its new rows to one
// shared `records` table and pulls everyone else's. Stock is kept correct by
// replaying stock-move events, so two counters selling at once never overwrite
// each other. Billing never waits for this — it runs in the background.
import { db, SYNC_TABLES, getSettings, setSyncCounter } from '../db.js';
import { uid } from './util.js';
import SETUP_SQL_TEXT from '../../supabase/setup.sql?raw';

// Who is logged in on this counter (shown in the owner app).
let syncUser = '';
export const setSyncUser = name => { syncUser = name || ''; };
let lastBeat = 0;

const r3 = n => Math.round((Number(n) || 0) * 1000) / 1000;

let timer = null, running = false, listeners = [];
const status = { enabled: false, online: navigator.onLine, lastSync: 0, pending: 0, error: '', busy: false };

export const onSyncStatus = fn => { listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; };
const emit = () => listeners.forEach(fn => { try { fn({ ...status }); } catch { /* ignore */ } });
export const getStatus = () => ({ ...status });

async function cfg() {
  const s = await getSettings();
  return {
    url: (s.syncUrl || '').replace(/\/+$/, ''),
    key: s.syncKey || '',
    enabled: !!s.syncEnabled,
    store: s.currentStore || 'S1',
    counter: s.terminal || 'T1',
  };
}

function headers(key) {
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

// Check the keys and that the table exists. Returns a friendly message.
export async function testConnection() {
  const c = await cfg();
  if (!c.url || !c.key) return { ok: false, msg: 'Paste your Project URL and anon key first.' };
  try {
    const res = await fetch(`${c.url}/rest/v1/records?select=id&limit=1`, { headers: headers(c.key) });
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

async function pushTable(c, t) {
  const cur = await metaGet('push:' + t);
  const mine = (await db[t].filter(r => (r.updatedAt || 0) > cur && !r._oc).toArray());
  if (!mine.length) return 0;
  // Stock moves made before sync existed have no global id yet: give them one.
  if (t === 'stockMoves') {
    for (const r of mine) if (!r.sid) { r.sid = c.counter + ':' + uid(); await db.stockMoves.update(r.id, { sid: r.sid }); }
  }
  // One row per (table, id) — the cloud refuses the same row twice in one request.
  const byId = new Map();
  for (const r of mine) {
    const id = t === 'stockMoves' ? r.sid : String(r.id);
    if (!id || id === 'undefined') continue;
    byId.set(id, { table_name: t, id, store_id: r.storeId || c.store, counter: c.counter, data: r, updated_at: r.updatedAt || Date.now() });
  }
  const rows = [...byId.values()];
  for (let i = 0; i < rows.length; i += 400) {
    const res = await fetch(`${c.url}/rest/v1/records?on_conflict=table_name,id`, {
      method: 'POST',
      headers: { ...headers(c.key), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(rows.slice(i, i + 400)),
    });
    if (!res.ok) {
      let why = ''; try { why = (await res.json()).message || ''; } catch { /* ignore */ }
      throw new Error(`push ${t} ${res.status}${why ? ' — ' + why : ''}`);
    }
  }
  await metaSet('push:' + t, Math.max(cur, ...mine.map(r => r.updatedAt || 0)));
  return rows.length;
}

async function applyRow(c, row) {
  if (row.counter === c.counter) return;          // our own row coming back
  const d = row.data || {};
  if (row.table_name === 'stockMoves') {
    const sid = row.id;
    if (await db.appliedMoves.get(sid)) return;
    if (d.batchId) {
      const b = await db.batches.get(d.batchId);
      if (b) await db.batches.update(d.batchId, { qty: r3(b.qty + d.qty), _mv: row.seq });
    }
    await db.stockMoves.add({ ...d, _oc: row.counter, _seq: row.seq });
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
    const res = await fetch(url, { headers: headers(c.key) });
    if (!res.ok) throw new Error('pull ' + res.status);
    const rows = await res.json();
    for (const row of rows) { await applyRow(c, row); if (row.seq > hi) hi = row.seq; }
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
    headers: { ...headers(c.key), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ table_name: 'counter_status', id: `${c.store}:${c.counter}`, store_id: c.store, counter: c.counter,
      updated_at: Date.now(), data: { counter: c.counter, user: syncUser, pending: status.pending, at: Date.now() } }]),
  });
}

async function countPending(c) {
  let n = 0;
  for (const t of SYNC_TABLES) {
    const cur = await metaGet('push:' + t);
    n += await db[t].filter(r => (r.updatedAt || 0) > cur && !r._oc).count();
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
    for (const t of SYNC_TABLES) await pushTable(c, t);
    await pull(c);
    status.pending = await countPending(c);
    await heartbeat(c);
    status.lastSync = Date.now(); status.error = '';
  } catch (e) {
    status.error = String(e.message || e);
  } finally {
    running = false; status.busy = false; emit();
  }
}

// Stamp every local row as new so this counter seeds the shared database once.
export async function pushEverything() {
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
  const json = JSON.stringify({ u: c.url, k: c.key, s: c.store, n: s.storeName || '' });
  const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'DFR1.' + b64;
}

