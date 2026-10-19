import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Tabs, Card, Stat, Badge, Input } from '../ui/kit.jsx';
import { inr, num, r2, sum, groupBy, todayISO, fmtDT, uid, waLink, daysBetween, localISO } from '../lib/util.js';
import { exportRows } from '../lib/excel.js';
import { stockMap, daysLeft } from '../lib/stock.js';

function Period({ value, onChange }) {
  return (
    <div className="row gap-s wrap" style={{ alignItems: 'flex-end' }}>
      <Input label="From" type="date" value={value.from} onChange={e => onChange({ ...value, from: e.target.value })} id="rp-from" />
      <Input label="To" type="date" value={value.to} onChange={e => onChange({ ...value, to: e.target.value })} id="rp-to" />
      {[['Today', 0], ['7 days', 6], ['This month', 'm'], ['Last month', 'lm']].map(([l, d]) => <Btn size="sm" key={l} onClick={() => {
        const now = new Date();
        if (d === 'm') return onChange({ from: localISO(new Date(now.getFullYear(), now.getMonth(), 1)), to: todayISO() });
        if (d === 'lm') return onChange({ from: localISO(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: localISO(new Date(now.getFullYear(), now.getMonth(), 0)) });
        onChange({ from: localISO(new Date(Date.now() - d * 864e5)), to: todayISO() });
      }}>{l}</Btn>)}
    </div>
  );
}

const inRange = (ts, p) => ts >= new Date(p.from).setHours(0, 0, 0, 0) && ts <= new Date(p.to).setHours(23, 59, 59, 999);

export default function Reports() {
  const { storeId } = useApp();
  const [tab, setTab] = useState('sales');
  const now = new Date();
  const [p, setP] = useState({ from: localISO(new Date(now.getFullYear(), now.getMonth(), 1)), to: todayISO() });
  const sales = useLive(() => db.sales.where('storeId').equals(storeId).toArray(), [storeId], []);
  const inP = useMemo(() => sales.filter(s => inRange(s.ts, p)), [sales, p]);
  return (
    <div className="stack">
      <PageHead title="Reports" sub="Every report exports to Excel. GST tables follow the GSTR-1 and GSTR-3B layout." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'sales', label: 'Sales' }, { value: 'items', label: 'Items & profit' }, { value: 'gstr1', label: 'GSTR-1' }, { value: 'gstr3b', label: 'GSTR-3B' }, { value: 'stock', label: 'Stock' }, { value: 'shifts', label: 'Cashier shifts' }, { value: 'builder', label: 'Build your own' }]} />
      {!['stock', 'builder'].includes(tab) && <Period value={p} onChange={setP} />}
      {tab === 'sales' && <SalesRep sales={inP} />}
      {tab === 'items' && <ItemsRep sales={inP} />}
      {tab === 'gstr1' && <Gstr1 sales={inP} p={p} />}
      {tab === 'gstr3b' && <Gstr3b sales={inP} p={p} />}
      {tab === 'stock' && <StockRep storeId={storeId} sales={sales} />}
      {tab === 'shifts' && <Shifts p={p} />}
      {tab === 'builder' && <Builder sales={sales} />}
    </div>
  );
}

const sg = s => (s.type === 'return' ? -1 : 1);

