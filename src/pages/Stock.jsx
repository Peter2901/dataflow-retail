import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, useApprove, PageHead, Table, Btn, Input, Select, Tabs, Card, Badge, SearchBox, Modal } from '../ui/kit.jsx';
import { inr, num, r2, fmtDT, uid, sum } from '../lib/util.js';
import { moveStock, expiryZone, daysLeft, DEFAULT_EXPIRY, stockValue } from '../lib/stock.js';
import { post } from '../lib/accounts.js';
import { audit } from '../lib/sales.js';
import { unitList, breakdown, plain } from '../lib/units.js';

const REASONS = { damaged: 'Damaged / broken', expired: 'Expired', theft: 'Missing / theft', count: 'Count correction', sample: 'Free sample / own use' };

// Writing off goods: stock leaves the books, and GST input credit is reversed for lost,
// destroyed, expired or stolen goods (CGST Act s.17(5)(h)). Count corrections upward add stock back.
export async function writeOff({ batch, product, qty, reason, user, approvedBy }) {
  const value = r2(qty * batch.cost);
  await moveStock({ batchId: batch.id, productId: product.id, storeId: batch.storeId, qty: -qty, type: 'writeoff', ref: reason, note: approvedBy ? `approved by ${approvedBy}` : '' });
  const itc = reason === 'count' && qty < 0 ? 0 : r2((value * (product.gst || 0)) / 100);
  const lines = qty >= 0
    ? [{ acc: 'shrinkage', dr: r2(value + itc) }, { acc: 'inventory', cr: value }, ...(itc ? [{ acc: 'in_cgst', cr: r2(itc / 2) }, { acc: 'in_sgst', cr: r2(itc - r2(itc / 2)) }] : [])]
    : [{ acc: 'inventory', dr: -value }, { acc: 'shrinkage', cr: -value }];
  await post({ ref: 'WO-' + Date.now().toString().slice(-6), type: 'writeoff', narration: `${REASONS[reason]}: ${product.name} × ${qty}`, lines });
  await audit('write_off', { product: product.name, batch: batch.batchNo, qty, value, reason, approvedBy }, user);
}

export default function Stock() {
  const { storeId, settings, user } = useApp();
  const [tab, setTab] = useState('items');
  const cfg = settings.expiry || DEFAULT_EXPIRY;
  const products = useLive(() => db.products.toArray(), [], []);
  const batches = useLive(() => db.batches.where('storeId').equals(storeId).toArray(), [storeId], []);
  const value = useLive(() => stockValue(storeId), [storeId], 0);
  const pmap = Object.fromEntries(products.map(p => [p.id, p]));
  return (
    <div className="stack">
      <PageHead title="Stock & batches" sub={`Stock value at cost ${inr(value, 0)} · every unit is tracked by batch and expiry`} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'items', label: 'By item' }, { value: 'moves', label: 'Movements' }, { value: 'adjust', label: 'Write-off / adjust' }, { value: 'count', label: 'Physical count' }, { value: 'transfer', label: 'Transfer between stores' }]} />
      {tab === 'items' && <ByItem products={products} batches={batches} cfg={cfg} />}
      {tab === 'moves' && <Moves pmap={pmap} storeId={storeId} />}
      {tab === 'adjust' && <Adjust products={products} batches={batches} pmap={pmap} settings={settings} user={user} />}
      {tab === 'count' && <Count products={products} batches={batches} user={user} />}
      {tab === 'transfer' && <Transfer products={products} batches={batches} pmap={pmap} storeId={storeId} user={user} />}
    </div>
  );
}

