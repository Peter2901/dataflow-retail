// Sync at high volume: 4 counters + 1 phone on one (mock) cloud, all working at the same time; counter T3
// goes offline for a while and catches up. In the end every device must hold exactly the same store.
// node volume.mjs <scratch> <ops per counter> [webPort] [cloudPort]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
const [S, OPS = '300', WEB = '5210', CLOUD = '54330'] = process.argv.slice(2);
const web = spawn('/opt/node22/bin/node', ['/opt/node22/lib/node_modules/http-server/bin/http-server', S + '/site-stress', '-p', WEB, '-s', '-c-1']);
const cloud = spawn('/opt/node22/bin/node', [S + '/stress/mock-supabase.mjs', CLOUD]);
process.on('exit', () => { web.kill(); cloud.kill(); });
process.on('uncaughtException', e => { console.log('CRASH', e.message); process.exit(1); });
await new Promise(r => setTimeout(r, 2000));
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
const errs = [];
const URL0 = `http://localhost:${WEB}/`, CLOUD_URL = `http://localhost:${CLOUD}`, SHOP = 'shop_volumetestvolumetestvolume1';
const stats = async () => (await fetch(CLOUD_URL + '/__stats')).json();
const t0 = Date.now(); const el = () => Math.round((Date.now() - t0) / 1000) + 's';

async function open(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(name + ': ' + e.message));
  page.on('console', async m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errs.length < 80) { const a = await Promise.all(m.args().map(x => x.evaluate(v => (v && (v.stack || v.message)) || String(v)).catch(() => ''))); errs.push(name + ' console: ' + (a.join(' ') || m.text()).slice(0, 400)); } });
  await page.goto(URL0, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__dfr, null, { timeout: 120000 });
  return { name, ctx, page };
}
const inject = async d => { for (const f of ['engine/inpage.js', 'sync/digest.js']) await d.page.addScriptTag({ path: S + '/' + f }); };
const login = async d => { await d.page.waitForSelector('.pinpad', { timeout: 300000 }); for (const k of '1111') await d.page.click(`.pinpad button:text-is("${k}")`); await d.page.waitForSelector('.main', { timeout: 300000 }); };

// 1. The main counter (with the store's data) joins the cloud and sends everything.
const T1 = await open('T1');
await T1.page.waitForFunction(async () => (await window.__dfr.db.products.count()) > 0, null, { timeout: 120000 });
await T1.page.evaluate(async ({ url, shop }) => { const X = window.__dfr; for (const [k, v] of Object.entries({ syncUrl: url, syncKey: 'anon-test', syncEnabled: true, shopKey: shop, terminal: 'T1' })) await X.setSetting(k, v); await X.sync.prepareForPhones(); }, { url: CLOUD_URL, shop: SHOP });
console.log(el(), 'T1 sent the store:', JSON.stringify(await stats()));
const code = { url: CLOUD_URL, key: 'anon-test', store: 'S1', name: 'Sample Supermart', shop: SHOP };

// 2. Three more counters and a phone join with the setup code (the real "connect" code path).
const devs = [T1];
for (const [name, mode] of [['T2', 'counter'], ['T3', 'counter'], ['T4', 'counter'], ['M1', 'mobile']]) {
  const d = await open(name);
  await d.page.evaluate(async ({ code, name, mode }) => { const X = window.__dfr; await X.sync.connectDevice(code, { terminal: name, deviceMode: mode }); await X.sync.pullUntilQuiet(40); }, { code, name, mode });
  await d.page.reload({ waitUntil: 'domcontentloaded' }); await d.page.waitForFunction(() => window.__dfr, null, { timeout: 120000 });
  devs.push(d);
  console.log(el(), name, 'joined:', JSON.stringify(await d.page.evaluate(async () => ({ products: await window.__dfr.db.products.count(), sales: await window.__dfr.db.sales.count(), users: await window.__dfr.db.users.count() }))));
}
for (const d of devs) { await d.page.reload({ waitUntil: 'domcontentloaded' }); await login(d); await inject(d); }
// A real store's counters join a store that already has its data: wait until every device has all of it.
for (let i = 0; i < 30; i++) {
  const c = await Promise.all(devs.map(d => d.page.evaluate(async () => { const { db } = window.__dfr; return [await db.products.count(), await db.sales.count(), await db.batches.count(), await db.customers.count()].join('/'); })));
  if (new Set(c).size === 1) { console.log(el(), 'all devices have the store:', c[0]); break; }
  await new Promise(r => setTimeout(r, 3000));
}