function SalesRep({ sales }) {
  const { settings } = useApp();
  const byDay = Object.entries(groupBy(sales, s => localISO(new Date(s.ts)))).map(([d, ss]) => ({
    id: d, bills: ss.filter(s => s.type === 'sale').length, returns: ss.filter(s => s.type === 'return').length,
    sales: r2(sum(ss, s => sg(s) * s.totals.payable)), tax: r2(sum(ss, s => sg(s) * (s.totals.cgst + s.totals.sgst + s.totals.igst))),
    disc: r2(sum(ss, s => sg(s) * (s.totals.lineDisc + s.totals.billDisc))),
  })).sort((a, b) => b.id.localeCompare(a.id));
  const modes = {};
  sales.forEach(s => s.payments.forEach(x => (modes[x.mode] = r2((modes[x.mode] || 0) + sg(s) * x.amount))));
  const cashiers = Object.entries(groupBy(sales, s => s.cashierName)).map(([n, ss]) => ({ id: n, bills: ss.length, amt: r2(sum(ss, s => sg(s) * s.totals.payable)) }));
  const total = r2(sum(byDay, d => d.sales));
  return (
    <div className="stack">
      <div className="grid g4"><Stat label="Net sales" value={inr(total, 0)} /><Stat label="Bills" value={sum(byDay, d => d.bills)} /><Stat label="Discounts given" value={inr(sum(byDay, d => d.disc), 0)} /><Stat label="GST collected" value={inr(sum(byDay, d => d.tax), 0)} /></div>
      <Card title="Day by day" actions={<><Btn size="sm" onClick={() => exportRows('sales-by-day.xlsx', 'Sales', byDay)}>Excel</Btn><a className="btn btn-sm" href={waLink('', `*${settings.storeName} sales*\n` + byDay.slice(0, 10).map(d => `${d.id}: ${inr(d.sales, 0)} (${d.bills} bills)`).join('\n'))} target="_blank" rel="noreferrer">WhatsApp</a></>}>
        <Table rows={byDay} cols={[{ label: 'Date', key: 'id' }, { label: 'Bills', num: true, key: 'bills' }, { label: 'Returns', num: true, key: 'returns' }, { label: 'Discounts', num: true, render: d => inr(d.disc) }, { label: 'GST', num: true, render: d => inr(d.tax) }, { label: 'Net sales', num: true, render: d => inr(d.sales) }]} />
      </Card>
      <div className="grid g2">
        <Card title="By payment"><Table rows={Object.entries(modes).map(([k, v]) => ({ id: k, v }))} cols={[{ label: 'Mode', render: r => r.id.toUpperCase() }, { label: 'Amount', num: true, render: r => inr(r.v) }]} /></Card>
        <Card title="By cashier"><Table rows={cashiers} cols={[{ label: 'Cashier', key: 'id' }, { label: 'Bills', num: true, key: 'bills' }, { label: 'Amount', num: true, render: r => inr(r.amt) }]} /></Card>
      </div>
    </div>
  );
}

function ItemsRep({ sales }) {
  const products = useLive(() => db.products.toArray(), [], []);
  const pm = Object.fromEntries(products.map(p => [p.id, p]));
  const items = {};
  sales.forEach(s => s.lines.forEach(l => {
    const k = l.productId;
    items[k] = items[k] || { id: k, name: l.name, category: pm[k]?.category || '', qty: 0, sales: 0, taxable: 0, cost: 0 };
    items[k].qty += sg(s) * l.qty; items[k].sales += sg(s) * l.total; items[k].taxable += sg(s) * l.taxable; items[k].cost += sg(s) * l.qty * (l.cost || 0);
  }));
  const rows = Object.values(items).map(i => ({ ...i, profit: r2(i.taxable - i.cost), margin: i.taxable ? r2(((i.taxable - i.cost) / i.taxable) * 100) : 0 })).sort((a, b) => b.sales - a.sales);
  const cats = Object.entries(groupBy(rows, r => r.category)).map(([c, rs]) => ({ id: c, sales: r2(sum(rs, r => r.sales)), profit: r2(sum(rs, r => r.profit)), taxable: sum(rs, r => r.taxable) })).map(c => ({ ...c, margin: c.taxable ? r2((c.profit / c.taxable) * 100) : 0 })).sort((a, b) => b.profit - a.profit);
  return (
    <div className="stack">
      <Card title="Categories by profit" actions={<Btn size="sm" onClick={() => exportRows('category-profit.xlsx', 'Categories', cats)}>Excel</Btn>}>
        <Table rows={cats} cols={[{ label: 'Category', key: 'id' }, { label: 'Sales', num: true, render: c => inr(c.sales, 0) }, { label: 'Profit', num: true, render: c => inr(c.profit, 0) }, { label: 'Margin', num: true, render: c => c.margin + '%' }]} />
      </Card>
      <Card title="Items" actions={<Btn size="sm" onClick={() => exportRows('item-sales.xlsx', 'Items', rows)}>Excel</Btn>}>
        <Table rows={rows} cols={[{ label: 'Item', key: 'name' }, { label: 'Qty', num: true, render: r => num(r.qty, 2) }, { label: 'Sales', num: true, render: r => inr(r.sales) }, { label: 'Profit', num: true, render: r => inr(r.profit) }, { label: 'Margin', num: true, render: r => <span style={{ color: r.margin < 5 ? 'var(--bad)' : undefined }}>{r.margin}%</span> }]} />
      </Card>
    </div>
  );
}

