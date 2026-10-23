import React from 'react';
import { db } from '../db.js';
import { useApp, useLive, Stat, Card, Badge, Table, Btn, PageHead, Bar } from '../ui/kit.jsx';
import { LineChart } from '../ui/Chart.jsx';
import { inr, num, r2, sum, dayStart, addDays, waLink, daysBetween, fmtDT, localISO } from '../lib/util.js';
import { expiryZone, daysLeft, stockMap, DEFAULT_EXPIRY } from '../lib/stock.js';
import { partyBalances } from '../lib/parties.js';
import { dailySummary } from '../lib/insights.js';
import { summaryText, LANGS } from '../lib/messages.js';
import { TodoList } from './Smart.jsx';
import { setSetting } from '../db.js';
import { counterStatus } from '../lib/sync.js';

export async function dashboardData(storeId, cfg) {
  const today0 = dayStart();
  // Last 14 days only (ts index) — the trend chart needs no more.
  const sales = await db.sales.where('ts').above(dayStart(addDays(new Date(), -14))).filter(s => s.storeId === storeId).toArray();
  const sign = s => (s.type === 'return' ? -1 : 1);
  const todays = sales.filter(s => s.ts >= today0);
  const yday = sales.filter(s => s.ts >= today0 - 86400000 && s.ts < today0);
  const total = arr => r2(sum(arr, s => sign(s) * s.totals.payable));
  const profit = arr => r2(sum(arr, s => sign(s) * sum(s.lines, l => l.taxable - l.qty * (l.cost || 0))));
  const byMode = {};
  todays.forEach(s => s.payments.forEach(p => (byMode[p.mode] = r2((byMode[p.mode] || 0) + sign(s) * p.amount))));
  const trend = [];
  for (let i = 13; i >= 0; i--) {
    const d0 = dayStart(addDays(new Date(), -i)), d1 = d0 + 86400000;
    trend.push({ label: new Date(d0).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }), value: total(sales.filter(s => s.ts >= d0 && s.ts < d1)) });
  }
  const items = {};
  todays.filter(s => s.type === 'sale').forEach(s => s.lines.forEach(l => { items[l.name] = items[l.name] || { name: l.name, qty: 0, amt: 0 }; items[l.name].qty += l.qty; items[l.name].amt += l.total; }));
  const top = Object.values(items).sort((a, b) => b.amt - a.amt).slice(0, 5);

  const products = await db.products.toArray();
  const stock = await stockMap(storeId);
  const low = products.filter(p => p.active !== false && (stock[p.id] || 0) <= p.reorderMin).map(p => ({ ...p, onHand: stock[p.id] || 0 })).sort((a, b) => a.onHand - b.onHand);
  const batches = (await db.batches.where('storeId').equals(storeId).toArray()).filter(b => b.status === 'active' && b.qty > 0);
  const pmap = Object.fromEntries(products.map(p => [p.id, p]));
  const exp = batches.map(b => ({ ...b, dl: daysLeft(b.expiry), p: pmap[b.productId] })).filter(b => b.dl <= 30).sort((a, b) => a.dl - b.dl);
  const expired = exp.filter(b => b.dl < 0);
  const cust = await partyBalances('cust');
  const supp = await partyBalances('supp');
  const custDue = r2(sum(Object.values(cust).filter(v => v > 0)));
  const purchases = await db.purchases.toArray();
  const suppDueWeek = r2(sum(purchases.filter(p => p.total - (p.paid || 0) > 0.5 && daysBetween(new Date(), new Date(p.dueDate)) <= 7), p => p.total - (p.paid || 0)));
  const orders = await db.orders.where('status').anyOf('new', 'packing', 'ready').toArray();
  const today = localISO(new Date());
  const followups = (await db.followups.toArray()).filter(f => !f.done && f.due <= today);
  const shiftsOpen = (await db.shifts.toArray()).filter(s => !s.closedAt && s.storeId === storeId);
  void cfg; void supp;
  return {
    sales: total(todays), bills: todays.filter(s => s.type === 'sale').length, yday: total(yday), profit: profit(todays),
    avg: todays.length ? r2(total(todays) / Math.max(1, todays.filter(s => s.type === 'sale').length)) : 0,
    byMode, trend, top, low, exp, expired, custDue, suppDueWeek, orders, followups, shiftsOpen,
    expValue: r2(sum(exp.filter(b => b.dl >= 0), b => b.qty * b.cost)), expiredValue: r2(sum(expired, b => b.qty * b.cost)),
  };
}

