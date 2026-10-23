import React, { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, useConfirm, Btn, Modal, Input, Select, Badge } from '../ui/kit.jsx';
import { inr, num, todayISO, uid, validGSTIN } from '../lib/util.js';
import { savePurchase, lastBillLines } from '../lib/purchasing.js';
import { readSheet } from '../lib/excel.js';
import { GST_SLABS } from '../lib/billing.js';
import { unitList, plain } from '../lib/units.js';
import ProductPicker from '../ui/ProductPicker.jsx';
import { loadPurchaseContext, checkBill, lineCalc, billCalc } from '../lib/purchaseChecks.js';
import { scanBill, smartScanConfig, supplierByGstin } from '../lib/billreader.js';
import { isStoreBarcode } from '../lib/barcode.js';
import QuickAdd from '../ui/QuickAdd.jsx';
import { voiceToLine, listen, speechSupported } from '../lib/voice.js';
import { loadAliases } from '../lib/match.js';
import Stickers from '../ui/Stickers.jsx';

export const emptyLine = () => ({ key: uid('pl'), productId: '', name: '', text: '', match: '', qty: '', free: 0, pack: 1, unit: '', rate: '', disc: 0, gst: 5, mrp: '', batchNo: '', expiry: '', mfg: '', hsn: '', amount: '' });

const Issues = ({ list }) => !list?.length ? null : (
  <ul className="issues">{list.map((x, i) => <li key={i} className={x.tone}>{{ bad: '✖ ', warn: '⚠ ', info: 'ℹ ', ok: '✔ ' }[x.tone]}{x.text}</li>)}</ul>
);

