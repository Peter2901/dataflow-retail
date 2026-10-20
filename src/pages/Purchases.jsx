import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Modal, Input, Select, Badge, Card, Tabs, Stat } from '../ui/kit.jsx';
import { inr, num, r2, sum, uid, validGSTIN, waLink, daysBetween, fmtDate } from '../lib/util.js';
import { reorderSuggestions, createPO, paySupplier } from '../lib/purchasing.js';
import { poTextLang, LANGS } from '../lib/messages.js';
import { partyBalances } from '../lib/parties.js';
import { readAny } from '../lib/excel.js';
import { DEFAULT_EXPIRY } from '../lib/stock.js';
import PurchaseBill from './PurchaseBill.jsx';

export default function Purchases() {
  const { param } = useApp();
  const [tab, setTab] = useState(param?.tab || 'bills');
  const [billDraft, setBillDraft] = useState(param?.newBill ? {} : null);
  return (
    <div className="stack">
      <PageHead title="Purchases & suppliers" sub="Supplier bills, goods receipt with batch and expiry, orders, returns and GST credit check" actions={<Btn kind="primary" onClick={() => setBillDraft({})}>New purchase bill</Btn>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'bills', label: 'Purchase bills' }, { value: 'po', label: 'Orders to suppliers' }, { value: 'suppliers', label: 'Suppliers & dues' }, { value: 'returns', label: 'Returns (debit notes)' }, { value: 'gstr2b', label: 'GST credit check (2B)' }]} />
      {tab === 'bills' && <Bills onNew={() => setBillDraft({})} />}
      {tab === 'po' && <Orders onReceive={po => setBillDraft({ fromPO: po })} />}
      {tab === 'suppliers' && <Suppliers />}
      {tab === 'returns' && <Returns />}
      {tab === 'gstr2b' && <Gstr2b />}
      {billDraft && <PurchaseBill draft={billDraft} onClose={() => setBillDraft(null)} />}
    </div>
  );
}

function Bills({ onNew }) {
  const purchases = useLive(() => db.purchases.orderBy('date').reverse().toArray(), [], null);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const [open, setOpen] = useState(null);
  return (
    <>
      <div className="card"><Table rows={purchases} onRow={setOpen} empty={<>No purchase bills yet. <Btn size="sm" onClick={onNew}>Add the first one</Btn></>} cols={[
        { label: 'Bill', render: p => <><b>{p.billNo || p.no}</b><div className="small muted">{p.no} · {p.scan ? (p.scan.method === 'ai' ? 'Smart Scan (AI)' : 'Smart Scan (free)') : p.source}</div></> },
        { label: 'Supplier', render: p => sm[p.supplierId]?.name },
        { label: 'Date', render: p => fmtDate(p.date) },
        { label: 'Items', num: true, render: p => p.lines.length },
        { label: 'Total', num: true, render: p => inr(p.total) },
        { label: 'Status', render: p => { const due = r2(p.total - (p.paid || 0)); if (due <= 0.5) return <Badge tone="ok">Paid</Badge>; const d = daysBetween(new Date(), new Date(p.dueDate)); return <Badge tone={d < 0 ? 'bad' : d <= 7 ? 'warn' : 'neutral'}>{inr(due, 0)} due {d < 0 ? `${-d}d ago` : `in ${d}d`}</Badge>; } },
      ]} /></div>
      {open && <Modal wide title={`${open.no} · ${sm[open.supplierId]?.name}`} onClose={() => setOpen(null)}>
        <Table rows={open.lines} keyField="productId" cols={[{ label: 'Item', key: 'name' }, { label: 'Batch', key: 'batchNo' }, { label: 'Expiry', key: 'expiry' }, { label: 'Qty', num: true, render: l => <>{l.qty}{l.free ? ` + ${l.free} free` : ''}{(l.pack || 1) > 1 ? ` × ${l.pack}` : ''}</> }, { label: 'Rate', num: true, render: l => <>{inr(l.rate)}{l.disc ? ` −${l.disc}%` : ''}</> }, { label: 'Cost/pc', num: true, render: l => l.landing ? inr(l.landing) : '' }, { label: 'GST', num: true, render: l => l.gst + '%' }, { label: 'Amount', num: true, render: l => inr(l.taxable + l.tax) }]} />
        <p className="right" style={{ marginTop: 8 }}>Taxable {inr(open.taxable)} · GST {inr(open.tax)} · <b>Total {inr(open.total)}</b></p>
      </Modal>}
    </>
  );
}

