import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Modal, Input, Tabs, Card, Stat, Badge } from '../ui/kit.jsx';
import { inr, r2, sum, uid, fmtDT, waLink, todayISO, localISO } from '../lib/util.js';
import { post } from '../lib/accounts.js';
import { audit, withLock } from '../lib/sales.js';

const monthKey = d => localISO(d).slice(0, 7);

// Statutory numbers come from Settings (defaults: PF 12% up to ₹15,000 wage, ESI 0.75%/3.25% up to ₹21,000 gross,
// Gujarat professional tax ₹200 from ₹12,000). Confirm current rates with your accountant.
export function computePay(emp, month, attendance, cfg) {
  const [y, m] = month.split('-').map(Number);
  const dim = new Date(y, m, 0).getDate();
  const isCurrent = month === monthKey(new Date());
  const lastDay = isCurrent ? new Date().getDate() : dim;
  let sundays = 0;
  for (let d = 1; d <= lastDay; d++) if (new Date(y, m - 1, d).getDay() === 0) sundays++;
  const present = attendance.filter(a => a.empId === emp.id && a.date.startsWith(month)).length;
  const paidDays = Math.min(lastDay, present + sundays);
  const full = Number(emp.basic) + Number(emp.hra) + Number(emp.allowance);
  const f = paidDays / dim;
  const basic = r2(emp.basic * f), hra = r2(emp.hra * f), allow = r2(emp.allowance * f);
  const gross = r2(basic + hra + allow);
  const pfWage = Math.min(basic, cfg.pfCap || 15000);
  const pfEmp = cfg.pfOn && emp.pfOn ? r2((pfWage * (cfg.pfRate || 12)) / 100) : 0;
  const pfEr = pfEmp;
  const esiApplies = cfg.esiOn && emp.esiOn && full <= (cfg.esiLimit || 21000);
  const esiEmp = esiApplies ? Math.ceil((gross * (cfg.esiEmp || 0.75)) / 100) : 0;
  const esiEr = esiApplies ? Math.ceil((gross * (cfg.esiEr || 3.25)) / 100) : 0;
  const pt = [...(cfg.ptSlabs || [])].sort((a, b) => b.min - a.min).find(s => gross >= s.min)?.amt || 0;
  const net = r2(gross - pfEmp - esiEmp - pt);
  return { empId: emp.id, name: emp.name, month, dim, present, sundays, paidDays, basic, hra, allow, gross, pfEmp, pfEr, esiEmp, esiEr, pt, net };
}

export default function Staff() {
  const [tab, setTab] = useState('attendance');
  return (
    <div className="stack">
      <PageHead title="Staff & salary" sub="Attendance, monthly salary with PF, ESI and professional tax, and payslips on WhatsApp" />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'attendance', label: 'Attendance' }, { value: 'salary', label: 'Salary' }, { value: 'team', label: 'Team' }]} />
      {tab === 'attendance' && <Attendance />}
      {tab === 'salary' && <Salary />}
      {tab === 'team' && <Team />}
    </div>
  );
}

function Attendance() {
  const { user } = useApp();
  const toast = useToast();
  const emps = useLive(() => db.employees.filter(e => e.active !== false).toArray(), [], []);
  const today = todayISO();
  const att = useLive(() => db.attendance.where('date').equals(today).toArray(), [], []);
  const month = monthKey(new Date());
  const monthAtt = useLive(() => db.attendance.where('date').startsWith(month).toArray(), [month], []);
  const punch = async e => {
    const rec = att.find(a => a.empId === e.id);
    if (!rec) { await db.attendance.add({ id: uid('at_'), empId: e.id, date: today, in: Date.now(), out: null, method: 'Counter' }); toast(`${e.name} punched in.`); }
    else if (!rec.out) { await db.attendance.update(rec.id, { out: Date.now() }); toast(`${e.name} punched out.`); }
    audit('attendance', { emp: e.name }, user);
  };
  const late = r => { const t = new Date(r.in); return t.getHours() * 60 + t.getMinutes() > 9 * 60 + 15; };
  return (
    <div className="stack">
      <div className="grid g3"><Stat label="Present today" value={`${att.length} / ${emps.length}`} /><Stat label="Late today (after 9:15)" value={att.filter(late).length} tone={att.filter(late).length ? 'warn' : undefined} /><Stat label="Punches this month" value={monthAtt.length} /></div>
      <div className="card"><Table rows={emps} cols={[
        { label: 'Staff', render: e => <><b>{e.name}</b><div className="small muted">{e.role}</div></> },
        { label: 'In', render: e => { const r = att.find(a => a.empId === e.id); return r ? <>{fmtDT(r.in)} {late(r) && <Badge tone="warn">Late</Badge>}</> : '—'; } },
        { label: 'Out', render: e => fmtDT(att.find(a => a.empId === e.id)?.out) },
        { label: 'Days this month', num: true, render: e => monthAtt.filter(a => a.empId === e.id).length },
        { label: '', render: e => { const r = att.find(a => a.empId === e.id); return r?.out ? <Badge tone="ok">Done</Badge> : <Btn size="sm" kind={r ? 'default' : 'primary'} onClick={() => punch(e)}>{r ? 'Punch out' : 'Punch in'}</Btn>; } },
      ]} /></div>
      <p className="small muted">On the store PC, staff punch in at the counter. A fingerprint or face reader can be connected so nobody punches in for someone else.</p>
    </div>
  );
}

