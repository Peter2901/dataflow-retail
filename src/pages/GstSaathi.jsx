// GST Saathi — the month's GST work in five steps: due dates, checks, GSTR-1, GSTR-2B, GSTR-3B.
// It prepares and checks; the person (or their CA) files on the GST portal. Plain code only:
// AI never files a return and never sets a GST rate. Rule-book changes need the owner's OK.
import React, { useEffect, useMemo, useState } from 'react';
import { db, setSetting } from '../db.js';
import { useApp, useLive, useToast, PageHead, Card, Btn, Badge, Table, Stat, Select, Input } from '../ui/kit.jsx';
import { inr, download, localISO } from '../lib/util.js';
import { exportRows, readAny } from '../lib/excel.js';
import { audit } from '../lib/sales.js';
import {
  DEFAULT_RULES, RULES_URL, rulesDiff, monthKey, monthRange, monthLabel, periodFor, dueDates, daysTo,
  gstr1Data, gstr1Json, gstr3bData, match2b, read2bRows, preChecks,
} from '../lib/gst.js';

const LEVEL = { stop: { tone: 'bad', label: 'Fix first' }, warn: { tone: 'warn', label: 'Check' }, ok: { tone: 'ok', label: 'OK' } };
const lastMonth = () => { const d = new Date(); return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)); };
const fmt = date => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export default function GstSaathi() {
  const { settings, storeId, user, go } = useApp();
  const toast = useToast();
  const rules = settings.gstRules || DEFAULT_RULES;
  const qrmp = !!settings.gstFiling?.qrmp;
  const [key, setKey] = useState(lastMonth());
  const per = periodFor(key, qrmp);
  const range = useMemo(() => ({ from: monthRange(per.keys[0]).from, to: monthRange(per.keys[per.keys.length - 1]).to }), [key, qrmp]);

  const sales = useLive(() => db.sales.where('storeId').equals(storeId).toArray(), [storeId], null);
  const purchases = useLive(() => db.purchases.toArray(), [], []);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const journal = useLive(() => db.journal.toArray(), [], []);
  const products = useLive(() => db.products.toArray(), [], []);

  const inP = useMemo(() => (sales || []).filter(s => s.ts >= range.from && s.ts <= range.to), [sales, range]);
  const purP = useMemo(() => purchases.filter(p => { const t = new Date(p.date).getTime(); return t >= range.from && t <= range.to && (!p.storeId || p.storeId === storeId); }), [purchases, range, storeId]);
  const jP = useMemo(() => journal.filter(j => j.ts >= range.from && j.ts <= range.to), [journal, range]);
  const twoB = settings.gst2b || {};
  const itcSafe = per.keys.every(k => twoB[k]) ? per.keys.reduce((a, k) => a + (twoB[k].safe || 0), 0) : null;
  const d = useMemo(() => gstr1Data(inP, settings), [inP, settings]);
  const b = useMemo(() => gstr3bData({ sales: inP, purchases: purP, suppliers, journal: jP, settings, itcSafe }), [inP, purP, suppliers, jP, settings, itcSafe]);
  const checks = useMemo(() => preChecks({ sales: inP, products, settings, rules, d, threeB: b }), [inP, products, settings, rules, d, b]);
  const filed = settings.gstFiled?.[key] || {};
  const due = dueDates(key, { qrmp, stateCode: settings.stateCode, rules });
  const stops = checks.filter(c => c.level === 'stop').length;

  const markFiled = async (id, arn = '') => {
    const all = { ...(settings.gstFiled || {}) };
    all[key] = { ...filed, [id]: { at: Date.now(), by: user.name, arn } };
    await setSetting('gstFiled', all);
    await audit('gst_filed', { period: key, ret: id, arn }, user);
    toast('Marked as filed.');
  };
  const months = Array.from({ length: 13 }, (_, i) => { const n = new Date(); return monthKey(new Date(n.getFullYear(), n.getMonth() - i, 1)); });

  if (!sales) return <p>Loading…</p>;
  return (
    <div className="stack">
      <PageHead title="GST Saathi" sub="Your month’s GST in five steps. GST Saathi prepares and checks — you or your CA file on the GST portal."
        actions={<>
          <Select aria-label="Return month" value={key} onChange={e => setKey(e.target.value)} options={months.map(k => ({ value: k, label: monthLabel(k) }))} />
          <Select aria-label="How you file" value={qrmp ? 'q' : 'm'} disabled={user.role !== 'owner'} onChange={e => setSetting('gstFiling', { qrmp: e.target.value === 'q' })} options={[{ value: 'm', label: 'Monthly filer' }, { value: 'q', label: 'Quarterly (QRMP)' }]} />
        </>} />

      {per.kind === 'quarter' && <div className="note">{`Quarter return: covers ${per.keys.map(monthLabel).join(', ')}.`}</div>}
      {per.kind === 'iff' && <div className="note">Quarterly filer, middle month: GSTR-1 is optional here (IFF, business bills only). Pay this month’s tax with PMT-06.</div>}

      <Card title="1 · Due dates">
        <div className="grid g3">
          {due.map(x => {
            const n = daysTo(x.date), done = filed[x.id];
            return <Stat key={x.id} label={x.label} value={fmt(x.date)} tone={done ? 'ok' : n < 0 ? 'bad' : n <= 3 ? 'warn' : undefined}
              sub={done ? `Filed ${new Date(done.at).toLocaleDateString('en-IN')}${done.arn ? ' · ARN ' + done.arn : ''}` : n < 0 ? `${-n} day(s) late — late fee and interest apply` : n === 0 ? 'Due today' : `${n} day(s) left`} />;
          })}
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>{`Usual dates from rule book ${rules.version}. The government sometimes extends them — the rule book shows approved extensions.`}</p>
      </Card>

      <Card title={`2 · Checks before filing ${stops ? `— ${stops} to fix` : ''}`}>
        <ul className="checks">
          {checks.map((c, i) => (
            <li key={i}><Badge tone={LEVEL[c.level].tone}>{LEVEL[c.level].label}</Badge><span className="grow">{c.text}</span>
              {c.fix && <Btn size="sm" onClick={() => go(c.fix.page, c.fix.param || null)}>Open</Btn>}</li>
          ))}
        </ul>
      </Card>

      <Gstr1Step d={d} settings={settings} keyM={key} per={per} stops={stops} filed={filed} onFiled={arn => markFiled(per.kind === 'iff' ? 'iff' : 'gstr1', arn)} />
      <TwoBStep keyM={key} purchases={purchases} suppliers={suppliers} twoB={twoB} />
      <ThreeBStep b={b} per={per} filed={filed} onFiled={arn => markFiled(per.kind === 'iff' ? 'pmt06' : 'gstr3b', arn)} />
      <RuleBook rules={rules} canApprove={user.role === 'owner'} />
    </div>
  );
}