function Gstr1({ sales, p }) {
  const { settings } = useApp();
  const b2b = sales.filter(s => s.type === 'sale' && s.b2b?.gstin).map(s => ({ id: s.no, gstin: s.b2b.gstin, date: localISO(new Date(s.ts)), value: s.totals.payable, pos: s.b2b.gstin.slice(0, 2), taxable: s.totals.taxable, igst: s.totals.igst, cgst: s.totals.cgst, sgst: s.totals.sgst }));
  const b2cLines = sales.filter(s => !s.b2b?.gstin).flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s), pos: settings.stateCode })));
  const b2cs = Object.entries(groupBy(b2cLines, l => `${l.pos}|${l.gst}`)).map(([k, ls]) => ({ id: k, pos: k.split('|')[0], rate: Number(k.split('|')[1]), taxable: r2(sum(ls, l => l.sg * l.taxable)), cgst: r2(sum(ls, l => l.sg * l.cgst)), sgst: r2(sum(ls, l => l.sg * l.sgst)), igst: r2(sum(ls, l => l.sg * l.igst)) })).sort((a, b) => a.rate - b.rate);
  const allLines = sales.flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s) })));
  const hsn = Object.entries(groupBy(allLines, l => `${l.hsn}|${l.gst}`)).map(([k, ls]) => ({ id: k, hsn: k.split('|')[0], rate: Number(k.split('|')[1]), uqc: ls[0].uom === 'KG' ? 'KGS' : 'NOS', qty: r2(sum(ls, l => l.sg * l.qty)), value: r2(sum(ls, l => l.sg * l.total)), taxable: r2(sum(ls, l => l.sg * l.taxable)), cgst: r2(sum(ls, l => l.sg * l.cgst)), sgst: r2(sum(ls, l => l.sg * l.sgst)), igst: r2(sum(ls, l => l.sg * l.igst)) })).sort((a, b) => a.hsn.localeCompare(b.hsn));
  const cdn = sales.filter(s => s.type === 'return').map(s => ({ id: s.no, against: s.origNo, date: localISO(new Date(s.ts)), value: s.totals.payable, taxable: s.totals.taxable }));
  const docs = sales.filter(s => s.type === 'sale');
  return (
    <div className="stack">
      {!settings.gstin && <div className="note note-warn">Store GSTIN is not set (Settings). It must be on every tax invoice before filing.</div>}
      <div className="row gap-s"><Btn kind="primary" onClick={() => {
        exportRows(`GSTR1-B2B-${p.from}.xlsx`, 'B2B (4A)', b2b); exportRows(`GSTR1-B2CS-${p.from}.xlsx`, 'B2CS (7)', b2cs); exportRows(`GSTR1-HSN-${p.from}.xlsx`, 'HSN (12)', hsn);
      }}>Export all GSTR-1 tables</Btn></div>
      <Card title="Table 4A · B2B invoices (business customers with GSTIN)"><Table rows={b2b} empty="No business invoices in this period." cols={[{ label: 'Invoice', key: 'id' }, { label: 'Buyer GSTIN', key: 'gstin' }, { label: 'Date', key: 'date' }, { label: 'Taxable', num: true, render: r => inr(r.taxable) }, { label: 'IGST', num: true, render: r => inr(r.igst) }, { label: 'CGST', num: true, render: r => inr(r.cgst) }, { label: 'SGST', num: true, render: r => inr(r.sgst) }]} /></Card>
      <Card title="Table 7 · B2C (others), by rate and place of supply"><Table rows={b2cs} cols={[{ label: 'State code', key: 'pos' }, { label: 'Rate', num: true, render: r => r.rate + '%' }, { label: 'Taxable', num: true, render: r => inr(r.taxable) }, { label: 'CGST', num: true, render: r => inr(r.cgst) }, { label: 'SGST', num: true, render: r => inr(r.sgst) }, { label: 'IGST', num: true, render: r => inr(r.igst) }]} foot={{ pos: 'Total', taxable: inr(sum(b2cs, r => r.taxable)), cgst: inr(sum(b2cs, r => r.cgst)), sgst: inr(sum(b2cs, r => r.sgst)) }} /></Card>
      <Card title="Table 9B · Credit notes (returns)"><Table rows={cdn} empty="No returns." cols={[{ label: 'Credit note', key: 'id' }, { label: 'Against bill', key: 'against' }, { label: 'Date', key: 'date' }, { label: 'Taxable', num: true, render: r => inr(r.taxable) }, { label: 'Value', num: true, render: r => inr(r.value) }]} /></Card>
      <Card title="Table 12 · HSN summary"><Table rows={hsn} cols={[{ label: 'HSN', key: 'hsn' }, { label: 'UQC', key: 'uqc' }, { label: 'Qty', num: true, render: r => num(r.qty, 3) }, { label: 'Rate', num: true, render: r => r.rate + '%' }, { label: 'Taxable', num: true, render: r => inr(r.taxable) }, { label: 'CGST', num: true, render: r => inr(r.cgst) }, { label: 'SGST', num: true, render: r => inr(r.sgst) }, { label: 'IGST', num: true, render: r => inr(r.igst) }]} /></Card>
      <Card title="Table 13 · Documents issued"><p>Invoices {docs[0]?.no ? `${[...docs].sort((a, b) => a.ts - b.ts)[0].no} to ${[...docs].sort((a, b) => b.ts - a.ts)[0].no}` : '—'} · {docs.length} issued · 0 cancelled · Credit notes {cdn.length}</p></Card>
    </div>
  );
}

