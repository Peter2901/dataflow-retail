import React, { useEffect, useRef, useState } from 'react';
import { db } from '../db.js';
import { suggestHsnGst, readPackPhoto } from '../lib/productTools.js';
import { useApp, useToast, useLive, Modal, Btn, Input, Select, Field, useOnce } from './kit.jsx';
import { GST_SLABS } from '../lib/billing.js';
import { quickAddProduct, freshStoreBarcode } from '../lib/products.js';
import { isStoreBarcode } from '../lib/barcode.js';
import { validEAN } from '../lib/util.js';

/**
 * Quick add a product with five fields. Used from Products, from the counter when a
 * barcode is unknown, and from purchase bills. `allowNext` shows "Save and add next".
 */
export default function QuickAdd({ barcode = '', name = '', mrp = '', gst = 5, cost = '', title = 'Quick add product', allowNext = true, askStock = true, onClose, onSaved }) {
  const { storeId, user } = useApp();
  const toast = useToast();
  const first = () => ({ name, barcode, mrp: mrp || '', price: '', gst, stock: '', cost: cost || '', hsn: '', category: '', brand: '' });
  const [f, setF] = useState(first);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef();
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const products = useLive(() => db.products.toArray(), [], []);
  const [hint, setHint] = useState(null);
  const [reading, setReading] = useState('');
  // HSN/GST hint from your own similar products (plain code); AI only when you press "Ask AI".
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => suggestHsnGst(f.name, products).then(h => live && setHint(h)).catch(() => {}), 350);
    return () => { live = false; clearTimeout(t); };
  }, [f.name, products]);
  const askHint = async () => { setReading('Asking AI…'); try { const h = await suggestHsnGst(f.name, [], { useAI: true }); setHint(h || { none: true }); } catch (e) { toast(e.message, 'bad'); } setReading(''); };
  const useHint = () => setF(x => ({ ...x, hsn: hint.hsn, ...(hint.gst != null ? { gst: hint.gst } : {}), ...(hint.category && !x.category ? { category: hint.category } : {}) }));
  const fromPack = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try {
      const r = await readPackPhoto(file, setReading);
      setF(x => ({ ...x, name: x.name || r.name || '', brand: r.brand || x.brand, mrp: x.mrp || (r.mrp ?? ''), barcode: x.barcode || r.barcode || '', category: x.category || r.category || '' }));
      const got = [r.name && 'name', r.mrp && 'MRP', r.barcode && 'barcode', r.netQty && 'size'].filter(Boolean);
      toast(got.length ? `Read ${got.join(', ')} from the pack${r.method === 'ai' ? ' (with AI help)' : ''}. Check before saving.` : 'Could not read the pack. Type the details.', got.length ? 'ok' : 'warn');
      if (r.netQty && r.unit && r.name && !new RegExp(`${r.netQty}\\s*${r.unit}`, 'i').test(r.name)) setF(x => ({ ...x, name: `${x.name} ${r.netQty} ${r.unit}`.trim() }));
      if (r.barcode && products.some(p => p.barcode === r.barcode)) toast(`Barcode ${r.barcode} is already in your products.`, 'warn');
    } catch (err) { toast(err.message || 'Could not read the photo.', 'bad'); }
    setReading('');
  };

  const save = useOnce(async next => {
    if (busy) return;
    setBusy(true);
    try {
      const p = await quickAddProduct({ ...f, price: f.price || f.mrp, storeId, user });
      setHint(null);
      toast(`${p.name} added${Number(f.stock) > 0 ? ` with ${f.stock} in stock` : ''}.`);
      onSaved?.(p);
      if (next) { setF({ name: '', barcode: '', mrp: '', price: '', gst: f.gst, stock: '', cost: '', hsn: '', category: '', brand: '' }); setTimeout(() => nameRef.current?.focus(), 0); }
      else onClose();
    } catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  });

  const codeHint = !f.barcode ? 'Leave empty for items without a barcode: a store barcode is made for you.'
    : isStoreBarcode(f.barcode) ? 'Store barcode (starts with 02). Print stickers from Products.'
    : /^\d{8}$|^\d{12,14}$/.test(f.barcode) ? (validEAN(f.barcode) ? 'Barcode OK' : 'Check digit wrong — scan it again') : '';

  return (
    <Modal title={title} onClose={onClose} footer={<>
      <Btn onClick={onClose}>Cancel</Btn>
      {allowNext && <Btn onClick={() => save(true)} disabled={busy}>Save and add next</Btn>}
      <Btn kind="primary" onClick={() => save(false)} disabled={busy}>Save</Btn>
    </>}>
      <form className="stack" onSubmit={e => { e.preventDefault(); save(allowNext); }}>
        <div className="row gap-s wrap"><label className="btn btn-sm">📷 Fill from pack photo<input type="file" accept="image/*" capture="environment" hidden onChange={fromPack} /></label>{reading && <span className="small muted">{reading}</span>}</div>
        <Input label="Product name (brand, variant, size)" value={f.name} onChange={set('name')} autoFocus ref={nameRef} id="qa-name" placeholder="e.g. Parle-G 100 g" />
        <div className="grid g2">
          <Input label="MRP (₹)" type="number" step="0.01" value={f.mrp} onChange={set('mrp')} id="qa-mrp" />
          <Input label="Selling price (₹)" type="number" step="0.01" value={f.price} onChange={set('price')} placeholder={f.mrp ? `Same as MRP (${f.mrp})` : ''} id="qa-price" />
          <Select label="GST" value={f.gst} onChange={set('gst')} options={GST_SLABS.map(g => ({ value: g, label: g + '%' }))} id="qa-gst" />
          {askStock && <Input label="Opening stock (pieces)" type="number" value={f.stock} onChange={set('stock')} id="qa-stock" />}
        </div>
        <Field label="Barcode" hint={codeHint}>
          <div className="row gap-s">
            <input className="input" value={f.barcode} onChange={set('barcode')} id="qa-bar" placeholder="Scan, or leave empty" />
            <Btn size="sm" type="button" onClick={async () => setF({ ...f, barcode: await freshStoreBarcode() })}>New</Btn>
          </div>
        </Field>
        <div className="grid g2">
          <Input label="HSN code" value={f.hsn} onChange={set('hsn')} id="qa-hsn" />
          <Input label="Purchase rate before GST (₹, optional)" type="number" step="0.01" value={f.cost} onChange={set('cost')} id="qa-cost" />
        </div>
        {hint && !hint.none && (hint.hsn !== f.hsn || (hint.gst != null && Number(hint.gst) !== Number(f.gst))) && <p className="note small">Suggested: HSN <b>{hint.hsn}</b>{hint.gst != null ? <> · GST <b>{hint.gst}%</b></> : null} — {hint.source}. <Btn size="sm" type="button" onClick={useHint}>Use</Btn></p>}
        {!hint && f.name.length > 3 && <p className="small muted">No HSN hint from your products. <button type="button" className="linkish" onClick={askHint}>Ask AI</button> (if AI is on) or ask your CA.</p>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
