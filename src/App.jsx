import React, { useEffect, useState, Suspense } from 'react';
import { db, ensureSeeded, getSettings } from './db.js';
import { AppCtx, ToastHost, ApproveHost, ConfirmHost, useLive } from './ui/kit.jsx';
import { hashPin, daysBetween, localISO } from './lib/util.js';
import { audit } from './lib/sales.js';
import Dashboard from './pages/Dashboard.jsx';
import POS from './pages/POS.jsx';
import Orders from './pages/Orders.jsx';
import Products from './pages/Products.jsx';
import Stock from './pages/Stock.jsx';
import Expiry from './pages/Expiry.jsx';
import Offers from './pages/Offers.jsx';
import Purchases from './pages/Purchases.jsx';
import Customers from './pages/Customers.jsx';
import Credit from './pages/Credit.jsx';
import Accounts from './pages/Accounts.jsx';
import Reports from './pages/Reports.jsx';
import Staff from './pages/Staff.jsx';
import Assistant from './pages/Assistant.jsx';
import Audit from './pages/Audit.jsx';
import Setup from './pages/Setup.jsx';
import Settings from './pages/Settings.jsx';

const ALL = ['owner', 'manager', 'cashier', 'accountant'];
export const NAV = [
  { group: 'Today', items: [
    { id: 'dashboard', label: 'Dashboard', roles: ['owner', 'manager', 'accountant'], el: Dashboard },
    { id: 'pos', label: 'Billing counter', roles: ['owner', 'manager', 'cashier'], el: POS },
    { id: 'orders', label: 'WhatsApp orders', roles: ['owner', 'manager', 'cashier'], el: Orders, badge: 'orders' },
  ] },
  { group: 'Stock', items: [
    { id: 'products', label: 'Products', roles: ['owner', 'manager', 'accountant'], el: Products },
    { id: 'stock', label: 'Stock & batches', roles: ['owner', 'manager'], el: Stock },
    { id: 'expiry', label: 'Expiry control', roles: ['owner', 'manager'], el: Expiry, badge: 'expiry' },
    { id: 'offers', label: 'Offers & pricing', roles: ['owner', 'manager'], el: Offers },
    { id: 'purchases', label: 'Purchases & suppliers', roles: ['owner', 'manager', 'accountant'], el: Purchases },
  ] },
  { group: 'Customers', items: [
    { id: 'customers', label: 'Customers & loyalty', roles: ['owner', 'manager', 'cashier'], el: Customers, badge: 'followups' },
    { id: 'credit', label: 'Credit & dues', roles: ['owner', 'manager', 'accountant'], el: Credit },
  ] },
  { group: 'Money & team', items: [
    { id: 'accounts', label: 'Accounts', roles: ['owner', 'accountant'], el: Accounts },
    { id: 'reports', label: 'Reports', roles: ['owner', 'manager', 'accountant'], el: Reports },
    { id: 'staff', label: 'Staff & salary', roles: ['owner', 'manager'], el: Staff },
  ] },
  { group: 'Control', items: [
    { id: 'assistant', label: 'AI assistant', roles: ['owner', 'manager', 'accountant'], el: Assistant },
    { id: 'audit', label: 'Security & audit', roles: ['owner'], el: Audit },
    { id: 'setup', label: 'Import & setup', roles: ['owner', 'manager'], el: Setup },
    { id: 'settings', label: 'Settings', roles: ['owner'], el: Settings },
  ] },
];
const ROLE_LABEL = { owner: 'Owner', manager: 'Manager', cashier: 'Cashier', accountant: 'Accountant' };
void ALL;

