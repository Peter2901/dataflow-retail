// Sample data so the app opens in a working state. Clearly marked as samples:
// Settings › Start fresh wipes it, and Setup › Import loads the real Excel list.
import { uid, hashPin, eanCheckDigit, addDays, r2, localISO } from './lib/util.js';
import { ensureChart, post, postPurchase, partyAccount } from './lib/accounts.js';
import { addBatch, allocateFEFO, DEFAULT_EXPIRY } from './lib/stock.js';
import { computeBill } from './lib/billing.js';
import { saveSale, audit } from './lib/sales.js';

const P = [
  // name, category, brand, uom, hsn, gst, mrp, price, cost, casePack, rack, loose/plu
  ['Whole Wheat Atta 5 kg', 'Staples', 'Golden Harvest', 'PCS', '1101', 5, 285, 259, 228, 4, 'A1-R1-S1'],
  ['Basmati Rice 1 kg', 'Staples', 'Royal Grain', 'PCS', '1006', 5, 160, 139, 118, 20, 'A1-R1-S2'],
  ['Toor Dal 1 kg', 'Staples', 'FarmFresh', 'PCS', '0713', 5, 180, 162, 142, 20, 'A1-R1-S3'],
  ['Sugar 1 kg', 'Staples', 'SweetLeaf', 'PCS', '1701', 5, 52, 46, 41, 30, 'A1-R2-S1'],
  ['Iodised Salt 1 kg', 'Staples', 'SeaPure', 'PCS', '2501', 0, 28, 25, 20, 40, 'A1-R2-S2'],
  ['Sunflower Oil 1 L', 'Edible Oils', 'SunGold', 'PCS', '1512', 5, 175, 149, 132, 12, 'A2-R1-S1'],
  ['Mustard Oil 1 L', 'Edible Oils', 'Kachi Ghani', 'PCS', '1514', 5, 190, 168, 148, 12, 'A2-R1-S2'],
  ['Cow Ghee 500 ml', 'Dairy', 'PureDesi', 'PCS', '0405', 5, 340, 315, 280, 12, 'C1-R1-S1'],
  ['Toned Milk 500 ml', 'Dairy', 'DairyDay', 'PCS', '0401', 0, 28, 27, 24, 24, 'C1-R1-S2'],
  ['Paneer 200 g', 'Dairy', 'DairyDay', 'PCS', '0406', 0, 95, 88, 74, 10, 'C1-R1-S3'],
  ['Butter 100 g', 'Dairy', 'DairyDay', 'PCS', '0405', 5, 58, 56, 49, 24, 'C1-R2-S1'],
  ['Curd 400 g', 'Dairy', 'DairyDay', 'PCS', '0403', 5, 45, 42, 35, 12, 'C1-R2-S2'],
  ['Marie Biscuits 250 g', 'Biscuits & Snacks', 'CrispCo', 'PCS', '1905', 5, 40, 35, 29, 24, 'B1-R1-S1'],
  ['Cream Biscuits 120 g', 'Biscuits & Snacks', 'CrispCo', 'PCS', '1905', 5, 30, 27, 22, 36, 'B1-R1-S2'],
  ['Aloo Bhujia 400 g', 'Biscuits & Snacks', 'NamkeenWala', 'PCS', '2106', 5, 110, 95, 78, 20, 'B1-R2-S1'],
  ['Potato Chips 90 g', 'Biscuits & Snacks', 'Crunchy', 'PCS', '2106', 5, 50, 45, 36, 30, 'B1-R2-S2'],
  ['Instant Noodles 4 pack', 'Packaged Foods', 'QuickMeal', 'PCS', '1902', 5, 60, 56, 47, 24, 'B2-R1-S1'],
  ['Tomato Ketchup 1 kg', 'Packaged Foods', 'RedRipe', 'PCS', '2103', 5, 150, 129, 106, 12, 'B2-R1-S2'],
  ['Mixed Fruit Juice 1 L', 'Beverages', 'FruitBowl', 'PCS', '2009', 5, 120, 99, 80, 12, 'B3-R1-S1'],
  ['Cola 2 L', 'Beverages', 'FizzUp', 'PCS', '2202', 40, 99, 95, 78, 9, 'B3-R1-S2'],
  ['Packaged Water 1 L', 'Beverages', 'AquaClear', 'PCS', '2201', 5, 20, 18, 13, 12, 'B3-R2-S1'],
  ['Tea 500 g', 'Beverages', 'Assam Gold', 'PCS', '0902', 5, 280, 245, 205, 24, 'B3-R2-S2'],
  ['Instant Coffee 100 g', 'Beverages', 'BrewMax', 'PCS', '2101', 5, 330, 299, 255, 24, 'B3-R2-S3'],
  ['Milk Chocolate 50 g', 'Confectionery', 'ChocoJoy', 'PCS', '1806', 5, 50, 48, 39, 48, 'B4-R1-S1'],
  ['Toothpaste 150 g', 'Personal Care', 'BrightSmile', 'PCS', '3306', 5, 120, 105, 86, 36, 'D1-R1-S1'],
  ['Shampoo 340 ml', 'Personal Care', 'SilkHair', 'PCS', '3305', 5, 299, 249, 205, 24, 'D1-R1-S2'],
  ['Bath Soap 4 x 100 g', 'Personal Care', 'FreshBath', 'PCS', '3401', 5, 160, 139, 112, 24, 'D1-R2-S1'],
  ['Face Cream 50 g', 'Personal Care', 'GlowUp', 'PCS', '3304', 18, 199, 179, 140, 24, 'D1-R2-S2'],
  ['Detergent Powder 1 kg', 'Home Care', 'WashWell', 'PCS', '3402', 18, 140, 125, 102, 20, 'D2-R1-S1'],
  ['Dishwash Bar 3 pack', 'Home Care', 'ShineDish', 'PCS', '3402', 18, 60, 55, 44, 30, 'D2-R1-S2'],
  ['Floor Cleaner 1 L', 'Home Care', 'SparkClean', 'PCS', '3402', 18, 199, 175, 140, 12, 'D2-R2-S1'],
  ['Toilet Cleaner 500 ml', 'Home Care', 'SparkClean', 'PCS', '3402', 18, 99, 89, 70, 24, 'D2-R2-S2'],
  ['Eggs 6 pack', 'Fresh', 'FarmFresh', 'PCS', '0407', 0, 48, 45, 38, 30, 'F1-R1-S1'],
  ['Brown Bread 400 g', 'Bakery', 'DailyBake', 'PCS', '1905', 0, 50, 48, 40, 10, 'F1-R1-S2'],
  ['Onion (loose)', 'Fresh', 'Loose', 'KG', '0703', 0, 40, 40, 30, 1, 'F2-BIN-1', '00101'],
  ['Tomato (loose)', 'Fresh', 'Loose', 'KG', '0702', 0, 36, 36, 26, 1, 'F2-BIN-2', '00102'],
  ['Almonds (loose)', 'Dry Fruits', 'Loose', 'KG', '0802', 5, 900, 880, 760, 1, 'F3-BIN-1', '00201'],
];

