import React, { useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { db } from '../db.js';
import { useApp, useLive, useToast, useApprove, useConfirm, Btn, Input, Modal, Badge, Card, useHotkeys, Select } from '../ui/kit.jsx';
import Receipt, { receiptText } from '../ui/Receipt.jsx';
import { computeBill, parseScaleBarcode } from '../lib/billing.js';
import { applyOffers } from '../lib/offers.js';
import { allocateFEFO, DEFAULT_EXPIRY } from '../lib/stock.js';
import { saveSale, audit, tierFor } from '../lib/sales.js';
import { customerDue } from '../lib/parties.js';
import { inr, num, r2, uid, waLink, upiLink, validGSTIN, fmtDT, inArtifact, sum } from '../lib/util.js';
import { beep, readScaleWeight, serialSupported, printReceipt } from '../lib/hardware.js';
import QuickAdd from '../ui/QuickAdd.jsx';
import { smartSearch } from '../lib/search.js';
import { unitList, toBase, fromBase, plain, priceFor } from '../lib/units.js';

const PAY_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', credit: 'Credit (udhaar)' };
// Payment tiles on the counter: the icon says what it is, the key badge says how to press it.
const PAY_TILES = [
  { mode: 'upi', label: 'UPI', key: 'F10', icon: '<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><rect x="7" y="7" width="4" height="4" rx=".8"/><path d="M14 7h3v3"/><path d="M7 14v3h3"/><path d="M14 14h3v3h-3z"/>' },
  { mode: 'cash', label: 'Cash', key: 'F9', icon: '<path d="M6 3h12"/><path d="M6 8h12"/><path d="M6 13l8.5 8"/><path d="M6 13h3"/><path d="M9 13c6.667 0 6.667-10 0-10"/>' },
  { mode: 'card', label: 'Card', key: 'F11', icon: '<rect x="2.5" y="5.5" width="17" height="13" rx="2.2"/><rect x="5.5" y="9.5" width="3.6" height="2.8" rx=".6"/><path d="M5.5 15.5h5M13 15.5h3"/><path d="M20.3 9.2a3.6 3.6 0 0 1 0 5.6M22.3 7.4a6.3 6.3 0 0 1 0 9.2"/>' },
  { mode: 'credit', label: 'Udhaar', key: 'F12', icon: '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4M2 10h4M2 14h4M2 18h4"/><path d="M21.38 5.63a2.12 2.12 0 0 0-3-3l-5.01 5.01a2 2 0 0 0-.51.85l-.84 2.87a.5.5 0 0 0 .62.62l2.87-.84a2 2 0 0 0 .85-.51Z"/>' },
];

// Units: the cart keeps every quantity in the product's base unit; `unit` is only how the cashier sees it.
function unitInfo(p, c) {
  const L = unitList(p);
  if (!L.length) return {};
  const cur = L[c.unit] || L.find(x => x.base);
  return { units: L, unitIdx: cur.i, unitName: cur.name, unitFactor: cur.factor };
}
const r2e = v => Math.round(v * 1e4) / 1e4;
const stepFor = (l, f) => (f <= 0.01 ? 50 : l.uom === 'KG' && f === 1 ? 0.25 : 1);

// Batch allocation (FEFO) for every cart line (cart quantities are in the base unit). Lines whose
// quantity did not change keep their earlier result, so a 60-item bill does not re-read every batch per scan.
async function allocateCart(cart, storeId, cfg, cache = new Map()) {
  const m = {};
  for (const c of cart) {
    const q = Number(c.qty) || 0;
    const hit = cache.get(c.key);
    if (hit && hit.forQty === q && hit.productId === c.productId) { m[c.key] = hit; continue; }
    const res = { ...(await allocateFEFO(c.productId, q, storeId, cfg)), forQty: q, productId: c.productId };
    cache.set(c.key, res);
    m[c.key] = res;
  }
  return m;
}

// Everything on screen (and what gets saved) is worked out here, from the cart and its allocations.
// composition: the store is a composition dealer — no GST on bills (the item's rate is kept as rateWas).
// Wholesale bills skip shop offers unless the owner turned them on (Settings › Loyalty & credit).
function buildView({ cart, allocs, offers, pmap, customer, points, b2b, settings, priceMode }) {
  const composition = !!settings.gstFiling?.composition;
  const lines = cart.map(c => {
    const p = pmap[c.productId];
    if (!p) return null;
    const ui = unitInfo(p, c);
    const unitPrice = c.price ?? priceFor(p, ui.unitIdx, priceMode);
    const a = allocs[c.key] || { alloc: [], blocked: [] };
    const stale = !allocs[c.key] || allocs[c.key].forQty !== (Number(c.qty) || 0);
    const markdownDisc = r2(sum(a.alloc, x => (x.qty * unitPrice * x.markdown) / 100));
    return { key: c.key, productId: p.id, name: p.name, ...(p.localName ? { localName: p.localName } : {}), hsn: p.hsn, gst: composition ? 0 : p.gst, ...(composition ? { rateWas: p.gst } : {}), qty: Number(c.qty) || 0, unitPrice, mrp: p.mrp, cost: p.cost, uom: p.uom, category: p.category, markdownDisc, alloc: a, stale, override: c.price != null, ...ui };
  }).filter(Boolean);
  const noOffers = priceMode === 'wholesale' && !settings.wholesaleOffers;
  const o = applyOffers(lines, noOffers ? [] : offers, { marginOverride: lines.some(l => l.override) });
  const billLines = lines.map(l => ({
    ...l, lineDisc: r2(l.markdownDisc + (o.perLine[l.key]?.disc || 0)), batches: l.alloc.alloc,
    offerNote: [l.markdownDisc ? 'Near-expiry markdown' : '', o.perLine[l.key]?.note].filter(Boolean).join(' · '),
  }));
  const pre = computeBill(billLines, o.billDiscounts);
  const maxPts = customer ? Math.max(0, Math.min(customer.points || 0, Math.floor(pre.totals.payable * (settings.pointsMaxPct || 30) / 100))) : 0;
  const usePts = Math.min(points, maxPts);
  const bd = [...o.billDiscounts, ...(usePts ? [{ label: `Points (${usePts})`, amount: usePts }] : [])];
  const inter = !!(b2b && validGSTIN(b2b) && b2b.slice(0, 2) !== settings.stateCode);
  const bill = computeBill(billLines, bd, inter);
  return { lines, billLines, bill, maxPts, usePts, inter, stale: lines.some(l => l.stale), blocked: lines.filter(l => !l.stale && !l.alloc.alloc.length && l.alloc.blocked.length) };
}

export default function POS() {
  const { user, settings, storeId, param, go } = useApp();
  const toast = useToast();
  const approve = useApprove();
  const confirm = useConfirm();
  const cfg = settings.expiry || DEFAULT_EXPIRY;
  const products = useLive(() => db.products.toArray(), [], []);
  const offers = useLive(() => db.offers.toArray(), [], []);
  const shift = useLive(async () => (await db.shifts.where('userId').equals(user.id).toArray()).find(s => !s.closedAt && s.storeId === storeId) || null, [user.id, storeId], undefined);

  const [cart, setCart] = useState([]);
  const [allocs, setAllocs] = useState({});
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const [customer, setCustomer] = useState(null);
  const [priceMode, setPriceMode] = useState('retail');   // 'retail' | 'wholesale'
  const [autoWh, setAutoWh] = useState(false);              // switched by a wholesale customer, not by hand
  // Composition dealers cannot charge GST: bills become a 'Bill of supply' with no tax.
  const composition = !!settings.gstFiling?.composition;
  const [due, setDue] = useState(0);
  const [b2b, setB2b] = useState('');
  const [points, setPoints] = useState(0);
  const [modal, setModal] = useState(null);
  const [orderId, setOrderId] = useState(null);
  const scanRef = useRef();
  const allocCache = useRef(new Map());
  const saving = useRef(false);

  const pmap = useMemo(() => Object.fromEntries(products.map(p => [p.id, p])), [products]);

  // Load a WhatsApp order into the counter.
  useEffect(() => {
    if (param?.orderId && products.length) {
      db.orders.get(param.orderId).then(async o => {
        if (!o) return;
        setCart(o.items.map(i => ({ key: uid('l'), productId: i.productId, qty: i.qty })));
        if (o.customerId) setCust(await db.customers.get(o.customerId));
        setOrderId(o.id);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [param?.orderId, products.length]);

  // Re-run FEFO batch allocation for lines whose quantity changed.
  useEffect(() => {
    let live = true;
    (async () => {
      const m = await allocateCart(cart, storeId, cfg, allocCache.current);
      if (live) setAllocs(m);
    })();
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cart, storeId]);

  const setCust = async c => {
    setCustomer(c);
    // A customer whose rate is Wholesale (set by the owner or a manager) switches the bill to wholesale
    // prices without a PIN; taking that customer off the bill switches it back.
    if (c?.priceLevel === 'wholesale') { if (priceMode !== 'wholesale') { setPriceMode('wholesale'); setAutoWh(true); audit('wholesale_bill', { customer: c.name, auto: true }, user); } }
    else if (autoWh) { setPriceMode('retail'); setAutoWh(false); }
    setPoints(0);
    setDue(c ? await customerDue(c.id) : 0);
    if (c?.gstin) setB2b(c.gstin);
  };

  const view = useMemo(() => buildView({ cart, allocs, offers, pmap, customer, points, b2b, settings, priceMode }), [cart, allocs, offers, pmap, customer, points, b2b, settings, priceMode]);

  const suggestions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2 || /^\d{6,}$/.test(q)) return [];
    return smartSearch(query.trim(), products, 8);   // Hindi/Odia names and typing mistakes too
  }, [query, products]);

  const addProduct = async (p, qty = 1) => {
    const { alloc, blocked } = await allocateFEFO(p.id, qty, storeId, cfg);
    if (!alloc.length && blocked.length) {
      beep(); toast(`${p.name}: only expired or blocked stock on hand. Sale stopped — move it to quarantine.`, 'bad');
      audit('blocked_scan', { product: p.name }, user);
      return;
    }
    beep(true);
    setCart(c => {
      const ex = c.find(x => x.productId === p.id && !p.loose);
      if (ex) return c.map(x => x === ex ? { ...x, qty: Number(x.qty) + qty } : x);
      return [...c, { key: uid('l'), productId: p.id, qty }];
    });
    setQuery(''); setHi(0);
    scanRef.current?.focus();
  };

  const onScan = async e => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    // An exact code always wins (barcode, SKU, PLU), then weighing-scale stickers, then the name list —
    // so a scanned code can never add a look-alike product by name.
    const p = products.find(x => x.barcode === q || x.id.toLowerCase() === q.toLowerCase() || (x.plu && x.plu === q));
    if (p) {
      if (p.loose) return setModal({ type: 'weight', product: p });
      return addProduct(p);
    }
    const scale = parseScaleBarcode(q);
    if (scale) {
      const sp = products.find(x => x.plu === scale.plu);
      if (sp) return addProduct(sp, r2(scale.grams / 1000));
    }
    if (suggestions.length && !/^\d{6,}$/.test(q)) {
      const sp = suggestions[hi] || suggestions[0];
      return sp.loose ? setModal({ type: 'weight', product: sp }) : addProduct(sp);
    }
    beep(); setQuery('');
    if (/^[A-Z0-9-]{6,20}$/i.test(q)) {
      // Unknown barcode: add the product right here (cashiers need a manager's PIN).
      const ok = ['owner', 'manager'].includes(user.role) || await approve(`Barcode ${q} is not in the product list. Approve adding it as a new product.`);
      if (ok) return setModal({ type: 'quickadd', barcode: q });
    }
    toast(`No product with code ${q}.`, 'bad');
  };

  const setQty = (key, qty) => setCart(c => c.map(x => x.key === key ? { ...x, qty: Math.max(0, qty) } : x).filter(x => x.qty > 0));
  const removeLine = key => setCart(c => c.filter(x => x.key !== key));
  // Wholesale prices are lower, so a cashier needs a manager's PIN to switch a bill to them.
  const switchWholesale = async () => {
    if (priceMode === 'wholesale') return;
    const ok = ['owner', 'manager'].includes(user.role) || await approve('Switch this bill to wholesale prices');
    if (!ok) return;
    setPriceMode('wholesale');
    audit('wholesale_bill', { items: cart.length }, user);
  };
  const setUnit = (key, i) => setCart(c => c.map(x => x.key === key ? { ...x, unit: i } : x));

  const overridePrice = async line => {
    const f = line.unitFactor || 1;          // the cashier types the price of ONE unit (e.g. per Bag)
    const shown = f === 1 ? line : { ...line, unitPrice: line.unitPrice * f, mrp: line.mrp * f, cost: line.cost * f };
    const v = await new Promise(res => setModal({ type: 'price', line: shown, res }));
    setModal(null);
    if (v == null) return;
    const mgr = await approve(`Change price of ${line.name} to ${inr(v)}${line.unitName ? ' per ' + line.unitName : ''} (shelf price ${inr(shown.unitPrice)})`);
    if (!mgr) return;
    setCart(c => c.map(x => x.key === line.key ? { ...x, price: Math.round((Number(v) / f) * 1e6) / 1e6 } : x));
    audit('price_override', { product: line.name, from: shown.unitPrice, to: v, unit: line.unitName || null, approvedBy: mgr.name }, user);
  };

  const clearBill = async (force = false) => {
    if (!force && cart.length >= 3) {
      const mgr = await approve(`Cancel this bill with ${cart.length} items`);
      if (!mgr) return;
      audit('bill_cancel', { items: cart.length, value: view.bill.totals.payable, approvedBy: mgr.name }, user);
    }
    setCart([]); setPriceMode('retail'); setAutoWh(false); setCustomer(null); setB2b(''); setPoints(0); setDue(0); setOrderId(null);
    allocCache.current.clear();
    scanRef.current?.focus();
  };

  const hold = async () => {
    if (!cart.length) return;
    await db.held.add({ id: uid('h_'), ts: Date.now(), cart, priceMode, customerId: customer?.id || null, total: view.bill.totals.payable, by: user.name });
    toast('Bill put on hold. Press F8 to bring it back.');
    clearBill(true);
  };

  const finish = async payments => {
    if (saving.current) return;                     // a double press never makes two bills
    if (b2b && !validGSTIN(b2b)) { toast('That GSTIN is not valid. Fix it or clear it for a normal bill.', 'bad'); return; }
    saving.current = true;
    try {
      // Batches are read again right now, so stock sold at another counter a moment ago is respected.
      const fresh = await allocateCart(cart, storeId, cfg, new Map());
      const v = buildView({ cart, allocs: fresh, offers, pmap, customer, points, b2b, settings, priceMode });
      if (Math.abs(v.bill.totals.payable - view.bill.totals.payable) > 0.001) {
        setAllocs(fresh);
        toast(`Stock changed while billing — the total is now ${inr(v.bill.totals.payable)}. Take payment again.`, 'warn');
        return;
      }
      if (v.blocked.length) { setAllocs(fresh); toast(`${v.blocked.map(l => l.name).join(', ')}: only expired stock left.`, 'bad'); return; }
      const sale = await saveSale({
        bill: v.bill, payments, customer: customer ? await db.customers.get(customer.id) : null, user, shiftId: shift?.id, storeId,
        pointsUsed: v.usePts, b2b: b2b ? { gstin: b2b.toUpperCase(), inter: v.inter } : null, orderId, priceMode, composition,
      });
      if (orderId) await db.orders.update(orderId, { status: 'billed', saleId: sale.id, billNo: sale.no });
      const short = v.lines.filter(l => l.alloc.shortfall > 0);
      if (short.length) { toast(`Stock count was short for ${short.map(l => l.name).join(', ')}. Manager alerted to recount.`, 'warn'); audit('negative_stock', { items: short.map(l => l.name), bill: sale.no }, user); }
      setModal({ type: 'receipt', sale });
      clearBill(true);
    } catch (e) {
      toast('Bill not saved: ' + (e.message || e), 'bad');
    } finally {
      saving.current = false;
    }
  };

  // Payment opens only when the last scan's stock check has finished (a fast cashier can press F9 at once).
  const viewRef = useRef(view);
  viewRef.current = view;
  const openPay = (mode, tries = 0) => {
    const v = viewRef.current;
    if (!v.lines.length || v.blocked.length) return;
    if (v.stale && tries < 50) { setTimeout(() => openPay(mode, tries + 1), 40); return; }
    setModal({ type: 'pay', mode });
  };

  const canPay = cart.length > 0 && !view.blocked.length;
  useHotkeys({
    F2: () => scanRef.current?.focus(),
    F3: () => setModal({ type: 'customer' }),
    F7: hold,
    F8: () => setModal({ type: 'recall' }),
    F6: () => setModal({ type: 'return' }),
    // One key per way of paying (same keys as the tiles): F9 cash, F10 UPI, F11 card, F12 udhaar.
    F9: () => canPay && openPay('cash'),
    F10: () => canPay && openPay('upi'),
    F11: () => canPay && openPay('card'),
    F12: () => canPay && openPay('credit'),
  }, [cart, view, customer]);

  if (shift === undefined) return <p className="muted">Loading counter…</p>;
  if (!shift) return <OpenShift storeId={storeId} />;

  const t = view.bill.totals;
  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Billing counter</h1><p className="muted">Counter {settings.terminal} · shift opened {fmtDT(shift.openedAt)} · {orderId ? 'Billing a WhatsApp order' : 'Scan or type to add items'}</p></div>
        <div className="row gap-s wrap">
          <Btn onClick={() => setModal({ type: 'recall' })}>Held bills <span className="kbd">F8</span></Btn>
          <Btn onClick={() => setModal({ type: 'return' })}>Return <span className="kbd">F6</span></Btn>
          <Btn onClick={async () => { const m = await approve('Open the cash drawer without a sale'); if (m) { audit('drawer_open', { approvedBy: m.name }, user); toast('Drawer opening logged.'); } }}>Open drawer</Btn>
          <Btn onClick={() => setModal({ type: 'shift', mode: 'x' })}>Shift report</Btn>
          <Btn kind="dark" onClick={() => setModal({ type: 'shift', mode: 'z' })}>Close shift</Btn>
        </div>
      </div>

      <div className="pos">
        <div className="stack">
          <Card>
            <form className="scan suggest" onSubmit={onScan}>
              <input ref={scanRef} className="input" id="scan" autoFocus autoComplete="off" placeholder="Scan barcode or type product name (F2)" value={query}
                onChange={e => { setQuery(e.target.value); setHi(0); }}
                onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, suggestions.length - 1)); } if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); } if (e.key === 'Escape') setQuery(''); }} />
              <Btn kind="primary" type="submit">Add</Btn>
              {suggestions.length > 0 && (
                <div className="suggest-list">
                  {suggestions.map((p, i) => (
                    <div key={p.id} className={`suggest-item ${i === hi ? 'on' : ''}`} onMouseDown={e => { e.preventDefault(); p.loose ? setModal({ type: 'weight', product: p }) : addProduct(p); }}>
                      <span><b>{p.name}</b> <span className="muted small">{p.brand} · {p.rack}</span></span>
                      <span className="mono">{inr(p.price)}{p.loose ? '/kg' : ''}</span>
                    </div>
                  ))}
                </div>
              )}
            </form>
          </Card>

          <Card title={`Items (${view.lines.length})`} actions={<>
            <div className="price-mode" role="group" aria-label="Price list">
              <button className={priceMode === 'retail' ? 'on' : ''} onClick={() => setPriceMode('retail')}>Retail</button>
              <button className={priceMode === 'wholesale' ? 'on' : ''} onClick={switchWholesale}>Wholesale</button>
            </div>
            {cart.length ? <Btn size="sm" kind="ghost" onClick={() => clearBill()}>Cancel bill</Btn> : null}</>}>
            {!view.lines.length && <div className="empty">Scan the first item. Loose items (vegetables, dry fruits) ask for the weight or read it from the scale.</div>}
            {view.billLines.map((l, i) => {
              const a = l.alloc;
              const bl = view.bill.lines[i];
              return (
                <div className="cart-line" key={l.key}>
                  <div className="grow">
                    <div className="name">{l.name}</div>
                    <div className="small muted">
                      <button className="btn btn-sm btn-ghost" style={{ padding: 0 }} onClick={() => overridePrice(l)} title="Change price (needs manager)">{l.units ? `${inr(l.unitPrice * l.unitFactor)}/${l.unitName}` : <>{inr(l.unitPrice)}{l.uom === 'KG' ? '/kg' : ''}</>}</button>
                      {' '}· MRP {inr(l.mrp, 0)} · GST {l.gst}%
                      {a.alloc.filter(x => x.batchNo !== 'NO-STOCK').map(x => <span key={x.batchId}> · {x.batchNo}{x.expiry ? ` (exp ${x.expiry})` : ''}</span>)}
                    </div>
                    {l.offerNote && <div className="small" style={{ color: 'var(--ok)' }}>{l.offerNote}</div>}
                    {a.shortfall > 0 && <Badge tone="warn">System stock short by {num(a.shortfall, 2)} — sale allowed, manager alerted</Badge>}
                    {!a.alloc.length && a.blocked.length > 0 && <Badge tone="bad">Expired stock — cannot be sold</Badge>}
                  </div>
                  <div className="qty-col">
                  {l.units && <select className="unit-pick" value={l.unitIdx} onChange={e => setUnit(l.key, Number(e.target.value))} aria-label="Unit">{l.units.map(u => <option key={u.i} value={u.i}>{u.name}</option>)}</select>}
                  <div className="qty">
                    <button onClick={() => setQty(l.key, r2e(l.qty - (l.unitFactor ? stepFor(l, l.unitFactor) * l.unitFactor : (l.uom === 'KG' ? 0.25 : 1))))} aria-label="Less">−</button>
                    <input value={l.unitFactor ? plain(l.qty / l.unitFactor) : l.qty} inputMode="decimal" onChange={e => setQty(l.key, l.unitFactor ? r2e((Number(e.target.value) || 0) * l.unitFactor) : Number(e.target.value) || 0)} aria-label="Quantity" />
                    <button onClick={() => setQty(l.key, r2e(l.qty + (l.unitFactor ? stepFor(l, l.unitFactor) * l.unitFactor : (l.uom === 'KG' ? 0.25 : 1))))} aria-label="More">+</button>
                  </div>
                  </div>
                  <div className="num line-total">{inr(bl?.total || 0)}{l.lineDisc > 0 && <div className="small" style={{ color: 'var(--ok)' }}>−{inr(l.lineDisc)}</div>}</div>
                  <button className="icon-btn" onClick={() => removeLine(l.key)} aria-label={`Remove ${l.name}`}>✕</button>
                </div>
              );
            })}
          </Card>
          <div className="keys small muted">
            <span><span className="kbd">F2</span> scan</span><span><span className="kbd">F3</span> customer</span><span><span className="kbd">F7</span> hold</span>
            <span><span className="kbd">F8</span> recall</span><span><span className="kbd">F6</span> return</span><span><span className="kbd">F9–F12</span> pay</span>
          </div>
        </div>

        <div className="stack">
          <Card title="Customer" actions={<Btn size="sm" onClick={() => setModal({ type: 'customer' })}>{customer ? 'Change' : 'Add'} <span className="kbd">F3</span></Btn>}>
            {customer ? (
              <div className="stack">
                <div className="cust-chip">
                  <div><b>{customer.name}</b><div className="small muted">{customer.phone} · {tierFor(customer.yearSpend || 0).key} member</div></div>
                  <button className="icon-btn" onClick={() => setCust(null)} aria-label="Remove customer">✕</button>
                </div>
                <div className="row between small"><span>Points available</span><b className="mono">{customer.points || 0}</b></div>
                {due > 0 && <div className="row between small"><span>Credit due</span><b className="mono" style={{ color: 'var(--bad)' }}>{inr(due)}</b></div>}
                {view.maxPts >= (settings.pointsMinRedeem || 50) ? (
                  <div className="row gap-s">
                    <Input label={`Use points (max ${view.maxPts})`} type="number" min="0" max={view.maxPts} value={points || ''} onChange={e => setPoints(Math.max(0, Number(e.target.value)))} id="pts" />
                    <Btn size="sm" onClick={() => setPoints(view.maxPts)} style={{ alignSelf: 'flex-end' }}>Max</Btn>
                  </div>
                ) : customer.points > 0 ? <p className="small muted">Points can be used from {settings.pointsMinRedeem || 50} points, up to {settings.pointsMaxPct || 30}% of the bill.</p> : null}
              </div>
            ) : <p className="muted small">Add the customer’s phone to give loyalty points and send the bill on WhatsApp.</p>}
            <div style={{ marginTop: 10 }}>
              <Input label="Business bill — buyer GSTIN (optional)" value={b2b} onChange={e => setB2b(e.target.value.toUpperCase())} placeholder="e.g. 24ABCDE1234F1Z5" id="b2b" />
              {b2b && !validGSTIN(b2b) && <p className="err small">GSTIN check failed. A normal bill will be made unless it is fixed.</p>}
              {view.inter && <p className="small muted">Other state: IGST will be charged.</p>}
            </div>
          </Card>

          <Card title="Total">
            <div className="totals">
              <div className="row small"><span>MRP value</span><span className="mono">{inr(t.mrpTotal)}</span></div>
              <div className="row small"><span>Before discounts</span><span className="mono">{inr(t.gross)}</span></div>
              {t.lineDisc > 0 && <div className="row small"><span>Offers & markdowns</span><span className="mono">−{inr(t.lineDisc)}</span></div>}
              {view.bill.billDiscounts.map((d, i) => <div className="row small" key={i}><span>{d.label}</span><span className="mono">−{inr(d.amount)}</span></div>)}
              <div className="row small muted"><span>Taxable {inr(t.taxable)}</span><span className="mono">GST {inr(t.cgst + t.sgst + t.igst)}</span></div>
              {t.roundOff !== 0 && <div className="row small muted"><span>Round off</span><span className="mono">{inr(t.roundOff)}</span></div>}
              <hr className="sep" />
              <div className="row"><span className="muted">To pay</span><span className="grand">{inr(t.payable)}</span></div>
              {t.savings > 0 && <div className="save-pill">Customer saves {inr(t.savings)} on MRP</div>}
              <div className="pay-tiles" role="group" aria-label="Take payment">
                {PAY_TILES.map(pt => (
                  <button key={pt.mode} type="button" className={`pay-tile pay-${pt.mode}`} disabled={!canPay} onClick={() => openPay(pt.mode)} aria-label={`${pt.label}, shortcut ${pt.key}`}>
                    <kbd className="pay-key">{pt.key}</kbd>
                    <svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: pt.icon }} />
                    <span>{pt.label}</span>
                  </button>
                ))}
              </div>
              <Btn onClick={hold} disabled={!cart.length}>Hold bill <span className="kbd">F7</span></Btn>
            </div>
          </Card>
        </div>
      </div>

      {modal?.type === 'quickadd' && <QuickAdd barcode={modal.barcode} title="New product (barcode not found)" allowNext={false} onClose={() => { setModal(null); scanRef.current?.focus(); }} onSaved={p => { setModal(null); addProduct(p); }} />}
      {modal?.type === 'weight' && <WeightModal product={modal.product} onClose={() => setModal(null)} onAdd={kg => { setModal(null); addProduct(modal.product, kg); }} />}
      {modal?.type === 'price' && <PriceModal line={modal.line} onClose={() => modal.res(null)} onSave={v => modal.res(v)} />}
      {modal?.type === 'customer' && <CustomerModal onClose={() => setModal(null)} onPick={c => { setCust(c); setModal(null); scanRef.current?.focus(); }} />}
      {modal?.type === 'pay' && <PayModal initialMode={modal.mode || 'cash'} total={t.payable} customer={customer} due={due} settings={settings} onClose={() => setModal(null)} onDone={p => { setModal(null); finish(p); }} />}
      {modal?.type === 'receipt' && <ReceiptModal sale={modal.sale} settings={settings} onClose={() => { setModal(null); scanRef.current?.focus(); }} />}
      {modal?.type === 'recall' && <RecallModal onClose={() => setModal(null)} onPick={async h => {
        if (cart.length && !(await confirm('Replace the current bill with the held one?', 'Replace'))) return;
        setCart(h.cart); setPriceMode(h.priceMode || 'retail'); if (h.customerId) setCust(await db.customers.get(h.customerId)); await db.held.delete(h.id); setModal(null);
      }} />}
      {modal?.type === 'return' && <ReturnModal settings={settings} onClose={() => setModal(null)} onDone={async (bill, payments, orig) => {
        if (bill.totals.payable > (settings.supervisorRefundLimit || 500)) {
          const m = await approve(`Refund of ${inr(bill.totals.payable)} against bill ${orig.no}`);
          if (!m) return;
        }
        const cust = orig.customerId ? await db.customers.get(orig.customerId) : null;
        const sale = await saveSale({ bill, payments, customer: cust, user, shiftId: shift.id, storeId, type: 'return', origNo: orig.no });
        setModal({ type: 'receipt', sale });
      }} />}
      {modal?.type === 'shift' && <ShiftModal shift={shift} mode={modal.mode} settings={settings} onClose={() => setModal(null)} onClosed={() => { setModal(null); go('dashboard'); }} />}
    </div>
  );
}