function Orders({ onReceive }) {
  const { storeId, settings, user } = useApp();
  const toast = useToast();
  const cfg = settings.expiry || DEFAULT_EXPIRY;
  const sugg = useLive(() => reorderSuggestions(storeId, cfg), [storeId], null);
  const pos = useLive(() => db.purchaseOrders.orderBy('date').reverse().toArray(), [], []);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const [pick, setPick] = useState({});
  const [qtys, setQtys] = useState({});
  const groups = useMemo(() => {
    const g = {};
    (sugg || []).filter(s => !s.hasOpenPO).forEach(s => (g[s.supplierId || 'none'] = g[s.supplierId || 'none'] || []).push(s));
    return g;
  }, [sugg]);
  const make = async sid => {
    const items = groups[sid].filter(s => pick[s.product.id] ?? !s.nearExpiry);
    if (!items.length) return;
    const po = await createPO({ supplier: sm[sid], user, lines: items.map(s => ({ productId: s.product.id, name: s.product.name, qty: Number(qtys[s.product.id] ?? s.qty), rate: s.product.cost, gst: s.product.gst, casePack: s.product.casePack || 1 })) });
    toast(`${po.no} drafted. Send it on WhatsApp below.`);
  };
  const approvalTier = t => t <= 50000 ? 'Auto-approved' : t <= 250000 ? 'Manager approval' : 'Owner approval';
  return (
    <div className="stack">
      <Card title="Suggested orders" actions={<span className="small muted">Based on the last 30 days of sales, supplier lead time and carton size</span>}>
        {sugg === null ? <p className="muted">Working out…</p> : !Object.keys(groups).length ? <div className="empty">Nothing needs ordering right now.</div> :
          Object.entries(groups).map(([sid, list]) => (
            <div key={sid} className="stack" style={{ marginBottom: 18 }}>
              <div className="row between wrap"><b>{sm[sid]?.name || 'No supplier set'}</b>{sm[sid] && <Btn size="sm" kind="primary" onClick={() => make(sid)}>Draft order</Btn>}</div>
              <Table rows={list} cols={[
                { label: '', key: 'chk', render: s => <input type="checkbox" checked={pick[s.product.id] ?? !s.nearExpiry} onChange={e => setPick({ ...pick, [s.product.id]: e.target.checked })} aria-label={`Include ${s.product.name}`} /> },
                { label: 'Item', render: s => <>{s.product.name}{s.nearExpiry && <div><Badge tone="warn">Old stock near expiry — reorder paused</Badge></div>}</> },
                { label: 'On hand', num: true, render: s => num(s.onHand, 2) },
                { label: 'Sells per day', num: true, render: s => num(s.daily, 1) },
                { label: 'Reorder point', num: true, key: 'rop' },
                { label: 'Order qty', num: true, render: s => <input className="input" style={{ width: 80 }} type="number" value={qtys[s.product.id] ?? s.qty} onChange={e => setQtys({ ...qtys, [s.product.id]: e.target.value })} aria-label="Order quantity" /> },
              ]} />
            </div>
          ))}
      </Card>
      <Card title="Orders sent">
        <Table rows={pos} empty="No orders yet." cols={[
          { label: 'Order', render: o => <><b>{o.no}</b><div className="small muted">{fmtDate(o.date)}</div></> },
          { label: 'Supplier', render: o => sm[o.supplierId]?.name },
          { label: 'Total', num: true, render: o => inr(o.total, 0) },
          { label: 'Approval', render: o => <span className="small">{approvalTier(o.total)}</span> },
          { label: 'Status', render: o => <Badge tone={o.status === 'received' ? 'ok' : o.status === 'sent' ? 'info' : 'accent'}>{o.status}</Badge> },
          { label: '', render: o => o.status !== 'received' && <div className="row gap-s">
            <a className="btn btn-sm" href={waLink(sm[o.supplierId]?.phone, poTextLang(o, sm[o.supplierId], settings, sm[o.supplierId]?.lang || 'en'))} target="_blank" rel="noreferrer" onClick={() => db.purchaseOrders.update(o.id, { status: 'sent' })}>Send on WhatsApp</a>
            <Btn size="sm" onClick={() => onReceive(o)}>Goods arrived</Btn></div> },
        ]} />
      </Card>
    </div>
  );
}

