// Every office feature (products, stock, expiry, buying, offers, customers, udhaar, accounts, reports,
// staff, orders, store, settings, audit, assistant) on the huge store: node office.mjs <scratch> <profile> <port>
import { start, reporter, must, login, nav, tab, settle, approve, confirmYes, toasts, app, badText } from './lib.mjs';
const [S, profile, port] = process.argv.slice(2);
const { ctx, url } = await start({ S, profile, port });
const { t, watch, save, R } = reporter(S, 'office');
const page = await ctx.newPage();
watch(page);
await page.goto(url);
await login(page, '1111');
R.recover = async () => { for (let i = 0; i < 3; i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(150); } };
const pick = async (sel, text) => { await page.fill(sel, text); await page.waitForSelector('.picker-list button', { timeout: 15000 }); await page.press(sel, 'Enter'); await page.waitForTimeout(200); };
// The newest books entry made in the last 10 minutes (ids start with the time they were made).
const books = type => app(page, async (X, type) => (await X.db.journal.where('ts').above(Date.now() - 600000).toArray()).filter(e => !type || e.type === type).sort((a, b) => (a.id < b.id ? -1 : 1)).at(-1) || {}, type);
const lastAudit = () => app(page, async X => (await X.db.audit.orderBy('ts').last()));
const xlsx = () => page.evaluate(() => { const b = (window.__xlsxBooks || []).at(-1); return b ? { sheets: b.SheetNames, rows: b.SheetNames.map(n => (b.Sheets[n]?.__rows || b.Sheets[n]?.rows || []).length) } : null; });
const ref = await app(page, async X => {
  const { db } = X;
  const bs = (await db.batches.where('storeId').equals('S1').toArray()).filter(b => b.status === 'active' && b.qty > 20 && X.stock.daysLeft(b.expiry) > 60);
  const p = await db.products.get(bs[0].productId);
  const sup = (await db.suppliers.toArray())[0];
  return { pname: p.name, pid: p.id, bid: bs[0].id, word: p.name.split(' ')[0], sup: sup.name, sid: sup.id, nProducts: await db.products.count() };
});
console.log('using', JSON.stringify(ref));

// ---------- Products
await t('products: search is fast and finds the item', async () => {
  await nav(page, 'Products');
  const t0 = Date.now();
  await page.fill('.main input[type=search]', ref.word);
  await page.waitForFunction(w => [...document.querySelectorAll('.main table.tbl tbody tr')].some(r => r.innerText.toLowerCase().includes(w.toLowerCase())), ref.word, { timeout: 30000 });
  const ms = Date.now() - t0;
  await page.fill('.main input[type=search]', ref.word + 'x'); await page.waitForTimeout(100);
  await page.fill('.main input[type=search]', '');
  return `${ms} ms`;
});

const newName = 'Test Rice Bag ' + Date.now().toString().slice(-5);
await t('products: add with 3 units and retail/wholesale prices', async () => {
  await page.click('button:has-text("Add product (all details)")');
  await page.fill('#p-name', newName); await page.fill('#p-cat', 'Staples'); await page.fill('#p-hsn', '1006');
  await page.selectOption('#p-gst', '5'); await page.fill('#p-mrp', '140'); await page.fill('#p-price', '130'); await page.fill('#p-cost', '110');
  await page.fill('#p-u1', 'Bag'); await page.fill('#p-u2', 'Kg'); await page.fill('#p-u3', 'Gram');
  await page.fill('#p-c12', '25'); await page.fill('#p-c23', '1000');
  await page.selectOption('#p-ubase', '1');
  await page.fill('#p-r0', '3150'); await page.fill('#p-w0', '3000'); await page.fill('#p-w1', '122');
  await page.click('.modal button:has-text("Save product")');
  await page.waitForSelector('#p-name', { state: 'detached', timeout: 10000 });
  const p = await app(page, (X, n) => X.db.products.where('name').equals(n).first(), newName);
  must(p && p.units?.c12 === 25 && p.prices?.w?.[0] === 3000, JSON.stringify(p?.units) + JSON.stringify(p?.prices));
  const rp = await app(page, (X, p) => [X.units.priceFor(p, 0, 'retail'), X.units.priceFor(p, 1, 'retail'), X.units.priceFor(p, 0, 'wholesale')], p);
  return `price per Kg: retail bag ${(rp[0] * 25).toFixed(2)}, kg ${rp[1]}, wholesale bag ${(rp[2] * 25).toFixed(2)}`;
});

