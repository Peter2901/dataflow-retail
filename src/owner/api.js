// Owner app data: two small summaries computed in Supabase (see supabase/setup.sql).
const CFG = 'dfr_owner_cfg';
const LAST = 'dfr_owner_last';

const get = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage full or blocked */ } };

export const loadCfg = () => get(CFG);
export const saveCfg = c => set(CFG, c);
export const clearCfg = () => { try { localStorage.removeItem(CFG); localStorage.removeItem(LAST); } catch { /* ignore */ } };
export const loadLast = () => get(LAST);
export const saveLast = v => set(LAST, v);

// Setup code made on the counter: Settings › Cloud sync › Owner phone app.
export function parseCode(text) {
  const m = String(text || '').match(/DFR1\.([A-Za-z0-9_\-+/=]+)/);
  if (!m) throw new Error('That is not a setup code. It starts with DFR1.');
  const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
  let o;
  try { o = JSON.parse(decodeURIComponent(escape(atob(b64 + '==='.slice((b64.length + 3) % 4))))); }
  catch { throw new Error('This setup code is damaged. Copy it again from the counter.'); }
  if (!o.u || !o.k) throw new Error('This setup code is incomplete. Make a new one on the counter.');
  return { url: o.u.replace(/\/+$/, ''), key: o.k, store: o.s || 'S1', name: o.n || 'My store' };
}

const headers = c => ({ apikey: c.key, Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json' });

async function rpc(c, fn, body) {
  const res = await fetch(`${c.url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: headers(c), body: JSON.stringify(body) });
  if (res.status === 404) throw new Error('The cloud is missing the owner summaries. Run the latest setup SQL in Supabase.');
  if (!res.ok) throw new Error(`Cloud replied ${res.status}`);
  return res.json();
}

const dayStart = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

export const fetchToday = c => rpc(c, 'owner_today', { p_store: c.store, p_from: dayStart(), p_now: Date.now() });
export const fetchAlerts = c => rpc(c, 'owner_alerts', { p_store: c.store, p_now: Date.now() });

export async function fetchBill(c, id) {
  const res = await fetch(`${c.url}/rest/v1/records?table_name=eq.sales&id=eq.${encodeURIComponent(id)}&select=data`, { headers: headers(c) });
  if (!res.ok) throw new Error(`Cloud replied ${res.status}`);
  const rows = await res.json();
  return rows[0]?.data || null;
}

export async function testCfg(c) {
  await fetchToday(c);
  return true;
}
