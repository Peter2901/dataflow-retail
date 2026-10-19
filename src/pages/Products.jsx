import React, { useEffect, useMemo, useRef, useState } from 'react';
import JsBarcode from 'jsbarcode';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Modal, Input, Select, Badge, SearchBox, Field, Tabs } from '../ui/kit.jsx';
import { inr, num, validEAN, eanCheckDigit, inArtifact } from '../lib/util.js';
import { GST_SLABS } from '../lib/billing.js';
import { stockMap } from '../lib/stock.js';
import { audit } from '../lib/sales.js';
import { exportProducts } from '../lib/excel.js';

const blank = { id: '', barcode: '', name: '', category: '', brand: '', uom: 'PCS', hsn: '', gst: 5, mrp: '', price: '', cost: '', casePack: 1, rack: '', reorderMin: 5, reorderMax: 30, vendorId: '', loose: false, plu: '', active: true, batchTracked: true };

export default function Products() {
  const { storeId, user } = useApp();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [edit, setEdit] = useState(null);
  const [labels, setLabels] = useState(null);
  const products = useLive(() => db.products.toArray(), [], []);
  const stock = useLive(() => stockMap(storeId), [storeId], {});
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const cats = useMemo(() => ['All', ...[...new Set(products.map(p => p.category))].sort()], [products]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return products.filter(p => (cat === 'All' || p.category === cat) && (!s || p.name.toLowerCase().includes(s) || p.barcode?.includes(s) || p.id.toLowerCase().includes(s) || p.brand?.toLowerCase().includes(s)))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [products, q, cat]);

  const save = async p => {
    const errs = [];
    if (!p.name) errs.push('Name is needed.');
    if (!(Number(p.price) > 0)) errs.push('Selling price is needed.');
    if (Number(p.price) > Number(p.mrp)) errs.push('Selling price cannot be above MRP.');
    if (Number(p.cost) >= Number(p.price)) errs.push('Purchase rate should be below selling price.');
    if (p.barcode && !validEAN(p.barcode)) errs.push('Barcode check digit is wrong.');
    if (!GST_SLABS.includes(Number(p.gst))) errs.push('GST must be 0, 5, 18 or 40%.');
    if (p.barcode && products.some(x => x.barcode === p.barcode && x.id !== p.id)) errs.push('Another product already has this barcode.');
    if (errs.length) { toast(errs.join(' '), 'bad'); return; }
    const rec = { ...p, gst: Number(p.gst), mrp: Number(p.mrp), price: Number(p.price), cost: Number(p.cost), casePack: Number(p.casePack) || 1, reorderMin: Number(p.reorderMin) || 0, reorderMax: Number(p.reorderMax) || 0 };
    if (!rec.id) rec.id = 'SKU' + (Date.now() % 1000000);
    const old = await db.products.get(rec.id);
    await db.products.put(rec);
    if (old && (old.price !== rec.price || old.mrp !== rec.mrp)) audit('price_change', { product: rec.name, from: old.price, to: rec.price }, user);
    toast(`${rec.name} saved.`);
    setEdit(null);
  };

  return (
    <div className="stack">
      <PageHead title="Products" sub={`${products.length} products · prices include GST`} actions={<>
        <Btn onClick={() => exportProducts(products, stock)}>Export to Excel</Btn>
        <Btn onClick={() => setLabels(rows.slice(0, 24))}>Print shelf labels</Btn>
        <Btn kind="primary" onClick={() => setEdit({ ...blank })}>Add product</Btn>
      </>} />
      <div className="row gap-s wrap"><SearchBox value={q} onChange={setQ} placeholder="Search name, barcode, brand" /><select className="input" style={{ width: 200 }} value={cat} onChange={e => setCat(e.target.value)} aria-label="Category">{cats.map(c => <option key={c}>{c}</option>)}</select></div>
      <div className="card">
        <Table rows={rows} onRow={p => setEdit({ ...p })} cols={[
          { label: 'Product', render: p => <><b>{p.name}</b><div className="small muted">{p.brand} · {p.category} · {p.barcode || (p.plu ? 'PLU ' + p.plu : p.id)}</div></> },
          { label: 'Rack', key: 'rack' },
          { label: 'GST', num: true, render: p => p.gst + '%' },
          { label: 'MRP', num: true, render: p => inr(p.mrp) },
          { label: 'Price', num: true, render: p => inr(p.price) },
          { label: 'Margin', num: true, render: p => { const m = p.price ? ((p.price / (1 + p.gst / 100) - p.cost) / (p.price / (1 + p.gst / 100))) * 100 : 0; return <span style={{ color: m < 8 ? 'var(--bad)' : undefined }}>{num(m, 1)}%</span>; } },
          { label: 'Stock', num: true, render: p => { const s = stock[p.id] || 0; return <span style={{ color: s <= p.reorderMin ? 'var(--bad)' : undefined }}>{num(s, p.uom === 'KG' ? 2 : 0)} {p.uom}</span>; } },
          { label: '', render: p => p.active === false ? <Badge>Hidden</Badge> : p.sample ? <Badge tone="info">Sample</Badge> : null },
        ]} />
      </div>
      {edit && <EditModal p={edit} suppliers={suppliers} onClose={() => setEdit(null)} onSave={save} />}
      {labels && <LabelsModal items={labels} onClose={() => setLabels(null)} />}
    </div>
  );
}

