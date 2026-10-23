import React, { useState } from 'react';
import { db, setSetting } from '../db.js';
import { useApp, useLive, useToast, useConfirm, PageHead, Table, Btn, Card, Stat, Badge, Tabs, Input } from '../ui/kit.jsx';
import { readSheet, mapProducts, checkProducts, templateFile } from '../lib/excel.js';
import { post, partyAccount } from '../lib/accounts.js';
import { audit } from '../lib/sales.js';
import { inr, r2, sum, uid, todayISO, download, validEAN } from '../lib/util.js';
import { readScaleWeight, serialSupported } from '../lib/hardware.js';

export default function Setup() {
  const { param } = useApp();
  const [tab, setTab] = useState(param?.tab || 'products');
  return (
    <div className="stack">
      <PageHead title="Import & setup" sub="Bring in your item list and balances, check them, and connect the counter hardware" />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'products', label: '1. Product list' }, { value: 'balances', label: '2. Customer balances' }, { value: 'hardware', label: '3. Counter hardware' }, { value: 'backup', label: 'Backup & restore' }]} />
      {tab === 'products' && <ImportProducts />}
      {tab === 'balances' && <ImportBalances />}
      {tab === 'hardware' && <Hardware />}
      {tab === 'backup' && <Backup />}
    </div>
  );
}

