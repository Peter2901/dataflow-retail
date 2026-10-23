// A tiny stand-in for Supabase's REST API on the `records` table, with the same per-shop rule as
// setup.sql: a row belongs to the shop key it was saved with; a request only sees / changes its own shop's rows.
import http from 'http';
const PORT = Number(process.argv[2] || 54321);
const rows = new Map();          // `${table}|${id}` -> row
let seq = 0;
const stats = { posts: 0, gets: 0, rowsIn: 0, denied: 0 };
const send = (res, code, body, extra = {}) => { res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', ...extra }); res.end(body === undefined ? '' : JSON.stringify(body)); };
http.createServer((req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, 'http://x');
  const shop = String(req.headers['x-shop-key'] || '');
  if (url.pathname === '/__stats') return send(res, 200, { ...stats, total: rows.size, byShop: [...rows.values()].reduce((m, r) => ((m[r.shop || '(none)'] = (m[r.shop || '(none)'] || 0) + 1), m), {}), ids: url.searchParams.get('ids') ? [...rows.values()].filter(r => r.shop === url.searchParams.get('shop')).map(r => r.table_name + ':' + r.id) : undefined });
  if (url.pathname.startsWith('/rest/v1/rpc/')) return send(res, 200, {});
  if (url.pathname !== '/rest/v1/records') return send(res, 404, { message: 'not found' });
  if (req.method === 'GET') {
    stats.gets++;
    let list = [...rows.values()].filter(r => r.shop === shop);
    for (const [k, v] of url.searchParams) {
      const m = /^(eq|neq|gt)\.(.*)$/.exec(v); if (!m || ['select', 'order', 'limit'].includes(k)) continue;
      const val = m[2];
      list = list.filter(r => m[1] === 'eq' ? String(r[k]) === val : m[1] === 'neq' ? String(r[k]) !== val : Number(r[k]) > Number(val));
    }
    list.sort((a, b) => a.seq - b.seq);
    const lim = Number(url.searchParams.get('limit') || 1000);
    return send(res, 200, list.slice(0, lim).map(r => ({ table_name: r.table_name, id: r.id, counter: r.counter, data: r.data, seq: r.seq, updated_at: r.updated_at })));
  }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    stats.posts++;
    let list; try { list = JSON.parse(body || '[]'); } catch { return send(res, 400, { message: 'bad json' }); }
    for (const r of list) {
      const k = r.table_name + '|' + r.id;
      const ex = rows.get(k);
      if (ex && ex.shop !== shop) { stats.denied++; return send(res, 403, { message: 'new row violates row-level security policy for table "records"' }); }
      rows.set(k, { ...r, shop, seq: ++seq });
      stats.rowsIn++;
    }
    send(res, 201);
  });
}).listen(PORT, () => console.log('mock supabase on', PORT));