export default function Dashboard() {
  const { settings, storeId, go, user } = useApp();
  const cfg = settings.expiry || DEFAULT_EXPIRY;
  const d = useLive(() => dashboardData(storeId, cfg), [storeId], null);
  if (!d) return <p className="muted">Loading…</p>;
  const change = d.yday ? Math.round(((d.sales - d.yday) / d.yday) * 100) : null;
  const summary = `*${settings.storeName} — today so far*\nSales: ${inr(d.sales)} (${d.bills} bills)\nProfit (est.): ${inr(d.profit)}\nCash ${inr(d.byMode.cash || 0)} · UPI ${inr(d.byMode.upi || 0)} · Card ${inr(d.byMode.card || 0)} · Credit ${inr(d.byMode.credit || 0)}\nExpiring in 30 days: ${d.exp.length} batches\nItems to reorder: ${d.low.length}\nCustomer dues: ${inr(d.custDue)}`;
  const maxTop = Math.max(1, ...d.top.map(t => t.amt));
  return (
    <div className="stack">
      <PageHead title={`Good ${new Date().getHours() < 12 ? 'morning' : new Date().getHours() < 17 ? 'afternoon' : 'evening'}, ${user.name}`}
        sub={`${settings.storeName} · ${new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}`}
        actions={<a className="btn" href={waLink(settings.ownerPhone || '', summary)} target="_blank" rel="noreferrer">Send today’s summary on WhatsApp</a>} />
      {settings.sampleData && <div className="note">You’re looking at <b>sample data</b>. Load your real product list in Import & setup, then clear the samples in Settings.</div>}
      <SmartCards />

      <div className="grid g4">
        <Stat label="Sales today" value={inr(d.sales, 0)} sub={change == null ? `${d.bills} bills` : `${d.bills} bills · ${change >= 0 ? '+' : ''}${change}% vs yesterday`} />
        <Stat label="Profit today (est.)" value={inr(d.profit, 0)} sub={d.sales ? `${Math.round((d.profit / d.sales) * 100)}% margin` : 'No bills yet'} />
        <Stat label="Average bill" value={inr(d.avg, 0)} sub={`UPI ${inr(d.byMode.upi || 0, 0)} · Cash ${inr(d.byMode.cash || 0, 0)}`} />
        <Stat label="Customers owe you" value={inr(d.custDue, 0)} sub={`Suppliers due this week ${inr(d.suppDueWeek, 0)}`} tone={d.custDue > 0 ? 'warn' : undefined} />
      </div>

      <div className="grid g3">
        <Stat label="Expired on shelf" value={d.expired.length} sub={d.expired.length ? `${inr(d.expiredValue, 0)} at cost · remove now` : 'None'} tone={d.expired.length ? 'bad' : 'ok'} />
        <Stat label="Expiring within 30 days" value={d.exp.length - d.expired.length} sub={`${inr(d.expValue, 0)} at cost`} tone={d.exp.length - d.expired.length ? 'warn' : 'ok'} />
        <Stat label="Below reorder level" value={d.low.length} sub="Orders can be drafted in Purchases" tone={d.low.length ? 'warn' : 'ok'} />
      </div>

      <div className="grid g2">
        <Card title="Sales, last 14 days"><LineChart data={d.trend} /></Card>
        <Card title="Top items today" actions={<Btn size="sm" onClick={() => go('reports')}>All reports</Btn>}>
          {!d.top.length ? <div className="empty">No bills yet today.</div> : (
            <div className="stack">{d.top.map(t => (
              <div key={t.name}><div className="row between small"><span>{t.name}</span><span className="mono">{inr(t.amt, 0)} · {num(t.qty, 1)}</span></div><Bar value={t.amt} max={maxTop} /></div>
            ))}</div>
          )}
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Needs attention: expiry" actions={<Btn size="sm" onClick={() => go('expiry')}>Expiry control</Btn>}>
          <Table rows={d.exp.slice(0, 6)} empty="Nothing expiring in the next 30 days." cols={[
            { label: 'Item', render: b => <>{b.p?.name}<div className="small muted">Batch {b.batchNo} · {b.p?.rack}</div></> },
            { label: 'Qty', num: true, render: b => num(b.qty, 2) },
            { label: 'Status', render: b => { const z = expiryZone(b.dl, cfg); return <Badge tone={z.tone}>{z.label}</Badge>; } },
          ]} />
        </Card>
        <Card title="Needs attention: reorder" actions={<Btn size="sm" onClick={() => go('purchases', { tab: 'po' })}>Draft orders</Btn>}>
          <Table rows={d.low.slice(0, 6)} empty="All items are above their reorder level." cols={[
            { label: 'Item', render: p => <>{p.name}<div className="small muted">{p.rack}</div></> },
            { label: 'On hand', num: true, render: p => num(p.onHand, 2) },
            { label: 'Reorder at', num: true, key: 'reorderMin' },
          ]} />
        </Card>
      </div>

      <div className="grid g2">
        <Card title="Open WhatsApp orders" actions={<Btn size="sm" onClick={() => go('orders')}>Orders</Btn>}>
          <Table rows={d.orders} empty="No open orders." cols={[
            { label: 'Order', render: o => <>{o.no}<div className="small muted">{o.customerName}</div></> },
            { label: 'Status', render: o => <Badge tone={o.status === 'new' ? 'accent' : 'info'}>{o.status}</Badge> },
            { label: 'Placed', render: o => fmtDT(o.createdAt) },
          ]} />
        </Card>
        <Card title="Follow-ups due" actions={<Btn size="sm" onClick={() => go('customers', { tab: 'followups' })}>Customers</Btn>}>
          <FollowList items={d.followups} />
        </Card>
      </div>
    </div>
  );
}

