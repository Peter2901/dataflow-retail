// Engine stress test runner: node engine.mjs <scratch> <profileDir|fresh> <port> <ops per tab> <workers> <tabs> [label]
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import net from 'net';
const [S, prof, port, ops = '2000', workers = '4', tabs = '2', label = 'run'] = process.argv.slice(2);
const busy = await new Promise(r => { const s = net.connect(Number(port), '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
if (busy) { console.log('PORT BUSY', port); process.exit(1); }
const web = spawn('/opt/node22/bin/node', ['/opt/node22/lib/node_modules/http-server/bin/http-server', S + '/site-stress', '-p', port, '-s', '-c-1']);
process.on('exit', () => { try { web.kill(); } catch { /* */ } });
process.on('uncaughtException', e => { console.log('CRASH', e.message); process.exit(1); });
await new Promise(r => setTimeout(r, 1500));
let dir = prof;
if (prof === 'fresh') { dir = S + '/engine/prof-' + label; fs.rmSync(dir, { recursive: true, force: true }); }
const ctx = await chromium.launchPersistentContext(dir, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, viewport: { width: 1280, height: 800 } });
const errs = [];
const open = async () => {
  const page = await ctx.newPage();
  page.on('pageerror', e => errs.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && errs.length < 50) errs.push('console: ' + m.text().slice(0, 300)); });
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(async () => window.__dfr && (await window.__dfr.db.settings.count()) > 5 && (await window.__dfr.db.products.count()) > 0, null, { timeout: 600000, polling: 1000 });
  await page.waitForTimeout(2500);
  await page.waitForFunction(async () => window.__dfr && (await window.__dfr.db.products.count()) > 0, null, { timeout: 600000, polling: 1000 });
  for (let i = 0; i < 5; i++) {
    await page.addScriptTag({ path: S + '/engine/inpage.js' }).catch(e => console.log('inject failed', e.message));
    if (await page.evaluate(() => typeof window.__engineSnap === 'function').catch(() => false)) break;
    await page.waitForTimeout(1500);
  }
  return page;
};
const t0 = Date.now();
const pages = [];
for (let i = 0; i < Number(tabs); i++) pages.push(await open());
console.log('opened', pages.length, 'tab(s) in', Date.now() - t0, 'ms');
const snap = await pages[0].evaluate(() => window.__engineSnap());
console.log('before:', JSON.stringify(snap));
const t1 = Date.now();
const runs = await Promise.all(pages.map((p, i) => p.evaluate(a => window.__engineRun(a), { seed: 1000 + i * 77 + label.length, ops: Number(ops), workers: Number(workers) })));
const runMs = Date.now() - t1;
const made = { sales: [], returns: [], purchases: [], dns: [], receipts: [], suppPays: [], transfers: [], writeoffs: 0, expenses: [], errors: [] };
for (const r of runs) for (const k of Object.keys(made)) made[k] = typeof made[k] === 'number' ? made[k] + r[k] : made[k].concat(r[k]);
console.log(`ran ${Number(ops) * pages.length} jobs in ${runMs} ms:`, JSON.stringify({ bills: made.sales.length, returns: made.returns.length, purchases: made.purchases.length, receipts: made.receipts.length, supplierPayments: made.suppPays.length, debitNotes: made.dns.length, writeOffs: made.writeoffs, transfers: made.transfers.length, expenses: made.expenses.length, errors: made.errors.length }));
runs.forEach((r, i) => console.log(`tab ${i + 1} timings:`, JSON.stringify(r.timings), 'skipped', JSON.stringify(r.skipped)));
if (made.errors.length) console.log('JOB ERRORS:', made.errors.slice(0, 12));
const t2 = Date.now();
const res = await pages[0].evaluate(m => window.__engineCheck(m), made);
console.log('checked in', Date.now() - t2, 'ms');
console.log(res.pass ? 'ENGINE CHECK: PASS' : 'ENGINE CHECK: FAIL');
for (const f of res.fails) console.log('  FAIL', f);
console.log('info:', JSON.stringify(res.info));
console.log('page errors:', errs.length, errs.slice(0, 8));
fs.writeFileSync(S + `/engine/result-${label}.json`, JSON.stringify({ snap, runMs, made: { ...made, sales: made.sales.length, returns: made.returns.length }, timings: runs.map(r => r.timings), res, errs }, null, 1));
await ctx.close(); web.kill();
void execSync;
