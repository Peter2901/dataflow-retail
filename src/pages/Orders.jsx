import React, { useMemo, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, useToast, PageHead, Btn, Modal, Input, Select, Badge, Card, Table } from '../ui/kit.jsx';
import ProductPicker from '../ui/ProductPicker.jsx';
import { inr, uid, waLink, fmtDT, sum, r2 } from '../lib/util.js';
import { stockMap, reservedMap } from '../lib/stock.js';

const FLOW = { new: 'New', packing: 'Packing', ready: 'Ready', billed: 'Billed', delivered: 'Delivered', cancelled: 'Cancelled' };
const NEXT = { new: 'packing', packing: 'ready', billed: 'delivered' };
const TONE = { new: 'accent', packing: 'info', ready: 'ok', billed: 'ok', delivered: 'neutral', cancelled: 'bad' };

export default function Orders() {
  const { go, settings, storeId } = useApp();
  const toast = useToast();
  const orders = useLive(() => db.orders.orderBy('createdAt').reverse().toArray(), [], []);
  const products = useLive(() => db.products.toArray(), [], []);
  const stock = useLive(() => stockMap(storeId), [storeId], {});
  const reserved = useLive(() => reservedMap(), [], {});
  const [creating, setCreating] = useState(false);
  const [show, setShow] = useState('open');
  const list = orders.filter(o => show === 'open' ? ['new', 'packing', 'ready'].includes(o.status) : !['new', 'packing', 'ready'].includes(o.status));
  const move = async (o, s) => {
    await db.orders.update(o.id, { status: s, [`${s}At`]: Date.now() });
    toast(`${o.no} is now ${FLOW[s].toLowerCase()}.`);
  };
  const msg = o => ({
    packing: `Hi ${o.customerName}, your order ${o.no} from ${settings.storeName} is being packed.`,
    ready: o.mode === 'pickup' ? `Hi ${o.customerName}, your order ${o.no} is ready for pickup at ${settings.storeName}. Total ${inr(orderTotal(o))}.` : `Hi ${o.customerName}, your order ${o.no} is packed and will be delivered soon. Total ${inr(orderTotal(o))}.`,
  }[o.status] || `Hi ${o.customerName}, update on your order ${o.no}: ${FLOW[o.status]}.`);
  const catalogue = useMemo(() => {
    const byCat = {};
    products.filter(p => p.active !== false && (stock[p.id] || 0) - (reserved[p.id] || 0) > 0).forEach(p => (byCat[p.category] = byCat[p.category] || []).push(p));
    return `*${settings.storeName} — order on WhatsApp*\nReply with item names and quantities.\n\n` + Object.entries(byCat).map(([c, ps]) => `*${c}*\n` + ps.slice(0, 12).map(p => `• ${p.name} — ₹${p.price}${p.loose ? '/kg' : ''} (MRP ₹${p.mrp})`).join('\n')).join('\n\n');
  }, [products, stock, reserved, settings.storeName]);

  return (
    <div className="stack">
      <PageHead title="WhatsApp orders" sub="Customers order in a chat; you pack from the same shelves. Ordered items are held back from online stock so nothing is oversold."
        actions={<><a className="btn" href={waLink('', catalogue)} target="_blank" rel="noreferrer">Share price list on WhatsApp</a><Btn kind="primary" onClick={() => setCreating(true)}>New order</Btn></>} />
      <div className="row gap-s"><Btn size="sm" kind={show === 'open' ? 'primary' : 'default'} onClick={() => setShow('open')}>Open</Btn><Btn size="sm" kind={show === 'done' ? 'primary' : 'default'} onClick={() => setShow('done')}>Done</Btn></div>
      {!list.length && <div className="card empty">{show === 'open' ? 'No open orders. Share your price list on WhatsApp to get the first one.' : 'No finished orders yet.'}</div>}
      <div className="grid g3">
        {list.map(o => (
          <Card key={o.id} title={o.no} actions={<Badge tone={TONE[o.status]}>{FLOW[o.status]}</Badge>}>
            <div className="stack">
              <div><b>{o.customerName}</b> <span className="muted small">· {o.phone} · {o.mode === 'pickup' ? 'Pickup' : 'Home delivery'}</span>{o.address && o.mode !== 'pickup' && <div className="small muted">{o.address}</div>}</div>
              <div className="small">{o.items.map((i, k) => <div key={k} className="row between"><span>{i.name} × {i.qty}</span><span className="mono">{inr(i.qty * i.price)}</span></div>)}</div>
              <div className="row between"><span className="small muted">{fmtDT(o.createdAt)} · {o.channel}</span><b className="mono">{inr(orderTotal(o))}</b></div>
              {o.billNo && <div className="small">Bill {o.billNo}</div>}
              <div className="row gap-s wrap">
                {NEXT[o.status] && <Btn size="sm" kind="primary" onClick={() => move(o, NEXT[o.status])}>Mark {FLOW[NEXT[o.status]].toLowerCase()}</Btn>}
                {['packing', 'ready'].includes(o.status) && <Btn size="sm" onClick={() => go('pos', { orderId: o.id })}>Bill at counter</Btn>}
                {['new', 'packing', 'ready'].includes(o.status) && <a className="btn btn-sm" href={waLink(o.phone, msg(o))} target="_blank" rel="noreferrer">Update customer</a>}
                {['new', 'packing'].includes(o.status) && <Btn size="sm" kind="ghost" onClick={() => move(o, 'cancelled')}>Cancel</Btn>}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {creating && <NewOrder products={products} stock={stock} reserved={reserved} onClose={() => setCreating(false)} />}
    </div>
  );
}

export const orderTotal = o => r2(sum(o.items, i => i.qty * i.price));

function NewOrder({ products, stock, reserved, onClose }) {
  const toast = useToast();
  const customers = useLive(() => db.customers.toArray(), [], []);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState('pickup');
  const [address, setAddress] = useState('');
  const [items, setItems] = useState([]);
  const [pid, setPid] = useState('');
  const [qty, setQty] = useState('1');
  const known = customers.find(c => c.phone === phone.replace(/\D/g, ''));
  const avail = id => (stock[id] || 0) - (reserved[id] || 0);
  const add = () => {
    const p = products.find(x => x.id === pid); if (!p || !(Number(qty) > 0)) return;
    if (Number(qty) > avail(p.id)) toast(`Only ${avail(p.id)} of ${p.name} free to promise.`, 'warn');
    setItems([...items, { productId: p.id, name: p.name, qty: Number(qty), price: p.price }]); setPid(''); setQty('1');
  };
  const save = async () => {
    const ph = phone.replace(/\D/g, '');
    if (ph.length !== 10 || !items.length) { toast('Add a 10-digit mobile number and at least one item.', 'bad'); return; }
    let c = known;
    if (!c) { c = { id: uid('c_'), name: name || 'Customer ' + ph.slice(-4), phone: ph, yearSpend: 0, lifeSpend: 0, points: 0, visits: 0, creditLimit: 2000, gstin: '', consentWhatsApp: true, createdAt: Date.now() }; await db.customers.add(c); }
    const n = await db.orders.count();
    await db.orders.add({ id: uid('o_'), no: 'ORD-' + (1001 + n), customerId: c.id, customerName: c.name, phone: ph, items, status: 'new', mode, address, createdAt: Date.now(), channel: 'WhatsApp' });
    toast('Order saved. Stock for it is now held back.'); onClose();
  };
  return (
    <Modal wide title="New WhatsApp order" onClose={onClose} footer={<><span className="grow">Total <b className="mono">{inr(sum(items, i => i.qty * i.price))}</b></span><Btn onClick={onClose}>Cancel</Btn><Btn kind="primary" onClick={save}>Save order</Btn></>}>
      <div className="stack">
        <div className="grid g3">
          <Input label="Customer mobile" value={phone} onChange={e => setPhone(e.target.value)} inputMode="tel" id="o-phone" hint={known ? `Found: ${known.name}` : ''} />
          {!known && <Input label="Name" value={name} onChange={e => setName(e.target.value)} id="o-name" />}
          <Select label="Pickup or delivery" value={mode} onChange={e => setMode(e.target.value)} options={[{ value: 'pickup', label: 'Pickup at store' }, { value: 'delivery', label: 'Home delivery' }]} id="o-mode" />
        </div>
        {mode === 'delivery' && <Input label="Delivery address" value={address} onChange={e => setAddress(e.target.value)} id="o-addr" />}
        <div className="row gap-s wrap" style={{ alignItems: 'flex-end' }}>
          <ProductPicker className="grow" label="Item" products={products} value={pid} onChange={setPid} extra={p => `₹${p.price} · ${Math.max(0, avail(p.id))} free`} id="o-item" />
          <Input label="Qty" type="number" value={qty} onChange={e => setQty(e.target.value)} id="o-qty" />
          <Btn onClick={add}>Add</Btn>
        </div>
        <Table rows={items.map((i, k) => ({ ...i, id: k }))} empty="No items yet." cols={[{ label: 'Item', key: 'name' }, { label: 'Qty', num: true, key: 'qty' }, { label: 'Amount', num: true, render: i => inr(i.qty * i.price) }, { label: '', render: i => <button className="icon-btn" onClick={() => setItems(items.filter((_, k) => k !== i.id))} aria-label="Remove">✕</button> }]} />
      </div>
    </Modal>
  );
}
