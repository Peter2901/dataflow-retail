import React, { useMemo, useState } from 'react';
import { db, setSetting } from '../db.js';
import { useApp, useLive, useToast, useConfirm, PageHead, Table, Btn, Badge, Card, Select, Input } from '../ui/kit.jsx';
import { inr, num, r2, sum, daysBetween, waLink } from '../lib/util.js';
import { expiryZone, daysLeft, DEFAULT_EXPIRY } from '../lib/stock.js';
import { createDebitNote } from '../lib/purchasing.js';
import { writeOff } from './Stock.jsx';
import { audit } from '../lib/sales.js';

const RUNGS = [
  { key: 'expired', label: 'Expired', test: d => d < 0, action: 'Remove from shelf. Billing is blocked.' },
  { key: 'week', label: 'Last 7 days', test: (d, c) => d >= 0 && d <= c.lastWeekDays, action: 'Deep discount or stop sale (your rule).' },
  { key: 'd14', label: '8–14 days', test: (d, c) => d > c.lastWeekDays && d <= 14, action: 'Bigger price cut applies at the counter.' },
  { key: 'd30', label: '15–30 days', test: d => d > 14 && d <= 30, action: 'Price cut starts automatically.' },
  { key: 'd60', label: '31–60 days', test: (d, c) => d > 30 && d <= c.frontDisplayDays, action: 'Move to the front display. Return to supplier if in their window.' },
  { key: 'd90', label: '61–90 days', test: (d, c) => d > c.frontDisplayDays && d <= c.stopReorderDays, action: 'Reordering is paused for these items.' },
];

