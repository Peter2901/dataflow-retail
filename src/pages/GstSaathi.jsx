// GST Saathi — the month's GST work in clear steps: due dates (with late fee and interest), checks,
// GSTR-1, GSTR-2B + IMS, GSTR-3B with credit set-off by law, the yearly summary and a CA pack.
// It prepares and checks; the person (or their CA) files on the GST portal. Plain code only:
// AI never files a return and never sets a GST rate. Rule-book changes need the owner's OK.
import React, { useEffect, useMemo, useState } from 'react';
import { db, setSetting } from '../db.js';
import { useApp, useLive, useSlowLive, useToast, PageHead, Card, Btn, Badge, Table, Stat, Select, Input } from '../ui/kit.jsx';
import { inr, download, localISO, r2, sum } from '../lib/util.js';
import { exportRows, exportBook, readAny } from '../lib/excel.js';
import { audit } from '../lib/sales.js';
import {
  DEFAULT_RULES, RULES_URL, rulesDiff, monthKey, monthRange, monthLabel, periodFor, dueDates, daysTo,
  gstr1Data, gstr1Json, gstr3bData, match2b, read2bRows, preChecks,
  lateFeeFor, interestFor, daysLate, rule37, itcDeadline, turnoverStatus, compositionData, monthSummary,
  snapshotOf, changesSince, yearRows, fyStart,
} from '../lib/gst.js';

