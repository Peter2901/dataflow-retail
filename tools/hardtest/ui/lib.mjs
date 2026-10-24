// Shared helpers for the screen tests (Playwright, real Chromium, the stress build of the app).
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';

export async function start({ S, profile, port, site = 'site-stress', viewport = { width: 1366, height: 900 } }) {
  const busy = await new Promise(r => { const s = net.connect(Number(port), '127.0.0.1'); s.on('connect', () => { s.destroy(); r(true); }); s.on('error', () => r(false)); });
  if (busy) { console.log('PORT BUSY', port); process.exit(1); }
  const web = spawn('/opt/node22/bin/node', ['/opt/node22/lib/node_modules/http-server/bin/http-server', S + '/' + site, '-p', String(port), '-s', '-c-1']);
  process.on('exit', () => { try { web.kill(); } catch { /* */ } });
  await new Promise(r => setTimeout(r, 1500));
  const ctx = await chromium.launchPersistentContext(profile, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, viewport, acceptDownloads: true });
  return { ctx, web, url: `http://localhost:${port}/` };
}

export function reporter(S, label) {
  const R = { label, tests: [], errors: [] };
  let cur = '';
  const t = async (name, fn) => {
    cur = name;
    const t0 = Date.now();
    try {
      const info = await fn();
      const ms = Date.now() - t0;
      R.tests.push({ name, pass: true, ms, info });
      console.log(`PASS ${name} (${ms} ms)${info ? ' — ' + (typeof info === 'string' ? info : JSON.stringify(info)).slice(0, 220) : ''}`);
    } catch (e) {
      const ms = Date.now() - t0;
      R.tests.push({ name, pass: false, ms, error: String(e.message || e).slice(0, 600) });
      console.log(`FAIL ${name} (${ms} ms) — ${String(e.message || e).split('\n')[0].slice(0, 300)}`);
      if (R.page) await R.page.screenshot({ path: `${S}/ui/shots/FAIL-${label}-${name.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.png` }).catch(() => {});
      if (R.recover) await R.recover().catch(() => {});
    }
  };
  const watch = page => {
    R.page = page;
    page.on('pageerror', e => { R.errors.push(`[${cur}] ${e.message}`); console.log('  PAGEERROR', cur, e.message.slice(0, 200)); });
    page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) { R.errors.push(`[${cur}] console: ${m.text().slice(0, 300)}`); } });
  };
  const save = () => {
    const pass = R.tests.filter(x => x.pass).length;
    console.log(`\n${label}: ${pass}/${R.tests.length} passed, page errors ${R.errors.length}`);
    R.errors.slice(0, 10).forEach(e => console.log('  ', e.slice(0, 250)));
    fs.writeFileSync(`${S}/ui/result-${label}.json`, JSON.stringify(R, (k, v) => (k === 'page' || k === 'recover' ? undefined : v), 1));
    return R;
  };
  return { t, watch, save, R };
}

export const must = (cond, msg) => { if (!cond) throw new Error(msg); };

export async function login(page, pin = '1111') {
  await page.waitForSelector('.pinpad', { timeout: 300000 });
  for (const d of pin) await page.click(`.pinpad button:text-is("${d}")`);
  await page.waitForSelector('.main', { timeout: 300000 });
}

export async function logout(page) {
  const b = page.locator('button:has-text("Lock"), button[aria-label*="Lock"], button:has-text("Log out"), button:has-text("Sign out")').first();
  if (await b.count()) await b.click(); else await page.reload();
  await page.waitForSelector('.pinpad', { timeout: 300000 });
}

export async function nav(page, label) {
  const item = page.locator(`.nav-item:has-text("${label}")`).first();
  if (!(await item.isVisible())) await page.click('.nav-group-btn:has-text("Setup")');
  await item.click();
  await page.waitForFunction(() => document.querySelector('.main h1'), null, { timeout: 120000 });
  await settle(page);
}

export async function tab(page, label) {
  await page.click(`.tabs button:has-text("${label}")`);
  await settle(page);
}

// Wait until the screen stops saying "Loading…"/"Working…" (up to 2 minutes).
export async function settle(page, ms = 120000) {
  await page.waitForFunction(() => !/Loading…|Working it out|Reading the books/.test(document.querySelector('.main')?.innerText || ''), null, { timeout: ms, polling: 100 }).catch(() => {});
  await page.waitForTimeout(150);
}

export async function badText(page) {
  // Screen text without code boxes (the setup SQL legitimately says "not null").
  const txt = await page.evaluate(() => { const m = document.querySelector('.main'); if (!m) return ''; const c = m.cloneNode(true); c.querySelectorAll('pre, code, textarea').forEach(x => x.remove()); document.body.appendChild(c); c.style.position = 'absolute'; c.style.left = '-99999px'; const t = c.innerText; c.remove(); return t; }).catch(() => '');
  const m = txt.match(/\bNaN\b|\bundefined\b|Invalid Date|\[object Object\]|₹\s*Infinity|\bnull\b/);
  return m ? m[0] + ' … ' + txt.slice(Math.max(0, m.index - 80), m.index + 40).replace(/\n/g, ' ') : '';
}

export async function approve(page, pin = '1111') {
  await page.waitForSelector('#approve-pin', { timeout: 20000 });
  await page.fill('#approve-pin', pin);
  await page.click('.modal button:text-is("Approve")');
  await page.waitForSelector('#approve-pin', { state: 'detached', timeout: 20000 });
}

export async function confirmYes(page, label) {
  const b = page.locator(`.modal button:text-is("${label}")`).last();
  await b.waitFor({ timeout: 20000 });
  await b.click();
}

export const toasts = async page => (await page.locator('.toast').allInnerTexts()).join(' | ');

// Run real app code inside the page (stress build exposes window.__dfr).
export const app = (page, fn, arg) => page.evaluate(async ({ src, arg }) => (0, eval)('(' + src + ')')(window.__dfr, arg), { src: fn.toString(), arg });