function OpenShift({ storeId }) {
  const { user, settings } = useApp();
  const [cash, setCash] = useState('2000');
  const open = async e => {
    e.preventDefault();
    await db.shifts.add({ id: uid('sh_'), userId: user.id, userName: user.name, storeId, counter: settings.terminal || 'T1', openedAt: Date.now(), openingCash: Number(cash) || 0, closedAt: null });
    audit('shift_open', { float: Number(cash) }, user);
  };
  return (
    <div className="stack" style={{ maxWidth: 440 }}>
      <h1>Start your shift</h1>
      <p className="muted">Count the cash in the drawer before the first bill. This is checked when you close the shift.</p>
      <form onSubmit={open} className="stack card pad">
        <Input label="Opening cash in drawer (₹)" type="number" value={cash} onChange={e => setCash(e.target.value)} id="float" autoFocus />
        <Btn kind="primary" size="lg" type="submit">Open counter</Btn>
      </form>
    </div>
  );
}

function WeightModal({ product, onClose, onAdd }) {
  const L = unitList(product);
  const baseI = L.findIndex(x => x.base);
  const [ui, setUi] = useState(baseI < 0 ? 0 : baseI);
  const [kg, setKg] = useState('');
  const [err, setErr] = useState('');
  const cur = L[ui];
  const name = cur ? cur.name : 'kg';
  const toBaseQty = v => (cur ? toBase(product, ui, v) : r2(Number(v)));
  const read = async () => { try { setErr(''); const w = await readScaleWeight(); setKg(String(cur ? fromBase(product, ui, w) : w)); } catch (e) { setErr(e.message); } };
  const baseQty = toBaseQty(kg);
  return (
    <Modal title={`Weigh: ${product.name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!(Number(kg) > 0)} onClick={() => onAdd(baseQty)}>Add {kg ? `${kg} ${name}` : ''}</Btn></>}>
      <form className="stack" onSubmit={e => { e.preventDefault(); Number(kg) > 0 && onAdd(baseQty); }}>
        {L.length > 1 && <Select label="Unit" value={ui} onChange={e => setUi(Number(e.target.value))} options={L.map(u => ({ value: u.i, label: u.name }))} id="wunit" />}
        <Input label={`Weight in ${name}`} type="number" step="any" autoFocus value={kg} onChange={e => setKg(e.target.value)} id="kg" />
        <p className="small muted">{inr(product.price * (cur ? cur.factor : 1))}/{name} · {kg ? `amount ${inr(baseQty * product.price)}` : ''}</p>
        {serialSupported() && <Btn type="button" onClick={read}>Read from scale</Btn>}
        {err && <p className="err small">{err}</p>}
      </form>
    </Modal>
  );
}

function PriceModal({ line, onClose, onSave }) {
  const [v, setV] = useState(String(line.unitPrice));
  return (
    <Modal title={`Change price: ${line.name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => onSave(Number(v))}>Next: manager approval</Btn></>}>
      <Input label="New price per unit (₹)" type="number" value={v} onChange={e => setV(e.target.value)} autoFocus id="newprice" />
      <p className="small muted" style={{ marginTop: 8 }}>Cost {inr(line.cost)} · MRP {inr(line.mrp)}. Prices above MRP are not allowed.</p>
      {Number(v) > line.mrp && <p className="err small">Above MRP — not allowed by law.</p>}
    </Modal>
  );
}

