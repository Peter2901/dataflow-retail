// Opens every page and every tab (owner), times it, and looks for broken text (NaN, undefined…) and errors.
// Then the same in Hindi and Odia, and each role's menu. node pages.mjs <scratch> <profile> <port> [langs]
import { start, reporter, must, login, logout, settle, badText, app } from './lib.mjs';
const [S, profile, port, langs = 'en,hi,or'] = process.argv.slice(2);
const { ctx, url } = await start({ S, profile, port });
const { t, watch, save, R } = reporter(S, 'pages');
const page = await ctx.newPage();
watch(page);
await page.goto(url);
await login(page, '1111');
R.recover = async () => { await page.keyboard.press('Escape'); };

const openSetup = async () => { const b = page.locator('.nav-group-btn:has-text("Setup"), .nav-group-btn'); if (await b.count() && (await b.first().getAttribute('aria-expanded')) === 'false') await b.first().click(); };
const menu = async () => { await openSetup(); return page.locator('.nav-item').allInnerTexts(); };

for (const lang of langs.split(',')) {
  if (lang !== 'en') { await app(page, (X, l) => X.setSetting('lang', l), lang); await page.waitForTimeout(1500); }
  await openSetup();
  const items = await page.locator('.nav-item').count();
  for (let i = 0; i < items; i++) {
    await openSetup();
    const item = page.locator('.nav-item').nth(i);
    const label = (await item.innerText()).split('\n')[0].trim();
    await t(`[${lang}] ${label}`, async () => {
      const t0 = Date.now();
      await item.click();
      await page.waitForFunction(() => document.querySelector('.main h1'), null, { timeout: 120000 });
      await settle(page);
      const openMs = Date.now() - t0;
      if (await page.locator('.main #float').count()) return `${openMs} ms (counter closed)`;
      const bad = await badText(page);
      must(!bad, 'broken text: ' + bad);
      const tabs = page.locator('.main .tabs').first().locator('button');
      const nt = await tabs.count();
      const tabMs = [];
      for (let k = 0; k < nt; k++) {
        const tl = (await tabs.nth(k).innerText()).trim();
        const t1 = Date.now();
        await tabs.nth(k).click(); await settle(page);
        tabMs.push(`${tl} ${Date.now() - t1}`);
        const b2 = await badText(page);
        must(!b2, `broken text on tab "${tl}": ${b2}`);
      }
      if (lang === 'en') await page.screenshot({ path: `${S}/ui/shots/page-${String(i).padStart(2, '0')}-${label.replace(/[^a-z0-9]+/gi, '_')}.png` });
      return `${openMs} ms${nt ? ' · tabs: ' + tabMs.join(', ') : ''}`;
    });
  }
  // Untranslated words left on the main screens.
  if (lang !== 'en') await t(`[${lang}] screens are translated`, async () => {
    const words = await page.evaluate(() => { const txt = document.querySelector('.nav')?.innerText || ''; return txt; });
    must(!/Dashboard|Products|Reports|Settings/.test(words), 'English menu words: ' + words.slice(0, 200));
  });
}
await app(page, X => X.setSetting('lang', 'en')); await page.waitForTimeout(1200);

await t('dark theme renders', async () => {
  await page.click('.theme-pick button[aria-label="Dark"]'); await page.waitForTimeout(600);
  const dark = await page.evaluate(() => document.documentElement.dataset.theme || getComputedStyle(document.body).backgroundColor);
  await page.screenshot({ path: `${S}/ui/shots/theme-dark.png` });
  await page.click('.theme-pick button[aria-label="Light"]');
  return dark;
});

const ROLE = { '2222': 'manager', '3333': 'cashier', '4444': 'accountant' };
const mustNot = { manager: ['Accounts', 'GST Saathi', 'Settings', 'Security & audit'], cashier: ['Accounts', 'GST Saathi', 'Settings', 'Products', 'Reports', 'Stock & batches', 'Purchases & suppliers'], accountant: ['Settings', 'Billing counter', 'Stock & batches', 'Staff & salary'] };
for (const [pin, role] of Object.entries(ROLE)) {
  await t(`menu for ${role}`, async () => {
    await logout(page); await login(page, pin);
    const m = await menu();
    const leak = mustNot[role].filter(x => m.some(y => y.split('\n')[0].trim() === x));
    must(!leak.length, 'can see: ' + leak.join(', '));
    return m.map(x => x.split('\n')[0]).join(', ');
  });
}
await logout(page); await login(page, '1111');
save();
await ctx.close();
process.exit(0);