const LEVEL = { stop: { tone: 'bad', label: 'Fix first' }, warn: { tone: 'warn', label: 'Check' }, ok: { tone: 'ok', label: 'OK' } };
const lastMonth = () => { const d = new Date(); return monthKey(new Date(d.getFullYear(), d.getMonth() - 1, 1)); };
const fmt = date => new Date(date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const crore = v => `₹${(Number(v || 0) / 1e7).toFixed(2)} cr`;
const ZERO = { igst: 0, cgst: 0, sgst: 0 };

// Bills of a date range, all counters and stores of this GSTIN, read through the date index (fast on big data).
const salesIn = (from, to) => db.sales.where('ts').between(from, to, true, true).toArray();

// Month totals for turnover limits. Closed months are kept for a day so big stores do not re-read every bill.
async function monthTotals(key) {
  const cur = monthKey(new Date());
  const cached = key < cur ? (await db.syncMeta.get('gstsum:' + key))?.v : null;
  if (cached && Date.now() - cached.at < 7 * 864e5) return cached.sum;   // closed months rarely change; kept a week
  const { from, to } = monthRange(key);
  const s = monthSummary(await salesIn(from, to));
  if (key < cur) await db.syncMeta.put({ key: 'gstsum:' + key, v: { at: Date.now(), sum: s } });
  return s;
}
const fyKeys = fy => Array.from({ length: 12 }, (_, i) => monthKey(new Date(fy, 3 + i, 1)));

export default function GstSaathi() {
  const { settings, user, go } = useApp();
  const toast = useToast();
  const rules = useMemo(() => ({ ...DEFAULT_RULES, ...(settings.gstRules || {}) }), [settings.gstRules]);
  const qrmp = !!settings.gstFiling?.qrmp;
  const composition = !!settings.gstFiling?.composition;
  const [key, setKey] = useState(lastMonth());
  const per = composition ? compPeriod(key) : periodFor(key, qrmp);
  const range = useMemo(() => ({ from: monthRange(per.keys[0]).from, to: monthRange(per.keys[per.keys.length - 1]).to }), [key, qrmp, composition]);
  const home = String(settings.stateCode || '').padStart(2, '0');
  const isOwner = user.role === 'owner';

  // Read only the return period (by date), all stores of this GSTIN; refreshed at most every 30 s while open.
  const inP = useSlowLive(() => salesIn(range.from, range.to), [range.from, range.to], null, 30000);
  const purchases = useLive(() => db.purchases.toArray(), [], []);
  const suppliers = useLive(() => db.suppliers.toArray(), [], []);
  const writeoffs = useLive(() => db.journal.where('type').equals('writeoff').toArray(), [], []);
  const products = useLive(() => db.products.toArray(), [], []);

  // Turnover: last full financial year (AATO) and this year so far, from the app's own bills (owner can type it if the app is new).
  const [turn, setTurn] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      const fy = fyStart(new Date());
      const now = monthKey(new Date());
      const last = await Promise.all(fyKeys(fy - 1).map(monthTotals));
      const ytd = await Promise.all(fyKeys(fy).filter(k => k <= now).map(monthTotals));
      if (live) setTurn({ lastFy: r2(sum(last, m => m.taxable)), ytd: r2(sum(ytd, m => m.taxable)), lastMonths: last.filter(m => m.bills).length });
    })().catch(() => live && setTurn({ lastFy: 0, ytd: 0, lastMonths: 0 }));
    return () => { live = false; };
  }, []);
  const tset = settings.gstTurnover || {};
  const aato = Number(tset.lastFy) || turn?.lastFy || 0;
  const maxEver = Math.max(aato, Number(tset.maxEver) || 0);

  const purP = useMemo(() => purchases.filter(p => { const t = new Date(p.date).getTime(); return t >= range.from && t <= range.to; }), [purchases, range]);
  const jP = useMemo(() => writeoffs.filter(j => j.ts >= range.from && j.ts <= range.to), [writeoffs, range]);
  const twoB = settings.gst2b || {};
  const has2b = per.keys.every(k => twoB[k]);
  const itcSafe = has2b ? r2(per.keys.reduce((a, k) => a + (twoB[k].safe || 0), 0)) : null;
  const itcSafeHeads = has2b && per.keys.every(k => twoB[k].safeHeads) ? per.keys.reduce((a, k) => ({ igst: a.igst + twoB[k].safeHeads.igst, cgst: a.cgst + twoB[k].safeHeads.cgst, sgst: a.sgst + twoB[k].safeHeads.sgst }), { ...ZERO }) : null;
  const matchedAll = useMemo(() => new Set(Object.values(twoB).flatMap(v => v.matchedIds || [])), [twoB]);

  // Credit ledger: what was left last month carries forward (saved when 3B is marked filed; the owner can correct it).
  const credit = settings.gstCredit || {};
  const prevKey = monthKey(new Date(monthRange(per.keys[0]).y, monthRange(per.keys[0]).m - 2, 1));
  const openingJson = JSON.stringify(credit[key]?.opening || credit[prevKey]?.closing || ZERO);
  const opening = useMemo(() => JSON.parse(openingJson), [openingJson]);

  const r37 = useMemo(() => rule37({ purchases, suppliers, homeState: home, asOf: range.to, rules }), [purchases, suppliers, home, range, rules]);
  const deadline = useMemo(() => itcDeadline({ purchases, suppliers, matchedIds: matchedAll, rules }), [purchases, suppliers, matchedAll, rules]);
  const filed = settings.gstFiled?.[key] || {};
  const nowSum = useMemo(() => (inP ? monthSummary(inP) : null), [inP]);
  const changes = nowSum && filed.gstr1?.snap ? changesSince(filed.gstr1.snap, nowSum) : null;

  const d = useMemo(() => (inP ? gstr1Data(inP, settings) : null), [inP, settings]);
  const b = useMemo(() => (inP ? gstr3bData({ sales: inP, purchases: purP, suppliers, journal: jP, settings, itcSafe, itcSafeHeads, r37, opening }) : null), [inP, purP, suppliers, jP, settings, itcSafe, itcSafeHeads, r37, opening]);
  const comp = useMemo(() => (inP && composition ? compositionData(inP, rules) : null), [inP, composition, rules]);
  const checks = useMemo(() => (inP ? preChecks({ sales: inP, products, settings, rules, d, threeB: composition ? null : b, aato, r37: composition ? null : r37, deadline: composition ? null : deadline, changes, composition }) : []), [inP, products, settings, rules, d, b, aato, r37, deadline, changes, composition]);
  const due = dueDates(key, { qrmp, composition, stateCode: settings.stateCode, rules });
  const stops = checks.filter(c => c.level === 'stop').length;
  const curMonth = key === monthKey(new Date());

  const markFiled = async (id, arn = '', extra = {}) => {
    const all = { ...(settings.gstFiled || {}) };
    all[key] = { ...filed, [id]: { at: Date.now(), by: user.name, arn, ...extra } };
    await setSetting('gstFiled', all);
    await audit('gst_filed', { period: key, ret: id, arn }, user);
    toast('Marked as filed.');
  };
  // Filing 3B also: carries the unused credit forward, and records the Rule 37 credit given back / taken again.
  const file3b = async (id, arn) => {
    if (id === 'gstr3b' && b) {
      await setSetting('gstCredit', { ...credit, [key]: { ...(credit[key] || {}), opening, closing: b.setOff.closing } });
      for (const x of r37.reverse) await db.purchases.update(x.id, { rule37: { heads: x.heads, amount: x.amount, reversedIn: key } });
      for (const x of r37.reclaim) { const p = await db.purchases.get(x.id); await db.purchases.update(x.id, { rule37: { ...p.rule37, reclaimedIn: key } }); }
    }
    await markFiled(id, arn, b ? { itcClaim: b.itcClaim, cashTotal: b.cash, closing: b.setOff.closing } : {});
  };
  const months = Array.from({ length: 15 }, (_, i) => { const n = new Date(); return monthKey(new Date(n.getFullYear(), n.getMonth() - i, 1)); });
  const ready = composition ? null : [stops === 0, !!filed[per.kind === 'iff' ? 'iff' : 'gstr1'], has2b, !!filed[per.kind === 'iff' ? 'pmt06' : 'gstr3b']];

  if (!inP || !d) return <p>Loading…</p>;
  return (
    <div className="stack">
      <PageHead title="GST Saathi" sub="Your GST in clear steps. GST Saathi prepares and checks — you or your CA file on the GST portal."
        actions={<>
          <Select aria-label="Return month" value={key} onChange={e => setKey(e.target.value)} options={months.map(k => ({ value: k, label: monthLabel(k) + (k === monthKey(new Date()) ? ' (so far)' : '') }))} />
          <Select aria-label="How you file" value={composition ? 'c' : qrmp ? 'q' : 'm'} disabled={!isOwner}
            onChange={e => setSetting('gstFiling', { ...(settings.gstFiling || {}), qrmp: e.target.value === 'q', composition: e.target.value === 'c' })}
            options={[{ value: 'm', label: 'Monthly filer' }, { value: 'q', label: 'Quarterly (QRMP)' }, { value: 'c', label: 'Composition' }]} />
        </>} />

      {curMonth && <div className="note">This month is not over yet — the numbers are “so far”. File after the month ends.</div>}
      {per.kind === 'quarter' && <div className="note">{`Quarter return: covers ${per.keys.map(monthLabel).join(', ')}.`}</div>}
      {per.kind === 'iff' && <div className="note">Quarterly filer, middle month: GSTR-1 is optional here (IFF, business bills only). Pay this month’s tax with PMT-06.</div>}

      <Health ready={ready} turn={turn} aato={aato} composition={composition} tset={tset} rules={rules} maxEver={maxEver} isOwner={isOwner} />

      <Card title="1 · Due dates">
        {due.length ? <div className="grid g3">
          {due.map(x => {
            const n = daysTo(x.date), done = filed[x.id];
            const late = !done && n < 0 ? daysLate(x.date) : 0;
            const nil = composition ? !comp?.turnover : !(b?.outTax > 0);
            const fee = late && ['gstr1', 'gstr3b', 'gstr4', 'iff'].includes(x.id) ? lateFeeFor({ days: late, nil, aato, rules }) : null;
            const intr = late && ['gstr3b', 'pmt06', 'cmp08'].includes(x.id) ? interestFor({ cash: composition ? comp?.tax : b?.cash, days: late, rules }) : 0;
            return <Stat key={x.id} label={x.label} value={fmt(x.date)} tone={done ? 'ok' : n < 0 ? 'bad' : n <= 3 ? 'warn' : undefined}
              sub={done ? `Filed ${new Date(done.at).toLocaleDateString('en-IN')}${done.arn ? ' · ARN ' + done.arn : ''}`
                : n < 0 ? `${late} day(s) late${fee ? ` · late fee about ${inr(fee.fee, 0)}` : ''}${intr ? ` · interest about ${inr(intr, 0)}` : ''}`
                : n === 0 ? 'Due today' : `${n} day(s) left`} />;
          })}
        </div> : <p className="small muted">{composition ? 'Nothing due for this month. Composition dealers pay once a quarter (CMP-08) and file GSTR-4 once a year.' : 'Nothing due.'}</p>}
        <p className="small muted" style={{ marginTop: 8 }}>{`Dates, late fee (₹${rules.lateFee.perDay}/day, nil ₹${rules.lateFee.perDayNil}/day, with a cap by turnover) and ${rules.interestPct}% interest on late cash tax come from rule book ${rules.version}. The portal’s own figure is final.`}</p>
      </Card>

      <Card title={`2 · Checks before filing ${stops ? `— ${stops} to fix` : ''}`}>
        <ul className="checks">
          {checks.map((c, i) => (
            <li key={i}><Badge tone={LEVEL[c.level].tone}>{LEVEL[c.level].label}</Badge><span className="grow">{c.text}</span>
              {c.fix && <Btn size="sm" onClick={() => go(c.fix.page, c.fix.param || null)}>Open</Btn>}</li>
          ))}
        </ul>
      </Card>

      {composition
        ? <CompositionStep comp={comp} keyM={key} per={per} filed={filed} onFiled={(id, arn) => markFiled(id, arn)} />
        : <>
          <Gstr1Step d={d} settings={settings} keyM={key} per={per} stops={stops} filed={filed} onFiled={arn => markFiled(per.kind === 'iff' ? 'iff' : 'gstr1', arn, { snap: snapshotOf(nowSum) })} changes={changes} />
          <TwoBStep keyM={key} purchases={purchases} suppliers={suppliers} twoB={twoB} home={home} />
          <ThreeBStep b={b} per={per} filed={filed} r37={r37} opening={opening} isOwner={isOwner} keyM={key} credit={credit}
            onFiled={arn => file3b(per.kind === 'iff' ? 'pmt06' : 'gstr3b', arn)} />
        </>}

      <YearCard composition={composition} settings={settings} />
      <CaPack keyM={key} d={d} b={b} comp={comp} inP={inP} purP={purP} suppliers={suppliers} r37={r37} settings={settings} composition={composition} />
      <RuleBook rules={rules} canApprove={isOwner} />
    </div>
  );
}