function Salary() {
  const { settings, user } = useApp();
  const toast = useToast();
  const cfg = settings.payroll || {};
  const [month, setMonth] = useState(monthKey(new Date()));
  const emps = useLive(() => db.employees.filter(e => e.active !== false).toArray(), [], []);
  const att = useLive(() => db.attendance.where('date').startsWith(month).toArray(), [month], []);
  const runs = useLive(() => db.payroll.where('month').equals(month).toArray(), [month], []);
  const rows = useMemo(() => emps.map(e => computePay(e, month, att, cfg)), [emps, att, month, cfg]);
  const done = runs.length > 0;
  const [slip, setSlip] = useState(null);
  const T = k => r2(sum(rows, r => r[k]));
  // One salary run per month, even if two devices press the button (checked again just before saving).
  const run = () => withLock('payroll', async () => {
    if (await db.payroll.where('month').equals(month).count()) { toast(`Salary for ${month} is already booked.`, 'warn'); return; }
    for (const r of rows) await db.payroll.add({ id: uid('pr_'), ...r, status: 'unpaid', createdAt: Date.now() });
    await post({ ref: 'SAL-' + month, type: 'salary', narration: `Salary for ${month}`, lines: [
      { acc: 'salary', dr: T('gross') }, { acc: 'pf_er', dr: r2(T('pfEr') + T('esiEr')) },
      { acc: 'pf_payable', cr: r2(T('pfEmp') + T('pfEr')) }, { acc: 'esi_payable', cr: r2(T('esiEmp') + T('esiEr')) }, { acc: 'pt_payable', cr: T('pt') }, { acc: 'salary_payable', cr: T('net') },
    ] });
    await audit('payroll_run', { month, net: T('net') }, user);
    toast(`Salary for ${month} worked out and booked. Mark it paid once the bank transfer is done.`);
  });
  // Only the staff not paid yet are paid (and booked) — never the same salary twice.
  const pay = () => withLock('payroll', async () => {
    const unpaid = (await db.payroll.where('month').equals(month).toArray()).filter(x => x.status !== 'paid');
    if (!unpaid.length) return;
    for (const r of unpaid) await db.payroll.update(r.id, { status: 'paid', paidAt: Date.now() });
    const amt = r2(sum(unpaid, r => r.net));
    if (amt) await post({ ref: 'SALPAY-' + month, type: 'payment', narration: `Salary paid for ${month}`, lines: [{ acc: 'salary_payable', dr: amt }, { acc: 'bank', cr: amt }] });
    toast('Marked as paid.');
  });
  const list = done ? runs : rows;
  return (
    <div className="stack">
      <div className="row gap-s wrap" style={{ alignItems: 'flex-end' }}>
        <Input label="Month" type="month" value={month} onChange={e => setMonth(e.target.value)} id="sal-month" />
        {!done ? <Btn kind="primary" onClick={run} disabled={!rows.length}>Run salary for {month}</Btn> : runs.some(r => r.status !== 'paid') ? <Btn kind="primary" onClick={pay}>Mark all paid (bank)</Btn> : <Badge tone="ok">Paid</Badge>}
      </div>
      <div className="grid g4"><Stat label="Gross salary" value={inr(T('gross'), 0)} /><Stat label="PF (staff + store)" value={inr(T('pfEmp') + T('pfEr'), 0)} /><Stat label="ESI (staff + store)" value={inr(T('esiEmp') + T('esiEr'), 0)} /><Stat label="Net to pay" value={inr(T('net'), 0)} /></div>
      <div className="card"><Table rows={list.map(r => ({ ...r, id: r.id || r.empId }))} onRow={setSlip} cols={[
        { label: 'Staff', key: 'name' }, { label: 'Paid days', num: true, render: r => `${r.paidDays}/${r.dim}` },
        { label: 'Gross', num: true, render: r => inr(r.gross) }, { label: 'PF', num: true, render: r => inr(r.pfEmp) }, { label: 'ESI', num: true, render: r => inr(r.esiEmp) },
        { label: 'Prof. tax', num: true, render: r => inr(r.pt) }, { label: 'Net', num: true, render: r => <b>{inr(r.net)}</b> },
        { label: '', render: r => r.status ? <Badge tone={r.status === 'paid' ? 'ok' : 'warn'}>{r.status}</Badge> : <span className="small muted">preview</span> },
      ]} /></div>
      <p className="small muted">Paid days = days present + weekly offs (Sundays). Rates come from Settings › Salary rules; please confirm them with your accountant. Tap a row for the payslip.</p>
      {slip && <Payslip r={slip} settings={settings} onClose={() => setSlip(null)} />}
    </div>
  );
}

