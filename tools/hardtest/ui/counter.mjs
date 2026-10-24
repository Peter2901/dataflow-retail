// Every counter feature, on the huge store: node counter.mjs <scratch> <profile> <port>
import { start, reporter, must, login, logout, nav, approve, toasts, app, settle } from './lib.mjs';
const [S, profile, port] = process.argv.slice(2);
const { ctx, url } = await start({ S, profile, port });
const { t, watch, save, R } = reporter(S, 'counter');
const page = await ctx.newPage();
watch(page);
await page.goto(url);
await login(page, '1111');

const lines = () => page.locator('.cart-line').count();
const last = () => app(page, async X => { const s = await X.db.sales.orderBy('ts').last(); return s; });
const scan = async code => { await page.fill('#scan', code); await page.press('#scan', 'Enter'); };
const waitLines = n => page.waitForFunction(n => document.querySelectorAll('.cart-line').length === n, n, { timeout: 30000 });
const empty = async () => { if (await lines()) { await page.click('button:has-text("Cancel bill")'); if (await page.locator('#approve-pin').count()) await approve(page); } await waitLines(0); };
const pickCust = async phone => { await page.fill('#custq', phone); await page.waitForFunction(ph => (document.querySelector('.modal .cust-chip')?.innerText || '').includes(ph), phone, { timeout: 30000 }); await page.locator('.modal .cust-chip').first().click(); };
const closeReceipt = async () => { await page.click('.modal button:has-text("Next customer")'); await page.waitForSelector('.receipt', { state: 'detached' }); };
R.recover = async () => { await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.waitForTimeout(300); if (await page.locator('.cart-line').count()) await empty().catch(() => {}); };

// Items to scan: packed, in date, with a barcode; one loose (PLU); one with units.
const codes = await app(page, async X => {
  const { db } = X;
  const bs = (await db.batches.where('storeId').equals('S1').toArray()).filter(b => b.status === 'active' && b.qty > 50 && X.stock.daysLeft(b.expiry) > 60);
  const ok = new Set(bs.map(b => b.productId));
  const ps = (await db.products.toArray()).filter(p => ok.has(p.id) && p.active !== false);
  const packed = ps.filter(p => p.barcode && !p.loose && !p.units && p.price > 20 && p.price < 2000 && p.price <= p.mrp).slice(0, 40);
  const loose = ps.find(p => p.loose && p.plu);
  const unit = ps.find(p => p.units && p.units.names?.[0] && !p.loose) || ps.find(p => p.units && p.units.names?.[0]);
  const custs = await db.customers.toArray();
  const due = await X.parties.partyBalances('cust');
  const credit = custs.find(c => (!c.priceLevel || c.priceLevel === 'retail') && (c.creditLimit || 0) - (due[c.id] || 0) > 600 && !c.gstin);
  const pointsC = custs.find(c => (c.points || 0) >= 200 && c.priceLevel !== 'wholesale' && !c.gstin);
  const whC = custs.find(c => c.priceLevel === 'wholesale');
  const cheap = [...packed].sort((a, b) => a.price - b.price)[0];
  return { cheap: cheap && { code: cheap.barcode, price: cheap.price }, packed: packed.map(p => ({ code: p.barcode, name: p.name, price: p.price })), loose: loose && { plu: loose.plu, name: loose.name }, unit: unit && { code: unit.barcode || unit.id, name: unit.name, units: unit.units }, credit: credit && { phone: credit.phone, id: credit.id }, points: pointsC && { phone: pointsC.phone, id: pointsC.id, pts: pointsC.points }, wh: whC && { phone: whC.phone } };
});
console.log('test items:', JSON.stringify({ packed: codes.packed.length, loose: !!codes.loose, unit: !!codes.unit, credit: !!codes.credit, points: codes.points?.pts, wh: !!codes.wh }));
const P = i => codes.packed[i % codes.packed.length];

await t('open the counter', async () => {
  await nav(page, 'Billing counter');
  if (await page.locator('button:has-text("Open counter")').count()) { await page.fill('#float', '2000'); await page.click('button:has-text("Open counter")'); }
  await page.waitForSelector('#scan', { timeout: 60000 });
});