function Gstr3b({ sales, p }) {
  const purchases = useLive(() => db.purchases.toArray(), [], []);
  const inP = purchases.filter(x => inRange(new Date(x.date).getTime(), p));
  const T = k => r2(sum(sales, s => sg(s) * s.totals[k]));
  const nil = r2(sum(sales.flatMap(s => s.lines.map(l => ({ ...l, sg: sg(s) }))).filter(l => l.gst === 0), l => l.sg * l.taxable));
  const itc = r2(sum(inP, x => x.tax));
  const out = r2(T('cgst') + T('sgst') + T('igst'));
  return (
    <div className="stack">
      <Card title="3.1 Outward supplies">
        <Table rows={[{ id: '(a) Taxable supplies (other than zero/nil rated)', taxable: r2(T('taxable') - nil), igst: T('igst'), cgst: T('cgst'), sgst: T('sgst') }, { id: '(c) Nil-rated and exempted', taxable: nil, igst: 0, cgst: 0, sgst: 0 }]} cols={[{ label: 'Nature of supply', key: 'id' }, { label: 'Taxable value', num: true, render: r => inr(r.taxable) }, { label: 'IGST', num: true, render: r => inr(r.igst) }, { label: 'CGST', num: true, render: r => inr(r.cgst) }, { label: 'SGST', num: true, render: r => inr(r.sgst) }]} />
      </Card>
      <Card title="4. Eligible input tax credit (from purchase bills)">
        <p>All other ITC: <b className="mono">{inr(itc)}</b> from {inP.length} bills. Check against GSTR-2B (Purchases › GST credit check) before claiming.</p>
      </Card>
      <div className="grid g3"><Stat label="Tax on sales" value={inr(out, 0)} /><Stat label="Input credit" value={inr(itc, 0)} /><Stat label="Net to pay in cash" value={inr(Math.max(0, out - itc), 0)} tone="warn" /></div>
    </div>
  );
}