function ByItem({ products, batches, cfg }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => products.filter(p => !q || p.name.toLowerCase().includes(q.toLowerCase())).map(p => {
    const bs = batches.filter(b => b.productId === p.id && b.status === 'active');
    const qty = Math.round(sum(bs, b => b.qty) * 1000) / 1000;
    const next = bs.filter(b => b.qty > 0 && b.expiry).sort((a, b) => a.expiry.localeCompare(b.expiry))[0];
    return { ...p, qty, value: r2(sum(bs.filter(b => b.qty > 0), b => b.qty * b.cost)), batchCount: bs.filter(b => b.qty > 0).length, next };
  }).sort((a, b) => a.name.localeCompare(b.name)), [products, batches, q]);
  return (
    <div className="stack">
      <SearchBox value={q} onChange={setQ} placeholder="Search item" />
      <div className="card"><Table rows={rows} onRow={setOpen} cols={[
        { label: 'Item', render: p => <><b>{p.name}</b><div className="small muted">{p.rack}</div></> },
        { label: 'On hand', num: true, render: p => <span style={{ color: p.qty < 0 ? 'var(--bad)' : p.qty <= p.reorderMin ? 'var(--warn)' : undefined }}>{unitList(p).length ? <>{breakdown(p, p.qty)}<div className="small muted">{plain(p.qty)} {p.uom}</div></> : <>{num(p.qty, 2)} {p.uom}</>}</span> },
        { label: 'Batches', num: true, key: 'batchCount' },
        { label: 'Next expiry', render: p => p.next ? <Badge tone={expiryZone(daysLeft(p.next.expiry), cfg).tone}>{p.next.expiry}</Badge> : '—' },
        { label: 'Value at cost', num: true, render: p => inr(p.value, 0) },
      ]} /></div>
      {open && (
        <Modal wide title={open.name} onClose={() => setOpen(null)}>
          <Table rows={batches.filter(b => b.productId === open.id).sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))} cols={[
            { label: 'Batch', key: 'batchNo' }, { label: 'Expiry', render: b => b.expiry || '—' },
            { label: 'Status', render: b => b.status !== 'active' ? <Badge tone="bad">{b.status}</Badge> : <Badge tone={expiryZone(daysLeft(b.expiry), cfg).tone}>{expiryZone(daysLeft(b.expiry), cfg).label}</Badge> },
            { label: 'Qty', num: true, render: b => unitList(open).length ? <>{breakdown(open, b.qty)}<div className="small muted">{plain(b.qty)} {open.uom}</div></> : num(b.qty, 2) }, { label: 'Cost', num: true, render: b => inr(b.cost) }, { label: 'Received', render: b => fmtDT(b.receivedAt) },
          ]} />
        </Modal>
      )}
    </div>
  );
}

function Moves({ pmap, storeId }) {
  const moves = useLive(async () => (await db.stockMoves.where('storeId').equals(storeId).reverse().sortBy('ts')).slice(0, 300), [storeId], null);
  return <div className="card"><Table rows={moves} cols={[
    { label: 'When', render: m => fmtDT(m.ts) }, { label: 'Item', render: m => pmap[m.productId]?.name || m.productId },
    { label: 'Type', render: m => <Badge tone={m.qty > 0 ? 'ok' : 'neutral'}>{m.type}</Badge> }, { label: 'Ref', key: 'ref' },
    { label: 'Qty', num: true, render: m => (m.qty > 0 ? '+' : '') + num(m.qty, 3) },
  ]} /></div>;
}

function Adjust({ products, batches, pmap, settings, user }) {
  const toast = useToast();
  const approve = useApprove();
  const [pid, setPid] = useState('');
  const [bid, setBid] = useState('');
  const [qty, setQty] = useState('');
  const [reason, setReason] = useState('damaged');
  const bs = batches.filter(b => b.productId === pid && b.status === 'active');
  const batch = bs.find(b => b.id === bid);
  const value = batch ? r2(Number(qty) * batch.cost) : 0;
  const submit = async e => {
    e.preventDefault();
    if (!batch || !Number(qty)) return;
    let approvedBy = null;
    if (Math.abs(value) > (settings.writeOffLimit || 10000) || reason === 'theft') {
      const m = await approve(`Write off ${pmap[pid].name} × ${qty} worth ${inr(value)} (${REASONS[reason]})`);
      if (!m) return;
      approvedBy = m.name;
    }
    await writeOff({ batch, product: pmap[pid], qty: Number(qty), reason, user, approvedBy });
    toast(`Written off ${qty} × ${pmap[pid].name}. GST input credit reversed where needed.`);
    setQty('');
  };
  return (
    <Card title="Remove damaged, expired or missing stock">
      <form className="grid g3" onSubmit={submit}>
        <Select label="Item" value={pid} onChange={e => { setPid(e.target.value); setBid(''); }} options={[{ value: '', label: 'Choose item' }, ...products.map(p => ({ value: p.id, label: p.name }))]} id="adj-p" />
        <Select label="Batch" value={bid} onChange={e => setBid(e.target.value)} options={[{ value: '', label: 'Choose batch' }, ...bs.map(b => ({ value: b.id, label: `${b.batchNo} · exp ${b.expiry || '—'} · ${num(b.qty, 2)} on hand` }))]} id="adj-b" />
        <Select label="Reason" value={reason} onChange={e => setReason(e.target.value)} options={Object.entries(REASONS).map(([v, l]) => ({ value: v, label: l }))} id="adj-r" />
        <Input label="Quantity to remove (negative to add back)" type="number" step="0.001" value={qty} onChange={e => setQty(e.target.value)} id="adj-q" />
        <div className="field"><span className="field-label">Value at cost</span><b className="mono" style={{ paddingTop: 8 }}>{inr(value)}</b></div>
        <div className="field" style={{ justifyContent: 'flex-end' }}><Btn kind="primary" type="submit" disabled={!batch || !Number(qty)}>Write off</Btn></div>
      </form>
      <p className="small muted" style={{ marginTop: 10 }}>Above {inr(settings.writeOffLimit || 10000, 0)}, or for missing stock, a manager must approve. Every write-off is in the audit log.</p>
    </Card>
  );
}