export default function Expiry() {
  const { storeId, settings, user } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const cfg = { ...DEFAULT_EXPIRY, ...(settings.expiry || {}) };
  const [zone, setZone] = useState('expired');
  const [sel, setSel] = useState({});
  const products = useLive(() => db.products.toArray(), [], []);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const batches = useLive(() => db.batches.where('storeId').equals(storeId).toArray(), [storeId], []);
  const pmap = Object.fromEntries(products.map(p => [p.id, p]));
  const smap = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const live = batches.filter(b => b.status === 'active' && b.qty > 0 && b.expiry).map(b => ({ ...b, dl: daysLeft(b.expiry), p: pmap[b.productId] }));
  const byRung = useMemo(() => Object.fromEntries(RUNGS.map(r => [r.key, live.filter(b => r.test(b.dl, cfg))])), [live, cfg]);
  const quarantined = batches.filter(b => b.status === 'quarantine' && b.qty > 0);
  const rows = (zone === 'quarantine' ? quarantined.map(b => ({ ...b, dl: daysLeft(b.expiry), p: pmap[b.productId] })) : byRung[zone] || []).sort((a, b) => a.dl - b.dl);
  const chosen = rows.filter(b => sel[b.id]);
  const rung = RUNGS.find(r => r.key === zone);

  const quarantine = async () => {
    for (const b of chosen) await db.batches.update(b.id, { status: 'quarantine' });
    await audit('quarantine', { batches: chosen.map(b => b.batchNo) }, user);
    toast(`${chosen.length} batches moved to quarantine.`); setSel({});
  };
  const front = async () => {
    for (const b of chosen) await db.batches.update(b.id, { frontDisplay: true });
    toast(`${chosen.length} batches marked for the front display.`); setSel({});
  };
  const returnToSupplier = async () => {
    const bySupp = {};
    chosen.forEach(b => { const sid = b.p?.vendorId; if (sid) (bySupp[sid] = bySupp[sid] || []).push(b); });
    if (!Object.keys(bySupp).length) { toast('These items have no supplier set. Set one in Products.', 'bad'); return; }
    if (!(await confirm(`Make ${Object.keys(bySupp).length} debit note(s) and take the stock out of the shelf?`, 'Make debit notes'))) return;
    for (const [sid, list] of Object.entries(bySupp)) {
      await createDebitNote({ supplier: smap[sid], items: list.map(b => ({ batch: b, qty: b.qty })), reason: 'Near-expiry return', user });
    }
    toast('Debit notes made. Send them to the suppliers from Purchases › Returns.'); setSel({});
  };
  const destroy = async () => {
    if (!(await confirm(`Write off ${chosen.length} batches worth ${inr(sum(chosen, b => b.qty * b.cost))}? GST input credit will be reversed.`, 'Write off'))) return;
    for (const b of chosen) await writeOff({ batch: b, product: b.p, qty: b.qty, reason: 'expired', user });
    toast('Written off.'); setSel({});
  };
  const saveRule = async (k, v) => setSetting('expiry', { ...cfg, [k]: v });

  return (
    <div className="stack">
      <PageHead title="Expiry control" sub="Every batch is watched from 90 days before expiry. Nothing expired can be billed." />
      <div className="ladder">
        {RUNGS.map(r => (
          <button key={r.key} className={`rung ${zone === r.key ? 'on' : ''}`} onClick={() => { setZone(r.key); setSel({}); }}>
            <span className="small muted">{r.label}</span><b style={{ color: r.key === 'expired' || r.key === 'week' ? 'var(--bad)' : undefined }}>{byRung[r.key].length}</b>
            <span className="small">{inr(sum(byRung[r.key], b => b.qty * b.cost), 0)} at cost</span>
          </button>
        ))}
      </div>
      <div className="row gap-s wrap">
        <Btn size="sm" kind={zone === 'quarantine' ? 'primary' : 'default'} onClick={() => { setZone('quarantine'); setSel({}); }}>Quarantine room ({quarantined.length})</Btn>
      </div>

      <Card title={zone === 'quarantine' ? 'Quarantine room' : rung?.label} actions={<>
        {zone !== 'quarantine' && <Btn size="sm" disabled={!chosen.length} onClick={front}>Move to front</Btn>}
        <Btn size="sm" disabled={!chosen.length} onClick={returnToSupplier}>Return to supplier</Btn>
        {zone !== 'quarantine' && <Btn size="sm" disabled={!chosen.length} onClick={quarantine}>Quarantine</Btn>}
        <Btn size="sm" kind="danger" disabled={!chosen.length} onClick={destroy}>Write off</Btn>
      </>}>
        {rung && <p className="small muted" style={{ marginBottom: 8 }}>{rung.action}</p>}
        <Table rows={rows} empty="Nothing in this step." cols={[
          { label: <input type="checkbox" aria-label="Select all" checked={rows.length > 0 && chosen.length === rows.length} onChange={e => setSel(e.target.checked ? Object.fromEntries(rows.map(b => [b.id, true])) : {})} />, key: 'sel', render: b => <input type="checkbox" aria-label={`Select ${b.batchNo}`} checked={!!sel[b.id]} onChange={e => setSel({ ...sel, [b.id]: e.target.checked })} /> },
          { label: 'Item', render: b => <><b>{b.p?.name}</b><div className="small muted">Batch {b.batchNo} · rack {b.p?.rack}{b.frontDisplay ? ' · on front display' : ''}</div></> },
          { label: 'Expiry', render: b => <>{b.expiry}<div className="small"><Badge tone={expiryZone(b.dl, cfg).tone}>{expiryZone(b.dl, cfg).label}</Badge></div></> },
          { label: 'Supplier return', render: b => { const s = smap[b.p?.vendorId]; if (!s?.returnDays) return <span className="muted small">No return deal</span>; const open = b.dl >= s.returnDays; return open ? <Badge tone="ok">Open until {daysBetween(new Date(), new Date(b.expiry)) - s.returnDays}d</Badge> : <Badge tone="neutral">Window closed</Badge>; } },
          { label: 'Qty', num: true, render: b => num(b.qty, 2) },
          { label: 'At cost', num: true, render: b => inr(r2(b.qty * b.cost)) },
        ]} />
      </Card>

      <div className="grid g2">
        <Card title="Your expiry rules">
          <div className="grid g2">
            <Select label="Last 7 days" value={cfg.lastWeekRule} onChange={e => saveRule('lastWeekRule', e.target.value)} options={[{ value: 'discount', label: 'Deep discount' }, { value: 'block', label: 'Stop sale (block at counter)' }]} id="rule-week" />
            {cfg.lastWeekRule === 'discount' && <Input label="Last-week discount %" type="number" value={cfg.lastWeekPct} onChange={e => saveRule('lastWeekPct', Number(e.target.value))} id="rule-wpct" />}
            <Input label="15–30 days discount %" type="number" value={cfg.markdown30Pct} onChange={e => saveRule('markdown30Pct', Number(e.target.value))} id="rule-30" />
            <Input label="8–14 days discount %" type="number" value={cfg.markdown14Pct} onChange={e => saveRule('markdown14Pct', Number(e.target.value))} id="rule-14" />
            <Input label="Stop reordering at (days)" type="number" value={cfg.stopReorderDays} onChange={e => saveRule('stopReorderDays', Number(e.target.value))} id="rule-90" />
            <Input label="Front display at (days)" type="number" value={cfg.frontDisplayDays} onChange={e => saveRule('frontDisplayDays', Number(e.target.value))} id="rule-60" />
          </div>
          <p className="small muted" style={{ marginTop: 10 }}>Discounts apply automatically at the counter to the batch being sold, so a fresh batch of the same item keeps its normal price.</p>
        </Card>
        <Card title="Tell the team">
          <p className="small muted">Send this morning’s expiry list to the floor staff.</p>
          <a className="btn" style={{ marginTop: 10 }} href={waLink('', `*Expiry list ${new Date().toLocaleDateString('en-IN')}*\n` + RUNGS.slice(0, 5).map(r => `${r.label}: ${byRung[r.key].length} batches`).join('\n') + '\n\nRemove expired now:\n' + byRung.expired.map(b => `• ${b.p?.name} (${b.batchNo}) rack ${b.p?.rack}`).join('\n'))} target="_blank" rel="noreferrer">Share on WhatsApp</a>
        </Card>
      </div>
    </div>
  );
}