// Composition dealers work by quarter.
function compPeriod(key) {
  const { y, m } = monthRange(key);
  const q = Math.ceil(m / 3) * 3;
  return { keys: [q - 2, q - 1, q].map(x => `${y}-${String(x).padStart(2, '0')}`), kind: 'cquarter' };
}

function Health({ ready, turn, aato, composition, tset, rules, maxEver, isOwner }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ lastFy: tset.lastFy || '', maxEver: tset.maxEver || '' });
  const list = turnoverStatus({ aato, ytd: turn?.ytd || 0, maxEver, composition, rules });
  const done = ready ? ready.filter(Boolean).length : null;
  return (
    <Card title="Your GST health" actions={isOwner && <Btn size="sm" onClick={() => setEdit(x => !x)}>{edit ? 'Close' : 'Set turnover'}</Btn>}>
      <div className="grid g4">
        {ready && <Stat label="This return" value={`${done} of 4 steps`} tone={done === 4 ? 'ok' : done >= 2 ? 'warn' : 'bad'} sub="Checks clean · GSTR-1 · 2B loaded · 3B filed" />}
        <Stat label="Turnover last year (AATO)" value={turn ? crore(aato) : '…'} sub={tset.lastFy ? 'Entered by owner' : turn?.lastMonths ? `From ${turn.lastMonths} month(s) of bills in the app` : 'No bills last year — set it by hand'} />
        <Stat label="This year so far" value={turn ? crore(turn.ytd) : '…'} />
      </div>
      <ul className="checks" style={{ marginTop: 10 }}>
        {list.map(x => <li key={x.id}><Badge tone={x.tone}>{x.tone === 'ok' ? 'OK' : x.tone === 'bad' ? 'Must do' : 'Note'}</Badge><span className="grow">{x.text}</span></li>)}
      </ul>
      {edit && (
        <div className="row gap-s wrap" style={{ marginTop: 10, alignItems: 'flex-end' }}>
          <Input label="Turnover last FY (₹, if the app was not used all year)" type="number" value={f.lastFy} onChange={e => setF({ ...f, lastFy: e.target.value })} id="gst-aato" />
          <Input label="Highest yearly turnover since 2017-18 (₹, for e-invoice)" type="number" value={f.maxEver} onChange={e => setF({ ...f, maxEver: e.target.value })} id="gst-max" />
          <Btn kind="primary" onClick={async () => { await setSetting('gstTurnover', { lastFy: Number(f.lastFy) || 0, maxEver: Number(f.maxEver) || 0 }); setEdit(false); }}>Save</Btn>
        </div>
      )}
    </Card>
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

function Gstr1Step({ d, settings, keyM, per, stops, filed, onFiled, changes }) {
  const isIff = per.kind === 'iff';
  const data = isIff ? { ...d, b2cs: [], hsnB2C: [], nil: { b2b: d.nil.b2b, b2c: 0 } } : d;
  const json = () => {
    const j = gstr1Json(data, settings, keyM);
    download(`GSTR1-${settings.gstin || 'store'}-${keyM}.json`, JSON.stringify(j, null, 1), 'application/json');
  };
  const excel = () => exportBook(`GSTR1-tables-${keyM}.xlsx`, gstr1Sheets(data));
  const b2cTax = data.b2cs.reduce((a, r) => a + r.txval, 0);
  return (
    <Card title={`3 · ${isIff ? 'IFF (business bills only, optional)' : 'GSTR-1 — your sales'}`}>
      <div className="grid g4">
        <Stat label="Business bills (B2B)" value={data.b2b.length} />
        <Stat label="Shop sales taxable (B2C)" value={inr(b2cTax, 0)} />
        <Stat label="Credit notes to businesses" value={data.cdnr.length} />
        <Stat label="HSN rows (B2B + B2C)" value={`${data.hsnB2B.length} + ${data.hsnB2C.length}`} />
      </div>
      {stops > 0 && <div className="note note-bad" style={{ marginTop: 10 }}>{`Fix the ${stops} problem(s) in step 2 first. A wrong GSTR-1 also makes GSTR-3B wrong, because the portal copies it and 3B tax cannot be edited.`}</div>}
      {changes && <div className="note note-bad" style={{ marginTop: 10 }}>{`After filing: ${changes.bills} bill(s) added or changed (₹${changes.taxable} taxable, ₹${changes.tax} GST). File GSTR-1A with these before GSTR-3B.`}</div>}
      <div className="row gap-s wrap" style={{ marginTop: 10 }}>
        <Btn kind="primary" onClick={json} disabled={stops > 0}>Download GSTR-1 file (JSON)</Btn>
        <Btn onClick={excel}>Download all tables (one Excel)</Btn>
      </div>
      <details style={{ marginTop: 10 }}>
        <summary>How to upload it on the GST portal</summary>
        <ol className="small">
          <li>Log in at gst.gov.in → Services → Returns → Returns Dashboard → pick {monthLabel(keyM)}.</li>
          <li>{isIff ? 'Invoice Furnishing Facility (IFF)' : 'GSTR-1'} → <b>Prepare Offline</b> → Upload → choose the JSON file.</li>
          <li>Wait for “Processed”. If it shows errors, download the error file and send it to us.</li>
          <li>Open <b>Prepare Online</b> → check each table’s totals match the numbers above. In Table 12 (HSN), the portal checks the B2B part against your bills.</li>
          <li><b>Generate Summary</b> → preview → file with EVC (OTP) or DSC. Note the ARN and enter it below.</li>
          <li>Mistake found after filing? Correct it in <b>GSTR-1A</b> before you file GSTR-3B.</li>
        </ol>
      </details>
      <FiledBox done={filed[isIff ? 'iff' : 'gstr1']} onFiled={onFiled} label={isIff ? 'IFF' : 'GSTR-1'} />
    </Card>
  );
}

function gstr1Sheets(d) {
  return [
    { name: 'B2B (4A)', rows: d.b2b.map(x => ({ invoice: x.no, date: localISO(new Date(x.ts)), gstin: x.gstin, pos: x.pos, value: x.value, taxable: x.taxable })) },
    { name: 'B2CS (7)', rows: d.b2cs },
    { name: 'CDNR (9B)', rows: d.cdnr.map(x => ({ note: x.no, against: x.against, date: localISO(new Date(x.ts)), gstin: x.gstin, value: x.value, taxable: x.taxable })) },
    { name: 'Nil (8)', rows: [{ part: 'B2B', nil: d.nil.b2b }, { part: 'B2C', nil: d.nil.b2c }] },
    { name: 'HSN B2B (12)', rows: d.hsnB2B },
    { name: 'HSN B2C (12)', rows: d.hsnB2C },
    { name: 'Docs (13)', rows: d.docs },
  ];
}

function TwoBStep({ keyM, purchases, suppliers, twoB, home }) {
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
      const m = match2b(rows, purchases.filter(p => !already.has(p.id)), suppliers, keyM, home);
      setRes(m);
      await setSetting('gst2b', { ...twoB, [keyM]: { safe: m.safe, safeHeads: m.safeHeads, matchedIds: m.matchedIds, at: Date.now(), missing: m.rows.filter(r => r.status === 'missing').length, extra: m.rows.filter(r => r.status === 'extra').length } });
      toast('GSTR-2B matched and saved for this month.');
    } catch { setErr('Could not read that file. Download GSTR-2B (Excel or JSON) for this month from the portal and try again.'); }
  };
  const sname = id => suppliers.find(s => s.id === id)?.name || '';
  const imsExport = () => exportRows(`IMS-actions-${keyM}.xlsx`, 'IMS', res.rows.filter(r => r.status !== 'missing').map(r => ({ supplier_gstin: r.gstin, supplier: sname(r.supplierId), bill: r.billNo, gst_in_books: r.status === 'extra' ? '' : r.tax, gst_in_2b: r.twoBTax ?? r.tax, action: r.ims.act, why: r.ims.why })));
  const callList = () => exportRows(`Suppliers-to-call-${keyM}.xlsx`, 'Not filed', res.rows.filter(r => r.status === 'missing').map(r => ({ supplier: sname(r.supplierId), gstin: r.gstin, bill: r.billNo, date: r.date, gst: r.tax, note: r.note })));
  const tone = { matched: 'ok', mismatch: 'warn', missing: 'bad', extra: 'info' };
  const actTone = { Accept: 'ok', Pending: 'warn', Check: 'info', '—': undefined };
  return (
    <Card title="4 · GSTR-2B and IMS — input credit you can safely claim">
      <p className="small muted">GSTR-2B comes on the 14th. Download it (Excel or JSON) for {monthLabel(keyM)} and load it here. Credit is safe only for bills your suppliers filed. Before the 14th, use IMS on the portal to Accept, Reject or keep bills Pending — the action list below tells you which.</p>
      <div className="row gap-s wrap" style={{ marginTop: 8 }}>
        <label className="btn">Load GSTR-2B file<input type="file" accept=".xlsx,.xls,.csv,.json" hidden onChange={load} /></label>
        {res && <><Btn onClick={imsExport}>IMS action list (Excel)</Btn><Btn onClick={callList}>Suppliers to call (Excel)</Btn></>}
        {saved && !res && <span className="small">Loaded {new Date(saved.at).toLocaleDateString('en-IN')}: safe credit <b>{inr(saved.safe)}</b> · {saved.missing} not filed by suppliers · {saved.extra} not in your books</span>}
      </div>
      {err && <p className="err" style={{ marginTop: 8 }}>{err}</p>}
      {res && <>
        <div className="grid g4" style={{ marginTop: 10 }}>{['matched', 'mismatch', 'missing', 'extra'].map(k => <Stat key={k} label={{ matched: 'Safe to claim (Accept)', mismatch: 'Amount differs (Pending)', missing: 'Not filed by supplier', extra: 'Not in your books (Check)' }[k]} value={res.rows.filter(r => r.status === k).length} tone={k === 'missing' ? 'bad' : k === 'mismatch' ? 'warn' : undefined} />)}</div>
        <Table rows={res.rows.slice(0, 300)} cols={[
          { label: 'Bill', render: r => <><b>{r.billNo}</b><div className="small muted">{r.gstin}</div></> },
          { label: 'Supplier', render: r => sname(r.supplierId) || '—' },
          { label: 'GST', num: true, render: r => inr(r.tax) },
          { label: 'IMS', render: r => <Badge tone={actTone[r.ims.act]}>{r.ims.act}</Badge> },
          { label: 'Result', render: r => <><Badge tone={tone[r.status]}>{r.status}</Badge><div className="small muted">{r.note}</div></> },
        ]} />
        {res.rows.length > 300 && <p className="small muted">{`Showing 300 of ${res.rows.length}. The Excel lists have all of them.`}</p>}
      </>}
      <details style={{ marginTop: 10 }}>
        <summary>IMS (Invoice Management System) in short</summary>
        <ul className="small">
          <li><b>Accept</b> — the bill is yours and correct. Bills you leave alone are taken as accepted when 2B is made.</li>
          <li><b>Pending</b> — amount differs or goods not received yet. Allowed for one return period; the credit waits.</li>
          <li><b>Reject</b> — not your bill. The supplier sees it and must correct it.</li>
          <li>You can change an action until you file GSTR-3B; then press “recompute 2B” on the portal.</li>
        </ul>
      </details>
    </Card>
  );
}

