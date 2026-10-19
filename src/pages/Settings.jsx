import React, { useState } from 'react';
import { db, setSetting, resetAll } from '../db.js';
import { useApp, useLive, useToast, useConfirm, PageHead, Table, Btn, Modal, Input, Select, Card, Tabs, Badge } from '../ui/kit.jsx';
import { hashPin, validGSTIN, uid, fyOf } from '../lib/util.js';
import { audit } from '../lib/sales.js';

export default function Settings() {
  const [tab, setTab] = useState('store');
  return (
    <div className="stack">
      <PageHead title="Settings" />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'store', label: 'Store & GST' }, { value: 'users', label: 'Users & PINs' }, { value: 'loyalty', label: 'Loyalty & credit' }, { value: 'payroll', label: 'Salary rules' }, { value: 'stores', label: 'Stores' }, { value: 'system', label: 'Look & data' }]} />
      {tab === 'store' && <StoreSettings />}
      {tab === 'users' && <Users />}
      {tab === 'loyalty' && <LoyaltySettings />}
      {tab === 'payroll' && <PayrollSettings />}
      {tab === 'stores' && <Stores />}
      {tab === 'system' && <System />}
    </div>
  );
}

function useForm(keys) {
  const { settings } = useApp();
  const [f, setF] = useState(Object.fromEntries(keys.map(k => [k, settings[k] ?? ''])));
  return [f, k => e => setF({ ...f, [k]: e.target.value })];
}

function StoreSettings() {
  const { user } = useApp();
  const toast = useToast();
  const [f, on] = useForm(['storeName', 'address', 'phone', 'ownerPhone', 'gstin', 'stateCode', 'storeCode', 'terminal', 'upiVpa', 'upiName']);
  const save = async () => {
    if (f.gstin && !validGSTIN(f.gstin)) return toast('That GSTIN does not pass the check.', 'bad');
    if ((f.storeCode + f.terminal).length > 5) return toast('Store code + counter code must be 5 characters or fewer so bill numbers stay within 16 characters.', 'bad');
    for (const [k, v] of Object.entries(f)) await setSetting(k, k === 'gstin' ? v.toUpperCase() : v);
    if (f.gstin) await setSetting('stateCode', f.gstin.slice(0, 2));
    await audit('settings', { section: 'store' }, user);
    toast('Saved.');
  };
  const fy = fyOf();
  return (
    <Card title="Store details (printed on every bill)">
      <div className="grid g3">
        <Input label="Store name" value={f.storeName} onChange={on('storeName')} id="st-name" />
        <Input label="Address" value={f.address} onChange={on('address')} id="st-addr" />
        <Input label="Store phone" value={f.phone} onChange={on('phone')} id="st-phone" />
        <Input label="GSTIN" value={f.gstin} onChange={on('gstin')} hint="The state code is taken from the first two digits" id="st-gstin" />
        <Input label="State code (24 = Gujarat)" value={f.stateCode} onChange={on('stateCode')} id="st-state" />
        <Input label="Owner’s WhatsApp (daily summary)" value={f.ownerPhone} onChange={on('ownerPhone')} id="st-owner" />
        <Input label="Store code" value={f.storeCode} onChange={on('storeCode')} hint="e.g. S1" id="st-code" />
        <Input label="This counter’s code" value={f.terminal} onChange={on('terminal')} hint="e.g. T1, T2 — unique per counter" id="st-term" />
        <Input label="UPI ID for payments" value={f.upiVpa} onChange={on('upiVpa')} id="st-upi" />
        <Input label="Name shown in UPI apps" value={f.upiName} onChange={on('upiName')} id="st-upiname" />
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>Financial year runs 1 April to 31 March (now {fy.label}). Bill numbers look like {f.storeCode}{f.terminal}/{fy.short}/000123 — unique per counter, never more than 16 characters (GST Rule 46).</p>
      <div style={{ marginTop: 12 }}><Btn kind="primary" onClick={save}>Save</Btn></div>
    </Card>
  );
}