function ImportProducts() {
  const { storeId, user } = useApp();
  const toast = useToast();
  const [res, setRes] = useState(null);
  const [file, setFile] = useState('');
  const [cols, setCols] = useState({});
  const [show, setShow] = useState('errors');
  const [busy, setBusy] = useState(false);
  const load = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    const { rows } = await readSheet(f);
    const { mapped, columns } = mapProducts(rows);
    const existing = await db.products.toArray();
    setRes(checkProducts(mapped, existing)); setCols(columns); setFile(f.name);
  };
  // Saves in big batches inside one transaction: fast for 20,000+ products, and all-or-nothing.
  const importGood = async () => {
    setBusy(true);
    const good = res.rows.filter(r => !r.errors.length);
    let value = 0;
    const today = todayISO(), now = Date.now();
    const prods = [], bats = [], moves = [];
    for (const r of good) {
      const id = r.id || 'SKU' + uid('').slice(-7).toUpperCase() + prods.length.toString(36).toUpperCase();
      prods.push({ id, barcode: r.barcode, name: r.name, ...(r.localName ? { localName: r.localName } : {}), category: r.category, subCategory: r.subCategory, brand: r.brand, uom: r.uom, packSize: r.packSize, hsn: r.hsn, gst: r.gst, mrp: r.mrp || r.price, price: r.price, cost: r.cost, casePack: r.casePack, ...(r.units ? { units: r.units } : {}), ...(r.prices ? { prices: r.prices } : {}), ...(r.wholesale ? { wholesale: r.wholesale } : {}), rack: r.rack, reorderMin: r.reorderMin, reorderMax: r.reorderMax, vendorId: r.vendorId, plu: r.plu, loose: r.loose, batchTracked: true, active: true });
      if (r.openingStock > 0) {
        const bid = uid('b_');
        bats.push({ id: bid, productId: id, storeId, batchNo: r.batchNo || 'OPENING', mfg: null, expiry: r.expiry || null, qty: r.openingStock, cost: Number(r.cost) || 0, mrp: r.mrp || null, status: r.expiry && r.expiry < today ? 'quarantine' : 'active', receivedAt: now });
        moves.push({ ts: now, productId: id, batchId: bid, storeId, qty: r.openingStock, type: 'purchase', ref: 'IMPORT', note: '' });
        value += r.openingStock * r.cost;
      }
    }
    try {
      await db.transaction('rw', db.products, db.batches, db.stockMoves, async () => {
        for (let i = 0; i < prods.length; i += 2000) await db.products.bulkPut(prods.slice(i, i + 2000));
        for (let i = 0; i < bats.length; i += 2000) await db.batches.bulkAdd(bats.slice(i, i + 2000));
        for (let i = 0; i < moves.length; i += 2000) await db.stockMoves.bulkAdd(moves.slice(i, i + 2000));
      });
    } catch (e) { toast('Nothing was loaded: ' + e.message, 'bad'); setBusy(false); return; }
    if (value) await post({ ref: 'IMPORT', type: 'opening', narration: `Opening stock from ${file}`, lines: [{ acc: 'inventory', dr: r2(value) }, { acc: 'capital', cr: r2(value) }] });
    await audit('import', { file, products: good.length, value: r2(value) }, user);
    toast(`${good.length} products loaded with ${inr(value, 0)} of opening stock.`);
    setRes(null); setBusy(false);
  };
  const rows = res ? res.rows.filter(r => show === 'all' || (show === 'errors' ? r.errors.length : !r.errors.length && r.warnings.length)) : [];
  return (
    <div className="stack">
      <Card title="Load the product Excel">
        <p className="small muted">Works with the 'Sameer Excel Final 15OCT.xlsx' layout (SKU_CODE, BARCODE_EAN, ITEM_NAME … GST_RATE_PCT, PURCHASE_RATE, MRP, SELLING_PRICE, OPENING_STOCK, RACK_LOCATION) and similar sheets. Add BATCH_NO and EXPIRY_DATE columns to load expiry for opening stock. Nothing is saved until you press Load.</p>
        <div className="row gap-s wrap" style={{ marginTop: 10 }}>
          <label className="btn btn-primary">Choose Excel file<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={load} /></label>
          <Btn onClick={templateFile}>Download a template</Btn>
        </div>
      </Card>
      {res && <>
        <div className="grid g4">
          <Stat label="Ready to load" value={res.ok} tone="ok" />
          <Stat label="With errors (skipped)" value={res.withErrors} tone={res.withErrors ? 'bad' : undefined} />
          <Stat label="With warnings" value={res.withWarnings} tone={res.withWarnings ? 'warn' : undefined} />
          <Stat label="Old GST rate (12% / 28%)" value={res.gstOld} tone={res.gstOld ? 'bad' : undefined} sub={res.gstOld ? 'Fix in Excel: now 5%, 18% or 40%' : ''} />
        </div>
        <Card title={`Checked: ${file}`} actions={<><Btn size="sm" kind={show === 'errors' ? 'primary' : 'default'} onClick={() => setShow('errors')}>Errors</Btn><Btn size="sm" kind={show === 'warn' ? 'primary' : 'default'} onClick={() => setShow('warn')}>Warnings</Btn><Btn size="sm" kind={show === 'all' ? 'primary' : 'default'} onClick={() => setShow('all')}>All</Btn></>}>
          <p className="small muted" style={{ marginBottom: 8 }}>Columns found: {Object.entries(cols).map(([k, v]) => `${v} → ${k}`).join(' · ')}</p>
          <Table rows={rows.slice(0, 300)} keyField="row" empty="Nothing in this view." cols={[
            { label: 'Row', num: true, key: 'row' }, { label: 'Item', render: r => <><b>{r.name || '—'}</b><div className="small muted">{r.barcode} · GST {r.gst ?? '—'}% · ₹{r.price} (MRP {r.mrp})</div></> },
            { label: 'Problems', render: r => <div className="stack" style={{ gap: 4 }}>{r.errors.map((e, i) => <Badge key={'e' + i} tone="bad">{e}</Badge>)}{r.warnings.map((w, i) => <Badge key={'w' + i} tone="warn">{w}</Badge>)}{!r.errors.length && !r.warnings.length && <Badge tone="ok">OK</Badge>}</div> },
          ]} />
          <div className="row gap-s" style={{ marginTop: 12 }}><Btn kind="primary" disabled={!res.ok || busy} onClick={importGood}>{busy ? 'Loading…' : `Load ${res.ok} good products`}</Btn><span className="small muted">Fix rows with errors in Excel and load the file again — already-loaded products are matched by SKU.</span></div>
        </Card>
      </>}
    </div>
  );
}