// 3. Everyone works at once. Counters bill (with returns, udhaar, purchases, stock jobs); the phone does office work.
const counterMix = null;   // the engine's normal mix (70% bills)
const phoneMix = 'phone';
const offlineAfter = 20000, offlineFor = 60000;
setTimeout(async () => { console.log(el(), 'T3 goes OFFLINE'); await devs[2].ctx.setOffline(true); setTimeout(async () => { console.log(el(), 'T3 back ONLINE'); await devs[2].ctx.setOffline(false); }, offlineFor); }, offlineAfter);
const runs = await Promise.all(devs.map((d, i) => d.page.evaluate(async ({ seed, ops, phone }) => {
  const X = window.__dfr;
  if (phone) {
    // The phone app has no billing: purchases, supplier payments, udhaar received, write-offs, expenses.
    return window.__engineRun({ seed, ops, workers: 2, mix: 'phone' });
  }
  return window.__engineRun({ seed, ops, workers: 2 });
}, { seed: 5000 + i * 31, ops: d.name === 'M1' ? Math.round(Number(OPS) / 3) : Number(OPS), phone: d.name === 'M1' })));
void counterMix; void phoneMix;
runs.forEach((r, i) => console.log(el(), devs[i].name, 'made', JSON.stringify({ bills: r.sales.length, returns: r.returns.length, purchases: r.purchases.length, receipts: r.receipts.length, errors: r.errors.length, ms: r.ms }), r.errors.slice(0, 3)));

// 4. Let the sync settle: every device idle, nothing pending, cloud stops growing.
let last = -1, quiet = 0;
for (let i = 0; i < 120; i++) {
  await new Promise(r => setTimeout(r, 5000));
  const st = await stats();
  const sts = await Promise.all(devs.map(d => d.page.evaluate(() => window.__dfrSyncStatus?.() || {})));
  const pending = sts.map(s => s.pending ?? '?');
  if (i % 4 === 0) console.log(el(), 'cloud rows', st.total, 'pending', JSON.stringify(pending), 'errors', JSON.stringify(sts.map(s => (s.error || '').slice(0, 40))));
  if (st.total === last && sts.every(s => !s.busy && !s.pending)) { if (++quiet >= 4) break; } else quiet = 0;
  last = st.total;
}

// 5. Every device must hold the same store.
const dig = [];
for (const d of devs) dig.push(await d.page.evaluate(() => window.__syncDigest()));
const keys = Object.keys(dig[0]).filter(k => k.startsWith('#') || ['sales', 'batches', 'journal', 'moves', 'purchases', 'customers', 'todayDaySum', 'todayBills'].includes(k));
const table = keys.map(k => [k, ...dig.map(x => x[k])]);
console.log('\nper device:', devs.map(d => d.name).join(' | '));
for (const row of table) console.log(String(row[0]).padEnd(14), row.slice(1).join(' | '), new Set(row.slice(1).map(String)).size === 1 ? '' : '  <-- DIFFERENT');
const fails = [];
for (const row of table) if (new Set(row.slice(1).map(String)).size !== 1) fails.push('devices differ on ' + row[0]);
dig.forEach((x, i) => {
  if (x.dupBillNos) fails.push(`${devs[i].name}: ${x.dupBillNos} duplicate bill numbers`);
  if (x.dupMoves) fails.push(`${devs[i].name}: ${x.dupMoves} duplicate stock moves`);
  if (Math.abs(x.trialBalance) > 0.05) fails.push(`${devs[i].name}: trial balance ${x.trialBalance}`);
  if (x.chainProblems) fails.push(`${devs[i].name}: ${x.chainProblems} chain problems, e.g. ${JSON.stringify(x.chainFirst)}`);
  if (x.negativePoints) fails.push(`${devs[i].name}: ${x.negativePoints} customers with negative points`);
  if (Math.abs(x.todayDaySum - x.todayBills) > 0.05) fails.push(`${devs[i].name}: day total ${x.todayDaySum} ≠ bills ${x.todayBills}`);
});
// Where do they differ? (first few)
if (fails.some(f => f.startsWith('devices differ'))) {
  const full = [], cust = [];
  for (const d of devs) { const x = await d.page.evaluate(() => window.__syncDigest(true)); full.push(x.lists); cust.push(x.cust); }
  const odd = Object.keys(cust[0]).filter(id => new Set(cust.map(c => c[id]?.p)).size > 1).slice(0, 4);
  for (const id of odd) console.log('  points of', id, devs.map((d, i) => `${d.name}: ${JSON.stringify(cust[i][id])}`).join('  '));
  for (const k of Object.keys(full[0])) {
    const sets = full.map(l => new Set(l[k]));
    const union = new Set(full.flatMap(l => l[k]));
    const odd = [...union].filter(v => !sets.every(s => s.has(v))).slice(0, 6);
    if (odd.length) console.log('  differs in', k, '→', odd.map(v => `${v} [${sets.map((s, i) => (s.has(v) ? devs[i].name : '-')).join(',')}]`).join('  '));
  }
}
const st = await stats();
console.log('\ncloud:', JSON.stringify({ rows: st.total, posts: st.posts, gets: st.gets, denied: st.denied }));
console.log(fails.length ? 'SYNC VOLUME TEST: FAIL' : 'SYNC VOLUME TEST: PASS');
fails.forEach(f => console.log('  FAIL', f));
console.log('page errors:', errs.length, errs.slice(0, 8));
fs.writeFileSync(S + '/sync/result-volume.json', JSON.stringify({ dig, fails, errs, cloud: st, runs: runs.map(r => ({ ...r, sales: r.sales.length, returns: r.returns.length })) }, null, 1));
await browser.close();
process.exit(0);
