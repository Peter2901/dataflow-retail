// Backups that work for a big store (lakhs of bills): the data is written table by table, a few
// thousand rows at a time, straight into gzip — never one giant text in memory. Optional password
// (AES-GCM, key from PBKDF2). Restore checks the whole file first and only then replaces the data.
// Cloud and AI keys are never put in a backup.
import { db, DEVICE_KEYS } from '../db.js';

const MAGIC = 'DFRBENC1';                 // encrypted backup
const CHUNK = 2000;
const SECRET_SETTINGS = new Set(['syncKey', 'shopKey']);
const enc = new TextEncoder();

function cleanSetting(r) {
  if (SECRET_SETTINGS.has(r.key)) return null;
  if (r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
    const v = { ...r.value };
    for (const k of Object.keys(v)) if (/key|secret|token|password/i.test(k)) delete v[k];
    return { ...r, value: v };
  }
  return r;
}

// Rows of a table in primary-key order, CHUNK at a time.
async function* pages(t) {
  const kp = t.schema.primKey.keyPath;
  let last;
  for (;;) {
    const coll = last === undefined ? t.orderBy(':id') : t.where(':id').above(last);
    const rows = await coll.limit(CHUNK).toArray();
    if (!rows.length) return;
    yield rows;
    last = rows[rows.length - 1][kp];
    if (rows.length < CHUNK) return;
  }
}

async function deriveKey(password, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 250000, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

/** Make a backup. Returns { blob, name, counts }. */
export async function makeBackup({ password = '', onProgress, storeName = '' } = {}) {
  const gz = typeof CompressionStream !== 'undefined';
  const cs = gz ? new CompressionStream('gzip') : null;
  const plainParts = [];
  const writer = cs ? cs.writable.getWriter() : null;
  const out = cs ? new Response(cs.readable).blob() : null;      // reads while we write
  const write = async s => { if (writer) await writer.write(enc.encode(s)); else plainParts.push(s); };
  const counts = {};
  await write(JSON.stringify({ app: 'dataflow-retail', kind: 'backup', v: 2, at: Date.now(), dbVersion: db.verno, store: storeName }) + '\n');
  let done = 0;
  for (const t of db.tables) {
    counts[t.name] = 0;
    await write(JSON.stringify({ table: t.name }) + '\n');
    for await (const rows of pages(t)) {
      const list = t.name === 'settings' ? rows.map(cleanSetting).filter(Boolean) : rows;
      counts[t.name] += list.length; done += list.length;
      if (list.length) await write(list.map(r => JSON.stringify(r)).join('\n') + '\n');
      onProgress?.(done, t.name);
    }
  }
  await write(JSON.stringify({ end: true, counts }) + '\n');
  let blob;
  if (writer) { await writer.close(); blob = await out; } else blob = new Blob(plainParts, { type: 'application/x-ndjson' });
  if (password) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(password, salt), await blob.arrayBuffer());
    blob = new Blob([enc.encode(MAGIC), salt, iv, new Uint8Array(ct)], { type: 'application/octet-stream' });
  }
  const day = new Date(); const pad = n => String(n).padStart(2, '0');
  const name = `dataflow-backup-${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}-${pad(day.getHours())}${pad(day.getMinutes())}${password ? '-locked' : ''}.dfrbak`;
  return { blob, name, counts, rows: done };
}

/** What kind of file is this? 'locked' | 'gzip' | 'plain' | 'legacy' | 'unknown' */
export async function backupKind(file) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const txt = new TextDecoder().decode(head);
  if (txt.startsWith(MAGIC)) return 'locked';
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (txt.startsWith('{"app":"dataflow-retail","kind":"backup"')) return 'plain';
  if (txt.startsWith('{"app":"dataflow-retail"')) return 'legacy';
  return 'unknown';
}

