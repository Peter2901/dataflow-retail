import React, { useState, useEffect } from 'react';
import { db, setSetting, resetAll } from '../db.js';
import { useApp, useLive, useToast, useConfirm, PageHead, Table, Btn, Modal, Input, Select, Card, Tabs, Badge } from '../ui/kit.jsx';
import { hashPin, validGSTIN, uid, fyOf } from '../lib/util.js';
import { audit } from '../lib/sales.js';
import { testConnection, pushEverything, syncOnce, getStatus, onSyncStatus, SETUP_SQL, ownerSetupCode, OWNER_WEB_URL, OWNER_APK_URL, prepareForPhones } from '../lib/sync.js';
import QRCode from 'qrcode';
import { waLink, num } from '../lib/util.js';
import { scanUsageThisMonth, readWithAI, smartScanConfig } from '../lib/billreader.js';
import READ_BILL_CODE from '../../supabase/functions/dataflow-ai/index.ts?raw';
import { aiUsageThisMonth } from '../lib/smartai.js';

export default function Settings() {
  const [tab, setTab] = useState('store');
  return (
    <div className="stack">
      <PageHead title="Settings" />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'store', label: 'Store & GST' }, { value: 'users', label: 'Users & PINs' }, { value: 'sync', label: 'Cloud sync' }, { value: 'scan', label: 'AI & Smart Scan' }, { value: 'loyalty', label: 'Loyalty & credit' }, { value: 'payroll', label: 'Salary rules' }, { value: 'stores', label: 'Stores' }, { value: 'system', label: 'Look & data' }]} />
      {tab === 'store' && <StoreSettings />}
      {tab === 'users' && <Users />}
      {tab === 'sync' && <SyncSettings />}
      {tab === 'scan' && <SmartScanSettings />}
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