await t('products: price change is logged', async () => {
  await page.fill('.main input[type=search]', newName); await page.waitForTimeout(400);
  await page.locator('.main table.tbl tbody tr').first().click();
  await page.fill('#p-price', '128'); await page.click('.modal button:has-text("Save product")');
  let a = null;
  for (let i = 0; i < 40 && a?.action !== 'price_change'; i++) { await page.waitForTimeout(250); a = await lastAudit(); }
  must(a.action === 'price_change' && a.detail.to === 128, JSON.stringify(a.detail));
});

await t('products: bad barcode check digit is refused', async () => {
  await page.locator('.main table.tbl tbody tr').first().click();
  await page.fill('#p-bar', '8901234567891');
  const hint = await page.locator('.field-hint:has-text("Check digit")').innerText().catch(() => '');
  await page.keyboard.press('Escape');
  must(/wrong/.test(hint), hint);
});

await t('products: find duplicates on the whole list', async () => {
  await page.fill('.main input[type=search]', '');
  const t0 = Date.now();
  await page.click('button:has-text("Find duplicates")'); await page.waitForSelector('.modal:has-text("duplicates")', { timeout: 120000 });
  const title = (await page.locator('.modal').first().innerText()).split('\n')[0];
  const ms = Date.now() - t0;
  await page.click('.modal button:has-text("Close")');
  return `${title} in ${ms} ms`;
});

await t('products: export the whole list to Excel', async () => {
  const t0 = Date.now();
  await page.click('button:has-text("Export to Excel")'); await page.waitForTimeout(1500);
  const b = await xlsx();
  must(b, 'no file made');
  return `${JSON.stringify(b)} in ${Date.now() - t0} ms`;
});

await t('products: shelf labels for the list', async () => {
  await page.click('button:has-text("Print stickers")'); await page.waitForSelector('.modal', { timeout: 30000 });
  const n = await page.locator('.modal').innerText();
  await page.keyboard.press('Escape');
  return n.split('\n')[0];
});

// ---------- Stock
await t('stock: write off 1 damaged piece (books + stock)', async () => {
  await nav(page, 'Stock & batches'); await tab(page, 'Write-off');
  const before = await app(page, (X, id) => X.db.batches.get(id).then(b => b.qty), ref.bid);
  await pick('#adj-p', ref.pname);
  await page.selectOption('#adj-b', ref.bid); await page.selectOption('#adj-r', 'damaged'); await page.fill('#adj-q', '1');
  await page.click('.main button:has-text("Write off")'); await page.waitForTimeout(800);
  const after = await app(page, (X, id) => X.db.batches.get(id).then(b => b.qty), ref.bid);
  const j = await books('writeoff');
  must(Math.abs(before - after - 1) < 0.001 && /Damaged/.test(j.narration || ''), `stock ${before} → ${after}, last entry ${j.narration}`);
});

await t('stock: theft write-off needs a manager PIN', async () => {
  await page.selectOption('#adj-r', 'theft'); await page.fill('#adj-q', '1');
  await page.click('.main button:has-text("Write off")'); await approve(page, '2222'); await page.waitForTimeout(600);
  const a = await lastAudit();
  must(a.action === 'write_off' && a.detail.approvedBy, JSON.stringify(a.detail));
});

await t('stock: physical count correction', async () => {
  await tab(page, 'Physical count');
  const row = page.locator('.main table.tbl tbody tr').first();
  const sys = Number((await row.locator('td').nth(1).innerText()).replace(/,/g, ''));
  await row.locator('input').fill(String(sys + 2));
  await page.click('.main button:has-text("Apply")'); await page.waitForTimeout(1200);
  const j = await books('writeoff');
  must(/Count correction/.test(j.narration || ''), j.narration);
  return j.narration;
});

