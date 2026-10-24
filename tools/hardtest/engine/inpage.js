// Injected into the app (stress build). Drives the REAL app code (window.__dfr) with thousands of mixed jobs,
// then checks that everything still adds up. Three steps: __engineSnap (before), __engineRun (any number of
// tabs at once), __engineCheck (after, with what every tab made).
(() => {
  const D = () => window.__dfr;
  const r2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;
  const r3 = v => Math.round((Number(v) || 0) * 1000) / 1000;
  const P = v => Math.round((Number(v) || 0) * 100);
  const CH = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function gstin(state, rnd) {
    const L = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let s = state + Array.from({ length: 5 }, () => L[Math.floor(rnd() * 26)]).join('') + String(1000 + Math.floor(rnd() * 8999)) + L[Math.floor(rnd() * 26)] + '1Z';
    let sum = 0;
    for (let i = 0; i < 14; i++) { const p = CH.indexOf(s[i]) * (i % 2 ? 2 : 1); sum += Math.floor(p / 36) + (p % 36); }
    return s + CH[(36 - (sum % 36)) % 36];
  }
  const rng = seed => { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

  window.__engineSnap = async () => {
    const { db } = D();
    const settings = await D().getSettings();
    const storeId = settings.currentStore || 'S1';
    const fy = D().util.fyOf(new Date());
    const prefix = `${settings.storeCode}${settings.terminal}/${fy.short}/`;
    const last = await db.sales.where('no').startsWith(prefix).last();
    const head = await D().sales.chainHead(storeId, prefix.split('/')[0]);
    const snap = {
      t0: Date.now(), storeId, prefix, lastNo: last ? Number(last.no.slice(prefix.length)) : 0, head,
      batchQty: new Map((await db.batches.toArray()).map(b => [b.id, b.qty])),
      maxMove: (await db.stockMoves.orderBy(':id').last())?.id || 0,
      journalKeys: new Set(await db.journal.toCollection().primaryKeys()),
      custDue: await D().parties.partyBalances('cust'),
      suppBal: await D().parties.partyBalances('supp'),
      points: new Map((await db.customers.toArray()).map(c => [c.id, c.ptsRaw ?? c.points ?? 0])),
      sales: await db.sales.count(),
    };
    window.__snap = snap;
    return { storeId, prefix, lastNo: snap.lastNo, batches: snap.batchQty.size, journal: snap.journalKeys.size, sales: snap.sales, customers: snap.points.size };
  };

  window.__engineRun = async ({ seed = 1, ops = 500, workers = 4, mix = null } = {}) => {
    const X = D(), { db } = X;
    const rnd = rng(seed);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const settings = await X.getSettings();
    const storeId = settings.currentStore || 'S1';
    const cfg = settings.expiry || X.stock.DEFAULT_EXPIRY;
    const users = await db.users.toArray();
    const user = users.find(u => u.role === 'owner') || users[0];
    let shift = (await db.shifts.where('userId').equals(user.id).toArray()).find(x => !x.closedAt && x.storeId === storeId);
    if (!shift) { shift = { id: X.util.uid('sh_'), userId: user.id, userName: user.name, storeId, counter: settings.terminal, openedAt: Date.now(), openingCash: 2000, closedAt: null }; await db.shifts.add(shift); }
    if (!(await db.stores.get('S2'))) await db.stores.put({ id: 'S2', name: 'Test Branch 2', code: 'S2' });
    const all = await db.products.toArray();
    const pmap = Object.fromEntries(all.map(p => [p.id, p]));
    const batches = (await db.batches.where('storeId').equals(storeId).toArray()).filter(b => b.status === 'active' && b.qty > 0);
    const good = [...new Set(batches.filter(b => X.stock.daysLeft(b.expiry) > 31).map(b => b.productId))].filter(id => pmap[id] && pmap[id].active !== false);
    const pool = [];
    for (let i = 0; i < Math.min(3000, good.length); i++) pool.push(pmap[pick(good)]);
    const withUnits = all.filter(p => p.units).slice(0, 300), loose = all.filter(p => p.loose).slice(0, 100);
    const noStock = all.filter(p => !good.includes(p.id)).slice(0, 30);
    const custs = await db.customers.toArray();
    const cpool = []; for (let i = 0; i < Math.min(1500, custs.length); i++) cpool.push(pick(custs));
    cpool.push(...custs.filter(c => c.priceLevel === 'wholesale').slice(0, 50));
    const suppliers = await db.suppliers.toArray();
    // One offer of every kind, so the offer engine is part of the run.
    if (!(await db.offers.where('type').equals('billBuster').count())) {
      const a = pick(pool), b = pick(pool), c = pick(pool);
      await db.offers.bulkPut([
        { id: 'of_t1', type: 'qtySlab', name: 'Test slab', productId: a.id, slabs: [{ minQty: 3, price: r2(a.price * 0.95) }], active: true },
        { id: 'of_t2', type: 'bxgy', name: 'Test 2+1', productId: b.id, buy: 2, get: 1, pct: 100, active: true },
        { id: 'of_t3', type: 'category', name: 'Test category', category: c.category, pct: 5, active: true },
        { id: 'of_t4', type: 'combo', name: 'Test combo', productIds: [a.id, c.id], off: 10, active: true },
        { id: 'of_t5', type: 'billBuster', name: 'Test 2000+', minAmount: 2000, off: 50, active: true },
      ]);
    }
    const offers = await db.offers.toArray();
    const made = { sales: [], returns: [], purchases: [], dns: [], receipts: [], suppPays: [], transfers: [], writeoffs: 0, expenses: [], errors: [], skipped: {} };
    const times = {};
    const time = async (k, fn) => { const t = performance.now(); const r = await fn(); (times[k] ||= []).push(performance.now() - t); return r; };
    const dues = new Map();   // customer → udhaar given in this run (for receipts)

    async function sale() {
      const n = 1 + Math.floor(rnd() * rnd() * 30);
      const cust = cpool.length && rnd() < 0.55 ? await db.customers.get(pick(cpool).id) : null;
      let priceMode = cust?.priceLevel === 'wholesale' || rnd() < 0.06 ? 'wholesale' : 'retail';
      const cart = [];
      for (let i = 0; i < n; i++) {
        const r = rnd();
        const p = r < 0.08 && withUnits.length ? pick(withUnits) : r < 0.12 && loose.length ? pick(loose) : r < 0.125 && noStock.length ? pick(noStock) : pick(pool);
        const L = X.units.unitList(p);
        let unit, qty;
        if (L.length) { const u = pick(L); unit = u.i; qty = r3((u.factor <= 0.01 ? 50 * (1 + Math.floor(rnd() * 20)) : 1 + Math.floor(rnd() * 3)) * u.factor); }
        else qty = p.loose || p.uom === 'KG' ? r3(0.1 + rnd() * 2.9) : 1 + Math.floor(rnd() * rnd() * 6);
        const c = { key: X.util.uid('l'), productId: p.id, qty, ...(unit != null ? { unit } : {}) };
        if (rnd() < 0.03 && p.mrp > 1) c.price = r2(Math.min(p.mrp, p.price) * (0.85 + rnd() * 0.15));   // manager price change
        const same = cart.find(x => x.productId === p.id && !p.loose && x.unit === c.unit && x.price == null && c.price == null);
        if (same) same.qty = r3(same.qty + qty); else cart.push(c);
      }
      const allocs = await X.cart.allocateCart(cart, storeId, cfg, new Map());
      const usable = cart.filter(c => allocs[c.key].alloc.length);           // expired-only lines are refused by the counter
      if (!usable.length) { made.skipped.emptyCart = (made.skipped.emptyCart || 0) + 1; return; }
      const b2b = rnd() < 0.04 ? gstin(rnd() < 0.7 ? String(settings.stateCode || '21').padStart(2, '0') : '27', rnd) : '';
      const pts = cust && rnd() < 0.3 ? 1e9 : 0;
      const v = X.cart.buildView({ cart: usable, allocs, offers, pmap, customer: cust, points: pts, b2b, settings, priceMode });
      if (v.blocked.length) { made.skipped.blocked = (made.skipped.blocked || 0) + 1; return; }
      const usePts = v.usePts >= (settings.pointsMinRedeem || 50) ? v.usePts : 0;
      const view = usePts === v.usePts ? v : X.cart.buildView({ cart: usable, allocs, offers, pmap, customer: cust, points: 0, b2b, settings, priceMode });
      const pay = view.bill.totals.payable;
      let payments;
      const r = rnd();
      const due = cust ? (dues.get(cust.id) || 0) + Math.max(0, window.__snap?.custDue?.[cust.id] || 0) : 0;
      if (r < 0.1 && cust && pay <= (cust.creditLimit || 0) - due) payments = [{ mode: 'credit', amount: pay, ref: '', change: 0 }];
      else if (r < 0.18 && cust && pay > 20 && pay * 0.5 <= (cust.creditLimit || 0) - due) { const c = Math.floor(pay * 0.5); payments = [{ mode: 'cash', amount: c, ref: '', change: 0 }, { mode: 'credit', amount: r2(pay - c), ref: '', change: 0 }]; }
      else if (r < 0.45) payments = [{ mode: 'upi', amount: pay, ref: 'UTR' + Math.floor(rnd() * 1e9), change: 0 }];
      else if (r < 0.55) payments = [{ mode: 'card', amount: pay, ref: 'AP' + Math.floor(rnd() * 1e6), change: 0 }];
      else if (r < 0.65 && pay > 10) { const c = Math.floor(pay * rnd()); payments = [{ mode: 'cash', amount: c, ref: '', change: 0 }, { mode: 'upi', amount: r2(pay - c), ref: '', change: 0 }]; }
      else { const t = Math.ceil(pay / 100) * 100; payments = [{ mode: 'cash', amount: pay, ref: '', change: r2(t - pay) }]; }
      const fresh = cust ? await db.customers.get(cust.id) : null;
      const s = await time('save bill', () => X.sales.saveSale({ bill: view.bill, payments, customer: fresh, user, shiftId: shift.id, storeId,
        pointsUsed: view.usePts, b2b: b2b ? { gstin: b2b, inter: view.inter } : null, priceMode, composition: !!settings.gstFiling?.composition }));
      made.sales.push(s.id);
      const cr = payments.filter(p => p.mode === 'credit').reduce((a, p) => a + p.amount, 0);
      if (cr) dues.set(cust.id, r2((dues.get(cust.id) || 0) + cr));
    }

    async function ret() {
      if (!made.sales.length) return sale();
      const s = await db.sales.get(pick(made.sales));
      const done = await X.returns.returnedSoFar(s);
      const left = X.returns.returnLeft(s, done);
      if (left.every(v => v <= 1e-9)) { made.skipped.allReturned = (made.skipped.allReturned || 0) + 1; return; }
      const full = rnd() < 0.3;
      const want = left.map(v => (full ? v : rnd() < 0.5 ? r3(v * (s.lines.length > 1 ? 1 : rnd())) : 0));
      if (want.every(v => !(v > 0))) want[left.findIndex(v => v > 0)] = left.find(v => v > 0);
      const bill = X.returns.buildReturn(s, want, done);
      if (!bill.lines.length) return;
      const mode = s.customerId && rnd() < 0.3 ? 'credit' : pick(['cash', 'cash', 'upi', 'card']);
      let r;
      try { r = await time('save return', () => X.returns.saveReturn({ sale: s, bill, mode, user, shiftId: shift.id, storeId })); }
      catch (e) { if (/returned a moment ago/.test(e.message)) { made.skipped.returnRace = (made.skipped.returnRace || 0) + 1; return; } throw e; }
      made.returns.push(r.id);
      if (mode === 'credit') dues.set(s.customerId, r2((dues.get(s.customerId) || 0) - bill.totals.payable));
    }

    async function purchase() {
      const sup = pick(suppliers);
      const n = 1 + Math.floor(rnd() * 12);
      const lines = [];
      for (let i = 0; i < n; i++) {
        const p = rnd() < 0.1 && withUnits.length ? pick(withUnits) : pick(pool);
        const pack = p.casePack || 1;
        const gst = p.gst ?? 5;
        lines.push({ productId: p.id, name: p.name, hsn: p.hsn, qty: 1 + Math.floor(rnd() * 8), free: rnd() < 0.1 ? 1 : 0, pack, rate: r2((p.cost || p.price * 0.8) * pack * (0.95 + rnd() * 0.1)), disc: rnd() < 0.3 ? Math.floor(rnd() * 5) : 0, gst,
          mrp: rnd() < 0.05 ? r2((p.mrp || p.price) + 2) : p.mrp, batchNo: 'TB' + Math.floor(rnd() * 1e6), expiry: X.util.localISO(X.util.addDays(new Date(), 60 + Math.floor(rnd() * 600))) });
      }
      const pur = await time('save purchase', () => X.purchasing.savePurchase({ supplier: sup, billNo: 'INV' + Math.floor(rnd() * 1e7), date: X.util.todayISO(), lines, storeId, user }));
      made.purchases.push(pur.id);
      for (const l of pur.lines) { const p = pmap[l.productId]; if (p) pool.push(p); }
    }

    async function receipt() {
      const open = [...dues.entries()].filter(([, v]) => v > 1);
      if (!open.length) return mix === 'phone' ? undefined : sale();
      const [cid, d] = pick(open);
      const c = await db.customers.get(cid);
      const amt = Math.max(1, Math.floor(d * (rnd() < 0.5 ? 1 : rnd())));
      await time('udhaar received', async () => { await X.accounts.postReceipt({ customer: c, amount: amt, mode: pick(['cash', 'upi']), ref: 'R' + Math.floor(rnd() * 1e6), ts: Date.now() }); await X.sales.audit('receipt', { customer: c.name, amount: amt }, user); });
      dues.set(cid, r2(d - amt));
      made.receipts.push({ cid, amount: amt });
    }

    async function suppPay() {
      const mine = made.purchases.length ? await db.purchases.get(pick(made.purchases)) : null;
      if (!mine) return purchase();
      const sup = suppliers.find(s => s.id === mine.supplierId);
      const amt = Math.max(1, Math.floor((mine.total - (mine.paid || 0)) * (rnd() < 0.5 ? 1 : rnd())));
      await time('pay supplier', () => X.purchasing.paySupplier({ supplier: sup, amount: amt, mode: pick(['bank', 'cash', 'upi']), ref: 'P' + Math.floor(rnd() * 1e6), user, purchaseIds: [mine.id] }));
      made.suppPays.push({ sid: sup.id, amount: amt });
    }

    async function debitNote() {
      const sup = pick(suppliers);
      const bs = (await db.batches.where('productId').equals(pick(pool).id).toArray()).filter(b => b.storeId === storeId && b.status === 'active' && b.qty >= 2 && b.cost > 0);
      if (!bs.length) return;
      const dn = await time('debit note', () => X.purchasing.createDebitNote({ supplier: sup, items: [{ batch: bs[0], qty: 1 }], reason: 'Damaged in transit', user }));
      made.dns.push(dn.id);
    }

    async function writeOff() {
      const p = pick(pool);
      const bs = (await db.batches.where('productId').equals(p.id).toArray()).filter(b => b.storeId === storeId && b.status === 'active' && b.qty >= 2);
      if (!bs.length) return;
      const count = rnd() < 0.3;
      await time('write-off', () => X.stockOps.writeOff({ batch: bs[0], product: p, qty: count ? -1 : 1, reason: count ? 'count' : pick(['damaged', 'expired', 'theft', 'sample']), user }));
      made.writeoffs++;
    }

    async function transfer() {
      const p = pick(pool);
      const bs = (await db.batches.where('productId').equals(p.id).toArray()).filter(b => b.storeId === storeId && b.status === 'active' && b.qty >= 2);
      if (!bs.length) return;
      const r = await time('transfer', () => X.stockOps.transferStock({ batch: bs[0], qty: 1, to: 'S2', user, productName: p.name }));
      made.transfers.push(r.batchId);
    }

    async function expense() {
      const amt = 100 + Math.floor(rnd() * 5000);
      await time('expense', () => X.accounts.postExpense({ acc: pick(['rent', 'power', 'misc', 'bank_charges']), amount: amt, mode: 'cash', narration: 'Test expense', ts: Date.now() }));
      made.expenses.push(amt);
    }

    // The phone app has no billing: office work only. Udhaar received comes from what customers already owe.
    if (mix === 'phone') {
      const owe = await X.parties.partyBalances('cust');
      for (const [id, v] of Object.entries(owe)) if (v > 5) dues.set(id, v);
    }
    const MIX = mix === 'phone' ? [[purchase, 30], [receipt, 25], [suppPay, 15], [writeOff, 10], [expense, 10], [debitNote, 5], [transfer, 5]]
      : mix || [[sale, 70], [ret, 8], [purchase, 6], [receipt, 5], [suppPay, 3], [debitNote, 2], [writeOff, 2], [transfer, 2], [expense, 2]];
    const tot = MIX.reduce((a, m) => a + m[1], 0);
    const choose = () => { let x = rnd() * tot; for (const [f, w] of MIX) { if ((x -= w) < 0) return f; } return MIX[0][0]; };
    let left = ops;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: workers }, async () => {
      while (left-- > 0) {
        const f = choose();
        try { await f(); } catch (e) { made.errors.push(f.name + ': ' + (e && e.message || e) + ' ' + String(e?.stack || '').split('\n').slice(1, 3).join(' ')); }
      }
    }));
    const stat = a => { const s = [...a].sort((x, y) => x - y); return { n: s.length, p50: Math.round(s[Math.floor(s.length * 0.5)] || 0), p95: Math.round(s[Math.floor(s.length * 0.95)] || 0), max: Math.round(s.at(-1) || 0) }; };
    made.ms = Math.round(performance.now() - t0);
    made.timings = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, stat(v)]));
    return made;
  };

  window.__engineCheck = async (made) => {
    const X = D(), { db } = X, S = window.__snap;
    const settings = await X.getSettings();
    const storeId = S.storeId;
    const fails = [], info = {};
    const bad = (k, detail) => { fails.push(k + (detail ? ': ' + (typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 400)) : '')); };
    const ids = [...made.sales, ...made.returns];
    const bills = (await db.sales.bulkGet(ids)).filter(Boolean);
    if (bills.length !== ids.length) bad('bills missing', { made: ids.length, found: bills.length });
    info.bills = made.sales.length; info.returns = made.returns.length;

    // 1. Bill maths, to the paisa.
    let mathBad = 0;
    for (const s of bills) {
      const t = s.totals, L = s.lines;
      const e = [];
      if (!L.length) e.push('no lines');
      const exact = L.reduce((a, l) => a + P(l.total), 0);
      if (exact !== P(t.exact)) e.push('lines≠exact');
      if (s.type === 'sale' && P(t.payable) !== Math.round(exact / 100) * 100) e.push('payable not rounded exact');
      if (P(t.payable) - P(t.exact) !== P(t.roundOff)) e.push('roundOff');
      for (const l of L) {
        if (P(l.taxable) + P(l.cgst) + P(l.sgst) + P(l.igst) !== P(l.total)) e.push('line tax split ' + l.name);
        if (Math.abs(P(l.cgst) - P(l.sgst)) > 1) e.push('cgst≠sgst ' + l.name);
        if (l.igst && (l.cgst || l.sgst)) e.push('igst+cgst ' + l.name);
        if ([l.qty, l.total, l.taxable, l.gross].some(v => !Number.isFinite(v))) e.push('NaN ' + l.name);
        if (l.taxable < -0.001 || l.total < -0.001) e.push('negative ' + l.name);
        const bq = r3((l.batches || []).reduce((a, b) => a + b.qty, 0));
        if (Math.abs(bq - l.qty) > 0.001) e.push(`batches ${bq}≠qty ${l.qty} ${l.name}`);
        if (s.type === 'sale' && l.unitPrice > (l.mrp || Infinity) + 0.001 && !l.unitName) e.push('above MRP ' + l.name);
      }
      const paid = r2(s.payments.reduce((a, p) => a + p.amount, 0));
      if (Math.abs(paid - t.payable) > 0.001) e.push(`paid ${paid}≠payable ${t.payable}`);
      if (s.payments.some(p => p.mode === 'credit') && !s.customerId) e.push('credit without customer');
      if (!/^[A-Za-z0-9/-]{1,16}$/.test(s.no)) e.push('bad invoice no ' + s.no);
      if (s.b2b && !X.util.validGSTIN(s.b2b.gstin)) e.push('bad gstin');
      if (e.length) { mathBad++; if (mathBad <= 5) bad('bill maths ' + s.no, e.join(', ')); }
    }
    info.billMathBad = mathBad;

    // 2. Invoice numbers: unique, no gaps, follow on from the last one; chain unbroken.
    const mine = bills.filter(s => s.no.startsWith(S.prefix)).sort((a, b) => a.chainSeq - b.chainSeq);
    const nos = mine.map(s => Number(s.no.slice(S.prefix.length)));
    const uniq = new Set(bills.map(s => s.no));
    if (uniq.size !== bills.length) bad('duplicate bill numbers', bills.length - uniq.size);
    const sorted = [...nos].sort((a, b) => a - b);
    if (sorted.length && (sorted[0] !== S.lastNo + 1 || sorted.at(-1) !== S.lastNo + sorted.length)) bad('bill numbers have gaps', { first: sorted[0], last: sorted.at(-1), n: sorted.length, before: S.lastNo });
    let prev = S.head.hash, seq = S.head.chainSeq, chainBad = 0;
    for (const s of mine) {
      if (s.prevHash !== prev) chainBad++;
      if (s.chainSeq !== seq + 1) chainBad++;
      if (await X.util.sha256(X.sales.chainInput(s)) !== s.hash) chainBad++;
      prev = s.hash; seq = s.chainSeq;
    }
    if (chainBad) bad('tamper-proof chain broken', chainBad);
    const nowMax = await db.sales.where('no').startsWith(S.prefix).last();
    if (nowMax && Number(nowMax.no.slice(S.prefix.length)) !== S.lastNo + mine.length) bad('other bills appeared in this counter series', nowMax.no);

    // 3. Stock: every batch changed by exactly its new stock moves.
    const moves = await db.stockMoves.where(':id').above(S.maxMove).toArray();
    const byBatch = new Map();
    for (const m of moves) if (m.batchId) byBatch.set(m.batchId, r3((byBatch.get(m.batchId) || 0) + m.qty));
    let stockBad = 0;
    for (const [bid, d] of byBatch) {
      const b = await db.batches.get(bid);
      const was = S.batchQty.get(bid) || 0;
      if (!b || Math.abs(r3(b.qty - was) - d) > 0.002) { stockBad++; if (stockBad <= 5) bad('stock off', { batch: bid, was, now: b?.qty, moves: d }); }
    }
    info.stockMoves = moves.length; info.batchesTouched = byBatch.size; info.stockBad = stockBad;
    // every bill line's batches became moves
    const moveSum = new Map();
    for (const m of moves) if (m.type === 'sale' || m.type === 'return') moveSum.set(m.ref, r3((moveSum.get(m.ref) || 0) + Math.abs(m.qty)));
    let mvBad = 0;
    for (const s of bills) { const q = r3(s.lines.reduce((a, l) => a + (l.batches || []).reduce((x, b) => x + b.qty, 0), 0)); if (Math.abs((moveSum.get(s.no) || 0) - q) > 0.002) mvBad++; }
    if (mvBad) bad('bills whose stock moves do not match', mvBad);
    // transfers: the new batch must be sent by the sync (no "came from cloud" marks)
    for (const id of made.transfers) { const b = await db.batches.get(id); if (!b || b._oc || b._seq || !(b.updatedAt >= S.t0)) { bad('transferred batch would not sync', { id, oc: b?._oc, upd: b?.updatedAt }); break; } }

    // 4. Books: every new entry balanced; whole books balance; balance sheet balances.
    const allKeys = await db.journal.toCollection().primaryKeys();
    const newKeys = allKeys.filter(k => !S.journalKeys.has(k));
    const entries = (await db.journal.bulkGet(newKeys)).filter(Boolean);
    let jBad = 0;
    for (const e of entries) {
      const dr = e.lines.reduce((a, l) => a + P(l.dr || 0), 0), cr = e.lines.reduce((a, l) => a + P(l.cr || 0), 0);
      const odd = e.lines.some(l => !l.acc || typeof l.acc !== 'string' || ![l.dr || 0, l.cr || 0].every(Number.isFinite));
      if (dr !== cr || odd) { jBad++; if (jBad <= 5) bad('entry not balanced', { ref: e.ref, type: e.type, dr: dr / 100, cr: cr / 100, odd }); }
    }
    info.newEntries = entries.length; info.entryBad = jBad;
    const refs = new Map(); entries.forEach(e => refs.set(e.ref, (refs.get(e.ref) || 0) + 1));
    const noEntry = bills.filter(s => refs.get(s.no) !== 1).length;
    if (noEntry) bad('bills without exactly one books entry', noEntry);
    const bal = await X.accounts.balances();
    const tb = r2(Object.values(bal).reduce((a, v) => a + v, 0));
    info.trialBalance = tb;
    if (Math.abs(tb) > 0.05) bad('trial balance not zero', tb);
    const bs = await X.accounts.balanceSheet();
    info.balanceSheet = { assets: bs.totalAssets, liabs: bs.totalLiabs };
    if (Math.abs(bs.totalAssets - bs.totalLiabs) > 0.05) bad('balance sheet does not balance', info.balanceSheet);

    // 5. Udhaar: change = credit given − credit refunds − money received (per customer).
    const after = await X.parties.partyBalances('cust');
    const want = new Map();
    const add = (id, v) => want.set(id, r2((want.get(id) || 0) + v));
    for (const s of bills) for (const p of s.payments) if (p.mode === 'credit') add(s.customerId, s.type === 'return' ? -p.amount : p.amount);
    for (const r of made.receipts) add(r.cid, -r.amount);
    let dueBad = 0;
    for (const [id, d] of want) { const got = r2((after[id] || 0) - (S.custDue[id] || 0)); if (Math.abs(got - d) > 0.02) { dueBad++; if (dueBad <= 5) bad('udhaar off', { id, want: d, got }); } }
    info.customersWithUdhaarChange = want.size;
    const sample = [...want.keys()].slice(0, 40);
    for (const id of sample) { const d = await X.parties.customerDue(id); if (Math.abs(d - (after[id] || 0)) > 0.02) { bad('customerDue ≠ partyBalances', { id, d, b: after[id] }); break; } }
    const age = await X.parties.customerAgeing();
    let ageBad = 0; for (const [, a] of Object.entries(age)) if (Math.abs(a.b0 + a.b30 + a.b60 + a.b90 - a.due) > 0.05) ageBad++;
    if (ageBad) bad('udhaar ageing buckets do not add up', ageBad);

    // 6. Loyalty points: replay every bill of the run in save order.
    const byCust = new Map();
    for (const s of [...bills].sort((a, b) => a.ts - b.ts || String(a.no).localeCompare(String(b.no)))) if (s.customerId) (byCust.get(s.customerId) || byCust.set(s.customerId, []).get(s.customerId)).push(s);
    let ptBad = 0;
    for (const [cid, list] of byCust) {
      const c = await db.customers.get(cid);
      if (!c.base) continue;     // this device does not own the row
      let p = S.points.get(cid) || 0;
      for (const s of list) p = p + (s.pointsEarned || 0) - (s.pointsUsed || 0);
      p = Math.max(0, p);
      if ((c.points || 0) !== p) { ptBad++; if (ptBad <= 5) bad('points off', { cid, want: p, got: c.points }); }
      if ((c.points || 0) < 0) bad('negative points', cid);
    }
    info.customersWithPoints = byCust.size;

    // 7. Returns never give back more than the bill had.
    const byOrig = new Map();
    for (const s of bills.filter(b => b.type === 'return')) (byOrig.get(s.origNo) || byOrig.set(s.origNo, []).get(s.origNo)).push(s);
    let retBad = 0;
    for (const [no, rs] of byOrig) {
      const o = await db.sales.where('no').equals(no).first();
      const allR = (await db.sales.where('origNo').equals(no).toArray()).filter(x => x.type === 'return');
      const e = [];
      if (r2(allR.reduce((a, r) => a + r.totals.payable, 0)) > o.totals.payable + 0.001) e.push('refund > bill');
      const tax = s => P(s.totals.cgst) + P(s.totals.sgst) + P(s.totals.igst);
      if (allR.reduce((a, r) => a + tax(r), 0) > tax(o)) e.push('tax back > tax');
      o.lines.forEach((l, i) => { const q = r3(allR.reduce((a, r) => a + r.lines.filter(x => x.origLine === i).reduce((y, x) => y + x.qty, 0), 0)); if (q > l.qty + 0.001) e.push('qty back > sold ' + l.name); });
      if (o.b2b?.gstin && rs.some(r => r.b2b?.gstin !== o.b2b.gstin)) e.push('B2B return lost its GSTIN');
      if (rs.some(r => (r.pointsEarned || 0) > 0)) e.push('return earned points');
      if (e.length) { retBad++; if (retBad <= 5) bad('return ' + no, e.join(', ')); }
      void rs;
    }
    info.billsWithReturns = byOrig.size;

    // 8. GST: GSTR-1 and GSTR-3B add up to the bills.
    const g1 = X.gst.gstr1Data(bills, settings);
    const sg = s => (s.type === 'return' ? -1 : 1);
    const T = k => r2(bills.reduce((a, s) => a + sg(s) * (s.totals[k] || 0), 0));
    const g1tax = r2(g1.b2b.reduce((a, x) => a + x.taxable, 0) - g1.cdnr.reduce((a, x) => a + x.taxable, 0) + g1.b2cs.reduce((a, r) => a + r.txval, 0) + g1.nil.b2c
      + 0);   // b2b nil is inside b2b taxable
    const b2bNil = 0; void b2bNil;
    if (Math.abs(g1tax - T('taxable')) > 0.5) bad('GSTR-1 taxable ≠ bills', { g1: g1tax, bills: T('taxable') });
    const b2bReturns = bills.filter(s => s.type === 'return' && s.b2b?.gstin).length;
    if (g1.cdnr.length !== b2bReturns) bad('B2B returns missing from table 9B', { cdnr: g1.cdnr.length, b2bReturns });
    const hsnTx = r2([...g1.hsnB2B, ...g1.hsnB2C].reduce((a, h) => a + h.txval, 0));
    if (Math.abs(hsnTx - T('taxable')) > 0.5) bad('HSN table ≠ bills', { hsn: hsnTx, bills: T('taxable') });
    const purchases = (await db.purchases.bulkGet(made.purchases)).filter(Boolean);
    const g3 = X.gst.gstr3bData({ sales: bills, purchases, suppliers: await db.suppliers.toArray(), journal: entries, settings });
    if (Math.abs(g3.outTax - r2(T('cgst') + T('sgst') + T('igst'))) > 0.05) bad('GSTR-3B output tax ≠ bills', { g3: g3.outTax });
    if (Math.abs(g3.t4a5.booksTotal - r2(purchases.reduce((a, p) => a + p.tax, 0))) > 0.5) bad('GSTR-3B input credit ≠ purchases', { g3: g3.t4a5.booksTotal });
    if (g3.cash < 0 || Object.values(g3.setOff.cash || {}).some(v => v < 0)) bad('negative cash tax');
    info.gst = { taxable: T('taxable'), tax: g3.outTax, itc: g3.t4a5.booksTotal, cash: g3.cash, b2b: g1.b2b.length, cdnr: g1.cdnr.length };

    // 9. Today's totals (dashboard, smart tools) = the bills of today.
    const today = X.util.todayISO();
    const ds = (await X.daysums.daySumsBetween(storeId, today, today))[0];
    const todays = (await db.sales.where('ts').aboveOrEqual(X.util.dayStart()).toArray()).filter(s => s.storeId === storeId && s.status !== 'void');
    const want9 = r2(todays.reduce((a, s) => a + sg(s) * s.totals.payable, 0));
    if (Math.abs(ds.total - want9) > 0.05) bad('day totals ≠ bills', { day: ds.total, bills: want9 });
    info.today = { bills: ds.bills, returns: ds.returns, total: ds.total };

    // 10. Suppliers: balance change = − purchases + payments + debit notes.
    const sAfter = await X.parties.partyBalances('supp');
    const dns = (await db.debitNotes.bulkGet(made.dns)).filter(Boolean);
    const sw = new Map(); const sadd = (id, v) => sw.set(id, r2((sw.get(id) || 0) + v));
    purchases.forEach(p => sadd(p.supplierId, -p.total)); made.suppPays.forEach(p => sadd(p.sid, p.amount)); dns.forEach(d => sadd(d.supplierId, d.total));
    let supBad = 0;
    for (const [id, d] of sw) { const got = r2((sAfter[id] || 0) - (S.suppBal[id] || 0)); if (Math.abs(got - d) > 0.05) { supBad++; if (supBad <= 3) bad('supplier balance off', { id, want: d, got }); } }
    const pnos = purchases.map(p => p.no), dnos = dns.map(d => d.no);
    if (new Set(pnos).size !== pnos.length) bad('duplicate purchase numbers');
    if (new Set(dnos).size !== dnos.length) bad('duplicate debit note numbers');
    for (const p of purchases) if (Math.abs(r2(p.taxable + p.tax) - p.total) > 0.001 || (p.paid || 0) > p.total + 0.01) { bad('purchase totals', p.no); break; }
    info.purchases = purchases.length; info.debitNotes = dns.length;

    return { pass: !fails.length, fails, info };
  };
})();