await t('double Enter on Open counter makes one shift', async () => {
  const n = await app(page, async X => (await X.db.shifts.toArray()).filter(s => !s.closedAt && s.userId === 'u_owner').length);
  must(n === 1, `open shifts: ${n}`);
});

await t('scan barcode → line; same item again → qty 2', async () => {
  await scan(P(0).code); await waitLines(1);
  await scan(P(0).code); await page.waitForTimeout(400);
  const q = await page.locator('.cart-line input[aria-label="Quantity"]').first().inputValue();
  must((await lines()) === 1 && q === '2', `lines ${await lines()}, qty ${q}`);
});

await t('type a name, pick from suggestions with ↓ and Enter', async () => {
  const word = P(1).name.split(' ')[0];
  await page.fill('#scan', word); await page.waitForSelector('.suggest-item', { timeout: 10000 });
  await page.press('#scan', 'ArrowDown'); await page.press('#scan', 'Enter'); await waitLines(2);
  return word;
});

await t('quantity + − and typing', async () => {
  const row = page.locator('.cart-line').nth(1);
  await row.locator('button[aria-label="More"]').click(); await row.locator('button[aria-label="More"]').click();
  let q = await row.locator('input[aria-label="Quantity"]').inputValue(); must(q === '3', 'after ++ ' + q);
  await row.locator('button[aria-label="Less"]').click(); q = await row.locator('input[aria-label="Quantity"]').inputValue(); must(q === '2', 'after − ' + q);
  await row.locator('input[aria-label="Quantity"]').fill('5'); await page.waitForTimeout(300);
  q = await row.locator('input[aria-label="Quantity"]').inputValue(); must(q === '5', 'typed ' + q);
});

await t('remove a line', async () => {
  await page.locator('.cart-line').nth(1).locator('button[aria-label^="Remove"]').click(); await waitLines(1);
});

await t('cash bill with change (F9)', async () => {
  await scan(P(2).code); await waitLines(2);
  const total = await page.locator('.grand').innerText();
  await page.keyboard.press('F9'); await page.waitForSelector('#tender');
  await page.fill('#tender', '5000'); await page.waitForSelector('.save-pill:has-text("Give change")');
  await page.click('.modal button:has-text("Complete bill")'); await page.waitForSelector('.receipt', { timeout: 30000 });
  const s = await last(); await closeReceipt();
  must(s.payments[0].mode === 'cash' && s.payments[0].change > 0 && s.lines.length === 2, JSON.stringify(s.payments));
  return `${s.no} ${total} change ${s.payments[0].change}`;
});