function ThreeBStep({ b, per, filed, onFiled, r37, opening, isOwner, keyM, credit }) {
  const isIff = per.kind === 'iff';
  const [edit, setEdit] = useState(false);
  const [ob, setOb] = useState(opening);
  const rows = [
    { id: '3.1(a) Taxable sales (not nil-rated)', txval: b.t31a.txval, igst: b.t31a.igst, cgst: b.t31a.cgst, sgst: b.t31a.sgst },
    { id: '3.1(c) Nil-rated / exempt sales', txval: b.t31c.txval, igst: 0, cgst: 0, sgst: 0 },
    { id: `4(A)(5) Input credit ${b.itcSafe == null ? '(your bills — 2B not loaded)' : '(as per 2B)'}${b.t4d1.total ? ' + credit taken again' : ''}`, txval: '', igst: b.t4a5.igst + b.t4a5.reclaim.igst, cgst: b.t4a5.cgst + b.t4a5.reclaim.cgst, sgst: b.t4a5.sgst + b.t4a5.reclaim.sgst },
    { id: `4(B)(1) Given back — ${b.t4b1.count} write-off(s)`, txval: '', igst: -b.t4b1.igst, cgst: -b.t4b1.cgst, sgst: -b.t4b1.sgst },
    { id: `4(B)(2) Given back — ${b.t4b2.count} bill(s) unpaid after 180 days`, txval: '', igst: -b.t4b2.igst, cgst: -b.t4b2.cgst, sgst: -b.t4b2.sgst },
    { id: '4(C) Net input credit', txval: '', igst: b.net.igst, cgst: b.net.cgst, sgst: b.net.sgst },
    { id: `4(D)(1) Of 4(A)(5): taken again after paying (${b.t4d1.count})`, txval: '', igst: b.t4d1.igst, cgst: b.t4d1.cgst, sgst: b.t4d1.sgst },
  ].filter(r => !(r.id.startsWith('4(B)(2)') || r.id.startsWith('4(D)(1)')) || r.igst || r.cgst || r.sgst);
  const so = b.setOff;
  const useRows = [
    { id: 'IGST credit paid', igst: so.use.igst.igst, cgst: so.use.igst.cgst, sgst: so.use.igst.sgst },
    { id: 'CGST credit paid', igst: so.use.cgst.igst, cgst: so.use.cgst.cgst, sgst: 0 },
    { id: 'SGST credit paid', igst: so.use.sgst.igst, cgst: 0, sgst: so.use.sgst.sgst },
    { id: 'Cash to pay', igst: so.cash.igst, cgst: so.cash.cgst, sgst: so.cash.sgst, strong: true },
  ];
  const negative = ['igst', 'cgst', 'sgst'].filter(k => b.net[k] < 0);
  const saveOpening = async () => { await setSetting('gstCredit', { ...credit, [keyM]: { ...(credit[keyM] || {}), opening: { igst: Number(ob.igst) || 0, cgst: Number(ob.cgst) || 0, sgst: Number(ob.sgst) || 0 } } }); setEdit(false); };
  const col = (k, label) => ({ label, num: true, render: r => r[k] === '' ? '' : inr(r[k]) });
  return (
    <Card title={`5 · ${isIff ? 'PMT-06 — this month’s tax' : 'GSTR-3B — pay tax'}`}>
      <Table rows={rows} cols={[{ label: 'Table', key: 'id' }, { label: 'Taxable', num: true, render: r => r.txval === '' ? '' : inr(r.txval) }, col('igst', 'IGST'), col('cgst', 'CGST'), col('sgst', 'SGST')]} />
      {negative.length > 0 && <div className="note note-warn" style={{ marginTop: 8 }}>{`More credit given back than taken in ${negative.map(k => k.toUpperCase()).join(', ')}. The portal does not take negative net credit — that part is shown as cash to pay; ask your CA whether to pay it through DRC-03.`}</div>}
      <h3 className="hub-head" style={{ marginTop: 12 }}>How the tax is paid (order set by law)</h3>
      <p className="small muted">Credit brought forward: IGST {inr(opening.igst)} · CGST {inr(opening.cgst)} · SGST {inr(opening.sgst)}{isOwner && <> · <button className="link" onClick={() => setEdit(x => !x)}>{edit ? 'close' : 'correct it from the portal'}</button></>}</p>
      {edit && <div className="row gap-s wrap" style={{ alignItems: 'flex-end', marginBottom: 8 }}>
        {['igst', 'cgst', 'sgst'].map(k => <Input key={k} label={`${k.toUpperCase()} balance in credit ledger`} type="number" value={ob[k]} onChange={e => setOb({ ...ob, [k]: e.target.value })} id={`ob-${k}`} />)}
        <Btn kind="primary" onClick={saveOpening}>Save</Btn>
      </div>}
      <Table rows={useRows} cols={[{ label: '', render: r => r.strong ? <b>{r.id}</b> : r.id }, col('igst', 'IGST tax'), col('cgst', 'CGST tax'), col('sgst', 'SGST tax')]} />
      <div className="grid g4" style={{ marginTop: 10 }}>
        <Stat label="Tax on sales" value={inr(b.outTax, 0)} />
        <Stat label="Net input credit" value={inr(b.itcClaim, 0)} tone={b.itcSafe == null ? 'warn' : undefined} sub={b.itcSafe == null ? 'From your bills — load 2B' : 'As per 2B, after give-backs'} />
        <Stat label="Cash to pay" value={inr(b.cash, 0)} tone="warn" sub="Plus late fee / interest if late" />
        <Stat label="Credit carried to next month" value={inr(so.closingTotal, 0)} sub={`IGST ${inr(so.closing.igst, 0)} · CGST ${inr(so.closing.cgst, 0)} · SGST ${inr(so.closing.sgst, 0)}`} />
      </div>
      {r37.reverse.length > 0 && <details style={{ marginTop: 10 }}><summary>{`${r37.reverse.length} supplier bill(s) unpaid after 180 days (Rule 37)`}</summary>
        <Table rows={r37.reverse} cols={[{ label: 'Bill', render: x => <><b>{x.no}</b><div className="small muted">{x.supplier}</div></> }, { label: 'Date', key: 'date' }, { label: 'Unpaid', num: true, render: x => inr(x.unpaid) }, { label: 'Credit to give back', num: true, render: x => inr(x.amount) }]} />
        <p className="small muted">Interest at 18% a year applies on credit used for these bills. Pay the supplier, then the credit is taken back automatically in the month you pay.</p>
      </details>}
      <details style={{ marginTop: 10 }}>
        <summary>How to file it</summary>
        <ol className="small">
          {isIff ? <>
            <li>Returns Dashboard → Payment → <b>Create Challan</b> → reason “Monthly payment for quarterly return” → choose the 35% or self-assessment method.</li>
            <li>For self-assessment, use the cash amount above. Pay by UPI / net banking by the 25th.</li>
          </> : <>
            <li>Returns Dashboard → GSTR-3B → <b>Prepare Online</b>. The tax part (3.1, 3.2) is copied from GSTR-1/1A and <b>cannot be edited</b> — so GSTR-1 must already be right.</li>
            <li>Table 4 is filled from 2B. Enter the give-backs above in 4(B)(1) and 4(B)(2), and credit taken again in 4(D)(1).</li>
            <li>Save → <b>Proceed to payment</b>. The portal sets off credit in the same order shown above. Pay the cash part (Create Challan if the cash ledger is short).</li>
            <li>File with EVC (OTP) or DSC. Enter the ARN below — the unused credit is then carried to next month here.</li>
          </>}
        </ol>
      </details>
      <FiledBox done={filed[isIff ? 'pmt06' : 'gstr3b']} onFiled={onFiled} label={isIff ? 'PMT-06' : 'GSTR-3B'} />
    </Card>
  );
}