async function openBlob(file, password) {
  const kind = await backupKind(file);
  if (kind === 'unknown') throw new Error('That is not a DataFlow Retail backup.');
  if (kind === 'legacy') return { kind, blob: file };
  if (kind === 'locked') {
    if (!password) throw new Error('This backup is locked. Type its password.');
    const buf = new Uint8Array(await file.arrayBuffer());
    const salt = buf.slice(8, 24), iv = buf.slice(24, 36);
    let plain;
    try { plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await deriveKey(password, salt), buf.slice(36)); }
    catch { throw new Error('Wrong password, or the file is damaged.'); }
    const blob = new Blob([plain]);
    return { kind: await backupKind(blob), blob };
  }
  return { kind, blob: file };
}

// Read the backup line by line and call fn(obj) for each line.
async function eachLine(blob, kind, fn) {
  let stream = blob.stream();
  if (kind === 'gzip') stream = stream.pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    // Split each piece once (not line by line with slices — that copies the rest of the text every line).
    const parts = (buf + value).split('\n');
    buf = parts.pop();
    for (const line of parts) if (line) { const r = fn(JSON.parse(line)); if (r && r.then) await r; }
  }
  if (buf.trim()) { const r = fn(JSON.parse(buf)); if (r && r.then) await r; }
}

/** Check a backup without changing anything. Returns { header, counts, rows }. */
export async function checkBackup(file, password = '') {
  const { kind, blob } = await openBlob(file, password);
  if (kind === 'legacy') {
    const j = JSON.parse(await blob.text());
    const counts = Object.fromEntries(Object.entries(j.data || {}).map(([k, v]) => [k, v.length]));
    return { header: { at: j.at, v: 1 }, counts, rows: Object.values(counts).reduce((a, b) => a + b, 0), legacy: j };
  }
  let header = null, end = null, table = null; const counts = {};
  try {
    await eachLine(blob, kind, o => {
      if (!header) { if (o.app !== 'dataflow-retail') throw new Error('bad'); header = o; return; }
      if (o.table && Object.keys(o).length === 1) { table = o.table; counts[table] = 0; return; }
      if (o.end) { end = o; return; }
      if (table) counts[table]++;
    });
  } catch (e) {
    if (e.message === 'This backup is locked. Type its password.' || e.message.startsWith('Wrong password')) throw e;
    throw new Error('This backup file is damaged or cut short. Nothing was changed.');
  }
  if (!header || !end) throw new Error('This backup file is cut short (it has no end). Nothing was changed.');
  for (const [t, n] of Object.entries(end.counts)) if ((counts[t] || 0) !== n) throw new Error(`Backup does not add up for ${t}. Nothing was changed.`);
  return { header, counts, rows: Object.values(counts).reduce((a, b) => a + b, 0), kind, blob };
}

/** Replace everything on this device with the backup (after checkBackup passed). This device's own settings are kept. */
export async function restoreBackup(checked, onProgress) {
  const keepDevice = (await db.settings.toArray()).filter(r => DEVICE_KEYS.has(r.key));
  const known = new Set(db.tables.map(t => t.name));
  for (const t of db.tables) await t.clear();
  let done = 0;
  if (checked.legacy) {
    for (const [name, rows] of Object.entries(checked.legacy.data || {})) {
      if (!known.has(name)) continue;
      for (let i = 0; i < rows.length; i += CHUNK) { await db.table(name).bulkPut(rows.slice(i, i + CHUNK)); done += Math.min(CHUNK, rows.length - i); onProgress?.(done); }
    }
  } else {
    let table = null, batch = [];
    const flush = async () => { if (table && known.has(table) && batch.length) await db.table(table).bulkPut(batch); done += batch.length; batch = []; onProgress?.(done); };
    let first = true;
    await eachLine(checked.blob, checked.kind, async o => {
      if (first) { first = false; return; }
      if (o.table && Object.keys(o).length === 1) { await flush(); table = o.table; return; }
      if (o.end) { await flush(); return; }
      batch.push(o);
      if (batch.length >= CHUNK) await flush();
    });
    await flush();
  }
  for (const r of keepDevice) await db.settings.put(r);
  return done;
}
