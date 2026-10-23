import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, useConfirm, PageHead, Table, Btn, Modal, Input, Badge, Tabs, Card, SearchBox, Stat, Select } from '../ui/kit.jsx';
import { inr, num, uid, waLink, fmtDT, fmtDate, daysBetween, maskPhone, todayISO, validGSTIN, sum, addDays, localISO } from '../lib/util.js';
import { tierFor, TIERS, audit } from '../lib/sales.js';
import { partyBalances } from '../lib/parties.js';
import { LEVELS } from '../lib/pricing.js';

export function segment(c) {
  const rec = c.lastVisit ? daysBetween(new Date(c.lastVisit), new Date()) : 999;
  if (c.createdAt && daysBetween(new Date(c.createdAt), new Date()) <= 30) return { key: 'new', label: 'New', tone: 'info' };
  if (rec <= 14 && (c.visits || 0) >= 10) return { key: 'champ', label: 'Champion', tone: 'ok' };
  if (rec <= 30 && (c.visits || 0) >= 4) return { key: 'loyal', label: 'Loyal', tone: 'ok' };
  if (rec > 60) return { key: 'sleep', label: 'Hibernating', tone: 'neutral' };
  if (rec > 30) return { key: 'risk', label: 'At risk', tone: 'warn' };
  return { key: 'reg', label: 'Regular', tone: 'neutral' };
}

export default function Customers() {
  const { param, user } = useApp();
  const [tab, setTab] = useState(param?.tab || 'list');
  const customers = useLive(() => db.customers.toArray(), [], []);
  const dues = useLive(() => partyBalances('cust'), [], {});
  const [open, setOpen] = useState(null);
  const canSeePhone = user.role !== 'cashier';
  return (
    <div className="stack">
      <PageHead title="Customers & loyalty" sub={`${customers.length} customers · ₹100 spent = ${1} point · 1 point = ₹1 off`} actions={<Btn kind="primary" onClick={() => setOpen({ name: '', phone: '', creditLimit: 2000, gstin: '', notes: '', consentWhatsApp: true })}>Add customer</Btn>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'list', label: 'Customers' }, { value: 'followups', label: 'Follow-ups' }, { value: 'campaign', label: 'WhatsApp offers' }, { value: 'loyalty', label: 'Loyalty rules' }]} />
      {tab === 'list' && <List customers={customers} dues={dues} canSeePhone={canSeePhone} onOpen={setOpen} />}
      {tab === 'followups' && <Followups customers={customers} />}
      {tab === 'campaign' && <Campaign customers={customers} />}
      {tab === 'loyalty' && <Loyalty customers={customers} />}
      {open && <Detail c={open} due={dues[open.id] || 0} canSeePhone={canSeePhone} onClose={() => setOpen(null)} />}
    </div>
  );
}