function StockRep({ storeId, sales }) {
  const products = useLive(() => db.products.toArray(), [], []);
  const batches = useLive(() => db.batches.where('storeId').equals(storeId).toArray(), [storeId], []);
  const stock = useLive(() => stockMap(storeId), [storeId], {});
  const since = Date.now() - 30 * 864e5;
  const sold = {};
  sales.filter(s => s.ts >= since && s.type === 'sale').forEach(s => s.lines.forEach(l => (sold[l.productId] = (sold[l.productId] || 0) + l.qty)));
  const rows = products.map(p => {
    const on = stock[p.id] || 0, val = r2(sum(batches.filter(b => b.productId === p.id && b.status === 'active' && b.qty > 0), b => b.qty * b.cost));
    const daily = (sold[p.id] || 0) / 30;
    return { id: p.id, name: p.name, category: p.category, onHand: on, value: val, sold30: sold[p.id] || 0, daysCover: daily ? Math.round(on / daily) : null };
  });
  const cats = Object.entries(groupBy(rows, r => r.category)).map(([c, rs]) => ({ id: c, value: r2(sum(rs, r => r.value)), items: rs.length }));
  const dead = rows.filter(r => r.onHand > 0 && !r.sold30);
  const over = rows.filter(r => r.daysCover != null && r.daysCover > 45);
  const totalVal = r2(sum(rows, r => r.value));
  const cogs30 = r2(sum(sales.filter(s => s.ts >= since), s => sg(s) * sum(s.lines, l => l.qty * (l.cost || 0))));
  const turns = totalVal ? r2((cogs30 * 12) / totalVal) : 0;
  return (
    <div className="stack">
      <div className="grid g4"><Stat label="Stock value at cost" value={inr(totalVal, 0)} /><Stat label="Stock turns a year (est.)" value={turns} sub="Target 24–30 for a fast supermarket" /><Stat label="Not sold in 30 days" value={dead.length} tone={dead.length ? 'warn' : undefined} /><Stat label="Over 45 days of cover" value={over.length} tone={over.length ? 'warn' : undefined} /></div>
      <Card title="Value by category" actions={<Btn size="sm" onClick={() => exportRows('stock-valuation.xlsx', 'Stock', rows)}>Excel (all items)</Btn>}><Table rows={cats} cols={[{ label: 'Category', key: 'id' }, { label: 'Items', num: true, key: 'items' }, { label: 'Value at cost', num: true, render: c => inr(c.value, 0) }]} /></Card>
      <Card title="Dead stock (nothing sold in 30 days)"><Table rows={dead} empty="Every item with stock sold in the last 30 days." cols={[{ label: 'Item', key: 'name' }, { label: 'On hand', num: true, render: r => num(r.onHand, 2) }, { label: 'Value', num: true, render: r => inr(r.value, 0) }]} /></Card>
      <Card title="Too much stock (over 45 days of cover)"><Table rows={over} empty="No item has more than 45 days of stock." cols={[{ label: 'Item', key: 'name' }, { label: 'Days of cover', num: true, key: 'daysCover' }, { label: 'Value', num: true, render: r => inr(r.value, 0) }]} /></Card>
      <Card title="Expiry by batch"><Table rows={batches.filter(b => b.status === 'active' && b.qty > 0 && b.expiry && daysLeft(b.expiry) <= 60).map(b => ({ ...b, name: products.find(p => p.id === b.productId)?.name, dl: daysLeft(b.expiry) })).sort((a, b) => a.dl - b.dl)} cols={[{ label: 'Item', key: 'name' }, { label: 'Batch', key: 'batchNo' }, { label: 'Expiry', key: 'expiry' }, { label: 'Days', num: true, render: b => <span style={{ color: b.dl < 0 ? 'var(--bad)' : undefined }}>{b.dl}</span> }, { label: 'Qty', num: true, render: b => num(b.qty, 2) }]} /></Card>
    </div>
  );
}

function Shifts({ p }) {
  const shifts = useLive(() => db.shifts.toArray(), [], []);
  const rows = shifts.filter(s => s.closedAt && inRange(s.closedAt, p)).sort((a, b) => b.closedAt - a.closedAt);
  return <div className="card"><Table rows={rows} empty="No closed shifts in this period." cols={[
    { label: 'Cashier', key: 'userName' }, { label: 'Opened', render: s => fmtDT(s.openedAt) }, { label: 'Closed', render: s => fmtDT(s.closedAt) },
    { label: 'Bills', num: true, key: 'bills' }, { label: 'Cash expected', num: true, render: s => inr(s.expectedCash) }, { label: 'Counted', num: true, render: s => inr(s.countedCash) },
    { label: 'Difference', num: true, render: s => <Badge tone={Math.abs(s.variance || 0) > 50 ? 'bad' : 'ok'}>{inr(s.variance || 0)}</Badge> },
  ]} /></div>;
}