function Suppliers() {
  const { user } = useApp();
  const toast = useToast();
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const bal = useLive(() => partyBalances('supp'), [], {});
  const purchases = useLive(() => db.purchases.toArray(), [], []);
  const [edit, setEdit] = useState(null);
  const [pay, setPay] = useState(null);
  const owed = s => r2(-(bal[s.id] || 0));
  const totalOwed = r2(sum(suppliers, owed));
  const dueWeek = r2(sum(purchases.filter(p => p.total - (p.paid || 0) > 0.5 && daysBetween(new Date(), new Date(p.dueDate)) <= 7), p => p.total - (p.paid || 0)));
  const save = async s => {
    if (!s.name) return toast('Supplier name is needed.', 'bad');
    if (s.gstin && !validGSTIN(s.gstin)) return toast('That GSTIN does not pass the check.', 'bad');
    await db.suppliers.put({ ...s, id: s.id || uid('sp_'), stateCode: s.gstin ? s.gstin.slice(0, 2) : s.stateCode, termsDays: Number(s.termsDays) || 0, returnDays: Number(s.returnDays) || 0, leadDays: Number(s.leadDays) || 3 });
    toast('Supplier saved.'); setEdit(null);
  };
  return (
    <div className="stack">
      <div className="grid g3"><Stat label="You owe suppliers" value={inr(totalOwed, 0)} /><Stat label="Due in the next 7 days" value={inr(dueWeek, 0)} tone={dueWeek ? 'warn' : undefined} /><div className="row" style={{ justifyContent: 'flex-end' }}><Btn kind="primary" onClick={() => setEdit({ name: '', gstin: '', phone: '', termsDays: 30, returnDays: 45, leadDays: 3 })}>Add supplier</Btn></div></div>
      <div className="card"><Table rows={suppliers} cols={[
        { label: 'Supplier', render: s => <><b>{s.name}</b><div className="small muted">{s.gstin || 'No GSTIN'} · {s.phone}</div></> },
        { label: 'Pay within', render: s => `${s.termsDays} days` },
        { label: 'Return window', render: s => s.returnDays ? `${s.returnDays} days before expiry` : '—' },
        { label: 'You owe', num: true, render: s => inr(owed(s)) },
        { label: '', render: s => <div className="row gap-s"><Btn size="sm" onClick={() => setEdit({ ...s })}>Edit</Btn>{owed(s) > 0 && <Btn size="sm" kind="primary" onClick={() => setPay(s)}>Pay</Btn>}</div> },
      ]} /></div>
      {edit && <Modal title={edit.id ? 'Edit supplier' : 'New supplier'} onClose={() => setEdit(null)} footer={<><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn kind="primary" onClick={() => save(edit)}>Save</Btn></>}>
        <div className="grid g2">
          <Input label="Name" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} id="s-name" />
          <Input label="GSTIN" value={edit.gstin} onChange={e => setEdit({ ...edit, gstin: e.target.value.toUpperCase() })} id="s-gstin" />
          <Input label="WhatsApp number" value={edit.phone} onChange={e => setEdit({ ...edit, phone: e.target.value })} id="s-phone" />
          <Input label="Pay within (days)" type="number" value={edit.termsDays} onChange={e => setEdit({ ...edit, termsDays: e.target.value })} id="s-terms" />
          <Input label="Accepts returns until (days before expiry)" type="number" value={edit.returnDays} onChange={e => setEdit({ ...edit, returnDays: e.target.value })} id="s-ret" />
          <Input label="Delivery takes (days)" type="number" value={edit.leadDays} onChange={e => setEdit({ ...edit, leadDays: e.target.value })} id="s-lead" />
          <Select label="WhatsApp order language" value={edit.lang || 'en'} onChange={e => setEdit({ ...edit, lang: e.target.value })} options={LANGS} id="s-lang" />
        </div>
      </Modal>}
      {pay && <PayModal supplier={pay} owed={owed(pay)} onClose={() => setPay(null)} onPay={async (amt, mode, ref) => { await paySupplier({ supplier: pay, amount: amt, mode, ref, user }); toast(`Paid ${inr(amt)} to ${pay.name}.`); setPay(null); }} />}
    </div>
  );
}