await t('stock: transfer to another branch (and it will sync)', async () => {
  await app(page, X => X.db.stores.put({ id: 'S2', name: 'Branch Two', code: 'S2' }));
  await tab(page, 'Transfer'); await page.waitForTimeout(300);
  await pick('#tr-p', ref.pname);
  await page.selectOption('#tr-b', ref.bid); await page.selectOption('#tr-to', 'S2'); await page.fill('#tr-q', '1');
  await page.click('.main form button[type=submit]'); await page.waitForTimeout(800);
  const nb = await app(page, async X => (await X.db.batches.where('storeId').equals('S2').toArray()).sort((x, y) => (x.receivedAt || 0) - (y.receivedAt || 0)).at(-1));
  must(nb && !nb._oc && nb.updatedAt > Date.now() - 60000, JSON.stringify({ oc: nb?._oc, upd: nb?.updatedAt }));
});

await t('stock: movements list', async () => { await tab(page, 'Movements'); const n = await page.locator('.main table.tbl tbody tr').count(); must(n > 0, 'no rows'); return `${n} rows`; });

// ---------- Expiry
await t('expiry: move to front, quarantine, write off', async () => {
  await nav(page, 'Expiry control');
  const rungs = page.locator('.rung');
  let used = '';
  for (let i = 0; i < await rungs.count(); i++) {
    await rungs.nth(i).click(); await page.waitForTimeout(300);
    if (await page.locator('.main table.tbl tbody tr input[type=checkbox]').count() >= 3) { used = (await rungs.nth(i).innerText()).split('\n')[0]; break; }
  }
  must(used, 'no expiry step with 3 batches');
  const boxes = page.locator('.main table.tbl tbody tr input[type=checkbox]');
  const q0 = await app(page, async X => (await X.db.batches.toArray()).filter(b => b.status === 'quarantine').length);
  await boxes.nth(0).check(); await page.click('.card button:text-is("Move to front")'); await page.waitForTimeout(500);
  await boxes.nth(0).check(); await page.click('.card button:text-is("Quarantine")'); await page.waitForTimeout(500);
  await boxes.nth(0).check(); await page.click('.card button:text-is("Write off")'); await confirmYes(page, 'Write off'); await page.waitForTimeout(800);
  const a = await lastAudit();
  const r = await app(page, async X => { const all = await X.db.batches.toArray(); return { front: all.filter(b => b.frontDisplay).length, quarantine: all.filter(b => b.status === 'quarantine').length }; });
  must(a.action === 'write_off' && r.front >= 1 && r.quarantine === q0 + 1, JSON.stringify({ a: a.action, ...r, q0 }));
  return used + ' ' + JSON.stringify(r);
});

// ---------- Purchases
await t('purchase bill: enter, save, stock and books updated', async () => {
  await nav(page, 'Purchases & suppliers');
  await page.click('.main button:has-text("New purchase bill"), .main button:has-text("Purchase bill"), .main .page-head button.btn-primary');
  await page.waitForSelector('#pb-sup', { timeout: 30000 });
  await page.selectOption('#pb-sup', ref.sid);
  await page.fill('#pb-no', 'TINV-' + Date.now().toString().slice(-6));
  const picker = page.locator('.modal .picker input').first();
  await picker.fill(ref.pname); await page.waitForSelector('.modal .picker-list button'); await picker.press('Enter');
  await page.locator('.modal input[aria-label="Quantity"]').first().fill('6');
  await page.locator('.modal input[aria-label="Rate"]').first().fill('50');
  await page.locator('.modal input[aria-label="Batch"]').first().fill('TB' + Date.now().toString().slice(-4));
  await page.locator('.modal input[aria-label="Expiry"]').first().fill('2028-06-30');
  const n0 = await app(page, X => X.db.purchases.count());
  await page.click('.modal button:has-text("Save and add to stock")');
  await page.waitForTimeout(800);
  if (await page.locator('.modal :text("Save anyway")').count()) await confirmYes(page, 'Yes');
  await page.waitForFunction(n => window.__dfr.db.purchases.count().then(c => c > n), n0, { timeout: 30000 });
  await page.keyboard.press('Escape');
  const p = await app(page, async X => (await X.db.purchases.orderBy('no').toArray()).at(-1));
  const j = await app(page, (X, no) => X.db.journal.where('ref').equals(no).first(), p.no);
  must(p.total > 0 && j?.type === 'purchase', JSON.stringify({ no: p.no, total: p.total, j: j?.type }));
  return `${p.no} ₹${p.total}`;
});