function List({ customers, dues, canSeePhone, onOpen }) {
  const [q, setQ] = useState('');
  const [seg, setSeg] = useState('');
  const rows = useMemo(() => customers.map(c => ({ ...c, seg: segment(c), tier: tierFor(c.yearSpend || 0) }))
    .filter(c => (!q || c.name.toLowerCase().includes(q.toLowerCase()) || c.phone.includes(q)) && (!seg || c.seg.key === seg))
    .sort((a, b) => (b.yearSpend || 0) - (a.yearSpend || 0)), [customers, q, seg]);
  const segs = ['champ', 'loyal', 'reg', 'risk', 'sleep', 'new'];
  const count = k => customers.filter(c => segment(c).key === k).length;
  return (
    <div className="stack">
      <div className="grid g3">
        <Stat label="Loyalty members" value={customers.length} sub={`${customers.filter(c => tierFor(c.yearSpend || 0).key !== 'Silver').length} Gold or Platinum`} />
        <Stat label="At risk of leaving" value={count('risk')} sub="No visit in 30–60 days" tone={count('risk') ? 'warn' : undefined} />
        <Stat label="Points owed to customers" value={num(sum(customers, c => c.points || 0))} sub={`Worth ${inr(sum(customers, c => c.points || 0), 0)}`} />
      </div>
      <div className="row gap-s wrap"><SearchBox value={q} onChange={setQ} placeholder="Search name or mobile" />
        <select className="input" style={{ width: 200 }} value={seg} onChange={e => setSeg(e.target.value)} aria-label="Segment"><option value="">All groups</option>{segs.map(s => <option key={s} value={s}>{segment({ champ: { lastVisit: Date.now(), visits: 20 }, loyal: { lastVisit: Date.now(), visits: 5 }, reg: { lastVisit: Date.now(), visits: 1 }, risk: { lastVisit: Date.now() - 40 * 864e5 }, sleep: { lastVisit: Date.now() - 90 * 864e5 }, new: { createdAt: Date.now() } }[s]).label} ({count(s)})</option>)}</select></div>
      <div className="card"><Table rows={rows} onRow={onOpen} cols={[
        { label: 'Customer', render: c => <><b>{c.name}</b><div className="small muted">{canSeePhone ? c.phone : maskPhone(c.phone)}{c.gstin ? ' · B2B' : ''}</div></> },
        { label: 'Tier', render: c => <Badge tone={c.tier.key === 'Platinum' ? 'accent' : c.tier.key === 'Gold' ? 'warn' : 'neutral'}>{c.tier.key}</Badge> },
        { label: 'Group', render: c => <Badge tone={c.seg.tone}>{c.seg.label}</Badge> },
        { label: 'Spend this year', num: true, render: c => inr(c.yearSpend || 0, 0) },
        { label: 'Visits', num: true, render: c => c.visits || 0 },
        { label: 'Points', num: true, render: c => c.points || 0 },
        { label: 'Credit due', num: true, render: c => (dues[c.id] || 0) > 0 ? <span style={{ color: 'var(--bad)' }}>{inr(dues[c.id])}</span> : '—' },
        { label: 'Last visit', render: c => fmtDate(c.lastVisit) },
      ]} /></div>
    </div>
  );
}