function FiledBox({ done, onFiled, label }) {
  const [arn, setArn] = useState('');
  if (done) return <p className="small"><Badge tone="ok">Filed</Badge> {new Date(done.at).toLocaleString('en-IN')} by {done.by}{done.arn ? ` · ARN ${done.arn}` : ''}</p>;
  return (
    <div className="row gap-s wrap" style={{ alignItems: 'flex-end' }}>
      <Input label="ARN from the portal (optional)" value={arn} onChange={e => setArn(e.target.value.toUpperCase())} id={`arn-${label}`} />
      <Btn onClick={() => onFiled(arn.trim())}>{`I have filed ${label}`}</Btn>
    </div>
  );
}

function Gstr1Step({ d, settings, keyM, per, stops, filed, onFiled }) {
  const isIff = per.kind === 'iff';
  const data = isIff ? { ...d, b2cs: [], hsnB2C: [], nil: { b2b: d.nil.b2b, b2c: 0 } } : d;
  const json = () => {
    const j = gstr1Json(data, settings, keyM);
    download(`GSTR1-${settings.gstin || 'store'}-${keyM}.json`, JSON.stringify(j, null, 1), 'application/json');
  };
  const excel = () => {
    exportRows(`GSTR1-B2B-${keyM}.xlsx`, 'B2B (4A)', data.b2b.map(x => ({ invoice: x.no, date: localISO(new Date(x.ts)), gstin: x.gstin, pos: x.pos, value: x.value, taxable: x.taxable })));
    exportRows(`GSTR1-B2CS-${keyM}.xlsx`, 'B2CS (7)', data.b2cs);
    exportRows(`GSTR1-CDNR-${keyM}.xlsx`, 'CDNR (9B)', data.cdnr.map(x => ({ note: x.no, against: x.against, date: localISO(new Date(x.ts)), gstin: x.gstin, value: x.value, taxable: x.taxable })));
    exportRows(`GSTR1-HSN-${keyM}.xlsx`, 'HSN (12)', [...data.hsnB2B.map(h => ({ part: 'B2B', ...h })), ...data.hsnB2C.map(h => ({ part: 'B2C', ...h }))]);
    exportRows(`GSTR1-DOCS-${keyM}.xlsx`, 'Docs (13)', data.docs);
  };
  const b2cTax = data.b2cs.reduce((a, r) => a + r.txval, 0);
  return (
    <Card title={`3 · ${isIff ? 'IFF (business bills only, optional)' : 'GSTR-1 — your sales'}`}>
      <div className="grid g4">
        <Stat label="Business bills (B2B)" value={data.b2b.length} />
        <Stat label="Shop sales taxable (B2C)" value={inr(b2cTax, 0)} />
        <Stat label="Credit notes to businesses" value={data.cdnr.length} />
        <Stat label="HSN rows" value={data.hsnB2B.length + data.hsnB2C.length} />
      </div>
      {stops > 0 && <div className="note note-bad" style={{ marginTop: 10 }}>{`Fix the ${stops} problem(s) in step 2 first. A wrong GSTR-1 also makes GSTR-3B wrong, because the portal copies it.`}</div>}
      <div className="row gap-s wrap" style={{ marginTop: 10 }}>
        <Btn kind="primary" onClick={json} disabled={stops > 0}>Download GSTR-1 file (JSON)</Btn>
        <Btn onClick={excel}>Download tables (Excel)</Btn>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary>How to upload it on the GST portal</summary>
        <ol className="small">
          <li>Log in at gst.gov.in → Services → Returns → Returns Dashboard → pick {monthLabel(keyM)}.</li>
          <li>{isIff ? 'Invoice Furnishing Facility (IFF)' : 'GSTR-1'} → <b>Prepare Offline</b> → Upload → choose the JSON file.</li>
          <li>Wait for “Processed”. If it shows errors, download the error file and send it to us.</li>
          <li>Open <b>Prepare Online</b> → check each table’s totals match the numbers above.</li>
          <li><b>Generate Summary</b> → preview → file with EVC (OTP) or DSC. Note the ARN and enter it below.</li>
          <li>Mistake found after filing? Correct it in <b>GSTR-1A</b> before you file GSTR-3B.</li>
        </ol>
      </details>
      <FiledBox done={filed[isIff ? 'iff' : 'gstr1']} onFiled={onFiled} label={isIff ? 'IFF' : 'GSTR-1'} />
    </Card>
  );
}

