import React, { useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, useConfirm, PageHead, Table, Btn, Card, Stat, Badge, Tabs } from '../ui/kit.jsx';
import { readSheet, mapAnyProducts, checkProducts, templateFile, exportRows } from '../lib/excel.js';
import { suggestHsnGst } from '../lib/productTools.js';
import { getStatus as getSyncStatus, onSyncStatus } from '../lib/sync.js';
import { BLANK_PRODUCT } from '../lib/products.js';
import { addBatch } from '../lib/stock.js';
import { post, partyAccount } from '../lib/accounts.js';
import { audit } from '../lib/sales.js';
import { inr, r2, sum, uid, todayISO, download, validEAN } from '../lib/util.js';
import { readScaleWeight, serialSupported } from '../lib/hardware.js';

export default function Setup() {
  const [tab, setTab] = useState('products');
  return (
    <div className="stack">
      <PageHead title="Import & setup" sub="Bring in your item list and balances, check them, and connect the counter hardware" />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'products', label: '1. Product list' }, { value: 'balances', label: '2. Customer balances' }, { value: 'hardware', label: '3. Counter hardware' }, { value: 'backup', label: 'Backup & sync' }]} />
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
  const [layout, setLayout] = useState('');
  const [show, setShow] = useState('errors');
  const [busy, setBusy] = useState(false);
  const load = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    e.target.value = '';
    setBusy(true);
    try {
      const { rows, sheet } = await readSheet(f);
      const { mapped, columns, layout } = mapAnyProducts(rows);
      const existing = await db.products.toArray();
      // HSN hints for items without a real HSN (built-in list and your own products; GST is never changed for you).
      for (const r of mapped) if (!r.hsn) { const h = await suggestHsnGst(r.name, existing).catch(() => null); if (h?.hsn) r.hsnHint = h.hsn; }
      setRes(checkProducts(mapped, existing)); setCols(columns); setFile(`${f.name} › ${sheet}`); setLayout(layout);
      setShow('warn');
    } catch (err) {
      toast('Could not read that file: ' + (err.message || err), 'bad');
    } finally { setBusy(false); }
  };
  const useHints = () => {
    let n = 0;
    const rows = res.rows.map(r => {
      if (r.hsn || !r.hsnHint) return r;
      n++;
      return { ...r, hsn: r.hsnHint, warnings: r.warnings.filter(w => !w.includes('HSN')).concat(`HSN ${r.hsnHint} filled from the name — check the GST rate`) };
    });
    setRes({ ...res, rows });
    toast(`Suggested HSN filled for ${n} items. GST rates were not changed.`);
  };
  const importGood = async () => {
    setBusy(true);
    try {
      const good = res.rows.filter(r => !r.errors.length);
      const existing = Object.fromEntries((await db.products.toArray()).map(p => [p.id, p]));
      let plu = Math.max(10000, ...Object.values(existing).map(p => Number(p.plu) || 0));
      const prods = [], batches = [], moves = [];
      let value = 0, added = 0, updated = 0;
      const now = Date.now();
      for (const r of good) {
        const old = r.existingId ? existing[r.existingId] : null;
        const id = old?.id || r.id || 'SKU' + uid('').slice(-8).toUpperCase();
        const rec = {
          ...(old || BLANK_PRODUCT), id, barcode: r.barcode || old?.barcode || '', name: r.name, category: r.category, brand: r.brand || old?.brand || '',
          uom: r.uom, hsn: r.hsn || old?.hsn || '', gst: r.gst, mrp: r.mrp || r.price, price: r.price, cost: r.cost, casePack: r.casePack || 1,
          loose: !!r.loose, batchTracked: true, active: true,
          ...(r.localName ? { localName: r.localName } : {}), ...(r.subCategory ? { subCategory: r.subCategory } : {}),
          ...(r.rack ? { rack: r.rack } : {}), ...(r.reorderMin ? { reorderMin: r.reorderMin } : {}), ...(r.reorderMax ? { reorderMax: r.reorderMax } : {}),
          ...(r.vendorId ? { vendorId: r.vendorId } : {}), ...(r.packSize ? { packSize: r.packSize } : {}),
        };
        if (r.packs?.length) rec.packs = r.packs; else if (r.packs) delete rec.packs;
        if (r.prices && Object.keys(r.prices).length) rec.prices = r.prices;
        if (r.plu) rec.plu = r.plu; else if (rec.loose && !rec.plu) rec.plu = String(++plu);
        delete rec.sample;
        prods.push(rec);
        if (old) { updated++; continue; }
        added++;
        if (r.openingStock > 0) {
          const bid = uid('b_');
          const expired = r.expiry && r.expiry < todayISO();
          batches.push({ id: bid, productId: id, storeId, batchNo: r.batchNo || 'OPENING', mfg: null, expiry: r.expiry || null, qty: r.openingStock, cost: r.cost || 0, mrp: r.mrp || null, status: expired ? 'quarantine' : 'active', receivedAt: now });
          moves.push({ ts: now, productId: id, batchId: bid, storeId, qty: r.openingStock, type: 'purchase', ref: 'IMPORT', note: 'Opening stock' });
          value += r.openingStock * (r.cost || 0);
        }
      }
      await db.transaction('rw', db.products, db.batches, db.stockMoves, async () => {
        await db.products.bulkPut(prods);
        if (batches.length) await db.batches.bulkAdd(batches);
        if (moves.length) await db.stockMoves.bulkAdd(moves);
      });
      if (value) await post({ ref: 'IMPORT', type: 'opening', narration: `Opening stock from ${file}`, lines: [{ acc: 'inventory', dr: r2(value) }, { acc: 'capital', cr: r2(value) }] });
      await audit('import', { file, added, updated, value: r2(value) }, user);
      toast(`${added} new products loaded${updated ? `, ${updated} updated` : ''}, with ${inr(value, 0)} of opening stock.`);
      setRes(null);
    } catch (err) {
      toast('Loading stopped: ' + (err.message || err), 'bad');
    } finally { setBusy(false); }
  };
  const rows = res ? res.rows.filter(r => show === 'all' || (show === 'errors' ? r.errors.length : !r.errors.length && r.warnings.length)) : [];
  const hints = res ? res.rows.filter(r => !r.hsn && r.hsnHint).length : 0;
  const price = r => <>₹{r.price}{r.uom === 'KG' ? '/kg' : ''} (MRP {r.mrp}){r.prices?.wholesale ? ` · W ₹${r.prices.wholesale}` : ''}{(r.packs || []).map((k, i) => <span key={i}> · {k.name}×{k.qty} ₹{k.price}{k.wholesale ? ` (W ₹${k.wholesale})` : ''}</span>)}</>;
  return (
    <div className="stack">
      <Card title="Load the product Excel">
        <p className="small muted">Reads billing-software item masters (like Sameer’s sheet: Product*, Packing, Unit-1, Conversion, Retail, wholesale, Godown Rate, Exp. Date) and simple lists (SKU_CODE, BARCODE_EAN, ITEM_NAME, GST_RATE_PCT, MRP, SELLING_PRICE, OPENING_STOCK). Pack prices, wholesale rates, loose items by kg and messy dates are understood. Nothing is saved until you press Load.</p>
        <div className="row gap-s wrap" style={{ marginTop: 10 }}>
          <label className="btn btn-primary">{busy && !res ? 'Reading…' : 'Choose Excel file'}<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={load} disabled={busy} /></label>
          <Btn onClick={templateFile}>Download a template</Btn>
        </div>
      </Card>
      {res && <>
        <div className="grid g4">
          <Stat label="Ready to load" value={res.ok} tone="ok" sub={res.updates ? `${res.updates} already in the system (update)` : ''} />
          <Stat label="With errors (skipped)" value={res.withErrors} tone={res.withErrors ? 'bad' : undefined} />
          <Stat label="Load, but please check" value={res.withWarnings} tone={res.withWarnings ? 'warn' : undefined} />
          <Stat label="Sold in packs / loose by kg" value={`${res.rows.filter(r => r.packs?.length).length} / ${res.rows.filter(r => r.loose).length}`} sub={`${res.rows.filter(r => r.prices?.wholesale).length} with wholesale rate`} />
        </div>
        <Card title={`Checked: ${file}`} actions={<><Btn size="sm" kind={show === 'errors' ? 'primary' : 'default'} onClick={() => setShow('errors')}>Errors</Btn><Btn size="sm" kind={show === 'warn' ? 'primary' : 'default'} onClick={() => setShow('warn')}>To check</Btn><Btn size="sm" kind={show === 'all' ? 'primary' : 'default'} onClick={() => setShow('all')}>All</Btn></>}>
          <p className="small muted" style={{ marginBottom: 8 }}>Read as {layout}. Columns found: {Object.entries(cols).map(([k, v]) => `${String(v).trim()} → ${k}`).join(' · ')}</p>
          {hints > 0 && <div className="note" style={{ marginBottom: 8 }}>{hints} items have no real HSN. A likely HSN was found from the item name. <Btn size="sm" onClick={useHints}>Fill suggested HSN</Btn> <span className="small muted">GST rates are not changed — check items marked Nil.</span></div>}
          <Table rows={rows.slice(0, 400)} keyField="row" empty="Nothing in this view." cols={[
            { label: 'Row', num: true, key: 'row' }, { label: 'Item', render: r => <><b>{r.name || '—'}</b><div className="small muted">{r.barcode || 'no barcode'} · GST {r.gst ?? '—'}% · HSN {r.hsn || (r.hsnHint ? `— (suggest ${r.hsnHint})` : '—')} · {price(r)} · stock {r.openingStock}{r.uom === 'KG' ? ' kg' : ''}{r.expiry ? ` · exp ${r.expiry}` : ''}</div></> },
            { label: 'Problems', render: r => <div className="stack" style={{ gap: 4 }}>{r.errors.map((e, i) => <Badge key={'e' + i} tone="bad">{e}</Badge>)}{r.warnings.map((w, i) => <Badge key={'w' + i} tone="warn">{w}</Badge>)}{!r.errors.length && !r.warnings.length && <Badge tone="ok">OK</Badge>}</div> },
          ]} />
          {rows.length > 400 && <p className="small muted">Showing the first 400 of {rows.length}.</p>}
          <div className="row gap-s wrap" style={{ marginTop: 12 }}><Btn kind="primary" disabled={!res.ok || busy} onClick={importGood}>{busy ? 'Loading…' : `Load ${res.ok} products`}</Btn><Btn onClick={() => exportRows(`import-check-${todayISO()}.xlsx`, 'To check', res.rows.filter(r => r.errors.length || r.warnings.length).map(r => ({ ROW: r.row, ITEM: r.name, BARCODE: r.barcode, ERRORS: r.errors.join(' | '), TO_CHECK: r.warnings.join(' | ') })))}>Download the list to check</Btn><span className="small muted">Fix items later in Products, or fix the Excel and load it again — items already loaded are updated, not added twice.</span></div>
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
  const [pending, setPending] = useState(getSyncStatus().pending);
  React.useEffect(() => onSyncStatus(st => setPending(st.pending)), []);
  const backup = async () => {
    const out = {};
    for (const t of db.tables) out[t.name] = await t.toArray();
    download(`dataflow-retail-backup-${todayISO()}.json`, JSON.stringify({ app: 'dataflow-retail', at: Date.now(), data: out }), 'application/json');
  };
  const restore = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    const j = JSON.parse(await f.text());
    if (j.app !== 'dataflow-retail') return toast('That is not a DataFlow Retail backup.', 'bad');
    if (!(await confirm('Replace everything on this computer with the backup?', 'Restore'))) return;
    for (const t of db.tables) { await t.clear(); if (j.data[t.name]?.length) await t.bulkAdd(j.data[t.name]); }
    toast('Backup restored.');
  };
  return (
    <div className="grid g2">
      <Card title="Backup">
        <p className="small muted">Saves every bill, product, customer and entry in one file. Keep a copy off the counter PC each day (pen drive or Google Drive).</p>
        <div className="row gap-s wrap" style={{ marginTop: 10 }}><Btn kind="primary" onClick={backup}>Download backup</Btn><label className="btn">Restore from file<input type="file" accept=".json" hidden onChange={restore} /></label></div>
      </Card>
      <Card title="Cloud sync">
        <p className="small">{pending} changes are waiting to go to the cloud. Every bill is saved here first, so the counter never waits for the internet.</p>
        <p className="small muted" style={{ marginTop: 8 }}>Head-office sync (all stores, all counters, live owner view) connects to a cloud database in the next phase. Until then, use backups to move data between computers. Store: {settings.storeName}.</p>
      </Card>
    </div>
  );
}
