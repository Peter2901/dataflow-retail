// Cloud sync (free, via Supabase REST). Each counter pushes its new rows to one
// shared `records` table and pulls everyone else's. Stock is kept correct by
// replaying stock-move events, so two counters selling at once never overwrite
// each other. Billing never waits for this — it runs in the background.
import { db, SYNC_TABLES, getSettings, setSetting, setSyncCounter } from '../db.js';

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
  const rows = mine.map(r => ({
    table_name: t,
    id: t === 'stockMoves' ? r.sid : String(r.id),
    store_id: r.storeId || c.store,
    counter: c.counter,
    data: r,
    updated_at: r.updatedAt,
  }));
  const res = await fetch(`${c.url}/rest/v1/records?on_conflict=table_name,id`, {
    method: 'POST',
    headers: { ...headers(c.key), Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!res.ok) throw new Error(`push ${t} ${res.status}`);
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
      if (b) await db.batches.update(d.batchId, { qty: r3(b.qty + d.qty), _oc: row.counter });
    }
    await db.stockMoves.add({ ...d, _oc: row.counter });
    await db.appliedMoves.put({ sid });
    return;
  }
  if (row.table_name === 'batches') {
    const existing = await db.batches.get(d.id);
    await db.batches.put({ ...d, qty: existing ? existing.qty : 0, _oc: row.counter }); // qty comes from moves, not here
    return;
  }
  await db[row.table_name].put({ ...d, _oc: row.counter });
}

async function pull(c) {
  const cur = await metaGet('pull');
  const url = `${c.url}/rest/v1/records?store_id=eq.${encodeURIComponent(c.store)}&updated_at=gt.${cur}&order=updated_at.asc&limit=1000`;
  const res = await fetch(url, { headers: headers(c.key) });
  if (!res.ok) throw new Error('pull ' + res.status);
  const rows = await res.json();
  let max = cur;
  for (const row of rows) { await applyRow(c, row); if (row.updated_at > max) max = row.updated_at; }
  if (rows.length) await metaSet('pull', max);
  return rows.length;
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

// SQL the user pastes once into Supabase (SQL editor) to create the shared table.
export const SETUP_SQL = `create table if not exists records (
  table_name text not null,
  id text not null,
  store_id text,
  counter text,
  data jsonb,
  updated_at bigint,
  primary key (table_name, id)
);
create index if not exists records_pull on records (store_id, updated_at);
alter table records enable row level security;
create policy "app can read"  on records for select using (true);
create policy "app can write" on records for insert with check (true);
create policy "app can update" on records for update using (true) with check (true);`;