const ROLES = { owner: 'Owner — everything', manager: 'Manager — counter, stock, approvals', cashier: 'Cashier — billing only', accountant: 'Accountant — accounts, reports, purchases' };
function Users() {
  const { user } = useApp();
  const toast = useToast();
  const users = useLive(() => db.users.toArray(), [], []);
  const [edit, setEdit] = useState(null);
  const save = async () => {
    if (!edit.name || (!edit.id && !/^\d{4}$/.test(edit.pin || ''))) return toast('Name and a 4-digit PIN are needed.', 'bad');
    const rec = { id: edit.id || uid('u_'), name: edit.name, role: edit.role, disabled: !!edit.disabled, pinHash: edit.pinHash };
    if (edit.pin) {
      const h = await hashPin(edit.pin);
      if (users.some(u => u.pinHash === h && u.id !== rec.id)) return toast('Another user already has that PIN.', 'bad');
      rec.pinHash = h;
    }
    await db.users.put(rec);
    await audit('user_saved', { name: rec.name, role: rec.role }, user);
    if (edit.pin) await setSetting('sampleData', false);
    toast('User saved.'); setEdit(null);
  };
  return (
    <div className="stack">
      <div><Btn kind="primary" onClick={() => setEdit({ name: '', role: 'cashier', pin: '' })}>Add user</Btn></div>
      <div className="card"><Table rows={users} onRow={u => setEdit({ ...u, pin: '' })} cols={[{ label: 'Name', key: 'name' }, { label: 'Role', render: u => ROLES[u.role] }, { label: '', render: u => u.disabled ? <Badge tone="bad">Blocked</Badge> : null }]} /></div>
      <p className="small muted">Change the demo PINs (1111, 2222, 3333, 4444) before real use. PINs are stored as a one-way hash, not as numbers.</p>
      {edit && <Modal title={edit.id ? edit.name : 'New user'} onClose={() => setEdit(null)} footer={<><Btn onClick={() => setEdit(null)}>Cancel</Btn><Btn kind="primary" onClick={save}>Save</Btn></>}>
        <div className="stack">
          <Input label="Name" value={edit.name} onChange={e => setEdit({ ...edit, name: e.target.value })} id="u-name" />
          <Select label="Role" value={edit.role} onChange={e => setEdit({ ...edit, role: e.target.value })} options={Object.entries(ROLES).map(([v, l]) => ({ value: v, label: l }))} id="u-role" />
          <Input label={edit.id ? 'New PIN (leave empty to keep)' : '4-digit PIN'} type="password" inputMode="numeric" maxLength={4} value={edit.pin} onChange={e => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '') })} id="u-pin" />
          {edit.id && edit.id !== user.id && <label className="check"><input type="checkbox" checked={!!edit.disabled} onChange={e => setEdit({ ...edit, disabled: e.target.checked })} /> Block this user</label>}
        </div>
      </Modal>}
    </div>
  );
}

function LoyaltySettings() {
  const toast = useToast();
  const [f, on] = useForm(['pointsPer100', 'pointsMinRedeem', 'pointsMaxPct', 'creditDefaultLimit', 'supervisorRefundLimit', 'writeOffLimit']);
  const save = async () => { for (const [k, v] of Object.entries(f)) await setSetting(k, Number(v)); toast('Saved.'); };
  return (
    <Card title="Loyalty, credit and approval limits">
      <div className="grid g3">
        <Input label="Points per ₹100" type="number" value={f.pointsPer100} onChange={on('pointsPer100')} id="l-rate" />
        <Input label="Points needed before use" type="number" value={f.pointsMinRedeem} onChange={on('pointsMinRedeem')} id="l-min" />
        <Input label="Most of a bill payable by points (%)" type="number" value={f.pointsMaxPct} onChange={on('pointsMaxPct')} id="l-max" />
        <Input label="Default credit limit for new customers (₹)" type="number" value={f.creditDefaultLimit} onChange={on('creditDefaultLimit')} id="l-credit" />
        <Input label="Refunds above this need a manager (₹)" type="number" value={f.supervisorRefundLimit} onChange={on('supervisorRefundLimit')} id="l-refund" />
        <Input label="Write-offs above this need a manager (₹)" type="number" value={f.writeOffLimit} onChange={on('writeOffLimit')} id="l-wo" />
      </div>
      <div style={{ marginTop: 12 }}><Btn kind="primary" onClick={save}>Save</Btn></div>
    </Card>
  );
}

