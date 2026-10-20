import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Modal, Input, Select, Badge, SearchBox, Field } from '../ui/kit.jsx';
import { inr, num, validEAN } from '../lib/util.js';
import { GST_SLABS } from '../lib/billing.js';
import { stockMap } from '../lib/stock.js';
import { audit } from '../lib/sales.js';
import { exportProducts } from '../lib/excel.js';
import { BLANK_PRODUCT as blank, productErrors, cleanProduct, freshStoreBarcode } from '../lib/products.js';
import { isStoreBarcode } from '../lib/barcode.js';
import QuickAdd from '../ui/QuickAdd.jsx';
import Stickers from '../ui/Stickers.jsx';
import { smartSearch } from '../lib/search.js';
import { findDuplicates, mergeProducts, suggestHsnGst } from '../lib/productTools.js';
import { useConfirm } from '../ui/kit.jsx';

export default function Products() {
  const { storeId, user, param } = useApp();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const [edit, setEdit] = useState(null);
  const [labels, setLabels] = useState(null);
  const [quick, setQuick] = useState(!!param?.quick);
  const [dups, setDups] = useState(null);
  const products = useLive(() => db.products.toArray(), [], []);
  // Opened from the Smart & AI hub: run the duplicate finder once the list has loaded.
  const askedDups = React.useRef(!!param?.dups);
  React.useEffect(() => { if (askedDups.current && products.length) { askedDups.current = false; setDups(findDuplicates(products)); } }, [products]);
  const stock = useLive(() => stockMap(storeId), [storeId], {});
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const cats = useMemo(() => ['All', ...[...new Set(products.map(p => p.category))].sort()], [products]);
  const rows = useMemo(() => {
    const s = q.trim();
    const inCat = products.filter(p => cat === 'All' || p.category === cat);
    if (!s) return inCat.sort((a, b) => a.name.localeCompare(b.name));
    const plain = inCat.filter(p => p.barcode?.includes(s) || p.id.toLowerCase().includes(s.toLowerCase()));
    return [...new Set([...plain, ...smartSearch(s, inCat.map(p => ({ ...p, active: true })), 200).map(x => inCat.find(p => p.id === x.id))])];
  }, [products, q, cat]);

  const save = async p => {
    const errs = productErrors(p, products);
    if (errs.length) { toast(errs.join(' '), 'bad'); return; }
    const rec = cleanProduct(p);
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
        <Btn onClick={() => setDups(findDuplicates(products))}>Find duplicates</Btn>
        <Btn onClick={() => setLabels(rows.slice(0, 200))}>Print stickers & labels</Btn>
        <Btn onClick={() => setEdit({ ...blank })}>Add product (all details)</Btn>
        <Btn kind="primary" onClick={() => setQuick(true)}>Quick add</Btn>
      </>} />
      <div className="row gap-s wrap"><SearchBox value={q} onChange={setQ} placeholder="Search name, barcode, brand" /><select className="input" style={{ width: 200 }} value={cat} onChange={e => setCat(e.target.value)} aria-label="Category">{cats.map(c => <option key={c}>{c}</option>)}</select></div>
      <div className="card">
        <Table rows={rows} onRow={p => setEdit({ ...p })} cols={[
          { label: 'Product', render: p => <><b>{p.name}</b><div className="small muted">{p.brand} · {p.category} · {p.barcode || (p.plu ? 'PLU ' + p.plu : p.id)}</div></> },
          { label: 'Rack', key: 'rack' },
          { label: 'GST', num: true, render: p => p.gst + '%' },
          { label: 'MRP', num: true, render: p => inr(p.mrp) },
          { label: 'Price', num: true, render: p => inr(p.price) },
          { label: 'Margin', num: true, render: p => { if (!(p.cost > 0)) return <span className="muted">—</span>; const m = p.price ? ((p.price / (1 + p.gst / 100) - p.cost) / (p.price / (1 + p.gst / 100))) * 100 : 0; return <span style={{ color: m < 8 ? 'var(--bad)' : undefined }}>{num(m, 1)}%</span>; } },
          { label: 'Stock', num: true, render: p => { const s = stock[p.id] || 0; return <span style={{ color: s <= p.reorderMin ? 'var(--bad)' : undefined }}>{num(s, p.uom === 'KG' ? 2 : 0)} {p.uom}</span>; } },
          { label: '', render: p => p.active === false ? <Badge>Hidden</Badge> : p.sample ? <Badge tone="info">Sample</Badge> : null },
        ]} />
      </div>
      {edit && <EditModal p={edit} suppliers={suppliers} onClose={() => setEdit(null)} onSave={save} />}
      {labels && <Stickers items={labels.map(p => ({ product: p, copies: 1 }))} defaultLayout="shelf" title={`Stickers & labels (${labels.length} items shown in the list)`} onClose={() => setLabels(null)} />}
      {quick && <QuickAdd onClose={() => setQuick(false)} />}
      {dups && <DuplicatesModal pairs={dups} stock={stock} onClose={() => setDups(null)} onMerged={async () => setDups(findDuplicates(await db.products.toArray()))} />}
    </div>
  );
}

