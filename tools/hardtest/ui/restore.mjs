// Restore the 106 MB backup (2.5 lakh bills, 10 lakh stock moves) through the real screen and time it.
import { start, login, nav, tab, app } from './lib.mjs';
const [S, profile, port] = process.argv.slice(2);
const { ctx, url } = await start({ S, profile, port });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto(url); await login(page, '1111');
await nav(page, 'Import & setup'); await tab(page, 'Backup & restore');
await page.setInputFiles('input[type=file][accept*="dfrbak"]', S + '/stress/backup.dfrbak');
let t = Date.now();
await page.click('button:text-is("Restore")');
await page.waitForSelector('.modal button:has-text("Restore")', { timeout: 1800000 });
const check = Date.now() - t;
t = Date.now();
await page.click('.modal button:has-text("Restore")');
let lastLog = 0;
for (;;) {
  if (await page.locator('.pinpad').count()) break;
  if (Date.now() - lastLog > 30000) { lastLog = Date.now(); console.log(Math.round((Date.now() - t) / 1000) + 's', (await page.locator('.main').innerText().catch(() => '')).match(/Restoring…[^\n]*/)?.[0] || ''); }
  await page.waitForTimeout(1000);
}
const write = Date.now() - t;
await login(page, '1111');
const counts = await app(page, async X => { const o = {}; for (const k of ['sales', 'stockMoves', 'journal', 'products', 'customers']) o[k] = await X.db.table(k).count(); return o; });
console.log(JSON.stringify({ checkMs: check, writeMs: write, counts, errors: errs.slice(0, 3) }));
await ctx.close();
process.exit(0);