function PayrollSettings() {
  const { settings } = useApp();
  const toast = useToast();
  const [p, setP] = useState(settings.payroll || {});
  const n = k => e => setP({ ...p, [k]: Number(e.target.value) });
  const save = async () => { await setSetting('payroll', p); toast('Saved.'); };
  return (
    <Card title="Statutory salary rules">
      <div className="grid g3">
        <label className="check"><input type="checkbox" checked={!!p.pfOn} onChange={e => setP({ ...p, pfOn: e.target.checked })} /> PF applies</label>
        <Input label="PF rate % (staff and store each)" type="number" value={p.pfRate} onChange={n('pfRate')} id="py-pf" />
        <Input label="PF wage ceiling (₹)" type="number" value={p.pfCap} onChange={n('pfCap')} id="py-cap" />
        <label className="check"><input type="checkbox" checked={!!p.esiOn} onChange={e => setP({ ...p, esiOn: e.target.checked })} /> ESI applies</label>
        <Input label="ESI staff %" type="number" step="0.01" value={p.esiEmp} onChange={n('esiEmp')} id="py-esie" />
        <Input label="ESI store %" type="number" step="0.01" value={p.esiEr} onChange={n('esiEr')} id="py-esir" />
        <Input label="ESI applies up to gross (₹)" type="number" value={p.esiLimit} onChange={n('esiLimit')} id="py-esil" />
        <Input label="Professional tax: from gross (₹)" type="number" value={p.ptSlabs?.[0]?.min} onChange={e => setP({ ...p, ptSlabs: [{ min: Number(e.target.value), amt: p.ptSlabs?.[0]?.amt || 200 }] })} id="py-ptmin" />
        <Input label="Professional tax per month (₹)" type="number" value={p.ptSlabs?.[0]?.amt} onChange={e => setP({ ...p, ptSlabs: [{ min: p.ptSlabs?.[0]?.min || 12000, amt: Number(e.target.value) }] })} id="py-ptamt" />
      </div>
      <p className="small muted" style={{ marginTop: 10 }}>Defaults follow common rules for Gujarat. Rates change from time to time — confirm them with your accountant.</p>
      <div style={{ marginTop: 12 }}><Btn kind="primary" onClick={save}>Save</Btn></div>
    </Card>
  );
}

function Stores() {
  const { settings } = useApp();
  const toast = useToast();
  const stores = useLive(() => db.stores.toArray(), [], []);
  const [name, setName] = useState('');
  return (
    <div className="stack">
      <div className="card"><Table rows={stores} cols={[{ label: 'Store', key: 'name' }, { label: 'Code', key: 'code' }, { label: '', render: s => s.id === settings.currentStore ? <Badge tone="ok">This computer</Badge> : <Btn size="sm" onClick={async () => { await setSetting('currentStore', s.id); toast(`This computer now works as ${s.name}.`); }}>Use on this computer</Btn> }]} /></div>
      <div className="row gap-s" style={{ alignItems: 'flex-end' }}><Input label="New store name" value={name} onChange={e => setName(e.target.value)} id="store-name" /><Btn onClick={async () => { if (!name) return; const n = (await db.stores.count()) + 1; await db.stores.add({ id: 'S' + n, name, code: 'S' + n }); setName(''); }}>Add store</Btn></div>
      <p className="small muted">Products, prices and customers are shared by all stores. Stock, bills and shifts belong to each store. Move stock with Stock › Transfer.</p>
    </div>
  );
}

function System() {
  const { settings, logout } = useApp();
  const confirm = useConfirm();
  const toast = useToast();
  const clearSamples = async () => {
    if (!(await confirm('Delete ALL data on this computer (sample products, bills, customers, accounts) and start with an empty store? Download a backup first if unsure.', 'Start fresh'))) return;
    const keep = await db.users.toArray();
    await resetAll();
    await db.settings.put({ key: 'sampleData', value: false });
    const S = { storeName: settings.storeName, address: settings.address, gstin: settings.gstin, stateCode: settings.stateCode, storeCode: settings.storeCode, terminal: settings.terminal, upiVpa: settings.upiVpa, upiName: settings.upiName, currentStore: 'S1', pointsPer100: 1, pointsMinRedeem: 50, pointsMaxPct: 30, creditDefaultLimit: 2000, expiry: settings.expiry, payroll: settings.payroll, supervisorRefundLimit: 500, writeOffLimit: 10000 };
    for (const [k, v] of Object.entries(S)) await db.settings.put({ key: k, value: v });
    await db.users.bulkPut(keep);
    await db.stores.put({ id: 'S1', name: 'Main Store', code: 'S1' });
    const { ensureChart } = await import('../lib/accounts.js');
    await ensureChart();
    toast('Fresh start. Load your product list in Import & setup.');
    logout();
  };
  return (
    <div className="grid g2">
      <Card title="Look">
        <Select label="Theme" value={settings.theme || 'system'} onChange={e => setSetting('theme', e.target.value)} options={[{ value: 'system', label: 'Same as this device' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} id="sys-theme" />
      </Card>
      <Card title="Start fresh">
        <p className="small muted">Removes the sample data and every bill on this computer. Users and store details are kept.</p>
        <Btn kind="danger" style={{ marginTop: 10 }} onClick={clearSamples}>Delete all data and start fresh</Btn>
      </Card>
    </div>
  );
}
