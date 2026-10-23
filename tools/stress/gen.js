// Huge-data generator for DataFlow Retail stress tests. Runs inside the page, writes straight into
// the app's IndexedDB ('dataflow_retail') in big transactions. A year+ of a busy 4-counter store.
window.__gen = async function gen(opt) {
  const O = Object.assign({ products: 25000, customers: 30000, suppliers: 300, purchases: 6000, sales: 250000, days: 395, counters: 4 }, opt || {});
  const t0 = performance.now();
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const r2 = v => Math.round((v + Number.EPSILON) * 100) / 100;
  const C = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const gstinOf = (state, n) => {
    const pan = 'AAB' + 'CDFGH'[n % 5] + 'PQRST'[Math.floor(n / 5) % 5] + String(1000 + (n % 9000)).padStart(4, '0') + 'K';
    const s14 = String(state).padStart(2, '0') + pan + '1Z';
    let sum = 0; for (let i = 0; i < 14; i++) { const v = C.indexOf(s14[i]) * (i % 2 === 0 ? 1 : 2); sum += Math.floor(v / 36) + (v % 36); }
    return s14 + C[(36 - (sum % 36)) % 36];
  };
  const ean = n => { const b = '890' + String(n).padStart(9, '0'); let s = 0; for (let i = 0; i < 12; i++) s += Number(b[i]) * (i % 2 ? 3 : 1); return b + ((10 - (s % 10)) % 10); };
  const db = await new Promise((res, rej) => { const r = indexedDB.open('dataflow_retail'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const put = (store, rows) => new Promise((res, rej) => {
    const tx = db.transaction(store, 'readwrite'); const os = tx.objectStore(store);
    for (const r of rows) os.put(r);
    tx.oncomplete = res; tx.onerror = () => rej(tx.error);
  });
  const putMany = async (store, rows, size = 5000) => { for (let i = 0; i < rows.length; i += size) await put(store, rows.slice(i, i + size)); };
  const settings = {}; await new Promise(res => { const tx = db.transaction('settings'); const q = tx.objectStore('settings').getAll(); q.onsuccess = () => { q.result.forEach(r => (settings[r.key] = r.value)); res(); }; });
  const home = String(settings.stateCode || '24').padStart(2, '0');
  const now = Date.now();
  const log = [];

  // ---- products + one batch each
  const BR = ['Amul', 'Tata', 'ITC', 'HUL', 'Dabur', 'Parle', 'Britannia', 'Nestle', 'Patanjali', 'Haldiram', 'MDH', 'Everest', 'Fortune', 'Saffola', 'Colgate', 'Dettol', 'Surf', 'Ariel', 'Maggi', 'Kissan', 'Lijjat', 'Bikaji', 'Priya', 'Aashirvaad', 'Ruchi'];
  const IT = ['Atta', 'Rice', 'Dal', 'Sugar', 'Salt', 'Oil', 'Ghee', 'Butter', 'Biscuit', 'Namkeen', 'Soap', 'Shampoo', 'Toothpaste', 'Detergent', 'Tea', 'Coffee', 'Noodles', 'Ketchup', 'Pickle', 'Papad', 'Masala', 'Haldi', 'Jeera', 'Besan', 'Sooji', 'Poha', 'Chips', 'Juice', 'Cola', 'Agarbatti'];
  const SZ = ['50 g', '100 g', '200 g', '250 g', '500 g', '1 kg', '2 kg', '5 kg', '100 ml', '200 ml', '500 ml', '1 L', '5 L'];
  const CAT = { Atta: 'Staples', Rice: 'Staples', Dal: 'Pulses', Sugar: 'Staples', Salt: 'Staples', Oil: 'Edible Oil', Ghee: 'Dairy', Butter: 'Dairy', Biscuit: 'Bakery', Namkeen: 'Snacks', Soap: 'Personal Care', Shampoo: 'Personal Care', Toothpaste: 'Personal Care', Detergent: 'Household', Tea: 'Beverages', Coffee: 'Beverages', Noodles: 'Processed Foods', Ketchup: 'Sauces', Pickle: 'Sauces', Papad: 'Papad', Masala: 'Spices', Haldi: 'Spices', Jeera: 'Spices', Besan: 'Staples', Sooji: 'Staples', Poha: 'Staples', Chips: 'Snacks', Juice: 'Beverages', Cola: 'Beverages', Agarbatti: 'Puja Items' };
  const HSN = { Staples: '1101', Pulses: '0713', 'Edible Oil': '1512', Dairy: '0405', Bakery: '1905', Snacks: '2106', 'Personal Care': '3401', Household: '3402', Beverages: '0902', 'Processed Foods': '1902', Sauces: '2103', Papad: '1905', Spices: '0910', 'Puja Items': '3307' };
  const GST = { Staples: 5, Pulses: 0, 'Edible Oil': 5, Dairy: 5, Bakery: 5, Snacks: 5, 'Personal Care': 18, Household: 18, Beverages: 18, 'Processed Foods': 5, Sauces: 5, Papad: 0, Spices: 5, 'Puja Items': 5 };
  const products = [], batches = [];
  for (let i = 0; i < O.products; i++) {
    const it = pick(IT), cat = CAT[it], loose = i % 20 === 0;
    const mrp = Math.round(10 + rnd() * 490), price = Math.max(5, Math.round(mrp * (0.85 + rnd() * 0.15))), gst = GST[cat];
    const cost = r2(price / (1 + gst / 100) * (0.78 + rnd() * 0.12));
    const p = { id: 'P' + i, barcode: loose ? '' : ean(100000 + i), name: `${pick(BR)} ${it} ${loose ? '(loose)' : pick(SZ)} #${i}`, category: cat, brand: loose ? 'Loose' : pick(BR), uom: loose ? 'KG' : 'PCS',
      hsn: HSN[cat] + (i % 3 ? '0000' : ''), gst, mrp, price, cost, casePack: pick([1, 6, 10, 12, 24]), rack: `A${i % 30}-R${i % 7}`, reorderMin: 5, reorderMax: 50, vendorId: 'V' + (i % O.suppliers),
      plu: loose ? String(10000 + i) : '', loose, active: true, batchTracked: true, updatedAt: now - 400 * 864e5 };
    if (loose && i % 40 === 0) { p.units = { names: ['Bag', 'Kg', 'Gram'], c12: 30, c23: 1000, base: 1 }; p.prices = { r: [Math.round(price * 29), 0], w: [Math.round(price * 27), r2(price * 0.93), 0] }; }
    products.push(p);
    const exp = new Date(now + (rnd() * 500 - 40) * 864e5);
    batches.push({ id: 'B' + i, productId: p.id, storeId: 'S1', batchNo: 'GB' + i, mfg: null, expiry: exp.toISOString().slice(0, 10), qty: loose ? 200 : 300 + Math.floor(rnd() * 700), cost, mrp, status: 'active', receivedAt: now - 300 * 864e5, updatedAt: now - 300 * 864e5 });
  }
  await putMany('products', products); await putMany('batches', batches);
  log.push(['products+batches', Math.round(performance.now() - t0)]);

  // ---- suppliers, customers
  const suppliers = Array.from({ length: O.suppliers }, (_, i) => ({ id: 'V' + i, name: `Supplier ${i} Agencies`, gstin: gstinOf(i % 25 === 0 ? 19 : home, i), stateCode: i % 25 === 0 ? '19' : home, phone: '98' + String(10000000 + i), leadDays: 2 + (i % 5), updatedAt: now - 400 * 864e5 }));
  await putMany('suppliers', suppliers);
  const FN = ['Ravi', 'Sita', 'Amit', 'Priya', 'Rahul', 'Anita', 'Suresh', 'Kavita', 'Manoj', 'Pooja', 'Bikash', 'Sasmita', 'Prakash', 'Mamata', 'Deepak', 'Lipi'];
  const LN = ['Das', 'Mohanty', 'Sahoo', 'Patra', 'Nayak', 'Behera', 'Mishra', 'Rout', 'Swain', 'Jena', 'Panda', 'Sharma'];
  const customers = Array.from({ length: O.customers }, (_, i) => ({ id: 'C' + i, name: `${pick(FN)} ${pick(LN)} ${i}`, phone: String(7000000000 + i * 7), points: Math.floor(rnd() * 400), yearSpend: Math.round(rnd() * 60000), lifeSpend: Math.round(rnd() * 120000),
    visits: Math.floor(rnd() * 60), lastVisit: now - Math.floor(rnd() * 120) * 864e5, createdAt: now - 400 * 864e5, creditLimit: 2000, gstin: i % 500 === 0 ? gstinOf(home, 5000 + i) : '', consentWhatsApp: true, priceLevel: i % 300 === 0 ? 'wholesale' : 'retail', updatedAt: now - 10 * 864e5 }));
  await putMany('customers', customers);
  log.push(['customers', Math.round(performance.now() - t0)]);

  // ---- purchases (some unpaid > 180 days for Rule 37)
  const purchases = [], pj = [];
  for (let i = 0; i < O.purchases; i++) {
    const s = suppliers[i % suppliers.length], d = new Date(now - Math.floor(rnd() * O.days) * 864e5);
    const lines = Array.from({ length: 10 }, () => { const p = pick(products); const qty = 12 + Math.floor(rnd() * 48), rate = p.cost; const taxable = r2(qty * rate); return { productId: p.id, name: p.name, qty, free: 0, pack: 1, rate, disc: 0, gst: p.gst, taxable, tax: r2(taxable * p.gst / 100), pieces: qty, landing: rate }; });
    const taxable = r2(lines.reduce((a, l) => a + l.taxable, 0)), tax = r2(lines.reduce((a, l) => a + l.tax, 0)), total = r2(taxable + tax);
    const age = (now - d) / 864e5;
    const paid = age > 200 && i % 40 === 0 ? 0 : age > 30 ? total : (i % 3 ? total : 0);
    const date = d.toISOString().slice(0, 10);
    purchases.push({ id: 'PU' + i, no: 'PUR-' + (1000 + i), billNo: 'INV/' + (i % 900) + '/' + i, supplierId: s.id, date, storeId: 'S1', lines, taxable, tax, total, paid, dueDate: new Date(d.getTime() + 15 * 864e5).toISOString().slice(0, 10), updatedAt: d.getTime() });
    const inter = s.stateCode !== home;
    pj.push({ id: 'JP' + i, ts: d.getTime(), ref: 'PUR-' + (1000 + i), type: 'purchase', narration: 'Purchase', lines: [{ acc: 'inventory', dr: taxable }, ...(inter ? [{ acc: 'in_igst', dr: tax }] : [{ acc: 'in_cgst', dr: r2(tax / 2) }, { acc: 'in_sgst', dr: r2(tax - r2(tax / 2)) }]), { acc: 'supp:' + s.id, cr: total }], updatedAt: d.getTime() });
  }
  await putMany('purchases', purchases, 2000); await putMany('journal', pj);
  log.push(['purchases', Math.round(performance.now() - t0)]);

  // ---- sales, stock moves, journal, audit
  const fyShort = t => { const x = new Date(t); const y = x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1; return String(y).slice(2) + String(y + 1).slice(2); };
  const seq = {}, chain = {}, hot = products.slice(0, 3000);
  const step = (O.days * 864e5) / O.sales;
  let S = [], M = [], J = [], A = [];
  // Round-off line, as the app writes it, so every generated entry balances to the paisa.
  const balance = (paid, booked, sg) => { const d = r2(paid - booked); return !d ? [] : [{ acc: 'roundoff', [(d > 0) === (sg > 0) ? 'cr' : 'dr']: Math.abs(d) }]; };
  const usedCust = new Set();
  const flush = async () => { await put('sales', S); await put('stockMoves', M); await put('journal', J); await put('audit', A); S = []; M = []; J = []; A = []; };
  for (let i = 0; i < O.sales; i++) {
    let ts = now - O.days * 864e5 + i * step; const hh = new Date(ts).getHours(); if (hh < 9) ts += (9 - hh) * 36e5; if (ts > now - 60000) ts = now - 60000 - (O.sales - i) * 10;
    const k = 1 + (i % O.counters), term = 'T' + k, fy = fyShort(ts), sk = `S1${term}_${fy}`;
    seq[sk] = (seq[sk] || 0) + 1; chain[term] = (chain[term] || 0) + 1;
    const no = `S1${term}/${fy}/${String(seq[sk]).padStart(6, '0')}`;
    const isRet = i % 50 === 49;
    const n = 1 + Math.floor(rnd() * 7);
    const lines = [];
    let gross = 0, tx = 0, cg = 0, sgt = 0, cogs = 0;
    for (let j = 0; j < n; j++) {
      const p = rnd() < 0.7 ? pick(hot) : pick(products);
      const qty = p.loose ? r2(0.25 + rnd() * 2) : 1 + Math.floor(rnd() * 3);
      const total = r2(qty * p.price), taxable = r2(total * 100 / (100 + p.gst)), tax = r2(total - taxable), c = r2(tax / 2);
      lines.push({ productId: p.id, name: p.name, hsn: p.hsn, gst: p.gst, qty, uom: p.uom, mrp: p.mrp, unitPrice: p.price, cost: p.cost, batches: [{ batchId: 'B' + p.id.slice(1), batchNo: 'GB' + p.id.slice(1), qty }],
        gross: total, lineDisc: 0, billDisc: 0, taxable, cgst: c, sgst: r2(tax - c), igst: 0, total });
      gross += total; tx += taxable; cg += c; sgt += r2(tax - c); cogs += qty * p.cost;
      M.push({ ts, productId: p.id, batchId: 'B' + p.id.slice(1), storeId: 'S1', qty: isRet ? qty : -qty, type: isRet ? 'return' : 'sale', ref: no, sid: `${term}:g${i}_${j}`, updatedAt: ts });
    }
    const exact = r2(gross), payable = Math.round(exact), roundOff = r2(payable - exact);
    const r = rnd(); const cust = r < 0.3 ? customers[Math.floor(rnd() * customers.length)] : null;
    const mode = r < 0.03 && cust ? 'credit' : r < 0.5 ? 'upi' : r < 0.85 ? 'cash' : 'card';
    const b2b = cust && cust.gstin ? { gstin: cust.gstin } : null;
    const sale = { id: 'S' + i, no, ts, storeId: 'S1', type: isRet ? 'return' : 'sale', origNo: isRet ? S[0]?.no || null : null, status: 'done', shiftId: 'gen', cashierId: 'u2', cashierName: 'Cashier ' + k,
      customerId: cust?.id || null, customerName: cust?.name || '', customerPhone: cust?.phone || '', b2b, lines,
      totals: { gross: exact, lineDisc: 0, billDisc: 0, taxable: r2(tx), cgst: r2(cg), sgst: r2(sgt), igst: 0, exact, roundOff, payable, mrpTotal: exact, savings: 0, items: n, qty: n },
      billDiscounts: [], payments: [{ mode, amount: payable }], pointsUsed: 0, pointsEarned: 0, chainSeq: chain[term], prevHash: 'g', hash: 'g' + i, updatedAt: ts };
    S.push(sale);
    const sg = isRet ? -1 : 1;
    J.push({ id: 'JS' + i, ts, ref: no, type: isRet ? 'credit_note' : 'sale', narration: 'Sale ' + no, lines: [{ acc: mode === 'credit' ? 'cust:' + cust.id : mode === 'upi' ? 'bank' : mode === 'card' ? 'card' : 'cash', [sg > 0 ? 'dr' : 'cr']: payable }, { acc: 'sales', [sg > 0 ? 'cr' : 'dr']: r2(tx) }, { acc: 'out_cgst', [sg > 0 ? 'cr' : 'dr']: r2(cg) }, { acc: 'out_sgst', [sg > 0 ? 'cr' : 'dr']: r2(sgt) }, { acc: 'cogs', [sg > 0 ? 'dr' : 'cr']: r2(cogs) }, { acc: 'inventory', [sg > 0 ? 'cr' : 'dr']: r2(cogs) }, ...balance(payable, r2(tx) + r2(cg) + r2(sgt), sg)], updatedAt: ts });
    if (mode === 'credit') usedCust.add(cust.id);
    A.push({ id: 'AU' + i, ts, action: isRet ? 'return' : 'bill', detail: { no, amount: payable }, userId: 'u2', userName: 'Cashier ' + k, dev: term, prevHash: 'g', hash: 'g', updatedAt: ts, _oc: term === 'T1' ? undefined : term });
    if (S.length >= 2500) await flush();
  }
  await flush();
  // Party accounts, as the app makes them the first time a customer buys on credit or a supplier bill is saved.
  await putMany('accounts', [...suppliers.map(x => ({ id: 'supp:' + x.id, name: x.name, group: 'liability', party: 'supp', partyId: x.id })),
    ...[...usedCust].map(id => ({ id: 'cust:' + id, name: customers.find(c => c.id === id)?.name || id, group: 'asset', party: 'cust', partyId: id }))]);
  // This device is counter T1: continue its bill numbers and chain after the generated ones.
  const curFy = fyShort(now);
  await put('settings', [{ key: `seq_S1T1_${curFy}`, value: seq[`S1T1_${curFy}`] || 0 }, { key: 'chain_S1', value: chain.T1 || 0 }]);
  log.push(['sales+moves+journal+audit', Math.round(performance.now() - t0)]);
  db.close();
  return { ms: Math.round(performance.now() - t0), log, counts: { products: products.length, customers: customers.length, purchases: purchases.length, sales: O.sales, stockMoves: '~' + Math.round(O.sales * 4) } };
};
