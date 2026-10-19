import React, { useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Table, Btn, Modal, Input, Select, Badge, Card } from '../ui/kit.jsx';
import { inr, uid } from '../lib/util.js';
import { OFFER_TYPES } from '../lib/offers.js';
import { audit } from '../lib/sales.js';

const describe = (o, pm) => ({
  qtySlab: () => `${pm[o.productId]?.name}: ${o.slabs.map(s => `${s.minQty}+ at ₹${s.price}`).join(', ')}`,
  bxgy: () => `${pm[o.productId]?.name}: buy ${o.buy}, get ${o.get} ${o.pct === 100 ? 'free' : `at ${o.pct}% off`}`,
  category: () => `${o.pct}% off everything in ${o.category}`,
  combo: () => `${(o.productIds || []).map(id => pm[id]?.name).join(' + ')}: ₹${o.off} off together`,
  billBuster: () => `Bill of ${inr(o.minAmount, 0)} or more: ${inr(o.off, 0)} off`,
}[o.type]?.() || '');

export default function Offers() {
  const { user } = useApp();
  const toast = useToast();
  const offers = useLive(() => db.offers.toArray(), [], []);
  const products = useLive(() => db.products.toArray(), [], []);
  const pm = Object.fromEntries(products.map(p => [p.id, p]));
  const [edit, setEdit] = useState(null);
  const toggle = async o => { await db.offers.update(o.id, { active: !o.active }); audit('offer_toggle', { name: o.name, active: !o.active }, user); };
  const save = async o => {
    if (!o.name) { toast('Give the offer a name customers will see.', 'bad'); return; }
    await db.offers.put({ ...o, id: o.id || uid('of_') });
    audit('offer_saved', { name: o.name }, user);
    toast('Offer saved. Every counter applies it from the next bill.'); setEdit(null);
  };
  return (
    <div className="stack">
      <PageHead title="Offers & pricing" sub="Offers apply by themselves at every counter, even offline. The margin guard stops any offer selling below cost." actions={<Btn kind="primary" onClick={() => setEdit({ type: 'qtySlab', name: '', active: true, slabs: [{ minQty: 3, price: '' }] })}>New offer</Btn>} />
      <div className="card"><Table rows={offers} cols={[
        { label: 'Offer', render: o => <><b>{o.name}</b><div className="small muted">{describe(o, pm)}</div></> },
        { label: 'Type', render: o => OFFER_TYPES[o.type] },
        { label: 'Dates', render: o => o.from || o.to ? `${o.from || '…'} → ${o.to || '…'}` : 'Always' },
        { label: 'Status', render: o => <Badge tone={o.active ? 'ok' : 'neutral'}>{o.active ? 'On' : 'Off'}</Badge> },
        { label: '', render: o => <div className="row gap-s"><Btn size="sm" onClick={() => toggle(o)}>{o.active ? 'Turn off' : 'Turn on'}</Btn><Btn size="sm" onClick={() => setEdit({ ...o })}>Edit</Btn></div> },
      ]} /></div>
      <Card title="How offers combine">
        <p className="small">1) Near-expiry markdowns apply to the batch first. 2) Item offers (quantity, buy-X-get-Y, category, combo). 3) Bill-level offers (spend more, save more), then loyalty points. All discounts are given before GST, so tax is charged on the lower price, as GST law (s.15(3)) requires.</p>
      </Card>
      {edit && <OfferModal o={edit} products={products} onClose={() => setEdit(null)} onSave={save} />}
    </div>
  );
}

function OfferModal({ o: init, products, onClose, onSave }) {
  const [o, setO] = useState(init);
  const f = (k, num) => e => setO({ ...o, [k]: num ? Number(e.target.value) : e.target.value });
  const pOpts = [{ value: '', label: 'Choose product' }, ...products.map(p => ({ value: p.id, label: `${p.name} (₹${p.price})` }))];
  const cats = [...new Set(products.map(p => p.category))];
  return (
    <Modal title={init.id ? 'Edit offer' : 'New offer'} onClose={onClose} footer={<><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={() => onSave(o)}>Save offer</Btn></>}>
      <div className="stack">
        <Select label="Kind of offer" value={o.type} onChange={e => setO({ ...o, type: e.target.value, slabs: o.slabs || [{ minQty: 3, price: '' }], productIds: o.productIds || ['', ''] })} options={Object.entries(OFFER_TYPES).map(([v, l]) => ({ value: v, label: l }))} id="of-type" />
        <Input label="Name shown on the bill" value={o.name} onChange={f('name')} id="of-name" />
        {(o.type === 'qtySlab' || o.type === 'bxgy') && <Select label="Product" value={o.productId || ''} onChange={f('productId')} options={pOpts} id="of-prod" />}
        {o.type === 'qtySlab' && (o.slabs || []).map((s, i) => (
          <div className="row gap-s" key={i}>
            <Input label="From quantity" type="number" value={s.minQty} onChange={e => { const sl = [...o.slabs]; sl[i] = { ...s, minQty: Number(e.target.value) }; setO({ ...o, slabs: sl }); }} id={`of-min${i}`} />
            <Input label="Price each (₹)" type="number" value={s.price} onChange={e => { const sl = [...o.slabs]; sl[i] = { ...s, price: Number(e.target.value) }; setO({ ...o, slabs: sl }); }} id={`of-pr${i}`} />
          </div>
        ))}
        {o.type === 'qtySlab' && <Btn size="sm" onClick={() => setO({ ...o, slabs: [...o.slabs, { minQty: (o.slabs.at(-1)?.minQty || 1) + 3, price: '' }] })}>Add another step</Btn>}
        {o.type === 'bxgy' && <div className="grid g3"><Input label="Buy" type="number" value={o.buy || 2} onChange={f('buy', 1)} id="of-buy" /><Input label="Get" type="number" value={o.get || 1} onChange={f('get', 1)} id="of-get" /><Input label="At % off (100 = free)" type="number" value={o.pct ?? 100} onChange={f('pct', 1)} id="of-pct" /></div>}
        {o.type === 'category' && <div className="grid g2"><Select label="Category" value={o.category || ''} onChange={f('category')} options={['', ...cats]} id="of-cat" /><Input label="% off" type="number" value={o.pct || ''} onChange={f('pct', 1)} id="of-cpct" /></div>}
        {o.type === 'combo' && <>
          <Select label="First product" value={o.productIds?.[0] || ''} onChange={e => setO({ ...o, productIds: [e.target.value, o.productIds?.[1] || ''] })} options={pOpts} id="of-c1" />
          <Select label="Second product" value={o.productIds?.[1] || ''} onChange={e => setO({ ...o, productIds: [o.productIds?.[0] || '', e.target.value] })} options={pOpts} id="of-c2" />
          <Input label="₹ off when bought together" type="number" value={o.off || ''} onChange={f('off', 1)} id="of-off" />
        </>}
        {o.type === 'billBuster' && <div className="grid g2"><Input label="Bill of at least (₹)" type="number" value={o.minAmount || ''} onChange={f('minAmount', 1)} id="of-minamt" /><Input label="₹ off" type="number" value={o.off || ''} onChange={f('off', 1)} id="of-boff" /></div>}
        <div className="grid g2"><Input label="Starts (optional)" type="date" value={o.from || ''} onChange={f('from')} id="of-from" /><Input label="Ends (optional)" type="date" value={o.to || ''} onChange={f('to')} id="of-to" /></div>
      </div>
    </Modal>
  );
}