// Expiry plan per product: [days to expiry, qty] for each batch. Spread so every expiry step shows up.
const B = [
  [[150, 40]], [[300, 60]], [[200, 50]], [[365, 80]], [[700, 60]], [[95, 20], [240, 40]], [[260, 30]], [[75, 10], [180, 20]],
  [[2, 18], [5, 30]], [[-2, 4], [12, 15]], [[40, 30]], [[6, 10], [9, 14]], [[120, 60]], [[25, 30], [110, 40]], [[85, 25]], [[80, 40]],
  [[160, 50]], [[55, 15]], [[12, 12], [140, 20]], [[200, 30]], [[300, 60]], [[400, 30]], [[380, 20]], [[28, 40]],
  [[500, 40]], [[600, 25]], [[700, 40]], [[420, 15]], [[900, 30]], [[900, 40]], [[800, 15]], [[800, 25]],
  [[8, 20]], [[3, 12]], [[10, 45]], [[6, 30]], [[240, 12]],
];

const CUSTOMERS = [
  ['Anita Shah', '9800000001', 32000, 210], ['Rakesh Patel', '9800000002', 81000, 640], ['Meena Joshi', '9800000003', 12000, 80],
  ['Vikram Desai', '9800000004', 5400, 30], ['Farida Khan', '9800000005', 27500, 150], ['Suresh Traders (B2B)', '9800000006', 0, 0, '24AAACS1234A1Z8'],
];