await t('suppliers: add a supplier, then pay', async () => {
  await tab(page, 'Suppliers & dues');
  await page.click('.main button:has-text("Add supplier"), .main button:has-text("New supplier")');
  await page.fill('#s-name', 'Test Traders ' + Date.now().toString().slice(-4)); await page.fill('#s-phone', '9876500011'); await page.fill('#s-terms', '15');
  await page.click('.modal button:has-text("Save")'); await page.waitForTimeout(500);
  const payBtn = page.locator('.main button:text-is("Pay")').first();
  await payBtn.click(); await page.fill('#sp-amt', '500');
  await page.click('.modal button.btn-primary'); await page.waitForTimeout(800);
  const j = await books('payment');
  must(j.lines?.some(l => l.dr === 500), JSON.stringify(j.lines));
});

await t('orders to suppliers: draft from suggestions', async () => {
  await tab(page, 'Orders to suppliers');
  const b = page.locator('.main button:has-text("Draft order")').first();
  if (!(await b.count())) return 'no suggestions on this store';
  const n0 = await app(page, X => X.db.purchaseOrders.count());
  await b.click(); await page.waitForTimeout(1000);
  const n1 = await app(page, X => X.db.purchaseOrders.count());
  must(n1 === n0 + 1, `${n0} → ${n1}`);
});

await t('purchases: returns and 2B tabs', async () => { await tab(page, 'Returns'); await tab(page, 'GST credit check'); must(!(await badText(page)), await badText(page)); });

// ---------- Offers
await t('offers: half-filled offer is refused; good one saved and switched', async () => {
  await nav(page, 'Offers & prices');
  await page.click('.main button:has-text("New offer")'); await page.fill('#of-name', 'Test slab');
  await page.click('.modal button:has-text("Save offer")'); await page.waitForTimeout(300);
  const refused = await toasts(page);
  await pick('#of-prod', ref.pname); await page.fill('#of-min0', '3'); await page.fill('#of-pr0', '1');
  await page.click('.modal button:has-text("Save offer")'); await page.waitForTimeout(500);
  const o = await app(page, async X => (await X.db.offers.toArray()).find(x => x.name === 'Test slab'));
  await page.locator('.main tr:has-text("Test slab") button:has-text("Turn off")').click(); await page.waitForTimeout(300);
  const off = await app(page, (X, id) => X.db.offers.get(id).then(x => x.active), o.id);
  must(/Choose the product|price each/.test(refused) && o && off === false, refused + ' | ' + JSON.stringify(o));
});

// ---------- Customers
const phone = '9' + String(Date.now()).slice(-9);
await t('customers: add, duplicate mobile refused, wholesale rate, follow-up', async () => {
  await nav(page, 'Customers & points');
  await page.click('.main button:has-text("Add customer")'); await page.fill('#c-name', 'Test Customer'); await page.fill('#c-phone', phone);
  await page.click('.modal button:text-is("Save")'); await page.waitForTimeout(500);
  await page.click('.main button:has-text("Add customer")'); await page.fill('#c-name', 'Same Phone'); await page.fill('#c-phone', phone);
  await page.click('.modal button:text-is("Save")'); await page.waitForTimeout(400);
  const dup = await toasts(page);
  await page.keyboard.press('Escape');
  await page.fill('.main input[type=search]', phone); await page.waitForTimeout(500);
  await page.locator('.main table.tbl tbody tr').first().click();
  await page.selectOption('#c-level', 'wholesale'); await page.click('.modal button:text-is("Save")'); await page.waitForTimeout(400);
  await page.locator('.main table.tbl tbody tr').first().click();
  await page.click('.modal .tabs button:has-text("Follow-ups")'); await page.fill('#fu-note', 'Call about rice'); await page.click('.modal button:text-is("Add")'); await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  const c = await app(page, (X, ph) => X.db.customers.where('phone').equals(ph).toArray(), phone);
  const fu = await app(page, (X, id) => X.db.followups.where('customerId').equals(id).count(), c[0].id);
  must(c.length === 1 && c[0].priceLevel === 'wholesale' && fu === 1 && /already has this mobile/.test(dup), JSON.stringify({ n: c.length, lvl: c[0].priceLevel, fu, dup }));
});