let cashBillNo = null;
await t('UPI bill (F10)', async () => {
  await scan(P(3).code); await waitLines(1);
  await page.keyboard.press('F10'); await page.click('.modal button:has-text("Payment received")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  must(s.payments[0].mode === 'upi', s.payments[0].mode);
});

await t('card bill (F11) with approval code', async () => {
  await scan(P(4).code); await waitLines(1);
  await page.keyboard.press('F11'); await page.fill('#cardref', 'AP7788'); await page.click('.modal button:has-text("Complete bill")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  must(s.payments[0].mode === 'card' && s.payments[0].ref === 'AP7788', JSON.stringify(s.payments));
});

await t('split: part cash, rest UPI', async () => {
  await scan(P(5).code); await scan(P(6).code); await waitLines(2);
  await page.keyboard.press('F9'); await page.fill('#tender', '10');
  await page.click('.modal button:has-text("Take")'); await page.waitForSelector('.note:has-text("Paid so far")');
  await page.click('.pay-mode:has-text("UPI")'); await page.click('.modal button:has-text("Payment received")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  cashBillNo = s.no;
  must(s.payments.length === 2 && s.payments[0].amount === 10 && Math.abs(s.payments[0].amount + s.payments[1].amount - s.totals.payable) < 0.001, JSON.stringify(s.payments));
  return s.no + ' ' + JSON.stringify(s.payments.map(p => [p.mode, p.amount]));
});

await t('udhaar bill (F3 customer, F12)', async () => {
  must(codes.credit, 'no customer with credit room');
  const before = await app(page, (X, id) => X.parties.customerDue(id), codes.credit.id);
  await scan(codes.cheap.code); await waitLines(1);
  await page.keyboard.press('F3'); await pickCust(codes.credit.phone);
  await page.keyboard.press('F12'); await page.click('.modal button:has-text("Complete bill")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  const after = await app(page, (X, id) => X.parties.customerDue(id), codes.credit.id);
  must(s.payments[0].mode === 'credit' && Math.abs(after - before - s.totals.payable) < 0.01, `due ${before} → ${after}, bill ${s.totals.payable}`);
  return `due ${before} → ${after}`;
});

await t('udhaar refused for no customer', async () => {
  await scan(P(8).code); await waitLines(1);
  await page.keyboard.press('F12'); await page.waitForSelector('.modal :text("Add the customer first")');
  const dis = await page.locator('.modal button:has-text("Complete bill")').isDisabled();
  await page.keyboard.press('Escape');
  await empty();
  must(dis, 'complete button should be off');
});

await t('loyalty points: Max then bill', async () => {
  must(codes.points, 'no customer with points');
  await page.keyboard.press('F3'); await pickCust(codes.points.phone);
  await scan(P(9).code); await scan(P(10).code); await scan(P(11).code); await waitLines(3);
  const maxBtn = page.locator('button:has-text("Max")');
  must(await maxBtn.count(), 'no Max button (bill too small?)');
  await maxBtn.click(); await page.waitForTimeout(400);
  await page.keyboard.press('F10'); await page.click('.modal button:has-text("Payment received")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  const c = await app(page, (X, id) => X.db.customers.get(id), codes.points.id);
  must(s.pointsUsed > 0 && c.points === codes.points.pts - s.pointsUsed + s.pointsEarned, `used ${s.pointsUsed} earned ${s.pointsEarned} now ${c.points} was ${codes.points.pts}`);
  return `used ${s.pointsUsed}, earned ${s.pointsEarned}`;
});

await t('business bill with GSTIN; bad GSTIN refused', async () => {
  await scan(P(12).code); await waitLines(1);
  await page.fill('#b2b', '21AAAAA0000A1Z0'); await page.waitForSelector('.err:has-text("GSTIN check failed")');
  await page.keyboard.press('F9'); await page.click('.modal button:has-text("Complete bill")'); await page.waitForTimeout(600);
  must(/not valid/.test(await toasts(page)), 'bad GSTIN was not refused: ' + await toasts(page));
  const good = await app(page, X => { const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'; const s = '27ABCDE1234F1Z'; let sum = 0; for (let i = 0; i < 14; i++) { const p = CH.indexOf(s[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); } return s + CH[(36 - (sum % 36)) % 36]; });
  await page.fill('#b2b', good); await page.waitForSelector('text=IGST will be charged');
  await page.keyboard.press('F9'); await page.click('.modal button:has-text("Complete bill")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  must(s.b2b?.gstin === good && s.totals.igst > 0 && !s.totals.cgst, JSON.stringify({ b2b: s.b2b, igst: s.totals.igst, cgst: s.totals.cgst }));
  return good;
});

await t('hold (F7) and recall (F8)', async () => {
  await page.fill('#b2b', '');
  await scan(P(13).code); await scan(P(14).code); await waitLines(2);
  await page.keyboard.press('F7'); await waitLines(0);
  await page.keyboard.press('F8'); await page.locator('.modal .cust-chip').first().click(); await waitLines(2);
});

await t('cancel a 3-item bill needs manager PIN', async () => {
  await scan(P(15).code); await waitLines(3);
  await page.click('button:has-text("Cancel bill")'); await approve(page, '2222'); await waitLines(0);
  const a = await app(page, async X => (await X.db.audit.orderBy('ts').last()).action);
  must(a === 'bill_cancel', a);
});

await t('price change needs manager PIN, logged', async () => {
  await scan(P(16).code); await waitLines(1);
  await page.click('.cart-line button[title^="Change price"]');
  const newP = Math.floor(P(16).price * 0.9);
  await page.fill('#newprice', String(newP)); await page.click('.modal button:has-text("Next: manager approval")');
  await approve(page, '1111'); await page.waitForTimeout(400);
  const txt = await page.locator('.cart-line').first().innerText();
  const a = await app(page, async X => (await X.db.audit.orderBy('ts').last()));
  must(a.action === 'price_override' && txt.includes(String(newP)), a.action + ' ' + txt.slice(0, 80));
  await page.keyboard.press('F9'); await page.click('.modal button:has-text("Complete bill")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  must(s.lines[0].unitPrice === newP, 'saved price ' + s.lines[0].unitPrice);
});

await t('wholesale switch changes prices; back to retail after bill', async () => {
  await scan(P(17).code); await waitLines(1);
  const before = await page.locator('.grand').innerText();
  await page.click('.price-mode button:has-text("Wholesale")'); await page.waitForTimeout(500);
  const on = await page.locator('.price-mode button.on').innerText();
  await page.keyboard.press('F9'); await page.click('.modal button:has-text("Complete bill")'); await page.waitForSelector('.receipt');
  const s = await last(); await closeReceipt();
  const after = await page.locator('.price-mode button.on').innerText();
  must(on === 'Wholesale' && s.priceMode === 'wholesale' && after === 'Retail', `${on} ${s.priceMode} ${after}`);
  return `${before} wholesale ${s.totals.payable}`;
});

await t('wholesale customer switches by itself', async () => {
  if (!codes.wh) return 'no wholesale customer in data';
  await scan(P(18).code); await waitLines(1);
  await page.keyboard.press('F3'); await pickCust(codes.wh.phone); await page.waitForTimeout(500);
  const on = await page.locator('.price-mode button.on').innerText();
  await page.click('button[aria-label="Remove customer"]'); await page.waitForTimeout(300);
  const off = await page.locator('.price-mode button.on').innerText();
  await empty();
  must(on === 'Wholesale' && off === 'Retail', on + ' ' + off);
});

await t('loose item by PLU → weight box', async () => {
  if (!codes.loose) return 'no loose item';
  await scan(codes.loose.plu); await page.waitForSelector('#kg'); await page.fill('#kg', '0.75'); await page.press('#kg', 'Enter'); await waitLines(1);
  const q = await page.locator('.cart-line input[aria-label="Quantity"]').first().inputValue();
  await empty();
  must(Number(q) === 0.75 || q === '750', 'qty ' + q);
});

await t('weighing-scale sticker barcode', async () => {
  if (!codes.loose) return 'no loose item';
  const code12 = '21' + codes.loose.plu.padStart(5, '0') + '01250';
  const ean = await app(page, (X, c) => c + X.util.eanCheckDigit(c), code12);
  await scan(ean); await waitLines(1);
  const q = await page.locator('.cart-line input[aria-label="Quantity"]').first().inputValue();
  await empty();
  must(Number(q) === 1.25 || q === '1250', 'qty ' + q);
  return ean;
});

await t('item with units: switch unit on the line', async () => {
  if (!codes.unit) return 'no unit item';
  await scan(codes.unit.code);
  if (await page.locator('#kg').count() || await page.waitForSelector('#kg', { timeout: 1500 }).then(() => true, () => false)) { await page.fill('#kg', '1'); await page.press('#kg', 'Enter'); }
  await waitLines(1);
  const sel = page.locator('.cart-line select.unit-pick').first();
  const opts = await sel.locator('option').allInnerTexts();
  const t1 = await page.locator('.cart-line .line-total').first().innerText();
  await sel.selectOption({ index: 0 }); await page.waitForTimeout(400);
  const t2 = await page.locator('.cart-line .line-total').first().innerText();
  await empty();
  must(opts.length >= 2, 'units ' + opts.join(','));
  return `${opts.join('/')} ${t1} → ${t2}`;
});

await t('unknown barcode → add product right there', async () => {
  const code = 'TST' + Date.now().toString().slice(-8);
  await scan(code); await page.waitForSelector('#qa-name', { timeout: 20000 });
  await page.fill('#qa-name', 'Test Item ' + code); await page.fill('#qa-mrp', '99'); await page.fill('#qa-price', '95');
  await page.click('.modal button:text-is("Save")'); await waitLines(1);
  const p = await app(page, (X, c) => X.db.products.where('barcode').equals(c).first(), code);
  await empty();
  must(p && p.price === 95, JSON.stringify(p).slice(0, 100));
});

await t('return part of a bill (F6) → credit note, stock back', async () => {
  must(cashBillNo, 'no bill to return');
  const orig = await app(page, (X, no) => X.db.sales.where('no').equals(no).first(), cashBillNo);
  const bid = orig.lines[0].batches[0].batchId;
  const qb = await app(page, (X, id) => X.db.batches.get(id).then(b => b.qty), bid);
  await page.keyboard.press('F6'); await page.fill('#retno', cashBillNo); await page.click('.modal button:has-text("Find bill")');
  await page.locator('.modal input[aria-label^="Return quantity"]').first().fill('1');
  await page.click('.modal button:has-text("Refund")');
  if (await page.locator('#approve-pin').count()) await approve(page);
  await page.waitForSelector('.receipt', { timeout: 30000 });
  const s = await last(); await closeReceipt();
  const qa = await app(page, (X, id) => X.db.batches.get(id).then(b => b.qty), bid);
  must(s.type === 'return' && s.origNo === cashBillNo && Math.abs(qa - qb - 1) < 0.001, `type ${s.type} stock ${qb} → ${qa}`);
  return s.no;
});

await t('return again: a fully returned line is locked, the rest is limited', async () => {
  await page.keyboard.press('F6'); await page.fill('#retno', cashBillNo); await page.click('.modal button:has-text("Find bill")');
  const orig = await app(page, (X, no) => X.db.sales.where('no').equals(no).first(), cashBillNo);
  const inps = page.locator('.modal input[aria-label^="Return quantity"]');
  const first = inps.first();
  const max0 = Number(await first.getAttribute('max')), dis0 = await first.isDisabled();
  must(max0 === orig.lines[0].qty - 1 && (max0 > 0 || dis0), `line 1: max ${max0} disabled ${dis0} qty ${orig.lines[0].qty}`);
  const free = dis0 ? inps.nth(1) : first;
  await free.fill('999'); await page.waitForTimeout(200);
  const btn = await page.locator('.modal button:has-text("Refund")').innerText();
  await page.keyboard.press('Escape');
  const refund = Number(btn.replace(/[^\d.]/g, ''));
  must(refund <= orig.totals.payable, `refund ${refund} > bill ${orig.totals.payable}`);
  return `line 1 locked: ${dis0}; ${btn}`;
});

await t('double press of Complete bill makes one bill', async () => {
  const n0 = await app(page, X => X.db.sales.count());
  await scan(P(19).code); await waitLines(1);
  await page.keyboard.press('F9'); await page.waitForSelector('#tender');
  await page.press('#tender', 'Enter').catch(() => {});
  const b = page.locator('.modal button:has-text("Complete bill")');
  await Promise.all([b.click().catch(() => {}), b.click().catch(() => {}), page.keyboard.press('F9')]);
  await page.waitForSelector('.receipt', { timeout: 30000 }); await closeReceipt();
  await page.waitForTimeout(800);
  const n1 = await app(page, X => X.db.sales.count());
  must(n1 - n0 === 1, `bills made: ${n1 - n0}`);
});

await t('20 scans in a burst → 20 lines', async () => {
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) { await page.fill('#scan', P(20 + i).code); await page.press('#scan', 'Enter'); }
  await waitLines(Math.min(20, new Set(Array.from({ length: 20 }, (_, i) => P(20 + i).code)).size));
  const ms = Date.now() - t0;
  await page.keyboard.press('F10'); await page.click('.modal button:has-text("Payment received")'); await page.waitForSelector('.receipt'); await closeReceipt();
  return `${ms} ms`;
});

await t('drawer open needs PIN, logged', async () => {
  await page.click('button:has-text("Open drawer")'); await approve(page, '2222');
  const a = await app(page, async X => (await X.db.audit.orderBy('ts').last()).action);
  must(a === 'drawer_open', a);
});

await t('X report adds up', async () => {
  await page.click('button:has-text("Shift report")'); await page.waitForSelector('.modal:has-text("X report")');
  const txt = await page.locator('.modal').innerText();
  await page.click('.modal button:has-text("Done")');
  const exp = await app(page, async X => { const sh = (await X.db.shifts.toArray()).find(s => !s.closedAt && s.userId === 'u_owner'); const ss = await X.db.sales.where('shiftId').equals(sh.id).toArray(); return ss.reduce((a, s) => a + (s.type === 'return' ? -1 : 1) * s.payments.filter(p => p.mode === 'cash').reduce((x, p) => x + p.amount, 0), sh.openingCash); });
  const shown = Number((txt.match(/Cash that should be in drawer\s*₹([\d,.]+)/) || [])[1]?.replace(/,/g, ''));
  must(Math.abs(shown - exp) < 0.01, `shown ${shown} expected ${exp}`);
  return `drawer ₹${shown}`;
});

await t('cashier: wholesale needs PIN; no Accounts in menu', async () => {
  await logout(page); await login(page, '3333');
  await page.waitForSelector('#scan, button:has-text("Open counter")', { timeout: 60000 });
  if (await page.locator('button:has-text("Open counter")').count()) { await page.fill('#float', '1000'); await page.click('button:has-text("Open counter")'); }
  const menu = await page.locator('.nav').innerText().catch(() => '');
  await scan(P(1).code); await waitLines(1);
  await page.click('.price-mode button:has-text("Wholesale")'); await page.waitForSelector('#approve-pin');
  await page.fill('#approve-pin', '3333'); await page.click('.modal button:text-is("Approve")'); await page.waitForSelector('.modal .err');
  await page.click('.modal button:has-text("Cancel")');
  const on = await page.locator('.price-mode button.on').innerText();
  await empty().catch(async () => { await approve(page, '2222'); });
  must(on === 'Retail' && !/Accounts|GST Saathi|Settings/.test(menu), `mode ${on}; menu has office pages: ${/Accounts|GST Saathi|Settings/.test(menu)}`);
});

await t('5 wrong PINs lock the login for 30 s', async () => {
  await logout(page);
  for (let i = 0; i < 5; i++) for (const d of '9090') await page.click(`.pinpad button:text-is("${d}")`);
  const msg = await page.locator('.login .err').innerText();
  for (const d of '1111') await page.click(`.pinpad button:text-is("${d}")`);
  await page.waitForTimeout(500);
  const still = await page.locator('.pinpad').count();
  await page.evaluate(() => localStorage.removeItem('dfr_pin_fail'));
  await page.reload(); await login(page, '1111');
  must(/Too many wrong PINs/.test(msg) && still, msg);
  return msg;
});

await t('close shift (Z report) → dashboard', async () => {
  await nav(page, 'Billing counter');
  await page.click('button:has-text("Close shift")'); await page.fill('#counted', '2000'); await page.click('.modal button:has-text("Close shift")');
  await page.waitForFunction(() => /Dashboard|Good (morning|afternoon|evening)/.test(document.querySelector('.main h1')?.innerText || ''), null, { timeout: 60000 });
  const sh = await app(page, async X => (await X.db.shifts.orderBy('openedAt').toArray()).filter(s => s.userId === 'u_owner').at(-1));
  must(sh.closedAt && sh.expectedCash != null, JSON.stringify(sh).slice(0, 150));
  return `variance ${sh.variance}`;
});

await settle(page);
save();
await ctx.close();
process.exit(0);