function ImportBalances() {
  const { user } = useApp();
  const toast = useToast();
  const [rows, setRows] = useState(null);
  const load = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    const { rows } = await readSheet(f);
    const g = (r, ns) => { const k = Object.keys(r).find(h => ns.some(n => h.toUpperCase().includes(n))); return k ? r[k] : ''; };
    setRows(rows.map((r, i) => ({ id: i, name: String(g(r, ['NAME', 'PARTY'])).trim(), phone: String(g(r, ['MOBILE', 'PHONE'])).replace(/\D/g, '').slice(-10), due: Number(g(r, ['BALANCE', 'DUE', 'OUTSTANDING'])) || 0 })).filter(r => r.name));
  };
  const save = async () => {
    let n = 0;
    for (const r of rows) {
      let c = r.phone ? await db.customers.where('phone').equals(r.phone).first() : null;
      if (!c) { c = { id: uid('c_'), name: r.name, phone: r.phone || '0000000000', yearSpend: 0, lifeSpend: 0, points: 0, visits: 0, creditLimit: Math.max(2000, r.due), gstin: '', consentWhatsApp: !!r.phone, createdAt: Date.now() }; await db.customers.add(c); }
      if (r.due > 0) { await post({ ref: 'OPENING', type: 'opening', narration: `Opening due: ${c.name}`, lines: [{ acc: await partyAccount('cust', c), dr: r.due }, { acc: 'capital', cr: r.due }] }); n++; }
    }
    await audit('import_balances', { customers: rows.length, withDues: n }, user);
    toast(`${rows.length} customers loaded, ${n} with opening dues.`); setRows(null);
  };
  return (
    <div className="stack">
      <Card title="Customer list and old dues (udhaar)">
        <p className="small muted">An Excel with NAME, MOBILE and BALANCE columns — for example an export of the outstanding report from Marg or Tally.</p>
        <label className="btn btn-primary" style={{ marginTop: 10, width: 'fit-content' }}>Choose file<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={load} /></label>
      </Card>
      {rows && <Card title={`${rows.length} customers · ${inr(sum(rows, r => r.due), 0)} total dues`} actions={<Btn kind="primary" onClick={save}>Load</Btn>}>
        <Table rows={rows} cols={[{ label: 'Name', key: 'name' }, { label: 'Mobile', render: r => r.phone || <Badge tone="warn">missing</Badge> }, { label: 'Due', num: true, render: r => inr(r.due) }]} />
      </Card>}
    </div>
  );
}

function Hardware() {
  const [scan, setScan] = useState('');
  const [w, setW] = useState('');
  return (
    <div className="grid g2">
      <Card title="Barcode scanner">
        <p className="small muted">USB scanners type like a keyboard. Click the box and scan any product.</p>
        <input className="input" style={{ marginTop: 10 }} value={scan} onChange={e => setScan(e.target.value)} placeholder="Scan here to test" aria-label="Scanner test" id="hw-scan" />
        {scan.length >= 8 && <p className="small" style={{ marginTop: 6 }}>Read “{scan}” · {validEAN(scan) ? <Badge tone="ok">valid EAN</Badge> : <Badge tone="warn">not an EAN barcode</Badge>}</p>}
      </Card>
      <Card title="Weighing scale">
        <p className="small muted">{serialSupported() ? 'Connect the scale by USB/RS-232, then press Read. Chrome asks which port to use the first time.' : 'Scale reading needs Chrome on the counter PC (installed app). Staff can type weights meanwhile.'}</p>
        {serialSupported() && <div className="row gap-s" style={{ marginTop: 10 }}><Btn onClick={async () => { try { setW((await readScaleWeight()) + ' kg'); } catch (e) { setW(e.message); } }}>Read weight</Btn><span>{w}</span></div>}
      </Card>
      <Card title="Receipt printer (80 mm)">
        <p className="small">Set the thermal printer as the default printer in Windows with paper size 80 mm. Receipts print from the bill screen. For no print dialog at all, start Chrome with <span className="mono">--kiosk-printing</span>.</p>
      </Card>
      <Card title="Cash drawer, customer display, label printer">
        <p className="small">The drawer opens from the receipt printer’s kick port. Shelf labels print from Products › Print shelf labels on a label printer or A4 sticker sheet. Every no-sale drawer opening needs a manager PIN and is logged.</p>
      </Card>
    </div>
  );
}