function TwoBStep({ keyM, purchases, suppliers, twoB }) {
  const toast = useToast();
  const [res, setRes] = useState(null);
  const [err, setErr] = useState('');
  const saved = twoB[keyM];
  const load = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    setErr('');
    try {
      const rows = read2bRows(await readAny(f));
      if (!rows.length) throw new Error('empty');
      const already = new Set(Object.entries(twoB).filter(([k]) => k !== keyM).flatMap(([, v]) => v.matchedIds || []));
      const m = match2b(rows, purchases.filter(p => !already.has(p.id)), suppliers, keyM);
      setRes(m);
      await setSetting('gst2b', { ...twoB, [keyM]: { safe: m.safe, matchedIds: m.matchedIds, at: Date.now(), missing: m.rows.filter(r => r.status === 'missing').length, extra: m.rows.filter(r => r.status === 'extra').length } });
      toast('GSTR-2B matched and saved for this month.');
    } catch { setErr('Could not read that file. Download GSTR-2B (Excel or JSON) for this month from the portal and try again.'); }
  };
  const tone = { matched: 'ok', mismatch: 'warn', missing: 'bad', extra: 'info' };
  return (
    <Card title="4 · GSTR-2B — input credit you can safely claim">
      <p className="small muted">GSTR-2B comes on the 14th. Download it (Excel or JSON) for {monthLabel(keyM)} and load it here. Credit is safe only for bills your suppliers filed.</p>
      <div className="row gap-s wrap" style={{ marginTop: 8 }}>
        <label className="btn">Load GSTR-2B file<input type="file" accept=".xlsx,.xls,.csv,.json" hidden onChange={load} /></label>
        {saved && !res && <span className="small">Loaded {new Date(saved.at).toLocaleDateString('en-IN')}: safe credit <b>{inr(saved.safe)}</b> · {saved.missing} not filed by suppliers · {saved.extra} not in your books</span>}
      </div>
      {err && <p className="err" style={{ marginTop: 8 }}>{err}</p>}
      {res && <>
        <div className="grid g4" style={{ marginTop: 10 }}>{['matched', 'mismatch', 'missing', 'extra'].map(k => <Stat key={k} label={{ matched: 'Safe to claim', mismatch: 'Amount differs', missing: 'Not filed by supplier', extra: 'Not in your books' }[k]} value={res.rows.filter(r => r.status === k).length} tone={k === 'missing' ? 'bad' : k === 'mismatch' ? 'warn' : undefined} />)}</div>
        <Table rows={res.rows} cols={[
          { label: 'Bill', render: r => <><b>{r.billNo}</b><div className="small muted">{r.gstin}</div></> },
          { label: 'Supplier', render: r => suppliers.find(s => s.id === r.supplierId)?.name || '—' },
          { label: 'GST', num: true, render: r => inr(r.tax) },
          { label: 'Result', render: r => <><Badge tone={tone[r.status]}>{r.status}</Badge><div className="small muted">{r.note}</div></> },
        ]} />
      </>}
      <details style={{ marginTop: 10 }}>
        <summary>IMS (Invoice Management System) on the portal</summary>
        <p className="small">Before 2B is final you can Accept, Reject or keep Pending each supplier bill in IMS. Reject bills that are not yours or are wrong; keep Pending the ones you have not received yet. Bills marked “Not in your books” above are the ones to look at first.</p>
      </details>
    </Card>
  );
}

