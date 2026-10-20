import React, { useRef, useState } from 'react';
import { useApp, useToast, Modal, Btn, Input, Select, Field } from './kit.jsx';
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
  const first = () => ({ name, barcode, mrp: mrp || '', price: '', gst, stock: '', cost: cost || '' });
  const [f, setF] = useState(first);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef();
  const set = k => e => setF({ ...f, [k]: e.target.value });

  const save = async next => {
    if (busy) return;
    setBusy(true);
    try {
      const p = await quickAddProduct({ ...f, price: f.price || f.mrp, storeId, user });
      toast(`${p.name} added${Number(f.stock) > 0 ? ` with ${f.stock} in stock` : ''}.`);
      onSaved?.(p);
      if (next) { setF({ name: '', barcode: '', mrp: '', price: '', gst: f.gst, stock: '', cost: '' }); setTimeout(() => nameRef.current?.focus(), 0); }
      else onClose();
    } catch (e) { toast(e.message, 'bad'); }
    setBusy(false);
  };

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
        <Input label="Purchase rate before GST (₹, optional)" type="number" step="0.01" value={f.cost} onChange={set('cost')} id="qa-cost" />
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
