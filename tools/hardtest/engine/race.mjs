// Same-moment saves: returns of one bill, purchases, salary, orders — from 2 tabs × 5 calls at once.
import { chromium } from '/opt/node22/lib/node_modules/playwright/index.mjs';
import { spawn } from 'child_process';
import fs from 'fs';
const [S, port = '5251'] = process.argv.slice(2);
const web = spawn('/opt/node22/bin/node', ['/opt/node22/lib/node_modules/http-server/bin/http-server', S + '/site-stress', '-p', port, '-s', '-c-1']);
process.on('exit', () => web.kill());
await new Promise(r => setTimeout(r, 1500));
const dir = S + '/engine/prof-race'; fs.rmSync(dir, { recursive: true, force: true });
const ctx = await chromium.launchPersistentContext(dir, { executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', headless: true });
const open = async () => { const p = await ctx.newPage(); await p.goto(`http://localhost:${port}/`); await p.waitForFunction(async () => window.__dfr && (await window.__dfr.db.sales.count()) > 50, null, { timeout: 120000, polling: 500 }); await p.waitForTimeout(1500); return p; };
const A = await open(), B = await open();
const fails = [];
for (let round = 0; round < 10; round++) {
  // pick a bill with something left to return
  const no = await A.evaluate(async r => { const X = window.__dfr; const all = (await X.db.sales.where('type').equals('sale').toArray()); for (const s of all.slice(r * 7)) { const d = await X.returns.returnedSoFar(s); if (X.returns.returnLeft(s, d).some(v => v > 0)) return s.no; } return null; }, round);
  if (!no) break;
  const go = page => page.evaluate(async no => {
    const X = window.__dfr; const s = await X.db.sales.where('no').equals(no).first();
    const user = (await X.db.users.toArray())[0];
    const tries = Array.from({ length: 5 }, async () => { const d = await X.returns.returnedSoFar(s); const left = X.returns.returnLeft(s, d); const bill = X.returns.buildReturn(s, left, d); if (!bill.lines.length) return 'nothing'; try { await X.returns.saveReturn({ sale: s, bill, mode: 'cash', user, shiftId: 'race', storeId: s.storeId }); return 'saved'; } catch (e) { return /moment ago/.test(e.message) ? 'refused' : 'error: ' + e.message; } });
    return Promise.all(tries);
  }, no);
  const [ra, rb] = await Promise.all([go(A), go(B)]);
  const all = [...ra, ...rb];
  const check = await A.evaluate(async no => { const X = window.__dfr; const s = await X.db.sales.where('no').equals(no).first(); const rs = (await X.db.sales.where('origNo').equals(no).toArray()).filter(x => x.type === 'return'); const refund = rs.reduce((a, r) => a + r.totals.payable, 0); const over = s.lines.some((l, i) => rs.reduce((a, r) => a + r.lines.filter(x => x.origLine === i).reduce((y, x) => y + x.qty, 0), 0) > l.qty + 1e-6); return { returns: rs.length, refund: Math.round(refund * 100) / 100, bill: s.totals.payable, over }; }, no);
  const saved = all.filter(x => x === 'saved').length;
  console.log(no, JSON.stringify({ saved, refused: all.filter(x => x === 'refused').length, other: all.filter(x => x !== 'saved' && x !== 'refused') }), JSON.stringify(check));
  if (check.over || check.refund > check.bill + 0.001 || saved !== 1) fails.push(no);
}
// purchases at the same moment: numbers must stay unique
const nos = await Promise.all([A, B].map(p => p.evaluate(async () => { const X = window.__dfr; const sup = (await X.db.suppliers.toArray())[0]; const pr = (await X.db.products.toArray())[0]; const user = (await X.db.users.toArray())[0];
  return Promise.all(Array.from({ length: 6 }, () => X.purchasing.savePurchase({ supplier: sup, billNo: 'R' + Math.random(), date: X.util.todayISO(), lines: [{ productId: pr.id, name: pr.name, qty: 1, pack: 1, rate: 10, gst: 5 }], storeId: 'S1', user }).then(p => p.no))); })));
const flat = nos.flat();
console.log('purchase numbers', flat.length, 'unique', new Set(flat).size);
if (new Set(flat).size !== flat.length) fails.push('purchase numbers');
console.log(fails.length ? 'RACE TEST: FAIL ' + fails.join(', ') : 'RACE TEST: PASS');
await ctx.close(); process.exit(0);