function CompositionStep({ comp, keyM, per, filed, onFiled }) {
  const qEnd = per.keys[2] === keyM;
  return (
    <Card title="3 · CMP-08 — composition tax for the quarter">
      <p className="small muted">{`Quarter: ${per.keys.map(monthLabel).join(', ')}. Composition dealers pay ${'1%'} of taxable sales (0.5% CGST + 0.5% SGST) from cash. No input credit, no GST on bills — bills say “Bill of supply”.`}</p>
      <div className="grid g4" style={{ marginTop: 8 }}>
        <Stat label="Sales in the quarter" value={inr(comp.turnover, 0)} />
        <Stat label="Exempt / nil (no tax)" value={inr(comp.exempt, 0)} />
        <Stat label="Taxable sales" value={inr(comp.taxableTurnover, 0)} />
        <Stat label="Tax to pay" value={inr(comp.tax, 0)} tone="warn" sub={`CGST ${inr(comp.cgst)} · SGST ${inr(comp.sgst)}`} />
      </div>
      {!qEnd && <p className="small muted" style={{ marginTop: 8 }}>Pick the last month of the quarter (June, September, December or March) to mark CMP-08 filed.</p>}
      {qEnd && <FiledBox done={filed.cmp08} onFiled={arn => onFiled('cmp08', arn)} label="CMP-08" />}
    </Card>
  );
}

