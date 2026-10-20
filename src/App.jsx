import React, { useEffect, useState, Suspense } from 'react';
import { db, ensureSeeded, getSettings } from './db.js';
import { AppCtx, ToastHost, ApproveHost, ConfirmHost, useLive } from './ui/kit.jsx';
import { hashPin, daysBetween, localISO } from './lib/util.js';
import { audit } from './lib/sales.js';
import { startSync, getStatus, onSyncStatus, setSyncUser } from './lib/sync.js';
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
import Smart from './pages/Smart.jsx';
import Hub from './pages/Hub.jsx';
import { Connect, Downloading } from './ui/Connect.jsx';

// The Android phone app is the full store app without the billing counter.
export const PHONE_BUILD = import.meta.env.MODE === 'mobile';
import Audit from './pages/Audit.jsx';
import Setup from './pages/Setup.jsx';
import Settings from './pages/Settings.jsx';

const ALL = ['owner', 'manager', 'cashier', 'accountant'];

// Simple line icons (stroke) for the sidebar, keyed by nav id.
const ICON = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  pos: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 14h4"/>',
  orders: '<path d="M21 11.5a8.4 8.4 0 0 1-1.1 4.2L21 21l-5.3-1.1A8.5 8.5 0 1 1 21 11.5Z"/>',
  products: '<path d="M3 7l9-4 9 4-9 4-9-4Z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/>',
  stock: '<rect x="3" y="3" width="8" height="8" rx="1"/><rect x="13" y="3" width="8" height="8" rx="1"/><rect x="3" y="13" width="8" height="8" rx="1"/><rect x="13" y="13" width="8" height="8" rx="1"/>',
  expiry: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  offers: '<path d="M20 12l-8 8-9-9V3h8l9 9Z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
  purchases: '<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6L5 3H2"/><circle cx="9" cy="20" r="1.3"/><circle cx="18" cy="20" r="1.3"/>',
  customers: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8"/><path d="M18 20a6 6 0 0 0-3-5"/>',
  credit: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
  accounts: '<path d="M4 21V10M10 21V4M16 21v-8M22 21H2"/>',
  reports: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16l3-4 3 2 4-6"/>',
  staff: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  hub: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/>',
  smart: '<path d="M12 2l2.4 5.6L20 8.3l-4.3 3.9L17 18l-5-3-5 3 1.3-5.8L4 8.3l5.6-.7Z"/>',
  assistant: '<path d="M12 3a7 7 0 0 1 7 7c0 3-2 4-2 6H7c0-2-2-3-2-6a7 7 0 0 1 7-7Z"/><path d="M9 21h6"/>',
  audit: '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"/><path d="M9 12l2 2 4-4"/>',
  setup: '<path d="M4 7h16M4 12h16M4 17h10"/><circle cx="18" cy="17" r="2.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>',
};
const NavIcon = ({ id }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: ICON[id] || '' }} />
);