function PayModal({ supplier, owed, onClose, onPay }) {
  const [amt, setAmt] = useState(String(owed));
  const [mode, setMode] = useState('bank');
  const [ref, setRef] = useState('');
  return (
    <Modal title={`Pay ${supplier.name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => Number(amt) > 0 && onPay(Number(amt), mode, ref)}>Record payment</Btn></>}>
      <div className="stack">
        <Input label={`Amount (owed ${inr(owed)})`} type="number" value={amt} onChange={e => setAmt(e.target.value)} id="sp-amt" />
        <Select label="Paid by" value={mode} onChange={e => setMode(e.target.value)} options={[{ value: 'bank', label: 'Bank transfer (NEFT/RTGS)' }, { value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }]} id="sp-mode" />
        <Input label="UTR / cheque number" value={ref} onChange={e => setRef(e.target.value)} id="sp-ref" />
        <p className="small muted">Paying within the supplier’s terms keeps your GST input credit safe: credit must be reversed if a bill stays unpaid for 180 days.</p>
      </div>
    </Modal>
  );
}

function Returns() {
  const { settings } = useApp();
  const dns = useLive(() => db.debitNotes.orderBy('date').reverse().toArray(), [], []);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const text = d => `*Debit note ${d.no}* from ${settings.storeName}\nDate ${d.date} · Reason: ${d.reason}\n\n${d.lines.map(l => `• ${l.name} (batch ${l.batchNo}, exp ${l.expiry}) × ${l.qty} @ ₹${l.rate}`).join('\n')}\n\nValue ₹${d.taxable} + GST ₹${d.tax} = *₹${d.total}*\nPlease arrange pickup and adjust in our account.`;
  return <div className="card"><Table rows={dns} empty="No returns yet. Near-expiry stock can be sent back from Expiry control." cols={[
    { label: 'Debit note', render: d => <><b>{d.no}</b><div className="small muted">{d.reason}</div></> },
    { label: 'Supplier', render: d => sm[d.supplierId]?.name }, { label: 'Date', render: d => fmtDate(d.date) },
    { label: 'Items', num: true, render: d => d.lines.length }, { label: 'Value', num: true, render: d => inr(d.total) },
    { label: '', render: d => <a className="btn btn-sm" href={waLink(sm[d.supplierId]?.phone, text(d))} target="_blank" rel="noreferrer">Send on WhatsApp</a> },
  ]} /></div>;
}

// GSTR-2B: what suppliers actually filed. Credit is only safe for bills that appear there.
function Gstr2b() {
  const purchases = useLive(() => db.purchases.toArray(), [], []);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const load = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    setErr('');
    try {
      const data = await readAny(f);
      let rows = [];
      if (data.json) {
        const b2b = data.json?.data?.docdata?.b2b || data.json?.docdata?.b2b || [];
        b2b.forEach(s => (s.inv || []).forEach(i => rows.push({ gstin: s.ctin, inv: String(i.inum), taxable: Number(i.txval) || 0, tax: (Number(i.igst) || 0) + (Number(i.cgst) || 0) + (Number(i.sgst) || 0) })));
      } else {
        const g = (r, ns) => { const k = Object.keys(r).find(h => ns.some(n => h.toUpperCase().includes(n))); return k ? r[k] : ''; };
        rows = data.rows.map(r => ({ gstin: String(g(r, ['GSTIN'])).trim(), inv: String(g(r, ['INVOICE NUMBER', 'INVOICE NO', 'INV'])).trim(), taxable: Number(g(r, ['TAXABLE'])) || 0, tax: (Number(g(r, ['INTEGRATED'])) || 0) + (Number(g(r, ['CENTRAL'])) || 0) + (Number(g(r, ['STATE'])) || 0) }));
      }
      const books = purchases.filter(p => sm[p.supplierId]?.gstin).map(p => ({ ...p, gstin: sm[p.supplierId].gstin }));
      const key = (g, n) => `${g}|${String(n).replace(/\s/g, '').toUpperCase()}`;
      const twoB = Object.fromEntries(rows.map(r => [key(r.gstin, r.inv), r]));
      const out = books.map(p => {
        const r = twoB[key(p.gstin, p.billNo)];
        if (!r) return { ...p, status: 'missing', note: 'Supplier has not filed this bill — hold payment or ask them to file' };
        delete twoB[key(p.gstin, p.billNo)];
        const diff = r2(r.tax - p.tax);
        return { ...p, status: Math.abs(diff) > 10 ? 'mismatch' : 'matched', note: Math.abs(diff) > 10 ? `GST differs by ${inr(diff)}` : 'Matches' };
      });
      const extra = Object.values(twoB).map(r => ({ id: r.inv, billNo: r.inv, gstin: r.gstin, tax: r.tax, total: r.taxable + r.tax, status: 'extra', note: 'In 2B but not in your books — enter the purchase bill' }));
      setRes([...out, ...extra]);
    } catch { setErr('Could not read that file. Download GSTR-2B as Excel or JSON from the GST portal and try again.'); }
  };
  const tone = { matched: 'ok', mismatch: 'warn', missing: 'bad', extra: 'info' };
  return (
    <div className="stack">
      <Card title="Match your purchase bills with GSTR-2B">
        <p className="small muted">Download GSTR-2B (Excel or JSON) from the GST portal for the month and load it here. Bills your suppliers didn’t file can’t be claimed as input credit.</p>
        <label className="btn" style={{ marginTop: 10, width: 'fit-content' }}>Load GSTR-2B file<input type="file" accept=".xlsx,.xls,.csv,.json" hidden onChange={load} /></label>
        {err && <p className="err" style={{ marginTop: 8 }}>{err}</p>}
      </Card>
      {res && <>
        <div className="grid g4">{['matched', 'mismatch', 'missing', 'extra'].map(k => <Stat key={k} label={{ matched: 'Matched', mismatch: 'Amount differs', missing: 'Not filed by supplier', extra: 'Not in your books' }[k]} value={res.filter(r => r.status === k).length} tone={k === 'missing' ? 'bad' : k === 'mismatch' ? 'warn' : undefined} />)}</div>
        <div className="card"><Table rows={res} cols={[
          { label: 'Bill', render: r => <><b>{r.billNo}</b><div className="small muted">{r.gstin}</div></> },
          { label: 'Supplier', render: r => sm[r.supplierId]?.name || '—' },
          { label: 'GST', num: true, render: r => inr(r.tax) },
          { label: 'Result', render: r => <><Badge tone={tone[r.status]}>{r.status}</Badge><div className="small muted">{r.note}</div></> },
        ]} /></div>
      </>}
    </div>
  );
}