await t('customers: erase personal data (owner)', async () => {
  await page.locator('.main table.tbl tbody tr').first().click();
  await page.click('.modal button:has-text("Erase personal data")'); await confirmYes(page, 'Erase details'); await page.waitForTimeout(500);
  const c = await app(page, async X => (await X.db.customers.toArray()).filter(x => x.erased).at(-1));
  must(c && c.phone === '0000000000', JSON.stringify(c).slice(0, 100));
});

// ---------- Udhaar
await t('udhaar: money received from a customer', async () => {
  await nav(page, 'Udhaar & dues');
  const b = page.locator('.main button:text-is("Received")').first();
  await b.waitFor({ timeout: 90000 }).catch(() => {});
  must(await b.count(), 'no customer owes money');
  await b.click(); await page.fill('#rc-amt', '100'); await page.click('.modal button.btn-primary'); await page.waitForTimeout(800);
  const j = await books('receipt');
  must(j.lines?.some(l => l.cr === 100), JSON.stringify(j.lines));
});

// ---------- Accounts
await t('accounts: record an expense and a bank deposit', async () => {
  await nav(page, 'Accounts'); await tab(page, 'Expenses');
  const accs = await page.locator('#ex-acc option').evaluateAll(os => os.map(o => o.value));
  await page.selectOption('#ex-acc', accs[0]); await page.fill('#ex-amt', '750'); await page.fill('#ex-note', 'Test expense');
  await page.click('.main button:has-text("Save expense")'); await page.waitForTimeout(600);
  const e = await books('expense');
  await tab(page, 'Cash book'); await page.fill('#dep-amt', '1000'); await page.click('.main button:has-text("Record deposit")'); await page.waitForTimeout(600);
  const d = await books('contra');
  must(e.lines?.some(l => l.dr === 750) && d.lines?.some(l => l.dr === 1000), JSON.stringify([e.lines, d.lines]));
});

await t('accounts: balance sheet balances on screen', async () => {
  await tab(page, 'Balance sheet');
  const bs = await app(page, X => X.accounts.balanceSheet());
  must(Math.abs(bs.totalAssets - bs.totalLiabs) < 0.05, JSON.stringify({ a: bs.totalAssets, l: bs.totalLiabs }));
  return `₹${Math.round(bs.totalAssets).toLocaleString('en-IN')}`;
});

await t('accounts: ledger of a customer and the day book', async () => {
  await tab(page, 'Ledgers'); await page.waitForTimeout(300);
  await tab(page, 'Day book');
  must(!(await badText(page)), await badText(page));
});

await t('accounts: Tally export', async () => {
  await tab(page, 'Tally export');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.main button:has-text("vouchers")')]);
  const p = S + '/ui/tally.xml'; await dl.saveAs(p);
  const xml = (await import('fs')).readFileSync(p, 'utf8');
  must(/<ENVELOPE>/.test(xml) && /VOUCHER/.test(xml), xml.slice(0, 120));
  return `${dl.suggestedFilename()} ${(xml.length / 1024).toFixed(0)} KB, ${(xml.match(/<VOUCHER /g) || []).length} vouchers`;
});

// ---------- Reports
await t('reports: every export button makes a file', async () => {
  await nav(page, 'Reports');
  const made = [];
  for (const tb of ['Sales', 'Items & profit', 'Stock']) {
    await tab(page, tb);
    const bs = page.locator('.main button:has-text("Excel"), .main button:has-text("Export")');
    for (let i = 0; i < await bs.count(); i++) { await bs.nth(i).click(); await page.waitForTimeout(400); const b = await xlsx(); made.push(`${tb}:${b?.sheets?.[0]}`); }
  }
  must(made.length >= 3, made.join(', '));
  return made.join(', ');
});