// Simpler menu: everyday work first, every smart tool in one amber "Smart & AI" block,
// and setup screens folded away. `hidden` pages open from the hub, not from the menu.
const OFFICE = ['owner', 'manager', 'accountant'];
export const NAV = [
  { group: 'Today', items: [
    { id: 'dashboard', label: 'Home', roles: OFFICE, el: Dashboard },
    { id: 'pos', label: 'Billing counter', roles: ['owner', 'manager', 'cashier'], el: POS },
    { id: 'orders', label: 'WhatsApp orders', roles: ['owner', 'manager', 'cashier'], el: Orders, badge: 'orders' },
  ] },
  { group: 'Stock', items: [
    { id: 'products', label: 'Products', roles: OFFICE, el: Products },
    { id: 'stock', label: 'Stock & batches', roles: ['owner', 'manager'], el: Stock },
    { id: 'expiry', label: 'Expiry control', roles: ['owner', 'manager'], el: Expiry, badge: 'expiry' },
    { id: 'offers', label: 'Offers & pricing', roles: ['owner', 'manager'], el: Offers },
    { id: 'purchases', label: 'Purchases & suppliers', roles: OFFICE, el: Purchases },
  ] },
  { group: 'Customers', items: [
    { id: 'customers', label: 'Customers & loyalty', roles: ['owner', 'manager', 'cashier'], el: Customers, badge: 'followups' },
    { id: 'credit', label: 'Credit & dues', roles: OFFICE, el: Credit },
  ] },
  { group: 'Money & team', items: [
    { id: 'accounts', label: 'Accounts', roles: ['owner', 'accountant'], el: Accounts },
    { id: 'reports', label: 'Reports', roles: OFFICE, el: Reports },
    { id: 'staff', label: 'Staff & salary', roles: ['owner', 'manager'], el: Staff },
  ] },
  { group: 'Smart & AI', ai: true, items: [
    { id: 'hub', label: 'All smart tools', roles: OFFICE, el: Hub },
    { id: 'assistant', label: 'Ask your shop', roles: OFFICE, el: Assistant },
    { id: 'smart', label: 'Smart insights', roles: OFFICE, el: Smart, hidden: true },
  ] },
  { group: 'Setup', fold: true, items: [
    { id: 'setup', label: 'Import & setup', roles: ['owner', 'manager'], el: Setup },
    { id: 'audit', label: 'Security & audit', roles: ['owner'], el: Audit },
    { id: 'settings', label: 'Settings', roles: ['owner'], el: Settings },
  ] },
];
// Phone bottom tabs: first matches the role can open, AI hub always 5th.
const TAB_CHOICES = ['dashboard', 'pos', 'orders', 'products', 'purchases', 'customers', 'credit', 'reports'];
const TAB_LABEL = { dashboard: 'Home', pos: 'Billing', orders: 'Orders', products: 'Products', purchases: 'Purchases', customers: 'Customers', credit: 'Dues', reports: 'Reports', hub: 'Smart & AI' };
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
  const [setupOpen, setSetupOpen] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [sync, setSync] = useState(getStatus());
  const settings = useLive(() => getSettings(), [], null);

  useEffect(() => {
    (PHONE_BUILD ? Promise.resolve() : ensureSeeded()).then(() => setReady(true)).catch(e => { console.error(e); setReady(true); });
    const on = () => setOnline(true), off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    // Inside a claude.ai artifact, file saving goes through the downloads capability.
    autoBackup();
    window.claude?.use?.('downloads').then(d => { if (d) window.__dfrDownloads = d; }).catch(() => {});
    const offSync = onSyncStatus(setSync);
    startSync();
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); offSync(); };
  }, []);

  useEffect(() => { setSyncUser(user?.name || ''); }, [user]);

  useEffect(() => {
    const t = settings?.theme;
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }, [settings?.theme]);

  const userCount = useLive(() => db.users.count(), [], null);
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

  if (!ready || !settings || userCount === null) return <div className="login"><div className="login-box"><p>Opening the store…</p></div></div>;
  const phone = PHONE_BUILD || settings.deviceMode === 'mobile';
  if (PHONE_BUILD && !settings.syncUrl) return <ToastHost><Connect /></ToastHost>;
  if (phone && !userCount) return <ToastHost><Downloading /></ToastHost>;
  if (!user) return <Login settings={settings} onLogin={u => { setUser(u); setPage(u.role === 'cashier' ? (phone ? 'orders' : 'pos') : 'dashboard'); }} />;

  const visible = i => i.roles.includes(user.role) && !(phone && i.id === 'pos');
  const items = NAV.flatMap(g => g.items).filter(visible);
  const current = items.find(i => i.id === page) || items[0];
  const Page = current.el;
  const go = (id, p = null) => { setPage(id); setParam(p); setMenu(false); };
  const canOpen = id => items.some(i => i.id === id);
  const tabs = [...TAB_CHOICES.filter(canOpen).slice(0, canOpen('hub') ? 4 : 5), ...(canOpen('hub') ? ['hub'] : [])];
  const ctx = { canOpen, user, settings, storeId: settings.currentStore || 'S1', go, param, online, logout: () => { audit('logout', {}, user); setUser(null); } };

  return (
    <AppCtx.Provider value={ctx}>
      <ToastHost><ApproveHost><ConfirmHost>
        <div className={`shell ${tabs.length > 1 && current.id !== 'pos' ? 'has-tabs' : ''}`}>
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
                const vis = g.items.filter(i => visible(i) && !i.hidden);
                if (!vis.length) return null;
                const open = !g.fold || setupOpen || vis.some(i => i.id === current.id);
                return (
                  <div key={g.group} className={g.ai ? 'nav-ai' : ''}>
                    {g.fold
                      ? <button className="nav-group nav-group-btn" onClick={() => setSetupOpen(o => !o)} aria-expanded={open}><span>{g.group}</span><span aria-hidden="true">{open ? '−' : '+'}</span></button>
                      : <div className="nav-group">{g.ai ? '✦ ' : ''}{g.group}</div>}
                    {open && vis.map(i => (
                      <button key={i.id} className={`nav-item ${current.id === i.id || (i.id === 'hub' && current.id === 'smart') ? 'on' : ''}`} onClick={() => go(i.id)}>
                        <NavIcon id={i.id} /><span>{i.label}</span>{i.badge && counts?.[i.badge] ? <span className="nav-count">{counts[i.badge]}</span> : null}
                      </button>
                    ))}
                  </div>
                );
              })}
            </nav>
            <div className="side-foot">
              <span className="net" title={sync.error || ''}>
                <span className={`dot ${online ? '' : 'off'}`} />
                {!online ? 'Offline — billing continues'
                  : !sync.enabled ? 'Online'
                  : sync.pending ? `Syncing · ${sync.pending} to send`
                  : sync.lastSync ? `Synced ${new Date(sync.lastSync).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                  : 'Sync on'}
              </span>
              <div className="row between"><span>{user.name} · {ROLE_LABEL[user.role]}</span><button className="btn btn-sm btn-dark" onClick={ctx.logout}>Lock</button></div>
            </div>
          </aside>
          <main className="main">
            <Suspense fallback={<p>Loading…</p>}><Page key={current.id} /></Suspense>
          </main>
          {tabs.length > 1 && current.id !== 'pos' && (
            <nav className="tabbar" aria-label="Main">
              {tabs.map(id => {
                const it = items.find(i => i.id === id);
                const on = current.id === id || (id === 'hub' && (current.id === 'smart' || current.id === 'assistant'));
                return (
                  <button key={id} className={`${on ? 'on' : ''} ${id === 'hub' ? 'ai' : ''}`} onClick={() => go(id)} aria-current={on ? 'page' : undefined}>
                    <NavIcon id={id} /><span>{TAB_LABEL[id]}</span>{it?.badge && counts?.[it.badge] ? <span className="nav-count">{counts[it.badge]}</span> : null}
                  </button>
                );
              })}
            </nav>
          )}
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