// Report builder: pick data, columns, a filter and a group-by; save it for next time.
const DATASETS = {
  lines: { label: 'Items sold (bill lines)', cols: ['date', 'bill', 'cashier', 'customer', 'item', 'category', 'hsn', 'gst', 'qty', 'price', 'discount', 'taxable', 'tax', 'amount', 'cost', 'profit'] },
  bills: { label: 'Bills', cols: ['date', 'bill', 'type', 'cashier', 'customer', 'items', 'discount', 'taxable', 'tax', 'amount', 'payment'] },
  products: { label: 'Products & stock', cols: ['sku', 'item', 'category', 'brand', 'gst', 'mrp', 'price', 'cost', 'stock', 'rack'] },
  purchases: { label: 'Purchase lines', cols: ['date', 'purchase', 'supplier', 'item', 'batch', 'expiry', 'qty', 'rate', 'gst', 'taxable', 'tax'] },
  customers: { label: 'Customers', cols: ['name', 'phone', 'tier', 'yearSpend', 'visits', 'points', 'lastVisit'] },
};
const NUMS = new Set(['gst', 'qty', 'price', 'discount', 'taxable', 'tax', 'amount', 'cost', 'profit', 'items', 'mrp', 'stock', 'rate', 'yearSpend', 'visits', 'points']);

