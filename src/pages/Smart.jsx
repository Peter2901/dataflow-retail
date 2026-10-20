import React, { useMemo, useState } from 'react';
import { db, setSetting } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Card, Tabs, Badge, Stat, Modal, Input } from '../ui/kit.jsx';
import { inr, num, waLink, upiLink, fmtDate, uid } from '../lib/util.js';
import { morningTodo, clearancePlan, deadStock, festivalPlan, staffAlerts, customerHabits, udhaarPlan, weeklyReport, weeklyText } from '../lib/insights.js';
import { udhaarText, winbackText, rationText, LANGS } from '../lib/messages.js';
import { createPO } from '../lib/purchasing.js';
import { audit } from '../lib/sales.js';
import { readKhataPhoto, importCustomerDues } from '../lib/khata.js';
import { DEFAULT_EXPIRY } from '../lib/stock.js';

const TABS = [
  { value: 'todo', label: 'To-do today' }, { value: 'expiry', label: 'Expiry & dead stock' }, { value: 'festivals', label: 'Festivals' },
  { value: 'staff', label: 'Staff alerts' }, { value: 'customers', label: 'Customers' }, { value: 'udhaar', label: 'Udhaar recovery' }, { value: 'weekly', label: 'Weekly report' },
];

export default function Smart() {
  const { param, settings } = useApp();
  const [tab, setTab] = useState(param?.tab || 'todo');
  const lang = settings.msgLang || 'en';
  return (
    <div className="stack">
      <PageHead title="Smart insights" sub="Worked out from your own data on this device — free and offline. Biggest money first."
        actions={<label className="row gap-s small">Messages in <select className="input" style={{ width: 120 }} value={lang} onChange={e => setSetting('msgLang', e.target.value)} aria-label="Message language">{LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select></label>} />
      <Tabs value={tab} onChange={setTab} tabs={TABS} />
      {tab === 'todo' && <Todo />}
      {tab === 'expiry' && <ExpiryDead />}
      {tab === 'festivals' && <Festivals />}
      {tab === 'staff' && <Staff />}
      {tab === 'customers' && <CustomersTab lang={lang} />}
      {tab === 'udhaar' && <Udhaar lang={lang} />}
      {tab === 'weekly' && <Weekly />}
    </div>
  );
}

export function TodoList({ limit = 50 }) {
  const { storeId, go } = useApp();
  const list = useLive(() => morningTodo(storeId), [storeId], null);
  if (!list) return <p className="muted">Working out…</p>;
  if (!list.length) return <div className="empty">Nothing urgent today.</div>;
  return (
    <ol className="todo">{list.slice(0, limit).map((t, i) => (
      <li key={i}><span className="grow">{t.text}</span>{t.money >= 1000 && <Badge tone="accent">{inr(t.money, 0)}</Badge>}<Btn size="sm" onClick={() => go(t.page, t.param || null)}>Open</Btn></li>
    ))}</ol>
  );
}

function Todo() {
  return <Card title="What to do today" actions={<span className="small muted">Ranked by money at stake</span>}><TodoList /></Card>;
}

function ExpiryDead() {
  const { storeId, settings, go } = useApp();
  const plan = useLive(() => clearancePlan(storeId, settings.expiry || DEFAULT_EXPIRY), [storeId], null);
  const dead = useLive(() => deadStock(storeId), [storeId], null);
  const tone = { return: 'ok', discount: 'warn', writeoff: 'bad' };
  return (
    <div className="stack">
      <Card title="Will not sell before expiry" actions={<Btn size="sm" onClick={() => go('expiry')}>Open Expiry control</Btn>}>
        {!plan ? <p className="muted">Working out…</p> : !plan.length ? <div className="empty">Everything should sell before it expires.</div> :
          <Table rows={plan.map((x, i) => ({ ...x, id: i }))} cols={[
            { label: 'Item', render: x => <><b>{x.product.name}</b><div className="small muted">Batch {x.batch.batchNo} · {x.dl < 0 ? 'expired' : `${x.dl} days left`}</div></> },
            { label: 'Unsold', num: true, render: x => num(x.unsold, 2) },
            { label: 'Do this', render: x => <><Badge tone={tone[x.action]}>{x.action === 'return' ? 'Return' : x.action === 'discount' ? `${x.pct}% off` : 'Write off'}</Badge><div className="small">{x.text}</div></> },
            { label: 'Saves', num: true, render: x => x.saves ? inr(x.saves, 0) : '—' },
          ]} />}
      </Card>
      <Card title="Not selling for 60+ days" actions={<Btn size="sm" onClick={() => go('offers')}>Make an offer</Btn>}>
        {!dead ? <p className="muted">Working out…</p> : !dead.length ? <div className="empty">No dead stock.</div> : <>
          <p className="small muted">{dead.length} items · {inr(dead.reduce((a, d) => a + d.value, 0), 0)} of money stuck at cost.</p>
          <Table rows={dead.map(d => ({ ...d, id: d.product.id }))} cols={[
            { label: 'Item', render: d => <><b>{d.product.name}</b><div className="small muted">{d.product.category} · no sale in {d.days}+ days</div></> },
            { label: 'Stock', num: true, render: d => num(d.qty, 2) },
            { label: 'Money stuck', num: true, render: d => inr(d.value, 0) },
            { label: 'Ideas', render: d => <ul className="issues">{d.ideas.map((t, i) => <li key={i} className="info">• {t}</li>)}</ul> },
          ]} /></>}
      </Card>
    </div>
  );
}

function Festivals() {
  const { storeId, settings, user } = useApp();
  const toast = useToast();
  const [ahead, setAhead] = useState(45);
  const [add, setAdd] = useState(null);
  const plans = useLive(() => festivalPlan(storeId, ahead), [storeId, ahead, settings.festivals], null);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const draft = async f => {
    const bySup = {};
    f.items.filter(i => i.order > 0).forEach(i => (bySup[i.product.vendorId || ''] = bySup[i.product.vendorId || ''] || []).push(i));
    let n = 0;
    for (const [sid, items] of Object.entries(bySup)) {
      const sup = suppliers.find(s => s.id === sid); if (!sup) continue;
      await createPO({ supplier: sup, user, lines: items.map(i => ({ productId: i.product.id, name: i.product.name, qty: Math.ceil(i.order / (i.product.casePack || 1)) * (i.product.casePack || 1), rate: i.product.cost, gst: i.product.gst, casePack: i.product.casePack || 1 })) });
      n++;
    }
    toast(n ? `${n} order(s) drafted. Send them from Purchases › Orders to suppliers.` : 'These items have no main supplier set. Set it in Products.', n ? 'ok' : 'warn');
  };
  const saveOwn = async () => {
    if (!add.name || !add.date) return toast('Name and date are needed.', 'bad');
    const list = [...(settings.festivals || []), { id: add.id || 'own_' + uid(), name: add.name, date: add.date, keys: String(add.keys || '').split(',').map(x => x.trim()).filter(Boolean) }];
    await setSetting('festivals', list); setAdd(null); toast('Festival saved.');
  };
  return (
    <div className="stack">
      <div className="row gap-s wrap"><span className="small muted">Festivals in the next</span>
        <select className="input" style={{ width: 110 }} value={ahead} onChange={e => setAhead(Number(e.target.value))} aria-label="Days ahead"><option value={30}>30 days</option><option value={45}>45 days</option><option value={90}>90 days</option><option value={180}>6 months</option></select>
        <span className="grow" /><Btn size="sm" onClick={() => setAdd({ name: '', date: '', keys: '' })}>Add / correct a festival date</Btn></div>
      {!plans ? <p className="muted">Working out…</p> : !plans.length ? <div className="empty">No festival in this period.</div> : plans.map(f => (
        <Card key={f.festival.id + f.date} title={`${f.festival.name} — ${fmtDate(f.date)} (in ${f.inDays} days)`} actions={f.items.some(i => i.order > 0) && <Btn size="sm" kind="primary" onClick={() => draft(f)}>Draft supplier orders</Btn>}>
          <p className="small muted">{f.basis === 'lastyear' ? 'Based on what sold more around this festival last year.' : 'No sales history for last year’s festival yet — showing the items usually bought for it.'}</p>
          {!f.items.length ? <div className="empty">No matching items in your product list.</div> :
            <Table rows={f.items.slice(0, 40).map(i => ({ ...i, id: i.product.id }))} cols={[
              { label: 'Item', render: i => i.product.name },
              { label: 'Last year', num: true, render: i => i.lastYearQty != null ? <>{num(i.lastYearQty)}<div className="small muted">{i.times}× usual</div></> : '—' },
              { label: 'On hand', num: true, render: i => num(i.onHand, 2) },
              { label: 'Order', num: true, render: i => i.order ? <b>{num(i.order)}</b> : <span className="muted">enough</span> },
            ]} />}
        </Card>
      ))}
      {add && <Modal title="Add or correct a festival" onClose={() => setAdd(null)} footer={<><Btn onClick={() => setAdd(null)}>Cancel</Btn><Btn kind="primary" onClick={saveOwn}>Save</Btn></>}>
        <div className="stack">
          <Input label="Festival name (same name as in the list corrects its date)" value={add.name} onChange={e => setAdd({ ...add, name: e.target.value })} id="fe-name" />
          <Input label="Date" type="date" value={add.date} onChange={e => setAdd({ ...add, date: e.target.value })} id="fe-date" />
          <Input label="Items people buy (words, comma separated)" value={add.keys} onChange={e => setAdd({ ...add, keys: e.target.value })} placeholder="sweet, ghee, coconut" id="fe-keys" />
        </div>
      </Modal>}
    </div>
  );
}

function Staff() {
  const { storeId } = useApp();
  const s = useLive(() => staffAlerts(storeId), [storeId], null);
  if (!s) return <p className="muted">Working out…</p>;
  return (
    <div className="stack">
      <Card title="Alerts (last 30 days)">
        {!s.alerts.length ? <div className="empty">No unusual pattern. Good.</div> : <ul className="issues">{s.alerts.map((a, i) => <li key={i} className="warn">⚠ {a.text}</li>)}</ul>}
        <p className="small muted" style={{ marginTop: 8 }}>These are patterns to check, not proof of wrongdoing. Look at the bills and the CCTV first.</p>
      </Card>
      <Card title="By person">
        <Table rows={s.people.map(p => ({ ...p, id: p.name }))} cols={[
          { label: 'Person', key: 'name' }, { label: 'Bills', num: true, key: 'bills' },
          { label: 'Returns', num: true, render: p => `${p.returns}${p.returnValue ? ` (${inr(p.returnValue, 0)})` : ''}` },
          { label: 'Price changes', num: true, render: p => p.risky.price_override || 0 },
          { label: 'Bills cancelled', num: true, render: p => p.risky.bill_cancel || 0 },
          { label: 'Drawer opened', num: true, render: p => p.risky.drawer_open || 0 },
        ]} />
      </Card>
    </div>
  );
}

function CustomersTab({ lang }) {
  const { storeId, settings } = useApp();
  const h = useLive(() => customerHabits(storeId), [storeId], null);
  if (!h) return <p className="muted">Working out…</p>;
  const can = c => c.phone && c.phone !== '0000000000' && c.consentWhatsApp !== false;
  return (
    <div className="stack">
      <Card title="Regulars not seen lately">
        {!h.notSeen.length ? <div className="empty">All your regular customers are coming as usual.</div> :
          <Table rows={h.notSeen.map(x => ({ ...x, id: x.customer.id }))} cols={[
            { label: 'Customer', render: x => <><b>{x.customer.name}</b><div className="small muted">usually every {x.avgGap} days · {x.visits} visits</div></> },
            { label: 'Last seen', num: true, render: x => `${x.since} days ago` },
            { label: 'Spent (200 days)', num: true, render: x => inr(x.spend, 0) },
            { label: '', render: x => can(x.customer) ? <a className="btn btn-sm" target="_blank" rel="noreferrer" href={waLink(x.customer.phone, winbackText({ lang, name: x.customer.name.split(' ')[0], store: settings.storeName, pct: x.spend > 5000 ? 5 : 0 }))}>WhatsApp</a> : <span className="small muted">no consent</span> },
          ]} />}
      </Card>
      <Card title="Monthly items due now">
        {!h.ration.length ? <div className="empty">No regular purchase is due in the next 2 days.</div> :
          <Table rows={h.ration.map(x => ({ ...x, id: x.customer.id }))} cols={[
            { label: 'Customer', render: x => <b>{x.customer.name}</b> },
            { label: 'Usually buys', render: x => x.items.map(i => `${i.product.name} (every ${i.every} days)`).join(', ') },
            { label: '', render: x => can(x.customer) ? <a className="btn btn-sm" target="_blank" rel="noreferrer" href={waLink(x.customer.phone, rationText({ lang, name: x.customer.name.split(' ')[0], store: settings.storeName, items: x.items.map(i => i.product.name).join(', ') }))}>Remind</a> : <span className="small muted">no consent</span> },
          ]} />}
      </Card>
    </div>
  );
}

function Udhaar({ lang }) {
  const { settings, user } = useApp();
  const toast = useToast();
  const plan = useLive(() => udhaarPlan(), [], null);
  const [khata, setKhata] = useState(null);
  const [busy, setBusy] = useState('');
  const text = (u, level) => {
    const link = settings.upiVpa ? `${settings.upiVpa} — ${upiLink({ vpa: settings.upiVpa, name: settings.upiName || settings.storeName, amount: u.due, note: 'Dues ' + u.customer.name })}` : '';
    return udhaarText({ lang, name: u.customer.name.split(' ')[0], store: settings.storeName, amount: u.due, days: u.age, level, upiLink: link });
  };
  const loadKhata = async (e, forceAI = false) => {
    const f = e.target?.files?.[0] || khata?.file; if (!f) return;
    setBusy('Reading…');
    try { const r = await readKhataPhoto(f, { forceAI, onStep: setBusy }); setKhata({ file: f, rows: r.rows.map((x, i) => ({ ...x, id: i })), method: r.method }); if (!r.rows.length) toast('No names with amounts found. Try a clearer photo, or read with AI.', 'warn'); }
    catch (err) { toast(err.message, 'bad'); }
    setBusy('');
  };
  const saveKhata = async () => { const n = await importCustomerDues(khata.rows.filter(r => r.name && r.amount > 0), user, 'KHATA'); toast(`${n} customer dues added from the khata.`); setKhata(null); };
  return (
    <div className="stack">
      <Card title="Who to remind first" actions={<label className="btn btn-sm">📷 Import paper khata photo<input type="file" accept="image/*" hidden onChange={loadKhata} /></label>}>
        {busy && <p className="small muted">{busy}</p>}
        {!plan ? <p className="muted">Working out…</p> : !plan.length ? <div className="empty">Nobody owes you money.</div> :
          <Table rows={plan.map(u => ({ ...u, id: u.customer.id }))} cols={[
            { label: 'Customer', render: u => <><b>{u.customer.name}</b><div className="small muted">{u.reminders} reminder(s) sent{u.sinceLast != null ? `, last ${u.sinceLast} day(s) ago` : ''}</div></> },
            { label: 'Owes', num: true, render: u => inr(u.due, 0) },
            { label: 'Oldest', num: true, render: u => `${u.age} days` },
            { label: 'Next step', render: u => <span className="small">{u.next}</span> },
            { label: '', render: u => u.level === 'call' ? <a className="btn btn-sm" href={`tel:${u.customer.phone}`}>Call</a> : u.level === 'wait' ? null :
              <a className="btn btn-sm" target="_blank" rel="noreferrer" href={waLink(u.customer.phone, text(u, u.level))} onClick={() => audit('udhaar_reminder', { customerId: u.customer.id, customer: u.customer.name, level: u.level, amount: u.due }, user)}>{u.level === 'firm' ? 'Firm reminder' : 'Remind'}</a> },
          ]} />}
      </Card>
      {khata && <Modal wide title={`Khata page — ${khata.rows.length} row(s) read ${khata.method === 'ai' ? 'with AI' : 'on this device'}`} onClose={() => setKhata(null)} footer={<>
        <Btn onClick={() => loadKhata({}, true)}>Read again with AI</Btn><Btn onClick={() => setKhata(null)}>Cancel</Btn><Btn kind="primary" onClick={saveKhata} disabled={!khata.rows.length}>Add these dues</Btn></>}>
        <p className="small muted">Check every name and amount against the book. Wrong rows: fix or clear the amount.</p>
        <div className="table-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Phone</th><th className="num">Owes (₹)</th></tr></thead><tbody>
          {khata.rows.map(r => <tr key={r.id}>
            <td><input className="input" value={r.name} onChange={e => setKhata(k => ({ ...k, rows: k.rows.map(x => x.id === r.id ? { ...x, name: e.target.value } : x) }))} aria-label="Name" /></td>
            <td><input className="input" value={r.phone} onChange={e => setKhata(k => ({ ...k, rows: k.rows.map(x => x.id === r.id ? { ...x, phone: e.target.value } : x) }))} aria-label="Phone" /></td>
            <td><input className="input" type="number" value={r.amount} onChange={e => setKhata(k => ({ ...k, rows: k.rows.map(x => x.id === r.id ? { ...x, amount: Number(e.target.value) } : x) }))} aria-label="Amount" /></td>
          </tr>)}</tbody></table></div>
      </Modal>}
    </div>
  );
}

function Weekly() {
  const { storeId, settings } = useApp();
  const toast = useToast();
  const w = useLive(() => weeklyReport(storeId), [storeId], null);
  const text = useMemo(() => (w ? weeklyText(w, settings.storeName) : ''), [w, settings.storeName]);
  if (!w) return <p className="muted">Working out…</p>;
  const ch = w.prevSales ? Math.round(((w.sales - w.prevSales) / w.prevSales) * 100) : null;
  return (
    <div className="stack">
      <div className="grid g4">
        <Stat label="Sales, last 7 days" value={inr(w.sales, 0)} sub={ch !== null ? `${ch >= 0 ? '+' : ''}${ch}% vs week before` : ''} tone={ch < 0 ? 'warn' : undefined} />
        <Stat label="Profit (estimate)" value={inr(w.profit, 0)} /><Stat label="Bills" value={num(w.bills)} /><Stat label="Udhaar to collect" value={inr(w.dues, 0)} />
      </div>
      <Card title="Report to share" actions={<><Btn size="sm" onClick={() => navigator.clipboard?.writeText(text).then(() => toast('Copied.'))}>Copy</Btn><a className="btn btn-sm btn-primary" target="_blank" rel="noreferrer" href={`https://wa.me/?text=${encodeURIComponent(text)}`}>Share on WhatsApp</a></>}>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', fontSize: 13, margin: 0 }}>{text}</pre>
      </Card>
    </div>
  );
}