function FollowList({ items }) {
  const custs = useLive(() => db.customers.toArray(), [], []);
  const cm = Object.fromEntries(custs.map(c => [c.id, c]));
  return <Table rows={items} empty="No follow-ups due today." cols={[
    { label: 'Customer', render: f => cm[f.customerId]?.name || '—' },
    { label: 'What to do', key: 'note' },
    { label: 'Due', key: 'due' },
  ]} />;
}

// Today in one line (EN / Hindi / Odia), the top things to do, and which counters are online.
function SmartCards() {
  const { storeId, settings, go } = useApp();
  const lang = settings.msgLang || 'en';
  const sm = useLive(() => dailySummary(storeId), [storeId], null);
  const counters = useLive(() => counterStatus(), [], null);
  const text = sm ? summaryText(sm, lang) : '';
  return (
    <div className="grid g2">
      <Card title="Today in short" actions={<select className="input" style={{ width: 110 }} value={lang} onChange={e => setSetting('msgLang', e.target.value)} aria-label="Language">{LANGS.map(l => <option key={l.value} value={l.value}>{l.label}</option>)}</select>}>
        {!sm ? <p className="muted">…</p> : <p className="summary-text">{text}</p>}
        {counters?.length > 0 && <div className="row gap-s wrap" style={{ marginTop: 10 }}>{counters.map(c => <Badge key={c.counter} tone={c.online ? 'ok' : 'neutral'}>{c.counter} {c.online ? 'online' : 'offline'}{c.user ? ` · ${c.user}` : ''}</Badge>)}</div>}
        {sm && <div className="row gap-s" style={{ marginTop: 10 }}><a className="btn btn-sm" href={waLink(settings.ownerPhone || '', text)} target="_blank" rel="noreferrer">Share</a></div>}
      </Card>
      <Card title="To-do today" actions={<Btn size="sm" onClick={() => go('smart')}>All insights</Btn>}><TodoList limit={4} /></Card>
    </div>
  );
}