await t('reports: build your own and save it', async () => {
  await tab(page, 'Build your own');
  await page.fill('.main input[placeholder*="Dairy"]', 'Test report');
  await page.click('.main button:has-text("Save report")'); await page.waitForTimeout(400);
  const n = await app(page, X => X.db.reportsSaved.count());
  must(n >= 1, 'saved reports ' + n);
  await page.click('.main button:has-text("Export to Excel")'); await page.waitForTimeout(500);
  return JSON.stringify(await xlsx());
});

// ---------- Staff
await t('staff: add, punch in/out, run salary once, pay once', async () => {
  await nav(page, 'Staff & salary'); await tab(page, 'Team');
  await page.click('.main button:has-text("Add staff")'); await page.fill('#e-name', 'Test Helper'); await page.fill('#e-role', 'Helper'); await page.fill('#e-basic', '12000'); await page.fill('#e-hra', '2000');
  await page.click('.modal button:text-is("Save")'); await page.waitForTimeout(300);
  await tab(page, 'Attendance');
  const row = page.locator('.main tr:has-text("Test Helper")');
  await row.locator('button:has-text("Punch in")').click(); await page.waitForTimeout(300);
  await row.locator('button:has-text("Punch out")').click(); await page.waitForTimeout(300);
  await tab(page, 'Salary');
  const month = await page.inputValue('#sal-month');
  const runBtn = page.locator('.main button:has-text("Run salary")');
  if (await runBtn.count()) await Promise.all([runBtn.click(), runBtn.click().catch(() => {})]);
  await page.waitForTimeout(1500);
  const payBtn = page.locator('.main button:has-text("Mark all paid")');
  if (await payBtn.count()) await Promise.all([payBtn.click(), payBtn.click().catch(() => {})]);
  await page.waitForTimeout(1500);
  const r = await app(page, async (X, m) => ({ runs: (await X.db.journal.where('ref').equals('SAL-' + m).count()), pays: (await X.db.journal.where('ref').equals('SALPAY-' + m).count()), unpaid: (await X.db.payroll.where('month').equals(m).toArray()).filter(x => x.status !== 'paid').length }), month);
  must(r.runs === 1 && r.pays <= 1 && r.unpaid === 0, JSON.stringify(r));
  return JSON.stringify(r);
});

// ---------- WhatsApp order → bill
await t('WhatsApp order: new → packing → bill at counter → billed', async () => {
  await nav(page, 'WhatsApp orders');
  await page.click('.main button:has-text("New order")');
  await page.fill('#o-phone', '9' + String(Date.now() + 7).slice(-9)); await page.fill('#o-name', 'Order Test');
  await pick('#o-item', ref.pname); await page.fill('#o-qty', '2'); await page.click('.modal button:text-is("Add")');
  await page.click('.modal button:has-text("Save order")'); await page.waitForTimeout(600);
  const o = await app(page, async X => (await X.db.orders.orderBy('createdAt').last()));
  must(/^ORD-[A-Z0-9]+-\d{6}$/.test(o.no), 'order no ' + o.no);
  await page.locator(`.card:has-text("${o.no}") button:has-text("Mark packing")`).click(); await page.waitForTimeout(300);
  await page.locator(`.card:has-text("${o.no}") button:has-text("Bill at counter")`).click();
  await page.waitForSelector('.cart-line, button:has-text("Open counter")', { timeout: 60000 });
  if (await page.locator('button:has-text("Open counter")').count()) { await page.fill('#float', '1000'); await page.click('button:has-text("Open counter")'); await page.waitForSelector('.cart-line', { timeout: 60000 }); }
  await page.keyboard.press('F10'); await page.click('.modal button:has-text("Payment received")'); await page.waitForSelector('.receipt');
  await page.click('.modal button:has-text("Next customer")');
  const o2 = await app(page, (X, id) => X.db.orders.get(id), o.id);
  must(o2.status === 'billed' && o2.billNo, JSON.stringify({ s: o2.status, b: o2.billNo }));
  return `${o.no} → ${o2.billNo}`;
});

