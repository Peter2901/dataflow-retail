// Cloud sync (free, via Supabase REST). Each counter pushes its new rows to one
// shared `records` table and pulls everyone else's. Stock is kept correct by
// replaying stock-move events, so two counters selling at once never overwrite
// each other. Billing never waits for this — it runs in the background.
import { db, SYNC_TABLES, getSettings, setSyncCounter, isSharedSetting, settingsDirty, clearSettingsDirty, markSettingsDirty } from '../db.js';
import { uid } from './util.js';
import { journalAccs } from '../db.js';
import { recalcCustomer, ensureCustomerBase, addBillToCustomer } from './sales.js';
import { touchDay } from './daysums.js';
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
    phone: s.deviceMode === 'mobile',
  };
}

// Shop internet drops for a second all the time: each request is tried up to 3 times
// (after 0.4 s and 1.5 s) before the round gives up; the next round continues where it stopped.
async function call(url, opts = {}, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status < 500 && res.status !== 429) return res;
      last = res;
    } catch (e) { last = e; }
    if (i < tries - 1) await new Promise(r => setTimeout(r, i ? 1500 : 400));
  }
  if (last instanceof Error) throw last;
  return last;
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

// Rows changed on this device since the last push (index on updatedAt — never a full-table read).
const changedSince = (t, cur) => db[t].where('updatedAt').above(cur).filter(r => !r._oc);