function Detail({ c: init, due, canSeePhone, onClose }) {
  const { user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [c, setC] = useState(init);
  const [tab, setTab] = useState('profile');
  const sales = useLive(() => init.id ? db.sales.where('customerId').equals(init.id).reverse().sortBy('ts') : [], [init.id], []);
  const pts = useLive(() => init.id ? db.loyaltyTx.where('customerId').equals(init.id).reverse().sortBy('ts') : [], [init.id], []);
  const fus = useLive(() => init.id ? db.followups.where('customerId').equals(init.id).toArray() : [], [init.id], []);
  const [fu, setFu] = useState({ note: '', due: localISO(addDays(new Date(), 2)) });
  const save = async () => {
    const ph = String(c.phone).replace(/\D/g, '');
    if (ph.length !== 10) return toast('Mobile number must have 10 digits.', 'bad');
    if (c.gstin && !validGSTIN(c.gstin)) return toast('GSTIN does not pass the check.', 'bad');
    const rec = { ...c, phone: ph, creditLimit: Number(c.creditLimit) || 0, id: c.id || uid('c_'), createdAt: c.createdAt || Date.now(), points: c.points || 0, yearSpend: c.yearSpend || 0, visits: c.visits || 0 };
    // Points, spend and visits come from the bills (they may have changed while this was open): keep the saved ones.
    const DERIVED = ['points', 'yearSpend', 'lifeSpend', 'visits', 'lastVisit', 'base'];
    const details = Object.fromEntries(Object.entries(rec).filter(([k]) => !DERIVED.includes(k)));
    if (c.id && await db.customers.get(c.id)) await db.customers.update(c.id, details);
    else await db.customers.put(rec);
    toast('Customer saved.'); onClose();
  };
  const erase = async () => {
    if (!(await confirm('Remove this customer’s personal details? Their bills stay (GST law needs them) but name and phone are wiped.', 'Erase details'))) return;
    await db.customers.update(c.id, { name: 'Erased customer', phone: '0000000000', gstin: '', notes: '', consentWhatsApp: false, erased: true });
    await audit('customer_erased', { id: c.id }, user);
    toast('Personal details erased (DPDP Act request).'); onClose();
  };
  const tier = tierFor(c.yearSpend || 0);
  const nextTier = TIERS.find(t => t.min > (c.yearSpend || 0));
  return (
    <Modal wide title={init.id ? c.name : 'New customer'} onClose={onClose} footer={tab === 'profile' && <>{init.id && user.role === 'owner' && <Btn kind="danger" onClick={erase}>Erase personal data</Btn>}<span className="grow" /><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save}>Save</Btn></>}>
      {init.id && <Tabs value={tab} onChange={setTab} tabs={[{ value: 'profile', label: 'Profile' }, { value: 'bills', label: `Bills (${sales.length})` }, { value: 'points', label: 'Points' }, { value: 'fu', label: 'Follow-ups' }]} />}
      {tab === 'profile' && <div className="stack">
        {init.id && <div className="grid g4"><Stat label="Tier" value={tier.key} sub={nextTier ? `${inr(nextTier.min - (c.yearSpend || 0), 0)} more for ${nextTier.key}` : 'Top tier'} /><Stat label="Points" value={c.points || 0} /><Stat label="This year" value={inr(c.yearSpend || 0, 0)} /><Stat label="Credit due" value={inr(due)} tone={due > 0 ? 'warn' : undefined} /></div>}
        <div className="grid g2">
          <Input label="Name" value={c.name} onChange={e => setC({ ...c, name: e.target.value })} id="c-name" />
          <Input label="Mobile" value={canSeePhone || !init.id ? c.phone : maskPhone(c.phone)} disabled={!canSeePhone && !!init.id} onChange={e => setC({ ...c, phone: e.target.value })} id="c-phone" />
          <Input label="Credit (udhaar) limit ₹" type="number" value={c.creditLimit} onChange={e => setC({ ...c, creditLimit: e.target.value })} id="c-limit" />
          <Select label="Rate for this customer" value={c.priceLevel || 'retail'} onChange={e => setC({ ...c, priceLevel: e.target.value })} options={LEVELS.map(l => ({ value: l.value, label: l.label }))} id="c-level" hint="Shops buying in bulk get the Wholesale rate automatically at the counter" />
          <Input label="GSTIN (business customers)" value={c.gstin} onChange={e => setC({ ...c, gstin: e.target.value.toUpperCase() })} id="c-gstin" />
        </div>
        <Input label="Notes" value={c.notes || ''} onChange={e => setC({ ...c, notes: e.target.value })} id="c-notes" />
        <label className="check"><input type="checkbox" checked={!!c.consentWhatsApp} onChange={e => setC({ ...c, consentWhatsApp: e.target.checked })} /> Agrees to get bills and offers on WhatsApp</label>
      </div>}
      {tab === 'bills' && <Table rows={sales} cols={[{ label: 'Bill', key: 'no' }, { label: 'When', render: s => fmtDT(s.ts) }, { label: 'Items', num: true, render: s => s.lines.length }, { label: 'Amount', num: true, render: s => (s.type === 'return' ? '−' : '') + inr(s.totals.payable) }, { label: 'Paid by', render: s => s.payments.map(p => p.mode).join(' + ') }]} />}
      {tab === 'points' && <Table rows={pts} cols={[{ label: 'When', render: t => fmtDT(t.ts) }, { label: 'Type', key: 'type' }, { label: 'Bill', key: 'ref' }, { label: 'Points', num: true, render: t => (t.points > 0 ? '+' : '') + t.points }]} empty="No points yet." />}
      {tab === 'fu' && <div className="stack">
        <div className="row gap-s wrap" style={{ alignItems: 'flex-end' }}><Input className="grow" label="What to follow up" value={fu.note} onChange={e => setFu({ ...fu, note: e.target.value })} id="fu-note" /><Input label="When" type="date" value={fu.due} onChange={e => setFu({ ...fu, due: e.target.value })} id="fu-due" />
          <Btn kind="primary" onClick={async () => { if (!fu.note) return; await db.followups.add({ id: uid('f_'), customerId: init.id, ...fu, done: false, createdAt: Date.now(), by: user.name }); setFu({ ...fu, note: '' }); }}>Add</Btn></div>
        <Table rows={fus} cols={[{ label: 'Due', key: 'due' }, { label: 'Note', key: 'note' }, { label: '', render: f => f.done ? <Badge tone="ok">Done</Badge> : <Btn size="sm" onClick={() => db.followups.update(f.id, { done: true })}>Mark done</Btn> }]} empty="No follow-ups." />
      </div>}
    </Modal>
  );
}