function ThreeBStep({ b, per, filed, onFiled }) {
  const isIff = per.kind === 'iff';
  const rows = [
    { id: '3.1(a) Taxable sales (not nil-rated)', txval: b.t31a.txval, igst: b.t31a.igst, cgst: b.t31a.cgst, sgst: b.t31a.sgst },
    { id: '3.1(c) Nil-rated / exempt sales', txval: b.t31c.txval, igst: 0, cgst: 0, sgst: 0 },
    { id: '4(A)(5) Input credit — your purchase bills', txval: '', igst: b.t4a5.igst, cgst: b.t4a5.cgst, sgst: b.t4a5.sgst },
    { id: `4(B)(1) Credit given back — ${b.t4b1.count} write-off(s)`, txval: '', igst: -b.t4b1.igst, cgst: -b.t4b1.cgst, sgst: -b.t4b1.sgst },
  ];
  return (
    <Card title={`5 · ${isIff ? 'PMT-06 — this month’s tax' : 'GSTR-3B — pay tax'}`}>
      <Table rows={rows} cols={[{ label: 'Table', key: 'id' }, { label: 'Taxable', num: true, render: r => r.txval === '' ? '' : inr(r.txval) }, { label: 'IGST', num: true, render: r => inr(r.igst) }, { label: 'CGST', num: true, render: r => inr(r.cgst) }, { label: 'SGST', num: true, render: r => inr(r.sgst) }]} />
      <div className="grid g3" style={{ marginTop: 10 }}>
        <Stat label="Tax on sales" value={inr(b.outTax, 0)} />
        <Stat label={b.itcSafe == null ? 'Input credit (books — 2B not loaded)' : 'Input credit (as per 2B, after write-offs)'} value={inr(b.itcClaim, 0)} tone={b.itcSafe == null ? 'warn' : undefined} />
        <Stat label="To pay in cash (about)" value={inr(b.cash, 0)} tone="warn" sub="Plus any late fee / interest shown on the portal" />
      </div>
      <details style={{ marginTop: 10 }}>
        <summary>How to file it</summary>
        <ol className="small">
          {isIff ? <>
            <li>Returns Dashboard → Payment → <b>Create Challan</b> → reason “Monthly payment for quarterly return” → choose the 35% or self-assessment method.</li>
            <li>For self-assessment, use the amount above. Pay by UPI / net banking by the 25th.</li>
          </> : <>
            <li>Returns Dashboard → GSTR-3B → <b>Prepare Online</b>. The portal fills the sales part (3.1) from your GSTR-1 and it <b>cannot be edited</b> — so it must already be right.</li>
            <li>Compare the input credit the portal shows (from 2B) with the numbers above. Enter the write-off reversal in 4(B)(1).</li>
            <li>Save → <b>Proceed to payment</b> → pay any cash balance (Create Challan if the cash ledger is short).</li>
            <li>File with EVC (OTP) or DSC. Enter the ARN below.</li>
          </>}
        </ol>
      </details>
      <FiledBox done={filed[isIff ? 'pmt06' : 'gstr3b']} onFiled={onFiled} label={isIff ? 'PMT-06' : 'GSTR-3B'} />
    </Card>
  );
}

