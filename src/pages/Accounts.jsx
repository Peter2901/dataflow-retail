import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Modal, Input, Select, Tabs, Card, Stat, Badge } from '../ui/kit.jsx';
import { inr, r2, sum, fmtDate, fmtDT, fyOf, todayISO, dayStart, download, uid, inArtifact, localISO } from '../lib/util.js';
import { balances, ledger, profitAndLoss, balanceSheet, postExpense, post, tallyXML, GROUPS } from '../lib/accounts.js';
import { readSheet } from '../lib/excel.js';
import { audit } from '../lib/sales.js';

function usePeriod() {
  const [p, setP] = useState('month');
  const now = new Date();
  const fy = fyOf(now);
  const range = { today: [dayStart(), Date.now()], month: [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Date.now()], fy: [fy.start.getTime(), Date.now()], all: [-Infinity, Infinity] }[p];
  const picker = <select className="input" style={{ width: 200 }} value={p} onChange={e => setP(e.target.value)} aria-label="Period"><option value="today">Today</option><option value="month">This month</option><option value="fy">This financial year ({fy.label})</option><option value="all">All time</option></select>;
  return { range, picker };
}

export default function Accounts() {
  const [tab, setTab] = useState('pl');
  return (
    <div className="stack">
      <PageHead title="Accounts" sub="Full double-entry books, posted by every bill, purchase and payment. No extra typing." />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'pl', label: 'Profit & loss' }, { value: 'bs', label: 'Balance sheet' }, { value: 'gst', label: 'GST payable' }, { value: 'ledgers', label: 'Ledgers' }, { value: 'day', label: 'Day book' }, { value: 'cash', label: 'Cash book' }, { value: 'bank', label: 'Bank matching' }, { value: 'exp', label: 'Expenses' }, { value: 'tally', label: 'Tally export' }]} />
      {tab === 'pl' && <PL />}
      {tab === 'bs' && <BS />}
      {tab === 'gst' && <GstPayable />}
      {tab === 'ledgers' && <Ledgers />}
      {tab === 'day' && <DayBook />}
      {tab === 'cash' && <CashBook />}
      {tab === 'bank' && <Bank />}
      {tab === 'exp' && <Expenses />}
      {tab === 'tally' && <Tally />}
    </div>
  );
}

function PL() {
  const { range, picker } = usePeriod();
  const pl = useLive(() => profitAndLoss(range[0], range[1]), [range[0]], null);
  if (!pl) return null;
  return (
    <div className="stack">
      {picker}
      <div className="grid g3"><Stat label="Income" value={inr(pl.totalIncome, 0)} /><Stat label="Expenses (incl. cost of goods)" value={inr(pl.totalExpense, 0)} /><Stat label={pl.profit >= 0 ? 'Profit' : 'Loss'} value={inr(pl.profit, 0)} tone={pl.profit >= 0 ? 'ok' : 'bad'} sub={pl.totalIncome ? `${r2((pl.profit / pl.totalIncome) * 100)}% of sales` : ''} /></div>
      <div className="grid g2">
        <Card title="Income"><Table rows={pl.income} cols={[{ label: 'Account', key: 'name' }, { label: 'Amount', num: true, render: a => inr(a.amt) }]} foot={{ name: 'Total', amt: inr(pl.totalIncome) }} /></Card>
        <Card title="Expenses"><Table rows={pl.expense} cols={[{ label: 'Account', key: 'name' }, { label: 'Amount', num: true, render: a => inr(a.amt) }]} /></Card>
      </div>
    </div>
  );
}

function BS() {
  const bs = useLive(() => balanceSheet(), [], null);
  if (!bs) return null;
  const diff = r2(bs.totalAssets - bs.totalLiabs);
  return (
    <div className="stack">
      <div className={`note ${Math.abs(diff) > 1 ? 'note-bad' : ''}`}>{Math.abs(diff) <= 1 ? 'The books balance: assets equal liabilities plus capital.' : `Books are out by ${inr(diff)} — check the day book.`}</div>
      <div className="grid g2">
        <Card title="What the business owns"><Table rows={bs.assets} cols={[{ label: 'Asset', key: 'name' }, { label: 'Amount', num: true, render: a => inr(a.amt) }]} foot={{ name: 'Total', amt: inr(bs.totalAssets) }} /></Card>
        <Card title="What it owes, and capital"><Table rows={[...bs.liabs, ...bs.equity]} cols={[{ label: 'Item', key: 'name' }, { label: 'Amount', num: true, render: a => inr(a.amt) }]} foot={{ name: 'Total', amt: inr(bs.totalLiabs) }} /></Card>
      </div>
    </div>
  );
}

