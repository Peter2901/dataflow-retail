import React, { useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useSlowLive, useToast, PageHead, Table, Btn, Modal, Input, Select, Stat, Card, Badge } from '../ui/kit.jsx';
import { inr, r2, sum, waLink, upiLink, fmtDate, daysBetween } from '../lib/util.js';
import { customerAgeing, partyBalances } from '../lib/parties.js';
import { postReceipt } from '../lib/accounts.js';
import { audit } from '../lib/sales.js';

export default function Credit() {
  const { settings, user, go } = useApp();
  const toast = useToast();
  const ageing = useSlowLive(() => customerAgeing(), [], {}, 20000);
  const customers = useLive(() => db.customers.toArray(), [], []);
  const supp = useLive(() => partyBalances('supp'), [], {});
  const purchases = useLive(() => db.purchases.toArray(), [], []);
  const [receive, setReceive] = useState(null);
  const cm = Object.fromEntries(customers.map(c => [c.id, c]));
  const rows = Object.entries(ageing).map(([id, a]) => ({ id, c: cm[id], ...a })).filter(r => r.c).sort((a, b) => b.b90 - a.b90 || b.due - a.due);
  const tot = k => r2(sum(rows, r => r[k]));
  const owed = r2(-sum(Object.values(supp).filter(v => v < 0)));
  const remind = r => {
    const link = upiLink({ vpa: settings.upiVpa, name: settings.upiName || settings.storeName, amount: r.due, note: 'Dues ' + r.c.name });
    return `Namaste ${r.c.name.split(' ')[0]} ji, a gentle reminder from ${settings.storeName}: ${inr(r.due)} is pending on your account${r.oldest ? ` (oldest bill ${fmtDate(r.oldest)})` : ''}.\n\nPay by UPI to *${settings.upiVpa}* or tap: ${link}\n\nThank you!`;
  };
  return (
    <div className="stack">
      <PageHead title="Credit & dues" sub="Who owes you, oldest first — with one-tap WhatsApp reminders that carry a UPI pay link" />
      <div className="grid g4">
        <Stat label="Customers owe you" value={inr(tot('due'), 0)} sub={`${rows.length} customers`} />
        <Stat label="Over 90 days" value={inr(tot('b90'), 0)} tone={tot('b90') ? 'bad' : undefined} />
        <Stat label="31–90 days" value={inr(r2(tot('b30') + tot('b60')), 0)} tone={tot('b30') + tot('b60') ? 'warn' : undefined} />
        <Stat label="You owe suppliers" value={inr(owed, 0)} sub={<button className="btn btn-sm btn-ghost" style={{ padding: 0 }} onClick={() => go('purchases', { tab: 'suppliers' })}>See supplier dues</button>} />
      </div>
      <div className="card"><Table rows={rows} empty="No customer owes you money right now." cols={[
        { label: 'Customer', render: r => <><b>{r.c.name}</b><div className="small muted">{r.c.phone} · limit {inr(r.c.creditLimit || 0, 0)}</div></> },
        { label: '0–30 days', num: true, render: r => r.b0 ? inr(r.b0, 0) : '—' },
        { label: '31–60', num: true, render: r => r.b30 ? inr(r.b30, 0) : '—' },
        { label: '61–90', num: true, render: r => r.b60 ? inr(r.b60, 0) : '—' },
        { label: '90+', num: true, render: r => r.b90 ? <span style={{ color: 'var(--bad)' }}>{inr(r.b90, 0)}</span> : '—' },
        { label: 'Total due', num: true, render: r => <b>{inr(r.due)}</b> },
        { label: '', render: r => <div className="row gap-s">
          <a className="btn btn-sm" href={waLink(r.c.phone, remind(r))} target="_blank" rel="noreferrer" onClick={() => audit('reminder', { customer: r.c.name, amount: r.due }, user)}>Remind</a>
          <Btn size="sm" kind="primary" onClick={() => setReceive(r)}>Received</Btn></div> },
      ]} /></div>
      <Card title="Supplier bills due soon">
        <Table rows={purchases.filter(p => p.total - (p.paid || 0) > 0.5).sort((a, b) => a.dueDate.localeCompare(b.dueDate)).slice(0, 8)} empty="No unpaid supplier bills." cols={[
          { label: 'Bill', render: p => p.billNo || p.no }, { label: 'Due', render: p => { const d = daysBetween(new Date(), new Date(p.dueDate)); return <Badge tone={d < 0 ? 'bad' : d <= 7 ? 'warn' : 'neutral'}>{fmtDate(p.dueDate)}</Badge>; } },
          { label: 'Unpaid', num: true, render: p => inr(p.total - (p.paid || 0)) },
          { label: 'GST credit risk', render: p => daysBetween(new Date(p.date), new Date()) > 150 ? <Badge tone="bad">Pay before 180 days</Badge> : '—' },
        ]} />
      </Card>
      {receive && <ReceiveModal r={receive} onClose={() => setReceive(null)} onSave={async (amt, mode, ref) => {
        await postReceipt({ customer: receive.c, amount: amt, mode, ref, ts: Date.now() });
        await audit('receipt', { customer: receive.c.name, amount: amt, mode }, user);
        toast(`Received ${inr(amt)} from ${receive.c.name}.`); setReceive(null);
      }} />}
    </div>
  );
}

function ReceiveModal({ r, onClose, onSave }) {
  const [amt, setAmt] = useState(String(r.due));
  const [mode, setMode] = useState('upi');
  const [ref, setRef] = useState('');
  return (
    <Modal title={`Payment from ${r.c.name}`} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => Number(amt) > 0 && onSave(Number(amt), mode, ref)}>Save receipt</Btn></>}>
      <div className="stack">
        <Input label={`Amount received (due ${inr(r.due)})`} type="number" value={amt} onChange={e => setAmt(e.target.value)} id="rc-amt" />
        <Select label="Received by" value={mode} onChange={e => setMode(e.target.value)} options={[{ value: 'upi', label: 'UPI' }, { value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank transfer' }, { value: 'card', label: 'Card' }]} id="rc-mode" />
        <Input label="Reference (UTR)" value={ref} onChange={e => setRef(e.target.value)} id="rc-ref" />
      </div>
    </Modal>
  );
}