function Builder({ sales }) {
  const { storeId } = useApp();
  const toast = useToast();
  const saved = useLive(() => db.reportsSaved.toArray(), [], []);
  const [ds, setDs] = useState('lines');
  const [cols, setCols] = useState(['date', 'item', 'qty', 'amount', 'profit']);
  const [filter, setFilter] = useState('');
  const [group, setGroup] = useState('');
  const [name, setName] = useState('');
  const src = useLive(async () => {
    if (ds === 'lines') return sales.flatMap(s => s.lines.map(l => ({ date: localISO(new Date(s.ts)), bill: s.no, cashier: s.cashierName, customer: s.customerName, item: l.name, category: '', hsn: l.hsn, gst: l.gst, qty: sg(s) * l.qty, price: l.unitPrice, discount: sg(s) * (l.lineDisc + l.billDisc), taxable: sg(s) * l.taxable, tax: sg(s) * (l.cgst + l.sgst + l.igst), amount: sg(s) * l.total, cost: sg(s) * l.qty * (l.cost || 0), profit: r2(sg(s) * (l.taxable - l.qty * (l.cost || 0))), pid: l.productId })));
    if (ds === 'bills') return sales.map(s => ({ date: localISO(new Date(s.ts)), bill: s.no, type: s.type, cashier: s.cashierName, customer: s.customerName, items: s.lines.length, discount: sg(s) * (s.totals.lineDisc + s.totals.billDisc), taxable: sg(s) * s.totals.taxable, tax: sg(s) * (s.totals.cgst + s.totals.sgst + s.totals.igst), amount: sg(s) * s.totals.payable, payment: s.payments.map(x => x.mode).join('+') }));
    if (ds === 'products') { const st = await stockMap(storeId); return (await db.products.toArray()).map(p => ({ sku: p.id, item: p.name, category: p.category, brand: p.brand, gst: p.gst, mrp: p.mrp, price: p.price, cost: p.cost, stock: st[p.id] || 0, rack: p.rack })); }
    if (ds === 'purchases') { const sp = Object.fromEntries((await db.suppliers.toArray()).map(s => [s.id, s.name])); return (await db.purchases.toArray()).flatMap(x => x.lines.map(l => ({ date: x.date, purchase: x.billNo || x.no, supplier: sp[x.supplierId], item: l.name, batch: l.batchNo, expiry: l.expiry, qty: l.qty, rate: l.rate, gst: l.gst, taxable: l.taxable, tax: l.tax }))); }
    return (await db.customers.toArray()).map(c => ({ name: c.name, phone: c.phone, tier: c.yearSpend >= 75000 ? 'Platinum' : c.yearSpend >= 25000 ? 'Gold' : 'Silver', yearSpend: c.yearSpend || 0, visits: c.visits || 0, points: c.points || 0, lastVisit: c.lastVisit ? localISO(new Date(c.lastVisit)) : '' }));
  }, [ds, sales, storeId], []);
  const products = useLive(() => db.products.toArray(), [], []);
  const pcat = Object.fromEntries(products.map(p => [p.id, p.category]));
  const data = useMemo(() => {
    let rows = (src || []).map(r => (r.pid ? { ...r, category: pcat[r.pid] } : r));
    if (filter) { const f = filter.toLowerCase(); rows = rows.filter(r => Object.values(r).some(v => String(v).toLowerCase().includes(f))); }
    if (group) {
      rows = Object.entries(groupBy(rows, r => r[group])).map(([k, rs]) => {
        const o = { [group]: k, count: rs.length };
        cols.filter(c => NUMS.has(c) && c !== group).forEach(c => (o[c] = r2(sum(rs, r => r[c]))));
        return o;
      }).sort((a, b) => (b.amount ?? b.count) - (a.amount ?? a.count));
    }
    return rows.map((r, i) => ({ ...r, _id: i }));
  }, [src, filter, group, cols, pcat]);
  const shown = group ? [group, 'count', ...cols.filter(c => NUMS.has(c) && c !== group)] : cols;
  const save = async () => { if (!name) return; await db.reportsSaved.put({ id: uid('r_'), name, ds, cols, filter, group }); toast(`Saved “${name}”.`); setName(''); };
  return (
    <div className="stack">
      {saved.length > 0 && <div className="chips">{saved.map(r => <button key={r.id} className="chip" onClick={() => { setDs(r.ds); setCols(r.cols); setFilter(r.filter); setGroup(r.group); }}>{r.name}</button>)}</div>}
      <Card title="Your report">
        <div className="grid g3">
          <div className="field"><span className="field-label">Data</span><select className="input" value={ds} onChange={e => { setDs(e.target.value); setCols(DATASETS[e.target.value].cols.slice(0, 5)); setGroup(''); }} id="rb-ds">{Object.entries(DATASETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></div>
          <Input label="Only rows containing" value={filter} onChange={e => setFilter(e.target.value)} id="rb-filter" />
          <div className="field"><span className="field-label">Group and total by</span><select className="input" value={group} onChange={e => setGroup(e.target.value)} id="rb-group"><option value="">No grouping</option>{DATASETS[ds].cols.filter(c => !NUMS.has(c) || c === 'gst').map(c => <option key={c}>{c}</option>)}</select></div>
        </div>
        <div className="chips" style={{ marginTop: 12 }}>{DATASETS[ds].cols.map(c => <label key={c} className="chip check"><input type="checkbox" checked={cols.includes(c)} onChange={e => setCols(e.target.checked ? [...cols, c] : cols.filter(x => x !== c))} />{c}</label>)}</div>
        <div className="row gap-s wrap" style={{ marginTop: 12, alignItems: 'flex-end' }}>
          <Input label="Save as" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Dairy sales by day" id="rb-name" />
          <Btn onClick={save} disabled={!name}>Save report</Btn>
          <Btn kind="primary" onClick={() => exportRows(`${name || 'report'}.xlsx`, 'Report', data.map(r => Object.fromEntries(shown.map(c => [c, r[c]]))))}>Export to Excel</Btn>
        </div>
      </Card>
      <div className="card"><Table rows={data.slice(0, 500)} keyField="_id" cols={shown.map(c => ({ key: c, label: c, num: NUMS.has(c) || c === 'count', render: r => NUMS.has(c) && typeof r[c] === 'number' && !['gst', 'qty', 'items', 'visits', 'points', 'count', 'stock'].includes(c) ? inr(r[c]) : r[c] }))} />{data.length > 500 && <p className="small muted pad">Showing 500 of {data.length}. Export to see all.</p>}</div>
    </div>
  );
}