function GstPayable() {
  const { range, picker } = usePeriod();
  const b = useLive(() => balances(range[1], range[0]), [range[0]], {});
  const out = { c: -(b.out_cgst || 0), s: -(b.out_sgst || 0), i: -(b.out_igst || 0) };
  const inp = { c: b.in_cgst || 0, s: b.in_sgst || 0, i: b.in_igst || 0 };
  const net = r2(out.c + out.s + out.i - inp.c - inp.s - inp.i);
  return (
    <div className="stack">
      {picker}
      <div className="grid g3"><Stat label="GST collected on sales" value={inr(out.c + out.s + out.i, 0)} /><Stat label="GST credit on purchases" value={inr(inp.c + inp.s + inp.i, 0)} /><Stat label={net >= 0 ? 'To pay (GSTR-3B)' : 'Credit carried forward'} value={inr(Math.abs(net), 0)} tone={net > 0 ? 'warn' : 'ok'} /></div>
      <Card title="By tax head"><Table rows={[{ id: 'CGST', o: out.c, i: inp.c }, { id: 'SGST', o: out.s, i: inp.s }, { id: 'IGST', o: out.i, i: inp.i }]} cols={[{ label: 'Tax', key: 'id' }, { label: 'On sales', num: true, render: r => inr(r.o) }, { label: 'Credit on purchases', num: true, render: r => inr(r.i) }, { label: 'Net', num: true, render: r => inr(r.o - r.i) }]} /></Card>
      <p className="small muted">IGST credit is used first against IGST, then CGST and SGST, per GST rules. Your accountant confirms the final set-off when filing. Full GSTR-1 and 3B tables are in Reports.</p>
    </div>
  );
}