function RuleBook({ rules, canApprove }) {
  const toast = useToast();
  const [next, setNext] = useState(null);
  const [state, setState] = useState('');
  const check = async (quiet = false) => {
    setState('Checking…');
    try {
      const r = await fetch(RULES_URL, { cache: 'no-store' });
      const j = await r.json();
      if (!j?.version || !Array.isArray(j.slabs)) throw new Error('bad');
      try { localStorage.setItem('dfr_rules_check', localISO(new Date())); } catch { /* ignore */ }
      if (j.version === rules.version) { setNext(null); setState('Rule book is up to date.'); return; }
      setNext(j); setState('');
    } catch { setState(quiet ? '' : 'Could not check now (offline?). The saved rule book is still used.'); }
  };
  // Check once a day, quietly.
  useEffect(() => { let last = ''; try { last = localStorage.getItem('dfr_rules_check') || ''; } catch { /* ignore */ } if (last !== localISO(new Date())) check(true); }, []);
  const changes = next ? rulesDiff(rules, next) : [];
  const approve = async () => { await setSetting('gstRules', next); setNext(null); toast(`Rule book ${next.version} approved.`); };
  return (
    <Card title="Rule book" actions={<Btn size="sm" onClick={() => check(false)}>Check for updates</Btn>}>
      <p className="small">Using version <b>{rules.version}</b> (updated {rules.updated}) · GST rates {rules.slabs.join(', ')}% · HSN at least {rules.hsnMinDigits} digits.</p>
      {(rules.notes || []).length > 0 && <ul className="small">{rules.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {state && <p className="small muted">{state}</p>}
      {next && (
        <div className="note note-warn" style={{ marginTop: 8 }}>
          <b>New rule book {next.version}</b> ({next.updated}). Changes:
          <ul>{changes.map((c, i) => <li key={i}>{c.important && <Badge tone="bad">Important</Badge>} {c.text}</li>)}</ul>
          {canApprove ? <div className="row gap-s"><Btn kind="primary" onClick={approve}>Approve and use</Btn><Btn onClick={() => setNext(null)}>Not now</Btn></div>
            : <p className="small">The owner must approve this.</p>}
          <p className="small muted">Product GST rates are never changed automatically. After approving a rate change, check the products in Products.</p>
        </div>
      )}
    </Card>
  );
}