export async function seedDemo(db) {
  const now = new Date();
  const set = async (k, v) => db.settings.put({ key: k, value: v });
  const S = {
    storeName: 'Sample Supermart', address: '[Store address, Ahmedabad]', phone: '[Store phone]', gstin: '',
    stateCode: '24', stateName: 'Gujarat', storeCode: 'S1', terminal: 'T1', upiVpa: 'yourstore@upi', upiName: 'Sample Supermart',
    pointsPer100: 1, pointsMinRedeem: 50, pointsMaxPct: 30, creditDefaultLimit: 2000, currentStore: 'S1',
    expiry: DEFAULT_EXPIRY, supervisorRefundLimit: 500, writeOffLimit: 10000,
    payroll: { pfOn: true, pfRate: 12, pfCap: 15000, esiOn: true, esiEmp: 0.75, esiEr: 3.25, esiLimit: 21000, ptSlabs: [{ min: 12000, amt: 200 }] },
    sampleData: true, fyStartMonth: 4, createdAt: Date.now(),
  };
  for (const [k, v] of Object.entries(S)) await set(k, v);

  await db.users.bulkAdd([
    { id: 'u_owner', name: 'Owner', role: 'owner', pinHash: await hashPin('1111') },
    { id: 'u_mgr', name: 'Floor Manager', role: 'manager', pinHash: await hashPin('2222') },
    { id: 'u_cash', name: 'Cashier 1', role: 'cashier', pinHash: await hashPin('3333') },
    { id: 'u_acct', name: 'Accountant', role: 'accountant', pinHash: await hashPin('4444') },
  ]);
  await db.stores.bulkAdd([{ id: 'S1', name: 'Main Store', code: 'S1' }, { id: 'S2', name: 'Second Store', code: 'S2' }]);
  await ensureChart();

  const suppliers = [
    { id: 'sp_1', name: 'Shree Ganesh Distributors', gstin: '24AAAFS1111A1ZA', phone: '9811111111', stateCode: '24', termsDays: 30, returnDays: 45 },
    { id: 'sp_2', name: 'Western FMCG Agency', gstin: '27AAACW2222B1ZY', phone: '9822222222', stateCode: '27', termsDays: 21, returnDays: 60 },
    { id: 'sp_3', name: 'DairyDay Direct', gstin: '24AABCD3333C1ZE', phone: '9833333333', stateCode: '24', termsDays: 7, returnDays: 3 },
    { id: 'sp_4', name: 'Fresh Mandi Supply', gstin: '', phone: '9844444444', stateCode: '24', termsDays: 0, returnDays: 0 },
  ];
  await db.suppliers.bulkAdd(suppliers);
  const vendorFor = cat => ({ Dairy: 'sp_3', Fresh: 'sp_4', Bakery: 'sp_4', 'Dry Fruits': 'sp_4', 'Personal Care': 'sp_2', 'Home Care': 'sp_2', Beverages: 'sp_2' }[cat] || 'sp_1');

  let invValue = 0;
  for (let i = 0; i < P.length; i++) {
    const [name, category, brand, uom, hsn, gst, mrp, price, cost, casePack, rack, plu] = P[i];
    const id = 'SKU' + String(1001 + i);
    const body = '890' + String(7000000 + i * 137).padStart(9, '0');
    const barcode = plu ? '' : body + eanCheckDigit(body);
    await db.products.add({
      id, barcode, name, category, brand, uom, hsn, gst, mrp, price, cost, casePack, rack, plu: plu || '', loose: !!plu,
      packSize: '', reorderMin: uom === 'KG' ? 15 : Math.max(6, Math.round(casePack * 0.75)), reorderMax: uom === 'KG' ? 60 : casePack * 4,
      vendorId: vendorFor(category), batchTracked: true, active: true, sample: true,
    });
    for (const [d, q] of B[i]) {
      const exp = d > 3000 ? null : localISO(addDays(now, d));
      const qq = d < 0 ? q : q * 3;
      await addBatch({ productId: id, storeId: 'S1', batchNo: 'OPN' + (100 + i) + (d < 0 ? 'X' : ''), expiry: exp, qty: qq, cost, ref: 'OPENING' });
      invValue += qq * cost;
    }
    if (i % 5 === 0) await addBatch({ productId: id, storeId: 'S2', batchNo: 'OPN2' + i, expiry: localISO(addDays(now, 120)), qty: 10, cost, ref: 'OPENING' });
    if (i % 5 === 0) invValue += 10 * cost;
  }
  await post({ ts: addDays(now, -20).getTime(), ref: 'OPENING', type: 'opening', narration: 'Opening stock and cash', lines: [{ acc: 'inventory', dr: r2(invValue) }, { acc: 'cash', dr: 50000 }, { acc: 'capital', cr: r2(invValue + 50000) }] });

  const custs = [];
  for (const [name, phone, ys, pts, gstin] of CUSTOMERS) {
    const c = { id: uid('c_'), name, phone, yearSpend: ys, lifeSpend: ys, points: pts, visits: Math.round(ys / 1500), creditLimit: gstin ? 25000 : 2000, gstin: gstin || '', notes: '', consentWhatsApp: true, createdAt: addDays(now, -200).getTime(), sample: true };
    await db.customers.add(c); custs.push(c);
  }

  await db.offers.bulkAdd([
    { id: 'of_1', type: 'qtySlab', name: 'Sugar: 3 or more', productId: 'SKU1004', slabs: [{ minQty: 3, price: 44 }], active: true },
    { id: 'of_2', type: 'bxgy', name: 'Marie: buy 2 get 1 free', productId: 'SKU1013', buy: 2, get: 1, pct: 100, active: true },
    { id: 'of_3', type: 'combo', name: 'Oil + rice combo', productIds: ['SKU1006', 'SKU1002'], off: 20, active: true },
    { id: 'of_4', type: 'billBuster', name: 'Bill over ₹2,500: ₹150 off', minAmount: 2500, off: 150, active: true },
    { id: 'of_5', type: 'billBuster', name: 'Bill over ₹5,000: ₹400 off', minAmount: 5000, off: 400, active: true },
    { id: 'of_6', type: 'category', name: 'Home Care week', category: 'Home Care', pct: 8, active: false },
  ]);

  const emps = [
    ['Ravi Kumar', 'Cashier', 13000, 3000, 2000], ['Pooja Mehta', 'Cashier', 12500, 3000, 1500],
    ['Imran Sheikh', 'Floor staff', 11000, 2500, 1500], ['Kiran Rao', 'Store manager', 22000, 6000, 4000],
  ];
  for (const [name, role, basic, hra, allow] of emps) {
    const e = { id: uid('e_'), name, role, basic, hra, allowance: allow, phone: '', pin: '', joined: '2025-06-01', pfOn: true, esiOn: true, active: true };
    await db.employees.add(e);
    for (let d = 1; d < now.getDate(); d++) {
      const dt = new Date(now.getFullYear(), now.getMonth(), d);
      if (dt.getDay() === 0 || Math.random() < 0.06) continue;
      const inT = new Date(dt); inT.setHours(9, Math.floor(Math.random() * 25), 0, 0);
      const outT = new Date(dt); outT.setHours(19, 30 + Math.floor(Math.random() * 40), 0, 0);
      await db.attendance.add({ id: uid('at_'), empId: e.id, date: localISO(dt), in: inT.getTime(), out: outT.getTime(), method: 'PIN' });
    }
  }

  // Two purchase bills so supplier dues and GST credit have something to show.
  const products = await db.products.toArray();
  const pmap = Object.fromEntries(products.map(p => [p.id, p]));
  for (const [sid, items, daysAgo, billNo] of [['sp_1', [['SKU1001', 8], ['SKU1002', 20], ['SKU1004', 30]], 6, 'SGD/2627/0881'], ['sp_2', [['SKU1025', 24], ['SKU1029', 20]], 3, 'WFA/4471']]) {
    const sup = suppliers.find(s => s.id === sid);
    const pid = uid('p_');
    const no = 'PUR-' + String(Math.floor(Math.random() * 9000) + 1000);
    const lines = items.map(([prod, qty]) => {
      const p = pmap[prod];
      const taxable = r2(qty * p.cost);
      return { productId: prod, name: p.name, hsn: p.hsn, qty, rate: p.cost, gst: p.gst, taxable, tax: r2((taxable * p.gst) / 100), batchNo: 'NEW' + Math.floor(Math.random() * 900 + 100), expiry: localISO(addDays(now, 240)) };
    });
    const taxable = r2(lines.reduce((a, l) => a + l.taxable, 0));
    const tax = r2(lines.reduce((a, l) => a + l.tax, 0));
    const date = localISO(addDays(now, -daysAgo));
    const pur = { id: pid, no, billNo, supplierId: sid, date, storeId: 'S1', lines, taxable, tax, total: r2(taxable + tax), paid: 0, dueDate: localISO(addDays(new Date(date), sup.termsDays)), source: 'manual' };
    await db.purchases.add(pur);
    for (const l of lines) await addBatch({ productId: l.productId, storeId: 'S1', batchNo: l.batchNo, expiry: l.expiry, qty: l.qty, cost: l.rate, ref: no });
    await postPurchase(pur, sup, sup.stateCode !== '24');
  }

  // Two weeks of sample bills.
  const cashier = { id: 'u_cash', name: 'Cashier 1' };
  const sellable = products.filter(p => !['SKU1010'].includes(p.id));
  let rnd = 7;
  const rand = () => { rnd = (rnd * 9301 + 49297) % 233280; return rnd / 233280; };
  for (let day = 13; day >= 0; day--) {
    const bills = 6 + Math.floor(rand() * 7);
    for (let b = 0; b < bills; b++) {
      const ts = addDays(now, -day); ts.setHours(9 + Math.floor(rand() * 12), Math.floor(rand() * 60), 0, 0);
      if (day === 0) { const since = Date.now() - new Date(now).setHours(0, 0, 0, 0); ts.setTime(Date.now() - Math.floor(rand() * Math.min(since, 10 * 3600000))); }
      if (ts.getTime() > Date.now()) continue;
      const n = 2 + Math.floor(rand() * 5);
      const picked = [...new Set(Array.from({ length: n }, () => sellable[Math.floor(rand() * sellable.length)]))];
      const lines = [];
      for (const p of picked) {
        const qty = p.loose ? r2(0.5 + rand() * 1.5) : 1 + Math.floor(rand() * 3);
        const { alloc, shortfall } = await allocateFEFO(p.id, qty, 'S1', DEFAULT_EXPIRY);
        if (!alloc.length || shortfall > 0) continue;
        const markdown = alloc.reduce((a, x) => a + (x.qty * p.price * x.markdown) / 100, 0);
        lines.push({ productId: p.id, name: p.name, hsn: p.hsn, gst: p.gst, qty, unitPrice: p.price, lineDisc: r2(markdown), mrp: p.mrp, cost: p.cost, uom: p.uom, batches: alloc });
      }
      if (!lines.length) continue;
      const cust = rand() < 0.4 ? custs[Math.floor(rand() * 5)] : null;
      const bill = computeBill(lines, []);
      const r = rand();
      const mode = r < 0.45 ? 'upi' : r < 0.8 ? 'cash' : r < 0.95 ? 'card' : (cust ? 'credit' : 'cash');
      const fresh = cust ? await db.customers.get(cust.id) : null;
      await saveSale({ bill, payments: [{ mode, amount: bill.totals.payable, ref: mode === 'upi' ? 'UTR' + Math.floor(rand() * 1e9) : '' }], customer: fresh, user: cashier, shiftId: 'seed', storeId: 'S1', ts: ts.getTime() });
    }
  }

  // A B2B customer on credit with an older unpaid bill (shows up in dues ageing).
  const b2b = await db.customers.get(custs[5].id);
  const big = computeBill([{ productId: 'SKU1001', name: pmap.SKU1001.name, hsn: '1101', gst: 5, qty: 10, unitPrice: 259, mrp: 285, cost: 228, uom: 'PCS', batches: (await allocateFEFO('SKU1001', 10, 'S1')).alloc }], []);
  await saveSale({ bill: big, payments: [{ mode: 'credit', amount: big.totals.payable }], customer: b2b, user: cashier, shiftId: 'seed', storeId: 'S1', ts: addDays(now, -40).getTime(), b2b: { gstin: b2b.gstin } });
  await partyAccount('cust', b2b);

  await db.followups.bulkAdd([
    { id: uid('f_'), customerId: custs[1].id, due: localISO(addDays(now, 1)), note: 'Ask about monthly bulk order for office pantry', done: false, createdAt: Date.now() },
    { id: uid('f_'), customerId: custs[5].id, due: localISO(addDays(now, 0)), note: 'Follow up on pending payment', done: false, createdAt: Date.now() },
  ]);
  await db.orders.bulkAdd([
    { id: uid('o_'), no: 'ORD-1001', customerId: custs[0].id, customerName: custs[0].name, phone: custs[0].phone, items: [{ productId: 'SKU1009', name: 'Toned Milk 500 ml', qty: 4, price: 27 }, { productId: 'SKU1034', name: 'Brown Bread 400 g', qty: 1, price: 48 }], status: 'new', mode: 'delivery', address: '[Customer address]', createdAt: Date.now() - 3600000, channel: 'WhatsApp' },
    { id: uid('o_'), no: 'ORD-1002', customerId: custs[2].id, customerName: custs[2].name, phone: custs[2].phone, items: [{ productId: 'SKU1002', name: 'Basmati Rice 1 kg', qty: 2, price: 139 }, { productId: 'SKU1006', name: 'Sunflower Oil 1 L', qty: 1, price: 149 }], status: 'packing', mode: 'pickup', address: '', createdAt: Date.now() - 7200000, channel: 'WhatsApp' },
  ]);
  await audit('setup', { note: 'Sample data loaded' }, { id: 'system', name: 'System' });
}