function Ledgers() {
  const accs = useLive(() => db.accounts.toArray(), [], []);
  const b = useLive(() => balances(), [], {});
  const [open, setOpen] = useState(null);
  const rows = useLive(() => open ? ledger(open.id) : [], [open?.id], []);
  const [g, setG] = useState('');
  return (
    <div className="stack">
      <select className="input" style={{ width: 220 }} value={g} onChange={e => setG(e.target.value)} aria-label="Group"><option value="">All groups</option>{Object.entries(GROUPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <div className="card"><Table rows={accs.filter(a => !g || a.group === g).map(a => ({ ...a, bal: b[a.id] || 0 })).filter(a => a.bal || a.system)} onRow={setOpen} cols={[
        { label: 'Account', render: a => <>{a.name}{a.party && <span className="small muted"> · {a.party === 'cust' ? 'customer' : 'supplier'}</span>}</> },
        { label: 'Group', render: a => GROUPS[a.group] },
        { label: 'Balance', num: true, render: a => a.bal === 0 ? '—' : `${inr(Math.abs(a.bal))} ${a.bal > 0 ? 'Dr' : 'Cr'}` },
      ]} /></div>
      {open && <Modal wide title={`Ledger: ${open.name}`} onClose={() => setOpen(null)}>
        <Table rows={rows.map((r, i) => ({ ...r, id: i }))} cols={[{ label: 'Date', render: r => fmtDate(r.ts) }, { label: 'Ref', key: 'ref' }, { label: 'Details', key: 'narration' }, { label: 'Debit', num: true, render: r => r.dr ? inr(r.dr) : '' }, { label: 'Credit', num: true, render: r => r.cr ? inr(r.cr) : '' }, { label: 'Balance', num: true, render: r => `${inr(Math.abs(r.bal))} ${r.bal >= 0 ? 'Dr' : 'Cr'}` }]} />
      </Modal>}
    </div>
  );
}

function DayBook() {
  const [date, setDate] = useState(todayISO());
  const accs = useLive(() => db.accounts.toArray(), [], []);
  const an = Object.fromEntries(accs.map(a => [a.id, a.name]));
  const d0 = new Date(date).setHours(0, 0, 0, 0);
  const entries = useLive(() => db.journal.where('ts').between(d0, d0 + 86400000).toArray(), [date], []);
  return (
    <div className="stack">
      <Input label="Date" type="date" value={date} onChange={e => setDate(e.target.value)} id="db-date" className="search" />
      <div className="card"><Table rows={entries} empty="No entries on this day." cols={[
        { label: 'Time', render: e => fmtDT(e.ts) }, { label: 'Ref', key: 'ref' }, { label: 'Details', key: 'narration' },
        { label: 'Entries', render: e => <div className="small mono">{e.lines.map((l, i) => <div key={i}>{l.dr ? 'Dr' : 'Cr'} {an[l.acc] || l.acc} {inr(l.dr || l.cr)}</div>)}</div> },
      ]} /></div>
    </div>
  );
}

function CashBook() {
  const { user } = useApp();
  const toast = useToast();
  const b = useLive(() => balances(), [], {});
  const t0 = dayStart();
  const today = useLive(() => db.journal.where('ts').aboveOrEqual(t0).toArray(), [], []);
  const inToday = r2(sum(today.flatMap(e => e.lines.filter(l => l.acc === 'cash')), l => l.dr || 0));
  const outToday = r2(sum(today.flatMap(e => e.lines.filter(l => l.acc === 'cash')), l => l.cr || 0));
  const [dep, setDep] = useState('');
  const deposit = async () => {
    const a = Number(dep); if (!(a > 0)) return;
    await post({ ref: 'DEP-' + Date.now().toString().slice(-5), type: 'contra', narration: 'Cash deposited in bank', lines: [{ acc: 'bank', dr: a }, { acc: 'cash', cr: a }] });
    await audit('cash_deposit', { amount: a }, user);
    toast(`Deposit of ${inr(a)} recorded.`); setDep('');
  };
  return (
    <div className="stack">
      <div className="grid g4"><Stat label="Cash in hand (books)" value={inr(b.cash || 0, 0)} /><Stat label="Cash in today" value={inr(inToday, 0)} /><Stat label="Cash out today" value={inr(outToday, 0)} /><Stat label="Bank balance (books)" value={inr(b.bank || 0, 0)} /></div>
      <Card title="Deposit cash in the bank">
        <div className="row gap-s wrap" style={{ alignItems: 'flex-end' }}><Input label="Amount (₹)" type="number" value={dep} onChange={e => setDep(e.target.value)} id="dep-amt" /><Btn kind="primary" onClick={deposit}>Record deposit</Btn></div>
        <p className="small muted" style={{ marginTop: 8 }}>Counter cash is checked shift by shift when each cashier closes their shift (Billing › Close shift).</p>
      </Card>
    </div>
  );
}

// Bank matching: load the bank statement, and the app pairs each credit with UPI/card settlements or customer receipts.
function Bank() {
  const { user } = useApp();
  const toast = useToast();
  const lines = useLive(() => db.bankLines.orderBy('date').reverse().toArray(), [], []);
  const b = useLive(() => balances(), [], {});
  const [mdr, setMdr] = useState('1.5');
  const load = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    const { rows } = await readSheet(f);
    const g = (r, ns) => { const k = Object.keys(r).find(h => ns.some(n => h.toUpperCase().includes(n))); return k ? r[k] : ''; };
    const add = rows.map(r => {
      const cr = Number(String(g(r, ['CREDIT', 'DEPOSIT'])).replace(/,/g, '')) || 0;
      const dr = Number(String(g(r, ['DEBIT', 'WITHDRAW'])).replace(/,/g, '')) || 0;
      const desc = String(g(r, ['NARRATION', 'DESCRIPTION', 'PARTICULARS', 'DETAILS']));
      return { id: uid('bl_'), date: String(g(r, ['DATE'])), desc, amount: r2(cr - dr), matched: 0, kind: /UPI|PHONEPE|PAYTM|GPAY|RAZORPAY/i.test(desc) ? 'upi' : /POS|CARD|PINE|SETTLE|MERCHANT/i.test(desc) ? 'card' : 'other' };
    }).filter(x => x.amount);
    await db.bankLines.bulkAdd(add);
    toast(`${add.length} bank lines loaded.`);
  };
  const settle = async l => {
    if (l.kind === 'upi' || l.kind === 'card') {
      const gross = l.kind === 'card' ? r2(l.amount / (1 - Number(mdr) / 100)) : l.amount;
      const fee = r2(gross - l.amount);
      await post({ ref: 'SETTLE', type: 'contra', narration: `${l.kind.toUpperCase()} settlement: ${l.desc}`, lines: [{ acc: 'bank', dr: l.amount }, ...(fee ? [{ acc: 'bank_charges', dr: fee }] : []), { acc: l.kind, cr: gross }] });
    }
    await db.bankLines.update(l.id, { matched: 1 });
    audit('bank_match', { desc: l.desc, amount: l.amount }, user);
  };
  return (
    <div className="stack">
      <div className="grid g3"><Stat label="UPI not yet in bank" value={inr(b.upi || 0, 0)} /><Stat label="Card not yet in bank" value={inr(b.card || 0, 0)} /><Stat label="Unmatched bank lines" value={lines.filter(l => !l.matched).length} /></div>
      <Card title="Load bank statement" actions={<Input label="Card fee (MDR %)" type="number" value={mdr} onChange={e => setMdr(e.target.value)} id="mdr" />}>
        <p className="small muted">Download the statement from net banking as Excel or CSV. UPI and card settlements are spotted from the narration; card fees (MDR) are booked as bank charges so you can check what the bank kept.</p>
        <label className="btn" style={{ marginTop: 10, width: 'fit-content' }}>Load statement<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={load} /></label>
      </Card>
      <div className="card"><Table rows={lines} empty="No statement loaded yet." cols={[
        { label: 'Date', key: 'date' }, { label: 'Narration', render: l => <span className="small">{l.desc}</span> },
        { label: 'Type', render: l => <Badge tone={l.kind === 'other' ? 'neutral' : 'info'}>{l.kind}</Badge> },
        { label: 'Amount', num: true, render: l => inr(l.amount) },
        { label: '', render: l => l.matched ? <Badge tone="ok">Matched</Badge> : <Btn size="sm" onClick={() => settle(l)}>{l.kind === 'other' ? 'Mark checked' : 'Match settlement'}</Btn> },
      ]} /></div>
    </div>
  );
}

const EXP = [['rent', 'Rent'], ['power', 'Electricity'], ['bank_charges', 'Bank & card charges'], ['misc', 'Other expenses']];
function Expenses() {
  const { user } = useApp();
  const toast = useToast();
  const [e, setE] = useState({ acc: 'power', amount: '', mode: 'cash', narration: '' });
  const recent = useLive(() => db.journal.where('type').equals('expense').reverse().sortBy('ts'), [], []);
  const save = async () => {
    if (!(Number(e.amount) > 0)) return;
    await postExpense({ ...e, amount: Number(e.amount), narration: e.narration || EXP.find(x => x[0] === e.acc)[1], ts: Date.now() });
    await audit('expense', { acc: e.acc, amount: e.amount }, user);
    toast('Expense recorded.'); setE({ ...e, amount: '', narration: '' });
  };
  return (
    <div className="stack">
      <Card title="Record an expense">
        <div className="grid g4">
          <Select label="Type" value={e.acc} onChange={x => setE({ ...e, acc: x.target.value })} options={EXP.map(([v, l]) => ({ value: v, label: l }))} id="ex-acc" />
          <Input label="Amount (₹)" type="number" value={e.amount} onChange={x => setE({ ...e, amount: x.target.value })} id="ex-amt" />
          <Select label="Paid by" value={e.mode} onChange={x => setE({ ...e, mode: x.target.value })} options={[{ value: 'cash', label: 'Cash' }, { value: 'bank', label: 'Bank' }, { value: 'upi', label: 'UPI' }]} id="ex-mode" />
          <Input label="Note" value={e.narration} onChange={x => setE({ ...e, narration: x.target.value })} id="ex-note" />
        </div>
        <div style={{ marginTop: 10 }}><Btn kind="primary" onClick={save}>Save expense</Btn></div>
      </Card>
      <div className="card"><Table rows={recent.slice(0, 30)} empty="No expenses recorded." cols={[{ label: 'Date', render: x => fmtDate(x.ts) }, { label: 'Details', key: 'narration' }, { label: 'Amount', num: true, render: x => inr(x.lines[0]?.dr || 0) }]} /></div>
    </div>
  );
}

function Tally() {
  const { settings } = useApp();
  const accs = useLive(() => db.accounts.toArray(), [], []);
  const [from, setFrom] = useState(localISO(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [to, setTo] = useState(todayISO());
  const entries = useLive(() => db.journal.where('ts').between(new Date(from + 'T00:00:00').getTime(), new Date(to + 'T00:00:00').getTime() + 86400000).toArray(), [from, to], []);
  const exportIt = () => {
    const names = Object.fromEntries(accs.map(a => [a.id, a.name]));
    const xml = tallyXML(entries.filter(e => e.type !== 'opening'), names, settings.storeName);
    download(inArtifact() ? `tally-${from}-to-${to}.xml.txt` : `tally-${from}-to-${to}.xml`, xml, 'application/xml');
  };
  const counts = useMemo(() => entries.reduce((m, e) => ((m[e.type] = (m[e.type] || 0) + 1), m), {}), [entries]);
  return (
    <Card title="Send the books to your accountant’s Tally">
      <div className="grid g3"><Input label="From" type="date" value={from} onChange={e => setFrom(e.target.value)} id="t-from" /><Input label="To" type="date" value={to} onChange={e => setTo(e.target.value)} id="t-to" /><div className="field" style={{ justifyContent: 'flex-end' }}><Btn kind="primary" onClick={exportIt} disabled={!entries.length}>Export {entries.length} vouchers</Btn></div></div>
      <p className="small muted" style={{ marginTop: 10 }}>{Object.entries(counts).map(([k, v]) => `${v} ${k.replace('_', ' ')}`).join(' · ') || 'No entries in this period.'}</p>
      <p className="small muted">In Tally: Gateway of Tally › Import › Vouchers, pick this file. Create ledgers with the same names first (Sales, Output CGST, Cash in hand…), or let your accountant map them once.{inArtifact() ? ' From the demo link the file saves as .xml.txt — remove the .txt before importing.' : ''}</p>
    </Card>
  );
}