function Payslip({ r, settings, onClose }) {
  const emp = useLive(() => db.employees.get(r.empId), [r.empId], null);
  const text = `*Payslip ${r.month}* — ${settings.storeName}\n${r.name}\nPaid days ${r.paidDays}/${r.dim}\n\nBasic ${inr(r.basic)}\nHRA ${inr(r.hra)}\nAllowance ${inr(r.allow)}\n*Gross ${inr(r.gross)}*\n\nPF −${inr(r.pfEmp)}\nESI −${inr(r.esiEmp)}\nProf. tax −${inr(r.pt)}\n*Net pay ${inr(r.net)}*`;
  return (
    <Modal title={`Payslip · ${r.name} · ${r.month}`} onClose={onClose} footer={<a className="btn btn-primary" href={waLink(emp?.phone || '', text)} target="_blank" rel="noreferrer">Send on WhatsApp</a>}>
      <div className="stack">
        {[['Paid days', `${r.paidDays} of ${r.dim}`], ['Basic', inr(r.basic)], ['HRA', inr(r.hra)], ['Allowance', inr(r.allow)], ['Gross', inr(r.gross)], ['PF (12%)', '−' + inr(r.pfEmp)], ['ESI', '−' + inr(r.esiEmp)], ['Professional tax', '−' + inr(r.pt)], ['Net pay', inr(r.net)], ['Store also pays PF', inr(r.pfEr)], ['Store also pays ESI', inr(r.esiEr)]].map(([k, v]) => <div className="row between" key={k}><span>{k}</span><b className="mono">{v}</b></div>)}
      </div>
    </Modal>
  );
}

function Team() {
  const toast = useToast();
  const emps = useLive(() => db.employees.toArray(), [], []);
  const [edit, setEdit] = useState(null);
  const save = async () => {
    if (!edit.name) return;
    await db.employees.put({ ...edit, id: edit.id || uid('e_'), basic: Number(edit.basic) || 0, hra: Number(edit.hra) || 0, allowance: Number(edit.allowance) || 0 });
    toast('Saved.'); setEdit(null);
  };
  return (
    <div className="stack">
      <div><Btn kind="primary" onClick={() => setEdit({ name: '', role: '', basic: '', hra: '', allowance: '', phone: '', pfOn: true, esiOn: true, active: true, joined: todayISO() })}>Add staff</Btn></div>
      <div className="card"><Table rows={emps} onRow={e => setEdit({ ...e })} cols={[{ label: 'Name', key: 'name' }, { label: 'Role', key: 'role' }, { label: 'Monthly gross', num: true, render: e => inr(Number(e.basic) + Number(e.hra) + Number(e.allowance)) }, { label: 'PF / ESI', render: e => `${e.pfOn ? 'PF' : '—'} / ${e.esiOn ? 'ESI' : '—'}` }, { label: 'Joined', key: 'joined' }, { label: '', render: e => e.active === false ? <Badge>Left</Badge> : null }]} /></div>
      {edit && <Modal title={edit.id ? edit.name : 'New staff member'} onClose={() => setEdit(null)} footer={<><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn kind="primary" onClick={save}>Save</Btn></>}>
        <div className="grid g2">
          <Input label="Name" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} id="e-name" />
          <Input label="Role" value={edit.role} onChange={e => setEdit({ ...edit, role: e.target.value })} id="e-role" />
          <Input label="Basic (₹/month)" type="number" value={edit.basic} onChange={e => setEdit({ ...edit, basic: e.target.value })} id="e-basic" />
          <Input label="HRA (₹/month)" type="number" value={edit.hra} onChange={e => setEdit({ ...edit, hra: e.target.value })} id="e-hra" />
          <Input label="Other allowance (₹/month)" type="number" value={edit.allowance} onChange={e => setEdit({ ...edit, allowance: e.target.value })} id="e-allow" />
          <Input label="WhatsApp number" value={edit.phone} onChange={e => setEdit({ ...edit, phone: e.target.value })} id="e-phone" />
          <Input label="Joined on" type="date" value={edit.joined} onChange={e => setEdit({ ...edit, joined: e.target.value })} id="e-joined" />
          <div className="stack"><label className="check"><input type="checkbox" checked={!!edit.pfOn} onChange={e => setEdit({ ...edit, pfOn: e.target.checked })} /> PF applies</label><label className="check"><input type="checkbox" checked={!!edit.esiOn} onChange={e => setEdit({ ...edit, esiOn: e.target.checked })} /> ESI applies</label><label className="check"><input type="checkbox" checked={edit.active !== false} onChange={e => setEdit({ ...edit, active: e.target.checked })} /> Currently working</label></div>
        </div>
        <p className="small muted" style={{ marginTop: 10 }}>Bank and ID details (PAN, Aadhaar) are best kept in your payroll provider or bank portal, not here.</p>
      </Modal>}
    </div>
  );
}