function Followups({ customers }) {
  const cm = Object.fromEntries(customers.map(c => [c.id, c]));
  const fus = useLive(() => db.followups.toArray(), [], []);
  const today = todayISO();
  const rows = fus.filter(f => !f.done).sort((a, b) => a.due.localeCompare(b.due));
  return <div className="card"><Table rows={rows} empty="No open follow-ups. Add them from a customer’s profile." cols={[
    { label: 'Due', render: f => <Badge tone={f.due < today ? 'bad' : f.due === today ? 'warn' : 'neutral'}>{f.due}</Badge> },
    { label: 'Customer', render: f => cm[f.customerId]?.name },
    { label: 'What to do', key: 'note' },
    { label: '', render: f => <div className="row gap-s"><a className="btn btn-sm" href={waLink(cm[f.customerId]?.phone, `Hi ${cm[f.customerId]?.name}, `)} target="_blank" rel="noreferrer">WhatsApp</a><Btn size="sm" onClick={() => db.followups.update(f.id, { done: true })}>Done</Btn></div> },
  ]} /></div>;
}

function Campaign({ customers }) {
  const { settings } = useApp();
  const [seg, setSeg] = useState('risk');
  const [text, setText] = useState(`Hi {name}! We miss you at ${settings.storeName}. This week: extra savings on staples. You have {points} points (₹{points} off) waiting. See you soon!`);
  const list = customers.filter(c => c.consentWhatsApp && !c.erased && (seg === 'all' || segment(c).key === seg));
  const [sent, setSent] = useState({});
  const fill = c => text.replace(/\{name\}/g, c.name.split(' ')[0]).replace(/\{points\}/g, c.points || 0);
  return (
    <div className="stack">
      <Card title="Send an offer on WhatsApp">
        <div className="grid g2">
          <Select label="Who gets it" value={seg} onChange={e => setSeg(e.target.value)} options={[{ value: 'risk', label: 'At risk (no visit 30–60 days)' }, { value: 'sleep', label: 'Hibernating (60+ days)' }, { value: 'champ', label: 'Champions' }, { value: 'loyal', label: 'Loyal' }, { value: 'new', label: 'New this month' }, { value: 'all', label: 'Everyone who agreed' }]} id="cmp-seg" />
          <div className="field"><span className="field-label">Message ({'{name}'} and {'{points}'} fill in by themselves)</span><textarea className="input" value={text} onChange={e => setText(e.target.value)} id="cmp-text" /></div>
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>Only customers who agreed to WhatsApp messages are listed. Promotional messages should go between 9 am and 9 pm. Tap each Send to open WhatsApp with the message ready; with the WhatsApp Business API connected, this sends in one go.</p>
      </Card>
      <div className="card"><Table rows={list} empty="Nobody in this group." cols={[
        { label: 'Customer', render: c => c.name }, { label: 'Points', num: true, render: c => c.points || 0 },
        { label: 'Message', render: c => <span className="small">{fill(c)}</span> },
        { label: '', render: c => <a className="btn btn-sm" href={waLink(c.phone, fill(c))} target="_blank" rel="noreferrer" onClick={() => setSent({ ...sent, [c.id]: true })}>{sent[c.id] ? 'Opened ✓' : 'Send'}</a> },
      ]} /></div>
    </div>
  );
}

function Loyalty({ customers }) {
  const { settings } = useApp();
  return (
    <div className="grid g2">
      <Card title="How points work">
        <div className="stack small">
          <div className="row between"><span>Earn</span><b>{settings.pointsPer100 || 1} point per ₹100 paid</b></div>
          {TIERS.map(t => <div key={t.key} className="row between"><span>{t.key} (from {inr(t.min, 0)} a year)</span><b>{t.mult}× points · {customers.filter(c => tierFor(c.yearSpend || 0).key === t.key).length} members</b></div>)}
          <div className="row between"><span>Use</span><b>1 point = ₹1 off, from {settings.pointsMinRedeem || 50} points</b></div>
          <div className="row between"><span>Most per bill</span><b>{settings.pointsMaxPct || 30}% of the bill</b></div>
          <p className="muted">Points used are a discount before GST, so tax is charged on the lower amount. Change the numbers in Settings.</p>
        </div>
      </Card>
      <Card title="Biggest point balances">
        <Table rows={[...customers].sort((a, b) => (b.points || 0) - (a.points || 0)).slice(0, 8)} cols={[{ label: 'Customer', key: 'name' }, { label: 'Points', num: true, render: c => c.points || 0 }]} />
      </Card>
    </div>
  );
}