function Count({ products, batches, user }) {
  const toast = useToast();
  const [counts, setCounts] = useState({});
  const [cat, setCat] = useState('');
  const cats = [...new Set(products.map(p => p.category))].sort();
  const list = products.filter(p => !cat || p.category === cat);
  const sys = id => r2(sum(batches.filter(b => b.productId === id && b.status === 'active'), b => b.qty));
  const diffs = list.filter(p => counts[p.id] !== undefined && counts[p.id] !== '' && Number(counts[p.id]) !== sys(p.id));
  const apply = async () => {
    for (const p of diffs) {
      const d = r2(Number(counts[p.id]) - sys(p.id));
      const bs = batches.filter(b => b.productId === p.id && b.status === 'active').sort((a, b) => String(b.expiry).localeCompare(String(a.expiry)));
      const b = bs[0];
      if (!b) continue;
      await writeOff({ batch: b, product: p, qty: -d, reason: 'count', user });
    }
    await audit('stock_count', { items: diffs.length }, user);
    toast(`Stock corrected for ${diffs.length} items.`); setCounts({});
  };
  return (
    <div className="stack">
      <div className="row gap-s wrap"><select className="input" style={{ width: 220 }} value={cat} onChange={e => setCat(e.target.value)} aria-label="Category"><option value="">All categories</option>{cats.map(c => <option key={c}>{c}</option>)}</select>
        <Btn kind="primary" disabled={!diffs.length} onClick={apply}>Apply {diffs.length} corrections</Btn></div>
      <div className="card"><Table rows={list} cols={[
        { label: 'Item', render: p => <>{p.name}<div className="small muted">{p.rack}</div></> },
        { label: 'System', num: true, render: p => num(sys(p.id), 2) },
        { label: 'Counted', num: true, render: p => <input className="input" style={{ width: 100 }} type="number" value={counts[p.id] ?? ''} onChange={e => setCounts({ ...counts, [p.id]: e.target.value })} aria-label={`Counted ${p.name}`} /> },
        { label: 'Difference', num: true, render: p => counts[p.id] === undefined || counts[p.id] === '' ? '' : <span style={{ color: Number(counts[p.id]) < sys(p.id) ? 'var(--bad)' : 'var(--ok)' }}>{num(Number(counts[p.id]) - sys(p.id), 2)}</span> },
      ]} /></div>
    </div>
  );
}

function Transfer({ products, batches, pmap, storeId, user }) {
  const toast = useToast();
  const stores = useLive(() => db.stores.toArray(), [], []);
  const [to, setTo] = useState('');
  const [bid, setBid] = useState('');
  const [qty, setQty] = useState('');
  const bs = batches.filter(b => b.status === 'active' && b.qty > 0);
  const batch = bs.find(b => b.id === bid);
  const go = async e => {
    e.preventDefault();
    const q = Number(qty);
    if (!batch || !to || !(q > 0) || q > batch.qty) return;
    const ref = 'STO-' + Date.now().toString().slice(-6);
    await moveStock({ batchId: batch.id, productId: batch.productId, storeId, qty: -q, type: 'transfer_out', ref });
    const nid = uid('b_');
    await db.batches.add({ ...batch, id: nid, storeId: to, qty: 0, receivedAt: Date.now() });
    await moveStock({ batchId: nid, productId: batch.productId, storeId: to, qty: q, type: 'transfer_in', ref });
    await audit('transfer', { product: pmap[batch.productId]?.name, qty: q, from: storeId, to }, user);
    toast(`Moved ${q} × ${pmap[batch.productId]?.name} to ${stores.find(s => s.id === to)?.name}. Batch and expiry go with it.`);
    setQty('');
  };
  void products;
  return (
    <Card title="Send stock to another store">
      <form className="grid g3" onSubmit={go}>
        <Select label="Batch" value={bid} onChange={e => setBid(e.target.value)} options={[{ value: '', label: 'Choose batch' }, ...bs.map(b => ({ value: b.id, label: `${pmap[b.productId]?.name} · ${b.batchNo} · ${num(b.qty, 2)}` }))]} id="tr-b" />
        <Select label="To store" value={to} onChange={e => setTo(e.target.value)} options={[{ value: '', label: 'Choose store' }, ...stores.filter(s => s.id !== storeId).map(s => ({ value: s.id, label: s.name }))]} id="tr-to" />
        <Input label="Quantity" type="number" value={qty} onChange={e => setQty(e.target.value)} id="tr-q" />
        <div><Btn kind="primary" type="submit" disabled={!batch || !to || !(Number(qty) > 0) || Number(qty) > (batch?.qty || 0)}>Transfer</Btn></div>
      </form>
      <p className="small muted" style={{ marginTop: 10 }}>Goods moving between stores in different states need an e-way bill and a tax invoice; within one GSTIN it’s a delivery challan.</p>
    </Card>
  );
}