function Login({ onLogin, settings }) {
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const tryPin = async p => {
    const h = await hashPin(p);
    const u = (await db.users.toArray()).find(x => x.pinHash === h && !x.disabled);
    if (u) { await audit('login', { role: u.role }, u); onLogin(u); }
    else { setErr('Wrong PIN. Try again.'); setPin(''); }
  };
  const press = d => {
    setErr('');
    const p = (pin + d).slice(0, 6);
    setPin(p);
    if (p.length === 4) tryPin(p);
  };
  useEffect(() => {
    const k = e => { if (/^\d$/.test(e.key)) press(e.key); if (e.key === 'Backspace') setPin(x => x.slice(0, -1)); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  return (
    <div className="login">
      <div className="login-box">
        <div className="row gap-s"><div className="brand-mark">DF</div><div><div className="brand-name">DataFlow Retail</div><div className="muted small">{settings.storeName}</div></div></div>
        <h1>Enter your PIN</h1>
        <div className="pin-dots" aria-label={`${pin.length} digits entered`}>{[0, 1, 2, 3].map(i => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
        {err && <p className="err" role="alert">{err}</p>}
        <div className="pinpad">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((d, i) => d === '' ? <span key={i} /> :
            <button key={i} onClick={() => d === '⌫' ? setPin(x => x.slice(0, -1)) : press(d)} aria-label={d === '⌫' ? 'Delete' : d}>{d}</button>)}
        </div>
        {settings.sampleData && (
          <div className="note small">
            <b>Demo PINs</b> — Owner 1111 · Manager 2222 · Cashier 3333 · Accountant 4444. Change them in Settings before real use.
          </div>
        )}
      </div>
    </div>
  );
}

export default function App() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState(null);
  const [page, setPage] = useState('dashboard');
  const [param, setParam] = useState(null);
  const [menu, setMenu] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const settings = useLive(() => getSettings(), [], null);

  useEffect(() => {
    ensureSeeded().then(() => setReady(true)).catch(e => { console.error(e); setReady(true); });
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    // Inside a claude.ai artifact, file saving goes through the downloads capability.
    autoBackup();
    window.claude?.use?.('downloads').then(d => { if (d) window.__dfrDownloads = d; }).catch(() => {});
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  useEffect(() => {
    const t = settings?.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }, [settings?.theme]);

  const counts = useLive(async () => {
    const orders = await db.orders.where('status').anyOf('new', 'packing', 'ready').count();
    const today = localISO(new Date());
    const followups = (await db.followups.toArray()).filter(f => !f.done && f.due <= today).count ?? 0;
    const fu = (await db.followups.toArray()).filter(f => !f.done && f.due <= today).length;
    const store = settings?.currentStore || 'S1';
    const bs = await db.batches.where('storeId').equals(store).toArray();
    const exp = bs.filter(b => b.status === 'active' && b.qty > 0 && b.expiry && daysBetween(new Date(), new Date(b.expiry)) <= 7).length;
    const pending = await db.outbox.where('synced').equals(0).count();
    void followups;
    return { orders, followups: fu, expiry: exp, pending };
  }, [settings?.currentStore], {});

  if (!ready || !settings) return <div className="login"><div className="login-box"><p>Opening the store…</p></div></div>;
  if (!user) return <Login settings={settings} onLogin={u => { setUser(u); setPage(u.role === 'cashier' ? 'pos' : 'dashboard'); }} />;

  const items = NAV.flatMap(g => g.items).filter(i => i.roles.includes(user.role));
  const current = items.find(i => i.id === page) || items[0];
  const Page = current.el;
  const go = (id, p = null) => { setPage(id); setParam(p); setMenu(false); };
  const ctx = { user, settings, storeId: settings.currentStore || 'S1', go, param, online, logout: () => { audit('logout', {}, user); setUser(null); } };

  return (
    <AppCtx.Provider value={ctx}>
      <ToastHost><ApproveHost><ConfirmHost>
        <div className="shell">
          <div className="topbar">
            <button className="icon-btn" onClick={() => setMenu(true)} aria-label="Open menu">☰</button>
            <b>{current.label}</b>
            <span className="grow" />
            <span className="net"><span className={`dot ${online ? '' : 'off'}`} />{online ? 'Online' : 'Offline'}</span>
          </div>
          {menu && <div className="scrim" onClick={() => setMenu(false)} />}
          <aside className={`side ${menu ? 'open' : ''}`}>
            <div className="brand"><div className="brand-mark">DF</div><div><div className="brand-name">DataFlow Retail</div><div className="brand-store">{settings.storeName}</div></div></div>
            <nav className="nav">
              {NAV.map(g => {
                const vis = g.items.filter(i => i.roles.includes(user.role));
                if (!vis.length) return null;
                return (
                  <div key={g.group}>
                    <div className="nav-group">{g.group}</div>
                    {vis.map(i => (
                      <button key={i.id} className={`nav-item ${current.id === i.id ? 'on' : ''}`} onClick={() => go(i.id)}>
                        {i.label}{i.badge && counts?.[i.badge] ? <span className="nav-count">{counts[i.badge]}</span> : null}
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>
            <div className="side-foot">
              <span className="net"><span className={`dot ${online ? '' : 'off'}`} />{online ? 'Online' : 'Offline — billing continues'}{counts?.pending ? ` · ${counts.pending} to sync` : ''}</span>
              <div className="row between"><span>{user.name} · {ROLE_LABEL[user.role]}</span><button className="btn btn-sm btn-dark" onClick={ctx.logout}>Lock</button></div>
            </div>
          </aside>
          <main className="main">
            <Suspense fallback={<p>Loading…</p>}><Page key={current.id} /></Suspense>
          </main>
        </div>
      </ConfirmHost></ApproveHost></ToastHost>
    </AppCtx.Provider>
  );
}

// Windows app: one automatic backup a day into Documents\\DataFlow Retail Backups.
async function autoBackup() {
  if (!window.dfrDesktop) return;
  const day = localISO(new Date());
  try { if (localStorage.getItem('dfr_backup') === day) return; } catch { /* ignore */ }
  const out = {};
  for (const t of db.tables) out[t.name] = await t.toArray();
  await window.dfrDesktop.saveBackup(`backup-${day}.json`, JSON.stringify({ app: 'dataflow-retail', at: Date.now(), data: out }));
  try { localStorage.setItem('dfr_backup', day); } catch { /* ignore */ }
}