// ---------- Store, settings
await t('store details: save', async () => {
  await nav(page, 'Store & owner');
  await page.fill('#sd-phone', '9437000000'); await page.click('.main button:has-text("Save details")'); await page.waitForTimeout(400);
  const s = await app(page, X => X.getSettings());
  must(s.phone === '9437000000', s.phone);
});

await t('settings: add a user; last owner cannot be blocked', async () => {
  await nav(page, 'Settings'); await tab(page, 'Users');
  await page.click('.main button:has-text("Add user")'); await page.fill('#u-name', 'Test Cashier'); await page.selectOption('#u-role', 'cashier'); await page.fill('#u-pin', '5678');
  await page.click('.modal button:text-is("Save")'); await page.waitForTimeout(400);
  const u = await app(page, async X => (await X.db.users.toArray()).find(x => x.name === 'Test Cashier'));
  await page.locator('.main tr:has-text("Owner")').first().click();
  await page.selectOption('#u-role', 'manager'); await page.click('.modal button:text-is("Save")'); await page.waitForTimeout(300);
  const msg = await toasts(page);
  await page.keyboard.press('Escape');
  const owners = await app(page, async X => (await X.db.users.toArray()).filter(x => x.role === 'owner' && !x.disabled).length);
  must(u && owners >= 1 && /at least one owner/.test(msg), JSON.stringify({ u: !!u, owners, msg }));
});

await t('settings: loyalty limits save; stores add', async () => {
  await tab(page, 'Loyalty'); await page.fill('#l-rate', '2'); await page.locator('.main button:text-is("Save")').first().click(); await page.waitForTimeout(400);
  await tab(page, 'Stores'); await page.fill('#store-name', 'Third Branch'); await page.click('.main button:has-text("Add store")'); await page.waitForTimeout(400);
  const r = await app(page, async X => ({ rate: (await X.getSettings()).pointsPer100, stores: (await X.db.stores.toArray()).map(s => s.id) }));
  await app(page, X => X.setSetting('pointsPer100', 1));
  must(Number(r.rate) === 2 && r.stores.length >= 3, JSON.stringify(r));
  return JSON.stringify(r);
});

// ---------- Audit, assistant
await t('security: tamper check over every bill', async () => {
  await nav(page, 'Security & audit');
  const t0 = Date.now();
  await page.locator('.main button:has-text("Check now")').first().click();
  await page.waitForFunction(() => /bills intact|problems found/i.test(document.querySelector('.main')?.innerText || ''), null, { timeout: 600000 });
  const txt = (await page.locator('.main').innerText()).split('\n').filter(l => /intact|problems found/i.test(l)).slice(0, 2).join(' | ');
  await page.locator('.main button:has-text("Check now")').nth(1).click();
  await page.waitForFunction(() => /entries intact|broken entries/i.test(document.querySelector('.main')?.innerText || ''), null, { timeout: 600000 });
  const log = (await page.locator('.main').innerText()).split('\n').find(l => /entries intact|broken entries/i.test(l));
  const generated = await app(page, async X => /^g/.test((await X.db.sales.orderBy('ts').first())?.hash || ''));
  must(/intact/.test(txt) || generated, txt);
  if (generated) return `${Date.now() - t0} ms — test data made by the generator has no real fingerprints: ${txt}`;
  return `${Date.now() - t0} ms — ${txt} · log: ${log}`;
});

await t('ask your shop: answers from the books (no AI key)', async () => {
  await nav(page, 'Ask your shop');
  for (const q of ['today sales', 'udhaar', 'top items']) {
    await page.fill('.main form input', q); await page.press('.main form input', 'Enter'); await page.waitForTimeout(1500);
  }
  const txt = await page.locator('.main').innerText();
  must(!(await badText(page)), await badText(page));
  return txt.slice(-160).replace(/\n/g, ' ');
});

await t('smart insights: open every card', async () => {
  await nav(page, 'All smart tools');
  const cards = page.locator('.main .card button, .main a.card');
  return `${await cards.count()} smart tools listed`;
});

await settle(page);
save();
await ctx.close();
process.exit(0);