// The year in one table (for GSTR-9, or GSTR-4 for composition). Read on demand — a big store has many bills.
function YearCard({ composition, settings }) {
  const [fy, setFy] = useState(fyStart(new Date()) - 1);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const keys = fyKeys(fy).filter(k => k <= monthKey(new Date()));
      const months = [];
      for (const k of keys) months.push({ key: k, sum: await monthTotals(k), threeB: settings.gstFiled?.[k]?.gstr3b || null });
      setRes(yearRows(months));
    } finally { setBusy(false); }
  };
  const xl = () => exportRows(`${composition ? 'GSTR-4' : 'GSTR-9'}-summary-FY${fy}-${String(fy + 1).slice(2)}.xlsx`, 'Year', [...res.rows, res.total]);
  const fys = [0, 1, 2].map(i => fyStart(new Date()) - i);
  return (
    <Card title={`Year summary for ${composition ? 'GSTR-4' : 'GSTR-9'}`} actions={<>
      <Select aria-label="Financial year" value={fy} onChange={e => { setFy(Number(e.target.value)); setRes(null); }} options={fys.map(y => ({ value: y, label: `FY ${y}-${String(y + 1).slice(2)}` }))} />
      <Btn size="sm" onClick={run} disabled={busy}>{busy ? 'Adding up…' : 'Prepare'}</Btn>
      {res && <Btn size="sm" onClick={xl}>Excel</Btn>}
    </>}>
      {!res ? <p className="small muted">Month by month: sales, tax, credit and cash paid (from the 3B you marked filed). Your CA uses this for the annual return.</p> : (
        <Table rows={[...res.rows, res.total]} keyField="month" cols={[
          { label: 'Month', render: r => r.month === 'Total' ? <b>Total</b> : monthLabel(r.month) },
          { label: 'Bills', num: true, key: 'bills' },
          { label: 'Taxable', num: true, render: r => inr(r.taxable, 0) },
          { label: 'Nil', num: true, render: r => inr(r.nil, 0) },
          { label: 'CGST', num: true, render: r => inr(r.cgst, 0) },
          { label: 'SGST', num: true, render: r => inr(r.sgst, 0) },
          { label: 'IGST', num: true, render: r => inr(r.igst, 0) },
          { label: 'Credit (3B)', num: true, render: r => r.itc == null ? '—' : inr(r.itc, 0) },
          { label: 'Cash paid (3B)', num: true, render: r => r.cashPaid == null ? (r.month === 'Total' ? '' : <Badge tone="warn">3B not marked</Badge>) : inr(r.cashPaid, 0) },
        ]} />
      )}
    </Card>
  );
}