function CustomerModal({ onClose, onPick }) {
  const { settings } = useApp();
  const [q, setQ] = useState('');
  const [name, setName] = useState('');
  // Indexed look-ups first (phone / name start), so this stays instant with 50,000 customers.
  const list = useLive(async () => {
    const s = q.trim().toLowerCase();
    if (!s) return (await db.customers.orderBy('updatedAt').reverse().limit(60).toArray()).sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0)).slice(0, 6);
    const digits = s.replace(/\D/g, '');
    let hits = /^\d+$/.test(s) ? await db.customers.where('phone').startsWith(digits).limit(8).toArray() : await db.customers.where('name').startsWithIgnoreCase(s).limit(8).toArray();
    if (hits.length < 8 && s.length >= 3) {
      const more = (await db.customers.toArray()).filter(c => String(c.phone).includes(s) || String(c.name).toLowerCase().includes(s)).slice(0, 8);
      hits = [...hits, ...more.filter(m => !hits.some(h => h.id === m.id))].slice(0, 8);
    }
    return hits;
  }, [q], []);
  const add = async () => {
    const phone = q.replace(/\D/g, '');
    if (phone.length !== 10) return;
    const c = { id: uid('c_'), name: name || 'Customer ' + phone.slice(-4), phone, yearSpend: 0, lifeSpend: 0, points: 0, visits: 0, creditLimit: settings.creditDefaultLimit || 2000, gstin: '', notes: '', consentWhatsApp: true, createdAt: Date.now() };
    await db.customers.add(c);
    onPick(c);
  };
  const isNew = /^\d{10}$/.test(q.replace(/\D/g, '')) && !list.some(c => c.phone === q.replace(/\D/g, ''));
  return (
    <Modal title="Customer" onClose={onClose}>
      <div className="stack">
        <Input label="Mobile number or name" value={q} onChange={e => setQ(e.target.value)} autoFocus inputMode="tel" id="custq" />
        {list.map(c => (
          <button key={c.id} className="cust-chip" style={{ border: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left' }} onClick={() => onPick(c)}>
            <span><b>{c.name}</b><br /><span className="small muted">{c.phone} · {tierFor(c.yearSpend || 0).key} · {c.points || 0} pts</span></span><span>Select</span>
          </button>
        ))}
        {isNew && (
          <div className="stack card pad">
            <b>New customer: {q}</b>
            <Input label="Name (optional)" value={name} onChange={e => setName(e.target.value)} id="newcname" />
            <p className="small muted">The customer agrees to get bills and offers on WhatsApp (DPDP consent recorded).</p>
            <Btn kind="primary" onClick={add}>Add and select</Btn>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PayModal({ initialMode = 'cash', total, customer, due, settings, onClose, onDone }) {
  const [mode, setMode] = useState(initialMode);
  const [tendered, setTendered] = useState('');
  const [ref, setRef] = useState('');
  const [split, setSplit] = useState([]);
  const [qr, setQr] = useState('');
  const paidSplit = r2(sum(split, s => s.amount));
  const remaining = r2(total - paidSplit);
  const amountNow = split.length ? remaining : total;
  const creditLeft = customer ? (customer.creditLimit || 0) - due : 0;

  useEffect(() => {
    if (mode === 'upi' && settings.upiVpa) {
      QRCode.toDataURL(upiLink({ vpa: settings.upiVpa, name: settings.upiName || settings.storeName, amount: amountNow, note: 'Bill payment' }), { margin: 1, width: 220 }).then(setQr).catch(() => setQr(''));
    }
  }, [mode, amountNow, settings]);

  const canCredit = customer && amountNow <= creditLeft + 0.01;
  const tenderRow = () => {
    const amt = mode === 'cash' && tendered ? Math.min(Number(tendered), amountNow) : amountNow;
    return { mode, amount: r2(amt), ref: ref || '', change: mode === 'cash' && Number(tendered) > amountNow ? r2(Number(tendered) - amountNow) : 0 };
  };
  const complete = () => {
    const row = tenderRow();
    if (row.amount < amountNow - 0.001) { setSplit(s => [...s, row]); setTendered(''); setRef(''); return; }
    onDone([...split, row]);
  };
  const change = mode === 'cash' && Number(tendered) > amountNow ? r2(Number(tendered) - amountNow) : 0;

  return (
    <Modal title={`Payment · ${inr(total)}`} onClose={onClose}
      footer={<>
        <Btn onClick={onClose}>Back</Btn>
        <Btn kind="primary" size="lg" disabled={(mode === 'credit' && !canCredit) || (mode === 'cash' && tendered && Number(tendered) <= 0)} onClick={complete}>
          {mode === 'cash' && tendered && Number(tendered) < amountNow ? `Take ${inr(Number(tendered))}, pay rest another way` : mode === 'upi' ? 'Payment received' : 'Complete bill'}
        </Btn>
      </>}>
      <div className="stack">
        {split.length > 0 && <div className="note">Paid so far: {split.map(s => `${PAY_LABEL[s.mode]} ${inr(s.amount)}`).join(' + ')} · <b>left {inr(remaining)}</b></div>}
        <div className="pay-modes" role="radiogroup">
          {Object.entries(PAY_LABEL).map(([k, v]) => <button key={k} role="radio" aria-checked={mode === k} className={`pay-mode ${mode === k ? 'on' : ''}`} onClick={() => setMode(k)}>{v}</button>)}
        </div>
        {mode === 'cash' && (
          <>
            <Input label="Cash received (leave empty for exact)" type="number" autoFocus value={tendered} onChange={e => setTendered(e.target.value)} id="tender" />
            <div className="row gap-s wrap">{[amountNow, Math.ceil(amountNow / 100) * 100, Math.ceil(amountNow / 500) * 500, 2000].filter((v, i, a) => v >= amountNow && a.indexOf(v) === i).map(v => <Btn size="sm" key={v} onClick={() => setTendered(String(v))}>{inr(v, 0)}</Btn>)}</div>
            {change > 0 && <div className="save-pill">Give change: {inr(change)}</div>}
          </>
        )}
        {mode === 'upi' && (
          <>
            {settings.upiVpa ? (qr ? <div className="qr"><img src={qr} alt={`UPI QR for ${inr(amountNow)}`} width="220" height="220" /></div> : null) : <p className="err">Set the store UPI ID in Settings to show a QR.</p>}
            <p className="small muted" style={{ textAlign: 'center' }}>Customer scans with any UPI app. Amount {inr(amountNow)} is filled in. Pay to {settings.upiVpa}.</p>
            <Input label="UPI reference / UTR (optional)" value={ref} onChange={e => setRef(e.target.value)} id="utr" />
            <p className="small muted">Only press “Payment received” after you see the success message on the customer’s phone or your soundbox.</p>
          </>
        )}
        {mode === 'card' && <Input label="Card machine approval code" value={ref} onChange={e => setRef(e.target.value)} autoFocus id="cardref" />}
        {mode === 'credit' && (customer ? (
          <div className="stack">
            <div className="row between"><span>Credit limit</span><b className="mono">{inr(customer.creditLimit || 0)}</b></div>
            <div className="row between"><span>Already due</span><b className="mono">{inr(due)}</b></div>
            <div className="row between"><span>Can still give</span><b className="mono">{inr(Math.max(0, creditLeft))}</b></div>
            {!canCredit && <p className="err">This bill goes over the customer’s credit limit. Take part payment now, or raise the limit in Customers.</p>}
          </div>
        ) : <p className="err">Add the customer first (F3) to give credit.</p>)}
      </div>
    </Modal>
  );
}

function ReceiptModal({ sale, settings, onClose }) {
  const text = receiptText(sale, settings);
  const artifact = inArtifact();
  return (
    <Modal title={sale.type === 'return' ? 'Return saved' : 'Bill saved'} onClose={onClose}
      footer={<>
        {sale.customerPhone && <a className="btn" href={waLink(sale.customerPhone, text)} target="_blank" rel="noreferrer">Send on WhatsApp</a>}
        {!artifact && <Btn onClick={printReceipt}>Print receipt</Btn>}
        <Btn kind="primary" onClick={onClose} autoFocus>Next customer</Btn>
      </>}>
      <Receipt sale={sale} settings={settings} />
      {artifact && <p className="small muted" style={{ marginTop: 8 }}>Printing works on the installed store app. This demo link can’t open the print dialog.</p>}
    </Modal>
  );
}

function RecallModal({ onClose, onPick }) {
  const held = useLive(() => db.held.orderBy('ts').reverse().toArray(), [], []);
  return (
    <Modal title="Held bills" onClose={onClose}>
      {!held.length && <p className="muted">No bills on hold.</p>}
      <div className="stack">{held.map(h => (
        <button key={h.id} className="cust-chip" style={{ border: '1px solid var(--line)', cursor: 'pointer' }} onClick={() => onPick(h)}>
          <span>{h.cart.length} items · {fmtDT(h.ts)} · {h.by}</span><b className="mono">{inr(h.total)}</b>
        </button>
      ))}</div>
    </Modal>
  );
}

function ReturnModal({ onClose, onDone }) {
  const [no, setNo] = useState('');
  const [sale, setSale] = useState(null);
  const [qty, setQty] = useState({});
  const [mode, setMode] = useState('cash');
  const [err, setErr] = useState('');
  const find = async e => {
    e?.preventDefault();
    const s = await db.sales.where('no').equals(no.trim().toUpperCase()).first() || await db.sales.where('no').equals(no.trim()).first();
    if (!s || s.type !== 'sale') { setErr('No sale with that bill number.'); return; }
    const earlier = (await db.sales.where('origNo').equals(s.no).toArray()).filter(x => x.type === 'return');
    const returned = {};
    earlier.forEach(r => r.lines.forEach(l => (returned[l.productId] = (returned[l.productId] || 0) + l.qty)));
    setSale({ ...s, returned }); setErr('');
  };
  const recent = useLive(() => db.sales.orderBy('ts').reverse().filter(s => s.type === 'sale').limit(5).toArray(), [], []);
  const build = () => {
    const lines = sale.lines.map(l => {
      const q = Math.min(Number(qty[l.productId] || 0), l.qty - (sale.returned[l.productId] || 0));
      if (!(q > 0)) return null;
      const f = q / l.qty;
      const sc = k => r2(l[k] * f);
      return { ...l, qty: q, gross: sc('gross'), lineDisc: sc('lineDisc'), billDisc: sc('billDisc'), taxable: sc('taxable'), cgst: sc('cgst'), sgst: sc('sgst'), igst: sc('igst'), total: sc('total'),
        batches: [{ batchId: l.batches?.[0]?.batchId || null, batchNo: l.batches?.[0]?.batchNo, qty: q }] };
    }).filter(Boolean);
    const T = k => r2(sum(lines, l => l[k]));
    const exact = T('total');
    const payable = Math.round(exact);
    return { lines, billDiscounts: [], totals: { gross: T('gross'), lineDisc: T('lineDisc'), billDisc: T('billDisc'), taxable: T('taxable'), cgst: T('cgst'), sgst: T('sgst'), igst: T('igst'), exact, roundOff: r2(payable - exact), payable, mrpTotal: 0, savings: 0, items: lines.length, qty: T('qty') } };
  };
  const bill = sale ? build() : null;
  return (
    <Modal title="Return items" wide onClose={onClose} footer={sale && <><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" disabled={!bill.lines.length} onClick={() => onDone(bill, [{ mode, amount: bill.totals.payable }], sale)}>Refund {inr(bill.totals.payable)}</Btn></>}>
      {!sale ? (
        <form className="stack" onSubmit={find}>
          <Input label="Bill number (from receipt or WhatsApp bill)" value={no} onChange={e => setNo(e.target.value)} autoFocus id="retno" />
          {err && <p className="err">{err}</p>}
          <Btn kind="primary" type="submit">Find bill</Btn>
          <div className="small muted">Recent: {recent.map(r => <button type="button" key={r.id} className="chip" style={{ margin: 2 }} onClick={() => setNo(r.no)}>{r.no}</button>)}</div>
        </form>
      ) : (
        <div className="stack">
          <p>Bill <b>{sale.no}</b> · {fmtDT(sale.ts)} · {inr(sale.totals.payable)} {sale.customerName && `· ${sale.customerName}`}</p>
          <table className="tbl"><thead><tr><th>Item</th><th className="num">Bought</th><th className="num">Already returned</th><th className="num">Return now</th></tr></thead>
            <tbody>{sale.lines.map(l => (
              <tr key={l.productId}><td>{l.name}</td><td className="num">{l.qty}</td><td className="num">{sale.returned[l.productId] || 0}</td>
                <td className="num"><input className="input" style={{ width: 90 }} type="number" min="0" max={l.qty} value={qty[l.productId] || ''} onChange={e => setQty({ ...qty, [l.productId]: e.target.value })} aria-label={`Return quantity for ${l.name}`} /></td></tr>
            ))}</tbody></table>
          <Select label="Refund by" value={mode} onChange={e => setMode(e.target.value)} options={[{ value: 'cash', label: 'Cash' }, { value: 'upi', label: 'UPI' }, { value: 'card', label: 'Card reversal' }, { value: 'credit', label: 'Adjust in customer credit' }]} id="refmode" />
          <p className="small muted">Purchase price is locked to the original bill. A GST credit note is made automatically. Stock goes back to the original batch.</p>
        </div>
      )}
    </Modal>
  );
}

function ShiftModal({ shift, mode, settings, onClose, onClosed }) {
  const { user } = useApp();
  const sales = useLive(() => db.sales.where('shiftId').equals(shift.id).toArray(), [shift.id], []);
  const [counted, setCounted] = useState('');
  const by = {};
  let bills = 0, returns = 0;
  sales.forEach(s => {
    const sign = s.type === 'return' ? -1 : 1;
    if (s.type === 'return') returns++; else bills++;
    s.payments.forEach(p => (by[p.mode] = r2((by[p.mode] || 0) + sign * p.amount)));
  });
  const expected = r2(shift.openingCash + (by.cash || 0));
  const variance = counted === '' ? null : r2(Number(counted) - expected);
  const text = `*${mode === 'z' ? 'Shift closed' : 'Shift report'}* · ${settings.storeName}\n${user.name} · ${fmtDT(shift.openedAt)} → ${fmtDT(Date.now())}\nBills: ${bills} · Returns: ${returns}\n${Object.entries(by).map(([k, v]) => `${k.toUpperCase()}: ${inr(v)}`).join('\n')}\nCash expected: ${inr(expected)}${variance != null ? `\nCash counted: ${inr(Number(counted))}\nDifference: ${inr(variance)}` : ''}`;
  const close = async () => {
    await db.shifts.update(shift.id, { closedAt: Date.now(), countedCash: Number(counted), expectedCash: expected, variance, totals: by, bills, returns });
    audit('shift_close', { expected, counted: Number(counted), variance }, user);
    onClosed();
  };
  return (
    <Modal title={mode === 'z' ? 'Close shift (Z report)' : 'Shift so far (X report)'} onClose={onClose}
      footer={<>
        {settings.phone && <a className="btn" href={waLink('', text)} target="_blank" rel="noreferrer">Share on WhatsApp</a>}
        {mode === 'z' ? <Btn kind="primary" disabled={counted === ''} onClick={close}>Close shift</Btn> : <Btn kind="primary" onClick={onClose}>Done</Btn>}
      </>}>
      <div className="stack">
        <div className="row between"><span>Bills</span><b className="mono">{bills}</b></div>
        <div className="row between"><span>Returns</span><b className="mono">{returns}</b></div>
        {Object.entries(PAY_LABEL).map(([k, v]) => <div className="row between" key={k}><span>{v}</span><b className="mono">{inr(by[k] || 0)}</b></div>)}
        <hr className="sep" />
        <div className="row between"><span>Opening cash</span><b className="mono">{inr(shift.openingCash)}</b></div>
        <div className="row between"><span>Cash that should be in drawer</span><b className="mono">{inr(expected)}</b></div>
        {mode === 'z' && <Input label="Cash counted now (₹)" type="number" value={counted} onChange={e => setCounted(e.target.value)} autoFocus id="counted" />}
        {variance != null && <div className={`note ${Math.abs(variance) > 50 ? 'note-bad' : ''}`}>{variance === 0 ? 'Cash matches exactly.' : variance > 0 ? `Cash is over by ${inr(variance)}.` : `Cash is short by ${inr(-variance)}. This is noted against ${user.name}.`}</div>}
      </div>
    </Modal>
  );
}
