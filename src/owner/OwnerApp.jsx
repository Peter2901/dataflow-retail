import React, { useEffect, useMemo, useRef, useState } from 'react';
import { loadCfg, saveCfg, clearCfg, loadLast, saveLast, parseCode, fetchToday, fetchAlerts, fetchBill, testCfg } from './api.js';

const TODAY_EVERY = 15000;     // today's numbers: every 15 s while the app is open
const ALERTS_EVERY = 120000;   // stock alerts: every 2 min (heavier)
const ONLINE_WINDOW = 95000;   // a counter that checked in within this time is "online"

const inr = (v, dec = 0) => (v < 0 ? '−' : '') + '₹' + Math.abs(Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
const qty = v => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const clock = ts => new Date(ts).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
const ago = ms => {
  if (ms == null) return '';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} sec ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h} hr ago` : `${Math.floor(h / 24)} days ago`;
};
const MODE = { upi: 'UPI', cash: 'Cash', card: 'Card', credit: 'Udhaar', points: 'Points', other: 'Other' };
const modeLabel = m => String(m || '').split(' + ').map(x => MODE[x] || x).join(' + ');

// ── icons ──
const I = {
  today: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  counters: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M7 14h4" /></>,
  stock: <><path d="M3 7l9-4 9 4-9 4-9-4Z" /><path d="M3 7v10l9 4 9-4V7M12 11v10" /></>,
  bills: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2z" /><path d="M9 8h6M9 12h6" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v6h-6" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
};
const Icon = ({ n, size = 21 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{I[n]}</svg>
);

// ── setup (first open) ──
function Setup({ onDone }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async (text) => {
    setErr(''); setBusy(true);
    try {
      const c = parseCode(text);
      await testCfg(c);
      saveCfg(c); onDone(c);
    } catch (e) { setErr(e.message || 'Could not connect.'); }
    setBusy(false);
  };
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); setCode(t); if (t.includes('DFR1.')) go(t); }
    catch { setErr('Long-press the box and choose Paste.'); }
  };
  return (
    <div className="setup">
      <div className="setup-card">
        <div className="brandrow"><div className="mark">DF</div><div><div className="b1">DataFlow Owner</div><div className="b2">Live view of your store</div></div></div>
        <h1>Connect to your store</h1>
        <ol className="steps">
          <li>On the counter computer open <b>Settings › Cloud sync</b>.</li>
          <li>Under <b>Owner phone app</b>, tap <b>Share on WhatsApp</b> (or Copy).</li>
          <li>Copy the setup code from WhatsApp and paste it here.</li>
        </ol>
        <textarea className="code" rows={3} placeholder="DFR1.…" value={code} onChange={e => setCode(e.target.value)} aria-label="Setup code" />
        {err && <p className="err" role="alert">{err}</p>}
        <div className="btnrow">
          <button className="btn ghost" onClick={paste} disabled={busy}>Paste</button>
          <button className="btn primary" onClick={() => go(code)} disabled={busy || !code.trim()}>{busy ? 'Connecting…' : 'Connect'}</button>
        </div>
        <p className="fine">This app only reads. It cannot change bills, prices or stock.</p>
      </div>
    </div>
  );
}

// ── small pieces ──
const Card = ({ title, right, children, className = '' }) => (
  <section className={`card ${className}`}>
    {(title || right) && <div className="card-h"><h2>{title}</h2>{right}</div>}
    {children}
  </section>
);
const Empty = ({ children }) => <div className="empty">{children}</div>;

function PaySplit({ pay }) {
  const order = ['upi', 'cash', 'card', 'credit', 'points'];
  const entries = Object.entries(pay || {}).filter(([, v]) => v > 0)
    .sort((a, b) => (order.indexOf(a[0]) + 1 || 9) - (order.indexOf(b[0]) + 1 || 9));
  const total = entries.reduce((a, [, v]) => a + v, 0);
  if (!total) return <Empty>No payments yet today.</Empty>;
  return (
    <>
      <div className="split" role="img" aria-label="Payment split">
        {entries.map(([m, v]) => <div key={m} className={`pm-${m}`} style={{ width: `${(v / total) * 100}%` }} />)}
      </div>
      <div className="legend">
        {entries.map(([m, v]) => <span key={m}><i className={`pm-${m}`} />{MODE[m] || m} <b className="mono">{inr(v)}</b> <em>{Math.round((v / total) * 100)}%</em></span>)}
      </div>
    </>
  );
}

function Hours({ hours }) {
  const now = new Date().getHours();
  const keys = Object.keys(hours || {}).map(Number);
  const lo = Math.min(8, ...keys, now), hi = Math.max(21, ...keys, now);
  const list = []; for (let h = lo; h <= hi; h++) list.push({ h, v: Math.max(0, Number(hours?.[h]) || 0) });
  const max = Math.max(1, ...list.map(x => x.v));
  const peak = list.reduce((a, b) => (b.v > a.v ? b : a), list[0]);
  const lbl = h => (h % 12 || 12) + (h < 12 ? 'a' : 'p');
  return (
    <>
      <div className="card-h"><h2>Sales by hour</h2>{peak?.v > 0 && <span className="muted sm">peak {lbl(peak.h)}–{lbl(peak.h + 1)}</span>}</div>
      <div className="bars">
        {list.map(x => <div key={x.h} title={`${lbl(x.h)}: ${inr(x.v)}`} className={x.h === now && x.v > 0 ? 'now' : ''} style={{ height: `${Math.max(2, (x.v / max) * 100)}%`, opacity: x.v ? 1 : .25 }} />)}
      </div>
      <div className="hours">{list.filter((_, i) => i % 3 === 0).map(x => <span key={x.h}>{lbl(x.h)}</span>)}</div>
    </>
  );
}

// ── tabs ──
function Today({ t, a, go }) {
  const change = t.ydaySameTime > 0 ? Math.round(((t.sales - t.ydaySameTime) / t.ydaySameTime) * 100) : null;
  const avg = t.bills ? t.sales / t.bills : 0;
  const maxTop = Math.max(1, ...(t.top || []).map(x => x.amt));
  const expired = a?.expired?.length || 0, low = a?.lowCount || 0, orders = t.orders?.length || 0;
  return (
    <div className="stack">
      <section className="card hero">
        <div className="hero-l">Sales today · {new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</div>
        <div className="big mono">{inr(t.sales)}</div>
        <div className="hero-s">
          {t.bills} bill{t.bills === 1 ? '' : 's'}{t.returns ? ` · ${t.returns} return${t.returns === 1 ? '' : 's'}` : ''}
          {change != null && <> · <b className={change >= 0 ? 'up' : 'down'}>{change >= 0 ? '▲' : '▼'} {Math.abs(change)}%</b> <span className="dim">vs yesterday at this time</span></>}
        </div>
      </section>
      <div className="g3">
        <div className="mini"><div className="lbl">Profit (est.)</div><div className="v mono">{inr(t.profit)}</div>{t.sales > 0 && <div className="lbl">{Math.round((t.profit / t.sales) * 100)}% margin</div>}</div>
        <div className="mini"><div className="lbl">Average bill</div><div className="v mono">{inr(avg)}</div></div>
        <div className="mini"><div className="lbl">Udhaar due</div><div className="v mono">{a ? inr(a.custDue) : '…'}</div></div>
      </div>
      <Card title="How customers paid"><PaySplit pay={t.pay} /></Card>
      <section className="card"><Hours hours={t.hours} /></section>
      <Card title="Top items today">
        {!(t.top || []).length ? <Empty>No bills yet today.</Empty> : t.top.map(x => (
          <div className="ti" key={x.name}>
            <div className="row"><span>{x.name}</span><span className="mono sm">{inr(x.amt)} · {qty(x.qty)}</span></div>
            <div className="track"><div className="fill" style={{ width: `${(x.amt / maxTop) * 100}%` }} /></div>
          </div>
        ))}
      </Card>
      {expired > 0 && <button className="alert bad" onClick={() => go('stock', 'expired')}><span className="n mono">{expired}</span>Expired item{expired === 1 ? '' : 's'} still on the shelf<span className="go">›</span></button>}
      {(a?.expiring?.length || 0) > 0 && <button className="alert warn" onClick={() => go('stock', 'expiring')}><span className="n mono">{a.expiring.length}</span>Expiring within 30 days<span className="go">›</span></button>}
      {low > 0 && <button className="alert warn" onClick={() => go('stock', 'low')}><span className="n mono">{low}</span>Item{low === 1 ? '' : 's'} below reorder level<span className="go">›</span></button>}
      {orders > 0 && <button className="alert info" onClick={() => go('counters')}><span className="n mono">{orders}</span>Open WhatsApp order{orders === 1 ? '' : 's'}<span className="go">›</span></button>}
    </div>
  );
}

function Counters({ t }) {
  const list = t.counters || [];
  const online = list.filter(c => c.lastSeen && t.serverNow - c.lastSeen < ONLINE_WINDOW).length;
  return (
    <div className="stack">
      <div className="row muted sm pad"><span>{list.length} counter{list.length === 1 ? '' : 's'} · {online} online</span><span>Today</span></div>
      {!list.length && <Empty>No counter has connected yet. Turn on Cloud sync on each counter.</Empty>}
      {list.map(c => {
        const on = c.lastSeen && t.serverNow - c.lastSeen < ONLINE_WINDOW;
        return (
          <section className="card ctr" key={c.counter}>
            <div className="row">
              <span className="nm">Counter {c.counter}</span>
              <span className={`pill ${on ? 'ok' : 'warn'}`}><i />{on ? 'Online' : 'Offline'}{c.lastSeen ? ` · ${ago(t.serverNow - c.lastSeen)}` : ' · no signal yet'}</span>
            </div>
            <div className="row">
              <span className="mono amt-l">{inr(c.sales)}</span>
              <span className="muted sm">{c.bills} bill{c.bills === 1 ? '' : 's'}{c.user ? ` · ${c.user}` : ''}</span>
            </div>
            {!on && c.lastSeen && <div className="sm warn-t">May still be billing without internet. Its bills will arrive when it reconnects.</div>}
            {on && c.pending > 0 && <div className="sm muted">{c.pending} change{c.pending === 1 ? '' : 's'} waiting to send</div>}
          </section>
        );
      })}
      <Card title="Open WhatsApp orders">
        {!(t.orders || []).length ? <Empty>No open orders.</Empty> : t.orders.map(o => (
          <div className="li" key={o.no}>
            <div><div className="t">{o.no} · {o.cust || 'Customer'}</div><div className="s">{o.typ === 'delivery' ? 'Home delivery' : o.typ === 'pickup' ? 'Pickup' : (o.typ || 'Order')} · {o.n} item{o.n === 1 ? '' : 's'}{o.created ? ` · ${clock(o.created)}` : ''}</div></div>
            <span className={`badge ${o.status === 'new' ? 'warn' : 'info'}`}>{o.status === 'new' ? 'New' : o.status === 'packing' ? 'Packing' : 'Ready'}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}

function Stock({ a, seg, setSeg }) {
  if (!a) return <Empty>Loading stock…</Empty>;
  const segs = [['expired', 'Expired', a.expired.length], ['expiring', 'Expiring', a.expiring.length], ['low', 'Low', a.lowCount]];
  return (
    <div className="stack">
      <div className="seg" role="tablist">
        {segs.map(([k, l, n]) => <button key={k} role="tab" aria-selected={seg === k} className={seg === k ? 'on' : ''} onClick={() => setSeg(k)}>{l} <b className="mono">{n}</b></button>)}
      </div>
      {seg === 'expired' && (
        <Card>
          {!a.expired.length ? <Empty>Nothing expired on the shelf. 👍</Empty> : a.expired.map((b, i) => (
            <div className="li" key={i}><div><div className="t">{b.name}</div><div className="s">Batch {b.batch}{b.rack ? ` · Rack ${b.rack}` : ''} · expired {Math.abs(b.dl)} day{Math.abs(b.dl) === 1 ? '' : 's'} ago</div></div>
              <div className="r"><div className="mono b">{qty(b.q)}</div><span className="badge bad">Remove</span></div></div>
          ))}
          {a.expired.length > 0 && <div className="foot-note">Worth {inr(a.expiredValue)} at cost</div>}
        </Card>
      )}
      {seg === 'expiring' && (
        <Card>
          {!a.expiring.length ? <Empty>Nothing expires in the next 30 days.</Empty> : a.expiring.map((b, i) => (
            <div className="li" key={i}><div><div className="t">{b.name}</div><div className="s">Batch {b.batch}{b.rack ? ` · Rack ${b.rack}` : ''}</div></div>
              <div className="r"><div className="mono b">{qty(b.q)}</div><span className={`badge ${b.dl <= 7 ? 'bad' : 'warn'}`}>{b.dl === 0 ? 'Today' : `${b.dl} day${b.dl === 1 ? '' : 's'}`}</span></div></div>
          ))}
          {a.expiring.length > 0 && <div className="foot-note">Value at risk: {inr(a.expiringValue)} at cost</div>}
        </Card>
      )}
      {seg === 'low' && (
        <Card>
          {!a.low.length ? <Empty>All items are above their reorder level.</Empty> : a.low.map((p, i) => (
            <div className="li" key={i}><div><div className="t">{p.name}</div><div className="s">{p.rack ? `Rack ${p.rack} · ` : ''}reorder at {qty(p.rmin)}</div></div>
              <div className="r"><div className={`mono b ${p.q <= 0 ? 'bad-t' : ''}`}>{qty(p.q)}</div><span className="badge warn">Low</span></div></div>
          ))}
        </Card>
      )}
    </div>
  );
}

function Bills({ t, open }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (t.recent || []).filter(b => !s || [b.no, b.cust, b.phone, b.counter, b.cashier].some(x => String(x || '').toLowerCase().includes(s)));
  }, [q, t.recent]);
  return (
    <div className="stack">
      <input className="search" type="search" placeholder="Search bill no., customer or phone" value={q} onChange={e => setQ(e.target.value)} aria-label="Search bills" />
      <Card>
        {!list.length ? <Empty>{q ? 'No bill matches.' : 'No bills yet today.'}</Empty> : list.map(b => (
          <button className="li btnli" key={b.id} onClick={() => open(b)}>
            <div><div className="t">{b.typ === 'return' ? 'Return · ' : ''}{b.cust || 'Walk-in'}</div><div className="s">{b.no} · {clock(b.ts)} · {modeLabel(b.modes)}</div></div>
            <div className={`amt mono ${b.amt < 0 ? 'bad-t' : ''}`}>{inr(b.amt)}</div>
          </button>
        ))}
      </Card>
      {(t.recent || []).length >= 80 && <p className="muted sm center">Showing today’s latest 80 bills.</p>}
    </div>
  );
}

function BillSheet({ cfg, bill, onClose }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => { fetchBill(cfg, bill.id).then(setD).catch(e => setErr(e.message)); }, [cfg, bill.id]);
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label={`Bill ${bill.no}`}>
        <div className="row sheet-h"><div><div className="t">{bill.no}</div><div className="s">{new Date(bill.ts).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · Counter {bill.counter}{bill.cashier ? ` · ${bill.cashier}` : ''}</div></div>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon n="close" /></button></div>
        {err && <p className="err">{err}</p>}
        {!d && !err && <Empty>Loading bill…</Empty>}
        {d && (
          <>
            <div className="s pad-b">{d.customerName || 'Walk-in customer'}{d.customerPhone ? ` · ${d.customerPhone}` : ''}</div>
            <div className="lines">
              {(d.lines || []).map((l, i) => (
                <div className="row line" key={i}><div><div>{l.name}</div><div className="s">{qty(l.qty)} × {inr(l.unitPrice ?? (l.total / (l.qty || 1)), 2)}{l.offerNote ? ` · ${l.offerNote}` : ''}</div></div><div className="mono">{inr(l.total, 2)}</div></div>
              ))}
            </div>
            <div className="row tot"><span>Total</span><span className="mono">{inr(d.totals?.payable, 2)}</span></div>
            <div className="s">{(d.payments || []).map(p => `${MODE[p.mode] || p.mode} ${inr(p.amount, 2)}`).join(' · ')}</div>
            {d.totals && <div className="s">GST included: {inr((d.totals.cgst || 0) + (d.totals.sgst || 0) + (d.totals.igst || 0), 2)}</div>}
          </>
        )}
      </div>
    </div>
  );
}

function SettingsSheet({ cfg, onClose, onDisconnect }) {
  return (
    <div className="sheet-wrap" onClick={onClose}>
      <div className="sheet" onClick={e => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="row sheet-h"><div className="t">Settings</div><button className="icon-btn" onClick={onClose} aria-label="Close"><Icon n="close" /></button></div>
        <div className="li"><div><div className="s">Store</div><div className="t">{cfg.name} ({cfg.store})</div></div></div>
        <div className="li"><div><div className="s">Cloud</div><div className="t sm">{cfg.url.replace('https://', '')}</div></div></div>
        <p className="s">Numbers refresh every 15 seconds while this app is open. Stock alerts refresh every 2 minutes. Pull the refresh button any time.</p>
        <button className="btn danger full" onClick={onDisconnect}>Disconnect this phone</button>
      </div>
    </div>
  );
}

// ── app ──
export default function OwnerApp() {
  const [cfg, setCfg] = useState(() => loadCfg());
  const last = useRef(loadLast());
  const [t, setT] = useState(last.current?.today || null);
  const [a, setA] = useState(last.current?.alerts || null);
  const [okAt, setOkAt] = useState(last.current?.at || 0);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('today');
  const [seg, setSeg] = useState('expired');
  const [bill, setBill] = useState(null);
  const [gear, setGear] = useState(false);
  const [, tick] = useState(0);
  const alertsAt = useRef(0);

  // Open from a link like owner.html#setup=DFR1.xxx (sent from the counter).
  useEffect(() => {
    const m = location.hash.match(/setup=([^&]+)/);
    if (!m) return;
    try { const c = parseCode(decodeURIComponent(m[1])); saveCfg(c); setCfg(c); } catch { /* bad link: show setup */ }
    history.replaceState(null, '', location.pathname);
  }, []);

  const refresh = async (withAlerts = false) => {
    if (!cfg) return;
    setBusy(true);
    try {
      const today = await fetchToday(cfg);
      let alerts = a;
      if (withAlerts || Date.now() - alertsAt.current > ALERTS_EVERY) { alerts = await fetchAlerts(cfg); alertsAt.current = Date.now(); setA(alerts); }
      setT(today); setOkAt(Date.now()); setErr('');
      saveLast({ today, alerts, at: Date.now() });
    } catch (e) {
      setErr(navigator.onLine ? (e.message || 'Could not reach the cloud.') : 'No internet on this phone.');
    }
    setBusy(false);
  };

  useEffect(() => {
    if (!cfg) return undefined;
    refresh(true);
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, TODAY_EVERY);
    const vis = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('online', vis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', vis); window.removeEventListener('online', vis); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg]);

  useEffect(() => { const id = setInterval(() => tick(x => x + 1), 1000); return () => clearInterval(id); }, []);

  if (!cfg) return <Setup onDone={c => { setCfg(c); }} />;

  const go = (tb, sg) => { setTab(tb); if (sg) setSeg(sg); if (tb === 'stock' && Date.now() - alertsAt.current > 30000) refresh(true); window.scrollTo(0, 0); };
  const stale = okAt && Date.now() - okAt > 60000;
  const titles = { today: cfg.name, counters: 'Counters', stock: 'Stock', bills: 'Today’s bills' };
  const stockBadge = (a?.expired?.length || 0);

  return (
    <div className="app">
      <header className="top">
        <div className="top-row">
          <h1 className="store">{titles[tab]}</h1>
          <div className="top-act">
            <button className={`icon-btn ${busy ? 'spin' : ''}`} onClick={() => refresh(true)} aria-label="Refresh"><Icon n="refresh" size={19} /></button>
            <button className="icon-btn" onClick={() => setGear(true)} aria-label="Settings"><Icon n="gear" size={19} /></button>
          </div>
        </div>
        <div className="live">
          <span className={`pulse ${err || stale ? 'off' : ''}`} />
          {okAt ? (err || stale ? `Last updated ${clock(okAt)}` : `Live · updated ${ago(Date.now() - okAt)}`) : 'Connecting…'}
        </div>
        {err && <div className="banner">{err}{okAt ? ' Showing the last numbers.' : ''}</div>}
      </header>

      <main className="scroll">
        {!t ? <Empty>{err ? 'Could not load yet.' : 'Loading…'}</Empty> : (
          <>
            {tab === 'today' && <Today t={t} a={a} go={go} />}
            {tab === 'counters' && <Counters t={t} />}
            {tab === 'stock' && <Stock a={a} seg={seg} setSeg={setSeg} />}
            {tab === 'bills' && <Bills t={t} open={setBill} />}
          </>
        )}
      </main>

      <nav className="nav" aria-label="Sections">
        {[['today', 'Today'], ['counters', 'Counters'], ['stock', 'Stock'], ['bills', 'Bills']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => go(k)} aria-current={tab === k ? 'page' : undefined}>
            <Icon n={k} />{l}{k === 'stock' && stockBadge > 0 && <span className="dotb mono">{stockBadge}</span>}
          </button>
        ))}
      </nav>

      {bill && <BillSheet cfg={cfg} bill={bill} onClose={() => setBill(null)} />}
      {gear && <SettingsSheet cfg={cfg} onClose={() => setGear(false)} onDisconnect={() => { clearCfg(); setGear(false); setT(null); setA(null); setOkAt(0); setCfg(null); }} />}
    </div>
  );
}