async function pushTable(c, t) {
  const cur = await metaGet('push:' + t);
  const mine = await changedSince(t, cur).toArray();
  // Nothing of ours to send: move the mark up anyway (3 s behind), so the next round only looks at
  // rows changed since then — a counter that joined later must not re-read whole tables every round.
  if (!mine.length) { const to = Date.now() - 3000; if (to > cur) await metaSet('push:' + t, to); return 0; }
  // Customers leave with their `base` (points etc. not explained by any bill), worked out here
  // where the row and its bills agree, so other devices can add up the bills themselves.
  if (t === 'customers') {
    for (let i = 0; i < mine.length; i++) if (!mine[i].base) mine[i] = (await ensureCustomerBase(mine[i].id, { force: true })) || mine[i];
  }
  // Stock moves made before sync existed have no global id yet: give them one.
  if (t === 'stockMoves') {
    for (const r of mine) if (!r.sid) { r.sid = c.counter + ':' + uid(); await db.stockMoves.update(r.id, { sid: r.sid }); }
  }
  // One row per (table, id) — the cloud refuses the same row twice in one request.
  const byId = new Map();
  let hi = cur;
  for (const r of mine) {
    if ((r.updatedAt || 0) > hi) hi = r.updatedAt;
    const id = t === 'stockMoves' ? r.sid : String(r.id);
    if (!id || id === 'undefined') continue;
    byId.set(id, { table_name: t, id, store_id: r.storeId || c.store, counter: c.counter, data: r, updated_at: r.updatedAt || Date.now() });
  }
  // Send in pieces of at most 400 rows and about 1 MB, so a slow shop connection never times out.
  const rows = [...byId.values()];
  let i = 0;
  while (i < rows.length) {
    const part = []; let bytes = 2;
    while (i < rows.length && part.length < 400) {
      const n = JSON.stringify(rows[i]).length + 1;
      if (part.length && bytes + n > 900000) break;
      part.push(rows[i]); bytes += n; i++;
    }
    const res = await call(`${c.url}/rest/v1/records?on_conflict=table_name,id`, {
      method: 'POST',
      headers: { ...headers(c.key), Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(part),
    });
    if (!res.ok) {
      let why = ''; try { why = (await res.json()).message || ''; } catch { /* ignore */ }
      throw new Error(`push ${t} ${res.status}${why ? ' — ' + why : ''}`);
    }
  }
  // The mark stays 3 s behind: a bill saved in the same instant (or still being written) is sent
  // again next round instead of being skipped — sending a row twice is harmless.
  await metaSet('push:' + t, Math.max(cur, Math.min(hi, Date.now() - 3000)));
  return rows.length;
}

// Store settings (name, GSTIN, rules…) as one shared row, sent when someone saves them.
async function pushSettings(c) {
  const at = settingsDirty();
  if (!at) return;
  const values = Object.fromEntries((await db.settings.toArray()).filter(r => isSharedSetting(r.key)).map(r => [r.key, r.value]));
  const res = await call(`${c.url}/rest/v1/records?on_conflict=table_name,id`, {
    method: 'POST', headers: { ...headers(c.key), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([{ table_name: 'storeSettings', id: c.store, store_id: c.store, counter: c.counter, data: { values, at }, updated_at: at }]),
  });
  if (!res.ok) throw new Error('push settings ' + res.status);
  clearSettingsDirty(at);
}

async function applyRow(c, row) {
  const d = row.data || {};
  // Our own rows coming back are skipped — except on a device that is being set up again
  // (a replaced counter PC), which takes its own old bills and stock history back.
  const own = row.counter === c.counter;
  if (own && !c.restoring) return;
  if (row.table_name === 'storeSettings') {
    if (own) return;
    for (const [k, v] of Object.entries(d.values || {})) if (isSharedSetting(k)) await db.settings.put({ key: k, value: v });
    return;
  }
  if (row.table_name === 'stockMoves') {
    const sid = row.id;
    if (await db.appliedMoves.get(sid)) return;
    // Our own move coming back: normally already here. After a counter PC is replaced it is not,
    // and then it is added like any other, so the new PC gets its old stock history back.
    if (own && await db.stockMoves.where('sid').equals(sid).count()) return;
    await db.transaction('rw', db.batches, db.stockMoves, db.appliedMoves, async () => {
      if (await db.appliedMoves.get(sid)) return;
      if (d.batchId) await db.batches.where('id').equals(d.batchId).modify(b => { b.qty = r3(b.qty + d.qty); b._mv = row.seq; });
      const { id: _drop, ...m } = d;
      void _drop;
      await db.stockMoves.add({ ...m, sid, _oc: row.counter, _seq: row.seq });
      await db.appliedMoves.put({ sid });
    });
    return;
  }
  const table = db[row.table_name];
  if (!table) return;
  const existing = await table.get(d.id);
  if (own && existing) return;                          // our own row coming back
  if (existing && existing._seq === row.seq) return;    // this exact version is already here
  if (row.table_name === 'batches') {
    // Quantity always comes from stock moves, never from another counter's copy.
    const qty = existing ? existing.qty
      : r3((await db.stockMoves.where('batchId').equals(d.id).toArray()).reduce((a, m) => a + (Number(m.qty) || 0), 0));
    await db.batches.put({ ...d, qty, _oc: row.counter, _seq: row.seq });
    return;
  }
  if (row.table_name === 'journal') { await table.put({ ...d, accs: journalAccs(d), _oc: row.counter, _seq: row.seq }); return; }
  if (row.table_name === 'customers') {
    // Points / spend / visits come from the bills on this device (see recalcCustomer), not from
    // whichever counter saved the customer last.
    const keep = existing ? { points: existing.points, yearSpend: existing.yearSpend, lifeSpend: existing.lifeSpend, visits: existing.visits, lastVisit: existing.lastVisit } : {};
    await table.put({ ...d, ...keep, ...(existing?.base && !d.base ? { base: existing.base } : {}), _oc: row.counter, _seq: row.seq });
    // Add up the bills again only when the starting point changed (new customer, or base edited).
    if (d.base && JSON.stringify(d.base) !== JSON.stringify(existing?.base)) await recalcCustomer(d.id);
    return;
  }
  if (row.table_name === 'sales' && !existing && d.ts) await touchDay(d.storeId || c.store, d.ts);   // a late bill for a past day
  if (row.table_name === 'sales' && d.customerId && !existing) {
    await table.put({ ...d, _oc: row.counter, _seq: row.seq });
    await addBillToCustomer(d.customerId, d);
    return;
  }
  await table.put({ ...d, _oc: row.counter, _seq: row.seq });
}

// Pull by the server's row number (seq), not by anyone's clock, so a counter that
// was offline for hours still delivers every bill when it reconnects. Each tick
// re-reads the previous tick's rows once, to catch a save that was still in flight.
async function pull(c) {
  c = { ...c, restoring: !!(await metaGet('restoring')) };
  const prevHi = await metaGet('pullPrevHi');
  let cur = await metaGet('pullCur');
  let hi = Math.max(prevHi, cur), pages = 0, more = false, n = 0;
  while (pages < 10) {
    const url = `${c.url}/rest/v1/records?store_id=eq.${encodeURIComponent(c.store)}&table_name=neq.counter_status&seq=gt.${cur}&order=seq.asc&limit=1000&select=table_name,id,counter,data,seq`;
    const res = await call(url, { headers: headers(c.key) });
    if (!res.ok) throw new Error('pull ' + res.status);
    const rows = await res.json();
    // 50 rows per database write: a new phone downloads a big store quickly, and a bill being
    // saved at the counter never waits long behind the sync.
    for (let i = 0; i < rows.length; i += 50) {
      const part = rows.slice(i, i + 50);
      await db.transaction('rw', [...SYNC_TABLES.map(t => db[t]), db.settings, db.appliedMoves, db.daySums], async () => {
        for (const row of part) await applyRow(c, row);
      });
      for (const row of part) if (row.seq > hi) hi = row.seq;
    }
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

async function countPending() {
  let n = 0;
  for (const t of SYNC_TABLES) n += await changedSince(t, await metaGet('push:' + t)).count();
  return n;
}

export async function syncOnce() {
  const c = await cfg();
  status.enabled = c.enabled; status.online = navigator.onLine;
  if (!c.enabled || !c.url || !c.key || !navigator.onLine || running) { emit(); return; }
  running = true; status.busy = true; emit();
  try {
    setSyncCounter(c.counter);
    await pushSettings(c);
    for (const t of SYNC_TABLES) await pushTable(c, t);
    await pull(c);
    status.pending = await countPending();
    if (!c.phone) await heartbeat(c);          // phones are not counters
    status.lastSync = Date.now(); status.error = '';
  } catch (e) {
    status.error = String(e.message || e);
    try { status.pending = await countPending(); } catch { /* ignore */ }   // never show "all sent" when it isn't
  } finally {
    running = false; status.busy = false; emit();
  }
}

// Stamp every local row as new so this counter seeds the shared database once.
export async function pushEverything() {
  markSettingsDirty();
  // Sending everything again = start each table's "sent up to" mark from zero. Only rows from very
  // old versions without a time stamp are touched; nothing else is rewritten (fast on big stores).
  const now = Date.now();
  for (const t of SYNC_TABLES) {
    await db[t].filter(r => !r.updatedAt && !r._oc).modify(r => { r.updatedAt = now; });
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
export async function connectDevice({ url, key, store, name }, { terminal = 'M1', deviceMode = 'mobile' } = {}) {
  const { resetAll } = await import('../db.js');
  await resetAll();
  const put = (k, v) => db.settings.put({ key: k, value: v });
  await put('syncUrl', url); await put('syncKey', key); await put('syncEnabled', true);
  await put('currentStore', store); await put('terminal', terminal); await put('deviceMode', deviceMode);
  await put('storeName', name || 'My store'); await put('sampleData', false); await put('stateCode', '');
  await metaSet('restoring', 1);
  await syncOnce();
}

export async function pullUntilQuiet(maxRounds = 30, onRound) {
  for (let i = 0; i < maxRounds; i++) {
    const c = await cfg();
    const n = await pull(c);
    onRound?.(i, n);
    if (n < 1000) { await metaSet('restoring', 0); break; }
  }
}

/** Which counters are online (heartbeat within 95 s). Empty when sync is off. */
export async function counterStatus() {
  const c = await cfg();
  if (!c.enabled || !c.url || !c.key || !navigator.onLine) return [];
  try {
    const res = await fetch(`${c.url}/rest/v1/records?store_id=eq.${encodeURIComponent(c.store)}&table_name=eq.counter_status&select=data,updated_at`, { headers: headers(c.key) });
    if (!res.ok) return [];
    return (await res.json()).map(r => ({ counter: r.data?.counter, user: r.data?.user, online: Date.now() - Number(r.updated_at || r.data?.at || 0) < 95000 })).filter(x => x.counter).sort((a, b) => a.counter.localeCompare(b.counter));
  } catch { return []; }
}