export default function PurchaseBill({ draft, onClose }) {
  const { storeId, user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const products = useLive(() => db.products.toArray(), [], []);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const po = draft.fromPO;
  const [ctx, setCtx] = useState(null);
  const [supplierId, setSupplierId] = useState(po?.supplierId || '');
  const [billNo, setBillNo] = useState('');
  const [date, setDate] = useState(todayISO());
  const [printedTotal, setPrintedTotal] = useState('');
  const [taxType, setTaxType] = useState(null);
  const [lines, setLines] = useState(po ? po.lines.map(l => ({ ...emptyLine(), productId: l.productId, name: l.name, qty: l.qty, rate: l.rate, gst: l.gst })) : [emptyLine()]);
  const [busy, setBusy] = useState('');
  const [src, setSrc] = useState(po ? 'from order' : 'manual');
  const [scan, setScan] = useState(null);           // result info from Smart Scan
  const [files, setFiles] = useState(null);
  const [newSup, setNewSup] = useState(null);
  const [quick, setQuick] = useState(null);
  const [updateMrp, setUpdateMrp] = useState(true);
  const [stickers, setStickers] = useState(null);
  const [aiMode, setAiMode] = useState('off');
  const [code, setCode] = useState('');
  const codeRef = useRef();
  const [said, setSaid] = useState('');
  const [vlang, setVlang] = useState(() => { try { return localStorage.getItem('dfr_voice_lang') || 'hi-IN'; } catch { return 'hi-IN'; } });

  useEffect(() => { loadPurchaseContext(storeId).then(setCtx); smartScanConfig().then(c => setAiMode(c.ai)); }, [storeId]);
  const pm = useMemo(() => Object.fromEntries(products.map(p => [p.id, p])), [products]);
  const supplier = suppliers.find(s => s.id === supplierId);
  const setL = (k, patch) => setLines(ls => ls.map(l => l.key === k ? { ...l, ...patch } : l));
  const lastFrom = pid => (ctx?.history[pid] || []).find(h => h.supplierId === supplierId);
  const pick = (k, id) => {
    const p = pm[id]; const h = lastFrom(id);
    setL(k, { productId: id, name: p?.name || '', match: 'manual', ...(h ? { rate: h.rate, disc: h.disc, pack: h.pack } : { rate: p?.cost || '' }), gst: p?.gst ?? 5 });
  };
  // Products with 3 units: buy in Bag, Kg or Gram. Stock is added in the base unit, so Pcs/unit = base units in one chosen unit.
  const buyUnit = l => { const L = unitList(pm[l.productId]); return L.find(u => u.name === l.unit) || L.find(u => Math.abs(u.factor - (Number(l.pack) || 1)) < 1e-9) || L.find(u => u.base) || null; };
  const chooseUnit = (l, i) => {
    const p = pm[l.productId]; const L = unitList(p); const old = buyUnit(l); const nu = L[i]; if (!nu) return;
    const oldRate = p.cost && old ? Math.round(p.cost * old.factor * 100) / 100 : null;
    const same = !l.rate || (oldRate != null && Math.abs(Number(l.rate) - oldRate) < 0.01);
    setL(l.key, { unit: nu.name, pack: nu.factor, ...(same && p.cost ? { rate: Math.round(p.cost * nu.factor * 100) / 100 } : {}) });
  };
  const calc = billCalc(lines);
  const checks = useMemo(() => ctx ? checkBill(ctx, { supplier, billNo, date, lines, printed: { total: Number(printedTotal) || null, taxType }, products, suppliers }) : null, [ctx, supplier, billNo, date, lines, printedTotal, taxType, products, suppliers]);

  // ---- Smart Scan
  const runScan = async (fs, forceAI = false) => {
    if (!fs?.length || !ctx) return;
    setFiles(fs);
    setBusy('Starting…');
    try {
      const r = await scanBill(fs, { products, suppliers, storeId, ctx, uid, forceAI, onStep: setBusy });
      const h = r.header || {};
      const sup = supplierByGstin(h.supplierGstin, suppliers);
      if (sup) setSupplierId(sup.id);
      else if (h.supplierGstin && validGSTIN(h.supplierGstin)) setNewSup({ gstin: h.supplierGstin, name: h.supplierName || '' });
      if (h.billNo) setBillNo(h.billNo);
      if (h.date) setDate(h.date);
      if (h.total) setPrintedTotal(String(h.total));
      setTaxType(h.taxType || null);
      if (r.lines?.length) setLines(r.lines);
      setSrc('photo');
      setScan({ method: r.method, model: r.model, provider: r.provider, usage: r.usage, freeTried: r.freeTried, aiError: r.aiError, aiOff: r.aiOff, passed: r.passed, n: r.lines?.length || 0 });
      toast(r.method === 'free' && r.passed ? 'Bill read on this device (free). Check the lines and save.' : `${r.lines?.length || 0} lines read. Check the yellow and red lines before saving.`, r.passed ? 'ok' : 'warn');
    } catch (e) { toast(e.message || 'Could not read the photo.', 'bad'); }
    setBusy('');
  };

  const addSupplier = async () => {
    const s = { id: uid('sp_'), name: newSup.name || 'Supplier ' + newSup.gstin.slice(2, 7), gstin: newSup.gstin, stateCode: newSup.gstin.slice(0, 2), phone: '', termsDays: 30, returnDays: 45, leadDays: 3 };
    await db.suppliers.put(s); setSupplierId(s.id); setNewSup(null); toast(`${s.name} added as a supplier. Add the phone number later in Suppliers.`);
  };

  const fromFile = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    const { rows } = await readSheet(f);
    const get = (r, names) => { const k = Object.keys(r).find(h => names.includes(h.trim().toUpperCase())); return k ? r[k] : ''; };
    setLines(rows.map(r => {
      const code = String(get(r, ['BARCODE', 'EAN', 'SKU', 'CODE', 'ITEM CODE'])).replace(/\.0$/, '');
      const name = String(get(r, ['ITEM', 'ITEM NAME', 'PRODUCT', 'DESCRIPTION', 'NAME']));
      const p = products.find(x => (code && (x.barcode === code || x.id === code))) || products.find(x => name && x.name.toLowerCase() === name.toLowerCase());
      return { ...emptyLine(), productId: p?.id || '', name: p?.name || '', text: p ? '' : name, match: p ? 'ok' : 'none', qty: Number(get(r, ['QTY', 'QUANTITY'])) || '', free: Number(get(r, ['FREE', 'FREE QTY', 'SCHEME QTY'])) || 0, rate: Number(get(r, ['RATE', 'PRICE', 'COST'])) || p?.cost || '', disc: Number(get(r, ['DISC', 'DISC%', 'DISCOUNT'])) || 0, gst: Number(get(r, ['GST', 'GST%', 'TAX%'])) || p?.gst || 5, mrp: Number(get(r, ['MRP'])) || '', batchNo: String(get(r, ['BATCH', 'BATCH NO'])), expiry: String(get(r, ['EXPIRY', 'EXP', 'EXPIRY DATE'])) };
    }));
    setSrc('file'); toast(`${rows.length} lines loaded from the file. Check them before saving.`);
  };

  const repeatLast = async () => {
    const r = await lastBillLines(supplierId);
    if (!r) return toast('No earlier bill from this supplier.', 'warn');
    setLines(r.lines.map(l => ({ ...emptyLine(), ...l, match: 'ok' })));
    setSrc('repeat'); toast(`Copied ${r.lines.length} lines from bill ${r.bill.billNo || r.bill.no}. Change the quantities and add batch/expiry.`);
  };

  // Scan-to-receive: scan each item as the goods are unpacked.
  const onCode = e => {
    e.preventDefault();
    const q = code.trim(); if (!q) return;
    const p = products.find(x => x.barcode === q || x.id.toLowerCase() === q.toLowerCase());
    setCode('');
    if (!p) { setQuick({ barcode: q }); return; }
    const ex = lines.find(l => l.productId === p.id);
    if (ex) setL(ex.key, { qty: (Number(ex.qty) || 0) + 1 });
    else {
      const h = lastFrom(p.id);
      setLines(ls => [...ls.filter(l => l.productId || l.text || l.qty), { ...emptyLine(), productId: p.id, name: p.name, match: 'ok', qty: 1, gst: p.gst, ...(h ? { rate: h.rate, disc: h.disc, pack: h.pack } : { rate: p.cost || '' }) }]);
    }
    codeRef.current?.focus();
  };

  // Voice / quick-typed line: "amul butter 20 piece 52 rupaye". Code first, AI only if the code can't tell.
  const addSpoken = async text => {
    const t = (text ?? said).trim(); if (!t) return;
    setBusy('Understanding the line…');
    try {
      const r = await voiceToLine(t, { supplierId, products, aliases: await loadAliases(db) });
      const p = pm[r.match.productId]; const h = p ? lastFrom(p.id) : null;
      const pack = r.parsed.unit === 'CS' ? ((h?.pack > 1 ? h.pack : 0) || p?.casePack || 1) : 1;
      const perPiece = h ? h.rate / (h.pack || 1) : (p?.cost || 0);       // last rate, turned into this unit
      setLines(ls => [...ls.filter(l => l.productId || l.text || l.qty), { ...emptyLine(), productId: r.match.productId || '', name: p?.name || '', text: r.parsed.text, match: r.match.match,
        qty: r.parsed.qty ?? '', free: r.parsed.free || 0, unit: r.parsed.unit || '', pack,
        rate: r.parsed.rate ?? (perPiece ? Math.round(perPiece * pack * 100) / 100 : ''), disc: h?.disc || 0, gst: p?.gst ?? 5 }]);
      setSaid('');
      if (!p) toast(`Could not find “${r.parsed.text}”. Pick the product in the new line.`, 'warn');
      else if (r.method === 'ai') toast('Line understood with AI help. Check it.', 'warn');
    } catch (e) { toast(e.message, 'bad'); }
    setBusy('');
  };
  const speak = async () => {
    try { setBusy('Listening…'); const t = await listen(vlang); setSaid(t); setBusy(''); await addSpoken(t); } catch (e) { setBusy(''); toast(e.message, 'bad'); }
  };

  // Ordered vs received (when goods arrive for a purchase order).
  const poCheck = useMemo(() => {
    if (!po) return [];
    const got = {};
    lines.forEach(l => { if (l.productId) got[l.productId] = (got[l.productId] || 0) + lineCalc(l).pieces; });
    const out = [];
    for (const l of po.lines) {
      const g = got[l.productId] || 0;
      if (g < l.qty) out.push({ tone: g ? 'warn' : 'bad', text: `${l.name}: ordered ${l.qty}, received ${g}${g ? ` (short ${l.qty - g})` : ' — not delivered'}.` });
      else if (g > l.qty) out.push({ tone: 'info', text: `${l.name}: ordered ${l.qty}, received ${g} (extra ${g - l.qty}).` });
    }
    const ordered = new Set(po.lines.map(l => l.productId));
    lines.filter(l => l.productId && !ordered.has(l.productId)).forEach(l => out.push({ tone: 'info', text: `${l.name || l.text}: not in the order.` }));
    return out;
  }, [po, lines]);

  const save = async () => {
    if (!supplier) { toast('Choose the supplier.', 'bad'); return; }
    if (lines.some(l => Number(l.qty) > 0 && !l.productId)) { toast('Some lines are not matched to a product. Pick the product, quick-add it, or remove the line.', 'bad'); return; }
    const dup = checks?.bill.find(x => x.tone === 'bad' && /already entered/.test(x.text));
    if (dup) { toast(dup.text, 'bad'); return; }
    if (checks?.bad) {
      const ok = await confirm(`${checks.bad} problem(s) are marked in red (totals, GST or expiry). Save anyway?`);
      if (!ok) return;
    }
    const pur = await savePurchase({ supplier, billNo, date, lines, storeId, user, source: src, poId: po?.id, updateMrp,
      scan: scan ? { method: scan.method, model: scan.model || null, usage: scan.usage || null, freeTried: !!scan.freeTried } : null });
    toast(`${pur.no} saved. Stock, batches, expiry and GST credit updated.`);
    const forStickers = pur.lines.map(l => ({ product: pm[l.productId], copies: isStoreBarcode(pm[l.productId]?.barcode) ? l.pieces : 0 })).filter(x => x.product);
    if (forStickers.some(x => x.copies > 0)) setStickers(forStickers); else onClose();
  };

  if (stickers) return <Stickers items={stickers} title="Print barcode stickers for the items that need them" onClose={onClose} />;

  const lineIssues = k => checks?.line[k] || [];
  const rowClass = l => !l.productId && (l.qty || l.text) ? 'match-none' : l.match === 'check' ? 'match-check' : l.match === 'ok' || l.match === 'manual' ? 'match-ok' : '';
  const badCount = checks?.bad || 0, warnCount = checks?.warn || 0;

  return (
    <Modal xl title={po ? `Receive goods for ${po.no}` : 'New purchase bill (goods receipt)'} onClose={onClose} footer={<>
      <span className="grow small muted">Taxable {inr(calc.taxable)} · GST {inr(calc.tax)} · <b>Total {inr(calc.total)}</b>{printedTotal ? <> · bill says {inr(printedTotal)}</> : null}</span>
      <label className="check small"><input type="checkbox" checked={updateMrp} onChange={e => setUpdateMrp(e.target.checked)} /> Update MRP from this bill</label>
      <Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save} disabled={!!busy}>Save and add to stock</Btn>
    </>}>
      <div className="stack">
        <div className="row gap-s wrap">
          <label className="btn btn-primary">📷 Smart Scan bill photo<input type="file" accept="image/*" multiple hidden onChange={e => runScan([...e.target.files])} /></label>
          {files && aiMode !== 'off' && scan?.method === 'free' && <Btn onClick={() => runScan(files, true)} disabled={!!busy}>Read again with AI</Btn>}
          <label className="btn">Import Excel/CSV<input type="file" accept=".xlsx,.xls,.csv" hidden onChange={fromFile} /></label>
          {supplierId && <Btn onClick={repeatLast}>Repeat last bill</Btn>}
          <form onSubmit={onCode} className="row gap-s"><input ref={codeRef} className="input" style={{ width: 210 }} value={code} onChange={e => setCode(e.target.value)} placeholder="Scan item barcode to receive" aria-label="Scan item barcode" /></form>
          {busy && <span className="muted">{busy}</span>}
        </div>
        {scan && <p className={`note small ${scan.method === 'ai' || scan.passed ? '' : 'note-warn'}`}>
          {scan.method === 'free' ? (scan.passed ? 'Read on this device for free — totals match the bill.' : 'Read on this device for free, but the totals or lines did not fully match.') : `Read by AI (${scan.provider || ''} ${scan.model || ''})${scan.usage ? ` · ${num((scan.usage.input || 0) + (scan.usage.output || 0))} tokens` : ''}${scan.freeTried ? ' after the free reading was not sure' : ''}.`}
          {scan.aiOff && !scan.passed && ' AI reading is off for this store (Settings › Smart Scan).'}
          {scan.aiError && ` AI reading failed: ${scan.aiError}`}
          {' '}Green = sure · yellow = please check · red = pick the product.
        </p>}
        <form className="row gap-s wrap" onSubmit={e => { e.preventDefault(); addSpoken(); }}>
          <input className="input grow" style={{ minWidth: 240 }} value={said} onChange={e => setSaid(e.target.value)} placeholder="Say or type a line: amul butter 20 piece 52 rupaye" aria-label="Spoken line" />
          <select className="input" style={{ width: 110 }} value={vlang} onChange={e => { setVlang(e.target.value); try { localStorage.setItem('dfr_voice_lang', e.target.value); } catch { /* ignore */ } }} aria-label="Voice language">
            <option value="hi-IN">हिंदी</option><option value="or-IN">ଓଡ଼ିଆ</option><option value="en-IN">English</option></select>
          {speechSupported() && <Btn type="button" onClick={speak} disabled={!!busy} title="Speak the line">🎤 Speak</Btn>}
          <Btn type="submit" disabled={!said.trim() || !!busy}>Add line</Btn>
        </form>
        {poCheck.length > 0 && <div className="note note-warn small"><b>Ordered vs received</b><Issues list={poCheck} /></div>}
        {newSup && <p className="note note-warn small">The bill is from GSTIN <b>{newSup.gstin}</b>{newSup.name ? ` (${newSup.name})` : ''}, which is not in your suppliers. <Btn size="sm" onClick={addSupplier}>Add this supplier</Btn></p>}
        <div className="grid g4">
          <Select label="Supplier" value={supplierId} onChange={e => setSupplierId(e.target.value)} options={[{ value: '', label: 'Choose supplier' }, ...suppliers.map(s => ({ value: s.id, label: s.name }))]} id="pb-sup" />
          <Input label="Supplier’s bill number" value={billNo} onChange={e => setBillNo(e.target.value)} id="pb-no" />
          <Input label="Bill date" type="date" value={date} onChange={e => setDate(e.target.value)} id="pb-date" />
          <Input label="Bill total as printed (₹)" type="number" step="0.01" value={printedTotal} onChange={e => setPrintedTotal(e.target.value)} hint="Typed or read — used to check the lines" id="pb-total" />
        </div>
        {checks && checks.bill.length > 0 && (scan || lines.some(l => l.productId || l.text || l.qty)) && <div className={`note small ${badCount ? 'note-bad' : warnCount ? 'note-warn' : ''}`}><Issues list={checks.bill} /></div>}
        <div className="table-wrap"><table className="tbl">
          <thead><tr><th>Product</th><th>Qty</th><th>Free</th><th title="Pieces in one billed unit (case/box)">Pcs/unit</th><th>Rate (before GST)</th><th>Disc %</th><th>GST</th><th>MRP</th><th>Batch</th><th>Expiry</th><th className="num">Amount</th><th /></tr></thead>
          <tbody>{lines.map(l => {
            const c = lineCalc(l); const iss = lineIssues(l.key);
            return (
              <React.Fragment key={l.key}>
                <tr className={rowClass(l)}>
                  <td style={{ minWidth: 220 }}>
                    <div className="row gap-s">
                      <ProductPicker products={products} value={l.productId} onChange={id => pick(l.key, id)} placeholder={l.text ? 'Pick product…' : 'Type product or barcode'} />
                      {!l.productId && l.text && <Btn size="sm" onClick={() => setQuick({ key: l.key, name: l.text, mrp: l.mrp, gst: l.gst, cost: c.landing ? c.landing.toFixed(2) : '' })} title="Add as a new product">＋New</Btn>}
                    </div>
                    {unitList(pm[l.productId]).length > 0 && <select className="input" style={{ marginTop: 4 }} value={buyUnit(l)?.i ?? 0} onChange={e => chooseUnit(l, Number(e.target.value))} aria-label="Buying unit">{unitList(pm[l.productId]).map(u => <option key={u.i} value={u.i}>Buying in {u.name}{u.base ? ' (stock unit)' : ''}</option>)}</select>}
                    {l.text && <div className="small muted">On bill: {l.text}{l.unit ? ` · ${l.unit}` : ''}</div>}
                  </td>
                  <td><input className="input xs" type="number" value={l.qty} onChange={e => setL(l.key, { qty: e.target.value })} aria-label="Quantity" /></td>
                  <td><input className="input xs" type="number" value={l.free} onChange={e => setL(l.key, { free: e.target.value })} aria-label="Free quantity" /></td>
                  <td><input className="input xs" type="number" min="0" step="any" value={l.pack} onChange={e => setL(l.key, { pack: e.target.value })} aria-label="Pieces per unit" /></td>
                  <td><input className="input" style={{ width: 90 }} type="number" step="0.01" value={l.rate} onChange={e => setL(l.key, { rate: e.target.value })} aria-label="Rate" /></td>
                  <td><input className="input xs" type="number" step="0.01" value={l.disc} onChange={e => setL(l.key, { disc: e.target.value })} aria-label="Discount percent" /></td>
                  <td><select className="input" style={{ width: 70 }} value={l.gst} onChange={e => setL(l.key, { gst: Number(e.target.value) })} aria-label="GST">{GST_SLABS.map(g => <option key={g} value={g}>{g}%</option>)}</select></td>
                  <td><input className="input xs" type="number" step="0.01" value={l.mrp} onChange={e => setL(l.key, { mrp: e.target.value })} aria-label="MRP" /></td>
                  <td><input className="input" style={{ width: 90 }} value={l.batchNo} onChange={e => setL(l.key, { batchNo: e.target.value })} aria-label="Batch" /></td>
                  <td><input className="input" style={{ width: 140 }} type="date" value={l.expiry} onChange={e => setL(l.key, { expiry: e.target.value })} aria-label="Expiry" /></td>
                  <td className="num">{inr(c.total)}{c.pieces > 0 && <div className="small muted">{unitList(pm[l.productId]).length ? `${plain(c.pieces)} ${pm[l.productId].uom.toLowerCase()} · ${inr(c.landing)}/${pm[l.productId].uom.toLowerCase()}` : `${num(c.pieces)} pcs · ${inr(c.landing)}/pc`}</div>}</td>
                  <td><button className="icon-btn" onClick={() => setLines(ls => ls.filter(x => x.key !== l.key))} aria-label="Remove line">✕</button></td>
                </tr>
                {iss.length > 0 && <tr className={rowClass(l)}><td colSpan={12} style={{ paddingTop: 0 }}><Issues list={iss} /></td></tr>}
              </React.Fragment>
            );
          })}</tbody>
        </table></div>
        <div className="row gap-s"><Btn size="sm" onClick={() => setLines(ls => [...ls, emptyLine()])}>Add line</Btn>
          {checks && lines.some(l => l.productId || l.text || l.qty) && <span className="small muted">{badCount ? <Badge tone="bad">{badCount} to fix</Badge> : null} {warnCount ? <Badge tone="warn">{warnCount} to check</Badge> : null} {!badCount && !warnCount && lines.some(l => l.productId) ? <Badge tone="ok">All checks passed</Badge> : null}</span>}
        </div>
      </div>
      {quick && <QuickAdd title={quick.barcode ? `New product (barcode ${quick.barcode})` : 'Add as a new product'} barcode={quick.barcode || ''} name={quick.name || ''} mrp={quick.mrp || ''} gst={quick.gst ?? 5} cost={quick.cost || ''} askStock={false} allowNext={false}
        onClose={() => setQuick(null)}
        onSaved={p => {
          if (quick.key) setL(quick.key, { productId: p.id, name: p.name, match: 'manual' });
          else setLines(ls => [...ls.filter(l => l.productId || l.text || l.qty), { ...emptyLine(), productId: p.id, name: p.name, match: 'ok', qty: 1, gst: p.gst, rate: p.cost || '' }]);
        }} />}
    </Modal>
  );
}