function SyncSettings() {
  const { user, settings } = useApp();
  const toast = useToast();
  const [f, setF] = useState({ syncUrl: settings.syncUrl || '', syncKey: settings.syncKey || '' });
  const [st, setSt] = useState(getStatus());
  const [busy, setBusy] = useState('');
  const [result, setResult] = useState(null);
  useEffect(() => onSyncStatus(setSt), []);
  const save = async (enable) => {
    await setSetting('syncUrl', f.syncUrl.trim().replace(/\/+$/, ''));
    await setSetting('syncKey', f.syncKey.trim());
    if (enable !== undefined) await setSetting('syncEnabled', enable);
    await audit('settings', { section: 'sync', enabled: enable }, user);
  };
  const test = async () => { setBusy('test'); await save(); setResult(await testConnection()); setBusy(''); };
  const turnOn = async () => { setBusy('on'); await save(true); setResult(await testConnection()); await syncOnce(); setBusy(''); toast('Sync turned on.'); };
  const turnOff = async () => { await save(false); toast('Sync turned off. Billing still works.'); };
  const seed = async () => { setBusy('seed'); await save(true); await pushEverything(); setBusy(''); toast('Sent this counter’s data to the cloud.'); };
  const copySql = () => { navigator.clipboard?.writeText(SETUP_SQL).then(() => toast('SQL copied.')).catch(() => {}); };
  const when = st.lastSync ? new Date(st.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—';
  return (
    <div className="stack">
      <Card title="Cloud sync (keep all counters in step)">
        <p className="small muted" style={{ marginTop: 0 }}>
          Free with a Supabase project. Every counter sends its bills and stock changes to one online database and pulls the others’.
          Each counter still bills with no internet and catches up when it is back. Give every counter the <b>same</b> Project URL and key, but a <b>different</b> counter code (T1, T2…).
        </p>
        <div className="grid g2">
          <Input label="Supabase Project URL" value={f.syncUrl} onChange={e => setF({ ...f, syncUrl: e.target.value })} hint="e.g. https://abcdxyz.supabase.co" id="sy-url" />
          <Input label="anon public key" type="password" value={f.syncKey} onChange={e => setF({ ...f, syncKey: e.target.value })} hint="Project Settings › API › anon public" id="sy-key" />
        </div>
        <div className="row gap-s" style={{ marginTop: 12, flexWrap: 'wrap' }}>
          <Btn onClick={test} disabled={!!busy}>{busy === 'test' ? 'Checking…' : 'Test connection'}</Btn>
          {!settings.syncEnabled
            ? <Btn kind="primary" onClick={turnOn} disabled={!!busy}>{busy === 'on' ? 'Turning on…' : 'Turn sync on'}</Btn>
            : <Btn kind="danger" onClick={turnOff}>Turn sync off</Btn>}
          <Btn onClick={seed} disabled={!!busy}>{busy === 'seed' ? 'Sending…' : 'Send this counter’s data to cloud'}</Btn>
        </div>
        {result && <p className={`note ${result.ok ? '' : ''}`} style={{ marginTop: 12 }}>{result.ok ? '✅ ' : '⚠️ '}{result.msg}</p>}
      </Card>
      <Card title="Status">
        <div className="grid g3">
          <Stat label="Sync" value={settings.syncEnabled ? (st.online ? 'On' : 'On (offline)') : 'Off'} />
          <Stat label="Waiting to send" value={String(st.pending || 0)} />
          <Stat label="Last synced" value={when} />
        </div>
        {st.error ? <p className="small" style={{ color: 'var(--bad)', marginTop: 10 }}>Last error: {st.error}</p> : null}
      </Card>
      {settings.syncUrl && settings.syncKey && <OwnerPhone />}
      <Card title="One-time setup in Supabase">
        <p className="small muted" style={{ marginTop: 0 }}>In Supabase open <b>SQL Editor</b>, paste this once and press <b>Run</b>. It makes the shared table the app uses.</p>
        <pre className="mono" style={{ background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 8, padding: 12, overflowX: 'auto', fontSize: 12, whiteSpace: 'pre-wrap' }}>{SETUP_SQL}</pre>
        <Btn onClick={copySql} style={{ marginTop: 8 }}>Copy SQL</Btn>
      </Card>
    </div>
  );
}

// Owner's phone: live view of sales, counters, stock and bills (reads the cloud only).
function OwnerPhone() {
  const { settings } = useApp();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [qr, setQr] = useState('');
  const [prep, setPrep] = useState('');
  useEffect(() => {
    ownerSetupCode().then(c => {
      setCode(c);
      if (c) QRCode.toDataURL(c, { margin: 1, width: 220 }).then(setQr).catch(() => setQr(''));
    });
  }, [settings.syncUrl, settings.syncKey, settings.currentStore, settings.storeName]);
  // The first time: send users, staff, settings and history up once, so phones get the full store.
  useEffect(() => {
    if (!code || !settings.syncEnabled) return;
    if ((settings.terminal || 'T1') !== 'T1') { setPrep('Open this card once on the main counter (T1) so it shares the users and store settings.'); return; }
    setPrep('Sharing the full store for phones…');
    prepareForPhones().then(did => setPrep(did ? 'Store shared for phones.' : '')).catch(e => setPrep('Could not share yet: ' + e.message));
  }, [code, settings.syncEnabled, settings.terminal]);
  if (!code) return null;
  const msg = `DataFlow Retail phone app for ${settings.storeName || 'the store'} (everything except billing)\n\n1) Install the Android app: ${OWNER_APK_URL}\n2) Open it and paste this setup code:\n\n${code}\n\nLight live view without installing: ${OWNER_WEB_URL}#setup=${code}`;
  const copy = () => navigator.clipboard?.writeText(code).then(() => toast('Setup code copied.')).catch(() => toast('Select the code and copy it.', 'bad'));
  return (
    <Card title="Phone app (Android) — the whole store except billing">
      <div className="row gap-s" style={{ alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {qr && <img src={qr} alt="QR code with the phone app setup code" width="150" height="150" style={{ borderRadius: 8, background: '#fff', padding: 4 }} />}
        <div className="stack" style={{ flex: 1, minWidth: 240 }}>
          <p className="small muted" style={{ margin: 0 }}>
            On the phone: dashboard, Smart insights, products, stock, expiry, purchases with Smart Scan (take the bill photo on the phone), customers, udhaar, accounts, reports, staff and settings.
            Log in with the same PINs as the counters. Changes made on the phone reach the counters within seconds.
          </p>
          <div className="row gap-s" style={{ flexWrap: 'wrap' }}>
            <a className="btn btn-primary" href={waLink(settings.ownerPhone || '', msg)} target="_blank" rel="noreferrer">Share on WhatsApp</a>
            <Btn onClick={copy}>Copy setup code</Btn>
            <a className="btn" href={OWNER_APK_URL} target="_blank" rel="noreferrer">Download Android app</a>
          </div>
          {prep && <p className="small" style={{ margin: 0 }}>{prep}</p>}
          <p className="small muted" style={{ margin: 0 }}>The setup code contains this store’s cloud key. Share it only with the owner and managers.</p>
        </div>
      </div>
    </Card>
  );
}

function Stat({ label, value }) {
  return <div className="stat"><div className="small muted">{label}</div><div style={{ fontSize: 20, fontWeight: 700 }}>{value}</div></div>;
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
    // Kept users are not sent to the cloud: if this counter is joining a store, the real users come down instead.
    await db.syncMeta.put({ key: 'push:users', v: Date.now() + 60000 });
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

function SmartScanSettings() {
  const toast = useToast();
  const saved = useLive(async () => (await db.settings.get('smartScan'))?.value || {}, [], null);
  const usage = useLive(() => scanUsageThisMonth(), [], null);
  const [f, setF] = useState(null);
  const [test, setTest] = useState('');
  useEffect(() => { if (saved && !f) setF({ ai: saved.ai || 'off', scanKey: saved.scanKey || '' }); }, [saved, f]);
  if (!f) return null;
  const save = async () => { await setSetting('smartScan', f); toast('Smart Scan settings saved.'); };
  const runTest = async () => {
    setTest('Testing…');
    try {
      const c = document.createElement('canvas'); c.width = 600; c.height = 220;
      const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 600, 220); x.fillStyle = '#000'; x.font = '22px Arial';
      ['TAX INVOICE  No: T-1  Date: 01/10/2026', 'Item          Qty   Rate    Amount', 'Test Biscuit 100g  2   10.00   20.00', 'Grand Total                 21.00'].forEach((t, i) => x.fillText(t, 20, 40 + i * 45));
      const conf = { ...(await smartScanConfig()), scanKey: f.scanKey };
      const r = await readWithAI([c], conf);
      setTest(`Working: ${r.provider} ${r.model} read ${r.data?.lines?.length ?? 0} line(s) using ${num((r.usage?.input || 0) + (r.usage?.output || 0))} tokens.`);
    } catch (e) { setTest('Not working yet: ' + e.message); }
  };
  const copy = () => navigator.clipboard?.writeText(READ_BILL_CODE).then(() => toast('Function code copied.')).catch(() => {});
  return (
    <div className="stack">
       <Card title="How AI is used">
        <div className="stack">
          <p className="small muted">Every smart feature tries plain code on this device first (free, works offline). AI is used only when the code is not sure — for example a bill whose totals don’t match, a handwritten khata page, or a question the app’s reports don’t cover. With AI off, everything else keeps working.</p>
          <Select label="AI" value={f.ai} onChange={e => setF({ ...f, ai: e.target.value })} id="ss-ai" options={[
            { value: 'off', label: 'Off — free code only (Basic plan)' },
            { value: 'auto', label: 'Code first, AI only if not sure (recommended)' },
            { value: 'always', label: 'Bills always read by AI (most accurate)' }]} />
          <Input label="Smart Scan key (only if you set SCAN_KEY in Supabase)" value={f.scanKey} onChange={e => setF({ ...f, scanKey: e.target.value })} id="ss-key" />
          <div className="row gap-s"><Btn kind="primary" onClick={save}>Save</Btn>{f.ai !== 'off' && <Btn onClick={runTest}>Test AI reading</Btn>}{test && <span className="small">{test}</span>}</div>
        </div>
      </Card>
      <Card title="This month">
        {usage && <div className="grid g4">
          <Stat label="Bills scanned" value={usage.bills} /><Stat label="Read free on device" value={usage.free} /><Stat label="Read by AI" value={usage.ai} /><Stat label="AI calls on this device" value={`${aiUsageThisMonth().calls} · ${num(aiUsageThisMonth().tokens)} tokens`} />
        </div>}
      </Card>
      <Card title="Turn on AI reading (one time, in Supabase)" actions={<Btn size="sm" onClick={copy}>Copy function code</Btn>}>
        <ol className="small" style={{ lineHeight: 1.7, paddingLeft: 18 }}>
          <li>Supabase › your project › <b>Edge Functions</b> › <b>Deploy a new function</b> › “Via editor”. Name it <b>dataflow-ai</b>.</li>
          <li>Paste the function code (button above). In the function settings turn <b>Verify JWT</b> off. Deploy.</li>
          <li>Edge Functions › <b>Secrets</b>: add <b>XAI_API_KEY</b> = your key from the xAI console (type it there yourself — never in chat or in this app).</li>
          <li>Optional secrets: <b>AI_MODEL</b> (exact model name from the xAI console), <b>AI_PROVIDER</b> (xai, anthropic, gemini or openai — to switch companies later), <b>SCAN_KEY</b> (any password; then type the same here).</li>
          <li>Set “AI reading” above to “Free first, AI only if not sure”, save, and press <b>Test AI reading</b>.</li>
        </ol>
      </Card>
    </div>
  );
}