// Everything for the CA in one Excel file.
function CaPack({ keyM, d, b, comp, inP, purP, suppliers, r37, settings, composition }) {
  const sm = Object.fromEntries(suppliers.map(s => [s.id, s]));
  const make = () => {
    const sheets = [
      { name: 'Summary', rows: [
        { item: 'GSTIN', value: settings.gstin || '' }, { item: 'Period', value: monthLabel(keyM) }, { item: 'Bills', value: inP.filter(s => s.type === 'sale').length },
        { item: 'Returns (credit notes)', value: inP.filter(s => s.type === 'return').length },
        ...(composition ? [{ item: 'Composition tax', value: comp.tax }] : [
          { item: 'Tax on sales', value: b.outTax }, { item: 'Net input credit', value: b.itcClaim }, { item: 'Cash to pay', value: b.cash },
          { item: 'Credit carried forward', value: b.setOff.closingTotal }, { item: 'Input credit as per', value: b.itcSafe == null ? 'books (2B not loaded)' : 'GSTR-2B' }]),
      ] },
      { name: 'Sales register', rows: inP.map(s => ({ bill: s.no, date: localISO(new Date(s.ts)), type: s.type, buyer_gstin: s.b2b?.gstin || '', taxable: s.totals.taxable, cgst: s.totals.cgst, sgst: s.totals.sgst, igst: s.totals.igst, total: s.totals.payable })) },
      { name: 'Purchase register', rows: purP.map(p => ({ entry: p.no, supplier: sm[p.supplierId]?.name || '', gstin: sm[p.supplierId]?.gstin || '', bill: p.billNo, date: p.date, taxable: p.taxable, gst: p.tax, total: p.total, paid: p.paid || 0 })) },
      ...(composition ? [] : [...gstr1Sheets(d),
        { name: 'GSTR-3B', rows: [
          { table: '3.1(a)', ...b.t31a }, { table: '3.1(c)', txval: b.t31c.txval },
          { table: '4(A)(5)', igst: b.t4a5.igst + b.t4a5.reclaim.igst, cgst: b.t4a5.cgst + b.t4a5.reclaim.cgst, sgst: b.t4a5.sgst + b.t4a5.reclaim.sgst },
          { table: '4(B)(1)', igst: b.t4b1.igst, cgst: b.t4b1.cgst, sgst: b.t4b1.sgst }, { table: '4(B)(2)', igst: b.t4b2.igst, cgst: b.t4b2.cgst, sgst: b.t4b2.sgst },
          { table: '4(C) net', ...b.net }, { table: '4(D)(1)', igst: b.t4d1.igst, cgst: b.t4d1.cgst, sgst: b.t4d1.sgst },
          { table: 'Cash', ...b.setOff.cash }, { table: 'Carried forward', ...b.setOff.closing }] },
        { name: 'Rule 37 (180 days)', rows: r37.reverse.map(x => ({ bill: x.no, supplier: x.supplier, date: x.date, unpaid: x.unpaid, give_back: x.amount, ...x.heads })) }]),
    ];
    exportBook(`GST-pack-${settings.gstin || 'store'}-${keyM}.xlsx`, sheets);
  };
  return (
    <Card title="CA pack">
      <div className="row gap-s wrap"><span className="grow small muted">Sales and purchase registers, every GSTR-1 table, GSTR-3B with set-off and the 180-day list — one Excel file to send your CA.</span><Btn onClick={make}>Download CA pack</Btn></div>
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
      <p className="small">Using version <b>{rules.version}</b> (updated {rules.updated}) · GST rates {rules.slabs.join(', ')}% · HSN at least {rules.hsnMinDigits} digits · late fee ₹{rules.lateFee.perDay}/day · interest {rules.interestPct}%.</p>
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