function EditModal({ p: init, suppliers, onClose, onSave }) {
  const [p, setP] = useState(init);
  const [hint, setHint] = useState(null);
  const allProducts = useLive(() => db.products.toArray(), [], []);
  const f = k => e => setP({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const taxable = Number(p.price) / (1 + Number(p.gst) / 100);
  const margin = taxable ? ((taxable - Number(p.cost)) / taxable) * 100 : 0;
  const newEAN = async () => setP({ ...p, barcode: await freshStoreBarcode() });
  return (
    <Modal wide title={init.id ? `Edit: ${init.name}` : 'New product'} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => onSave(p)}>Save product</Btn></>}>
      <div className="grid g3">
        <Input label="Product name (brand, variant, size)" value={p.name} onChange={f('name')} className="span2" id="p-name" />
        <Input label="Brand" value={p.brand} onChange={f('brand')} id="p-brand" />
        <Input label="Name in Hindi / Odia (prints on the bill)" value={p.localName || ''} onChange={f('localName')} className="span2" id="p-local" placeholder="e.g. ଅମୁଲ ବଟର" />
        <Field label="Barcode (EAN-13)"><div className="row gap-s"><input className="input" value={p.barcode} onChange={f('barcode')} id="p-bar" /><Btn size="sm" type="button" onClick={newEAN} title="Make a store barcode for items without one">New</Btn></div>
          {p.barcode && /^\d{8}$|^\d{12,14}$/.test(p.barcode) && <span className="field-hint" style={{ color: validEAN(p.barcode) ? 'var(--ok)' : 'var(--bad)' }}>{validEAN(p.barcode) ? (isStoreBarcode(p.barcode) ? 'Store barcode — print stickers for it' : 'Check digit OK') : 'Check digit wrong'}</span>}</Field>
        <Input label="Category" value={p.category} onChange={f('category')} id="p-cat" />
        <Select label="Unit" value={p.uom} onChange={f('uom')} options={['PCS', 'KG', 'GM', 'LTR', 'ML', 'PACK']} id="p-uom" />
        <Field label="HSN code" hint={hint ? `Suggested ${hint.hsn}${hint.gst != null ? ` · GST ${hint.gst}%` : ''} — ${hint.source}` : ''}>
          <div className="row gap-s"><input className="input" value={p.hsn} onChange={f('hsn')} id="p-hsn" /><Btn size="sm" type="button" onClick={async () => { const h = await suggestHsnGst(p.name, allProducts.filter(x => x.id !== p.id), { useAI: true }).catch(() => null); setHint(h); if (h) setP(x => ({ ...x, hsn: h.hsn, ...(h.gst != null ? { gst: h.gst } : {}) })); }}>Suggest</Btn></div>
        </Field>
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

function DuplicatesModal({ pairs, stock, onClose, onMerged }) {
  const { user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const merge = async (keep, drop) => {
    if (!(await confirm(`Keep “${keep.name}” and move all stock, batches and history of “${drop.name}” into it? “${drop.name}” will be hidden.`, 'Merge'))) return;
    try { await mergeProducts(keep.id, drop.id, user); toast('Merged.'); onMerged(); } catch (e) { toast(e.message, 'bad'); }
  };
  const Side = ({ x }) => <div><b>{x.name}</b><div className="small muted">{x.barcode || 'no barcode'} · MRP ₹{x.mrp} · stock {num(stock[x.id] || 0)}</div></div>;
  return (
    <Modal wide title={`Possible duplicates (${pairs.length})`} onClose={onClose} footer={<Btn onClick={onClose}>Close</Btn>}>
      {!pairs.length ? <p className="muted">No duplicates found. Names with the same size and almost the same words, or the same barcode, show here.</p> :
        <div className="stack">{pairs.map(({ a, b, why }) => (
          <div key={a.id + b.id} className="card" style={{ padding: 12 }}>
            <div className="small muted" style={{ marginBottom: 6 }}>{why}</div>
            <div className="grid g2"><Side x={a} /><Side x={b} /></div>
            <div className="row gap-s wrap" style={{ marginTop: 8 }}><Btn size="sm" onClick={() => merge(a, b)}>Keep left, merge right into it</Btn><Btn size="sm" onClick={() => merge(b, a)}>Keep right</Btn></div>
          </div>))}</div>}
    </Modal>
  );
}