function Backup() {
  const { settings } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [pw, setPw] = useState('');
  const [rpw, setRpw] = useState('');
  const [busy, setBusy] = useState('');
  const [file, setFile] = useState(null);
  const backup = async () => {
    setBusy('Making backup…');
    try {
      const { makeBackup } = await import('../lib/backup.js');
      const b = await makeBackup({ password: pw, storeName: settings.storeName, onProgress: n => setBusy(`Making backup… ${n.toLocaleString('en-IN')} records`) });
      download(b.name, b.blob, 'application/octet-stream');
      await setSetting('backupAt', Date.now());
      toast(`Backup ready: ${b.rows.toLocaleString('en-IN')} records${pw ? ', locked with your password' : ''}.`);
    } catch (e) { toast('Backup failed: ' + e.message, 'bad'); }
    setBusy('');
  };
  const restore = async () => {
    if (!file) return;
    setBusy('Checking the backup…');
    try {
      const { checkBackup, restoreBackup } = await import('../lib/backup.js');
      const c = await checkBackup(file, rpw);
      const when = c.header.at ? new Date(c.header.at).toLocaleString('en-IN') : 'unknown date';
      setBusy('');
      if (!(await confirm(`Backup from ${when}${c.header.store ? ` (${c.header.store})` : ''}: ${c.rows.toLocaleString('en-IN')} records — ${c.counts.sales || 0} bills, ${c.counts.products || 0} products, ${c.counts.customers || 0} customers. Replace EVERYTHING on this device with it? This device’s own settings (counter code, cloud keys) are kept.`, 'Restore'))) return;
      setBusy('Restoring…');
      await restoreBackup(c, n => setBusy(`Restoring… ${n.toLocaleString('en-IN')} records`));
      toast('Backup restored. Opening it…');
      setTimeout(() => location.reload(), 800);
    } catch (e) { toast(e.message, 'bad'); }
    setBusy('');
  };
  const last = settings.backupAt ? new Date(settings.backupAt).toLocaleString('en-IN') : 'never on this device';
  return (
    <div className="grid g2">
      <Card title="Backup">
        <p className="small muted">Saves every bill, product, customer and entry in one small file. Keep a copy off the counter PC (pen drive or Google Drive). The Windows app also saves one by itself every day in Documents › DataFlow Retail Backups (last 14 kept). Cloud and AI keys are never in a backup.</p>
        <p className="small">Last backup: <b>{last}</b></p>
        <div className="row gap-s wrap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <Input label="Password to lock it (optional)" type="password" value={pw} onChange={e => setPw(e.target.value)} id="bk-pw" />
          <Btn kind="primary" onClick={backup} disabled={!!busy}>Download backup</Btn>
        </div>
        {pw && <p className="small muted">Write the password down. Without it the backup cannot be opened — not even by us.</p>}
      </Card>
      <Card title="Restore">
        <p className="small muted">The whole file is checked first; nothing changes if it is damaged or the password is wrong.</p>
        <div className="row gap-s wrap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <label className="btn">{file ? file.name.slice(0, 28) : 'Choose backup file'}<input type="file" accept=".dfrbak,.json,.gz" hidden onChange={e => setFile(e.target.files?.[0] || null)} /></label>
          <Input label="Password (if locked)" type="password" value={rpw} onChange={e => setRpw(e.target.value)} id="bk-rpw" />
          <Btn kind="danger" onClick={restore} disabled={!file || !!busy}>Restore</Btn>
        </div>
      </Card>
      {busy && <div className="note span2">{busy}</div>}
    </div>
  );
}