function EditModal({ p: init, suppliers, onClose, onSave }) {
  const [p, setP] = useState(init);
  const f = k => e => setP({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const taxable = Number(p.price) / (1 + Number(p.gst) / 100);
  const margin = taxable ? ((taxable - Number(p.cost)) / taxable) * 100 : 0;
  const newEAN = () => { const body = '2' + String(Date.now()).slice(-11); setP({ ...p, barcode: body + eanCheckDigit(body) }); };
  return (
    <Modal wide title={init.id ? `Edit: ${init.name}` : 'New product'} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => onSave(p)}>Save product</Btn></>}>
      <div className="grid g3">
        <Input label="Product name (brand, variant, size)" value={p.name} onChange={f('name')} className="span2" id="p-name" />
        <Input label="Brand" value={p.brand} onChange={f('brand')} id="p-brand" />
        <Field label="Barcode (EAN-13)"><div className="row gap-s"><input className="input" value={p.barcode} onChange={f('barcode')} id="p-bar" /><Btn size="sm" type="button" onClick={newEAN}>New</Btn></div>
          {p.barcode && <span className="field-hint" style={{ color: validEAN(p.barcode) ? 'var(--ok)' : 'var(--bad)' }}>{validEAN(p.barcode) ? 'Check digit OK' : 'Check digit wrong'}</span>}</Field>
        <Input label="Category" value={p.category} onChange={f('category')} id="p-cat" />
        <Select label="Unit" value={p.uom} onChange={f('uom')} options={['PCS', 'KG', 'GM', 'LTR', 'ML', 'PACK']} id="p-uom" />
        <Input label="HSN code" value={p.hsn} onChange={f('hsn')} id="p-hsn" />
        <Select label="GST rate" value={p.gst} onChange={f('gst')} options={GST_SLABS.map(g => ({ value: g, label: g + '%' }))} id="p-gst" />
        <Input label="MRP (₹)" type="number" value={p.mrp} onChange={f('mrp')} id="p-mrp" />
        <Input label="Selling price incl. GST (₹)" type="number" value={p.price} onChange={f('price')} id="p-price" />
        <Input label="Purchase rate, landed (₹)" type="number" value={p.cost} onChange={f('cost')} hint={`Margin ${num(margin, 1)}% on taxable value`} id="p-cost" />
        <Input label="Rack (Aisle-Rack-Shelf)" value={p.rack} onChange={f('rack')} id="p-rack" />
        <Input label="Reorder when stock is at" type="number" value={p.reorderMin} onChange={f('reorderMin')} id="p-min" />
        <Input label="Maximum stock" type="number" value={p.reorderMax} onChange={f('reorderMax')} id="p-max" />
        <Input label="Case pack (units per carton)" type="number" value={p.casePack} onChange={f('casePack')} id="p-case" />
        <Select label="Main supplier" value={p.vendorId} onChange={f('vendorId')} options={[{ value: '', label: '—' }, ...suppliers.map(s => ({ value: s.id, label: s.name }))]} id="p-vendor" />
        <Input label="Scale PLU (loose items)" value={p.plu} onChange={f('plu')} id="p-plu" />
        <label className="check"><input type="checkbox" checked={!!p.loose} onChange={f('loose')} /> Sold loose by weight</label>
        <label className="check"><input type="checkbox" checked={p.active !== false} onChange={f('active')} /> Show at the counter</label>
      </div>
    </Modal>
  );
}

function Label({ p }) {
  const ref = useRef();
  useEffect(() => { if (p.barcode && ref.current) try { JsBarcode(ref.current, p.barcode, { format: p.barcode.length === 13 ? 'EAN13' : 'CODE128', height: 40, fontSize: 12, margin: 0 }); } catch { /* invalid code */ } }, [p.barcode]);
  const save = p.mrp - p.price;
  return (
    <div className="label">
      <div style={{ fontWeight: 700 }}>{p.name}</div>
      <div><s>MRP ₹{p.mrp}</s> <b style={{ fontSize: 18 }}>₹{p.price}</b>{save > 0 && <> · SAVE ₹{save}</>}</div>
      {p.barcode ? <svg ref={ref} /> : <div className="small">PLU {p.plu}</div>}
      <div style={{ fontSize: 10 }}>HSN {p.hsn} · {p.rack} · {p.uom === 'KG' ? `₹${p.price}/kg` : ''}</div>
    </div>
  );
}

function LabelsModal({ items, onClose }) {
  const [tab, setTab] = useState('shelf');
  return (
    <Modal wide title={`Shelf labels (${items.length})`} onClose={onClose} footer={<>{!inArtifact() && <Btn kind="primary" onClick={() => window.print()}>Print</Btn>}<Btn onClick={onClose}>Close</Btn></>}>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'shelf', label: 'Shelf edge 50×30 mm' }]} />
      <div className="label-sheet print-area">{items.map(p => <Label key={p.id} p={p} />)}</div>
      {inArtifact() && <p className="small muted" style={{ marginTop: 8 }}>Printing works on the installed store app (thermal label or A4 sheet).</p>}
    </Modal>
  );
}
