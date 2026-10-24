// Repairs test data made by the old generator: adds the missing round-off lines and party account rows.
// Raw IndexedDB on a blank page of the same origin (no app running, no Dexie hooks) — fast.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'child_process';
const [S, prof, port] = process.argv.slice(2);
const web = spawn('/opt/node22/bin/node', ['/opt/node22/lib/node_modules/http-server/bin/http-server', S + '/site-stress', '-p', port, '-s', '-c-1']);
process.on('exit', () => web.kill());
await new Promise(r => setTimeout(r, 1500));
const ctx = await chromium.launchPersistentContext(prof, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true, serviceWorkers: 'block' });
const page = await ctx.newPage();
await page.goto(`http://localhost:${port}/gst-rules.json`).catch(() => {}); await page.waitForTimeout(2000);
const t0 = Date.now();
const r = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const q = indexedDB.open('dataflow_retail'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const P = v => Math.round((Number(v) || 0) * 100);
  const ids = new Set(); let fixed = 0;
  await new Promise((res, rej) => {
    const tx = db.transaction('journal', 'readwrite');
    const cur = tx.objectStore('journal').openCursor();
    cur.onsuccess = () => {
      const c = cur.result; if (!c) return;
      const e = c.value;
      for (const l of e.lines) if (/^(cust|supp):/.test(l.acc)) ids.add(l.acc);
      const d = e.lines.reduce((a, l) => a + P(l.dr) - P(l.cr), 0);
      if (d) { e.lines.push(d > 0 ? { acc: 'roundoff', cr: d / 100 } : { acc: 'roundoff', dr: -d / 100 }); c.update(e); fixed++; }
      c.continue();
    };
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  const all = (store) => new Promise(res => { const q = db.transaction(store).objectStore(store).getAll(); q.onsuccess = () => res(q.result); });
  const have = new Set((await all('accounts')).map(a => a.id));
  const custs = new Map((await all('customers')).map(c => [c.id, c.name])), sups = new Map((await all('suppliers')).map(s => [s.id, s.name]));
  const add = [...ids].filter(id => !have.has(id)).map(id => { const k = id.slice(0, 4), pid = id.slice(5); return { id, name: (k === 'cust' ? custs : sups).get(pid) || id, group: k === 'cust' ? 'asset' : 'liability', party: k, partyId: pid, updatedAt: Date.now() }; });
  await new Promise((res, rej) => { const tx = db.transaction(['accounts', 'syncMeta'], 'readwrite'); const st = tx.objectStore('accounts'); add.forEach(a => st.put(a)); tx.objectStore('syncMeta').delete('bal:cp'); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
  db.close();
  return { fixedEntries: fixed, addedAccounts: add.length };
});
console.log('repaired', JSON.stringify(r), 'in', Date.now() - t0, 'ms');
await ctx.close();
process.exit(0);
