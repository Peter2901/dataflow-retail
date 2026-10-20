import React, { useEffect, useState, useRef, createContext, useContext, useCallback } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../db.js';
import { hashPin } from '../lib/util.js';

// Re-runs a database query whenever the data changes.
export function useLive(fn, deps = [], initial = undefined) {
  const [v, setV] = useState(initial);
  useEffect(() => {
    const sub = liveQuery(fn).subscribe({ next: setV, error: e => console.error(e) });
    return () => sub.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return v;
}

export const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function Btn({ kind = 'default', size, children, className = '', ...p }) {
  return <button className={`btn btn-${kind} ${size ? 'btn-' + size : ''} ${className}`} {...p}>{children}</button>;
}

export function Field({ label, hint, children, className = '' }) {
  return <label className={`field ${className}`}><span className="field-label">{label}</span>{children}{hint && <span className="field-hint">{hint}</span>}</label>;
}

export const Input = React.forwardRef(function Input({ label, hint, className, ...p }, ref) {
  return <Field label={label} hint={hint} className={className}><input className="input" ref={ref} {...p} /></Field>;
});

export function Select({ label, hint, options, className, ...p }) {
  return (
    <Field label={label} hint={hint} className={className}>
      <select className="input" {...p}>
        {options.map(o => typeof o === 'object' ? <option key={o.value} value={o.value}>{o.label}</option> : <option key={o} value={o}>{o}</option>)}
      </select>
    </Field>
  );
}

export function Badge({ tone = 'neutral', children }) { return <span className={`badge badge-${tone}`}>{children}</span>; }

export function Stat({ label, value, sub, tone }) {
  return <div className={`stat ${tone ? 'stat-' + tone : ''}`}><div className="stat-label">{label}</div><div className="stat-value">{value}</div>{sub && <div className="stat-sub">{sub}</div>}</div>;
}

export function Card({ title, actions, children, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && <header className="card-head"><h3>{title}</h3><div className="row gap-s">{actions}</div></header>}
      <div className="card-body">{children}</div>
    </section>
  );
}

// Open modals, newest last: Escape closes only the top one (a quick-add box over a purchase bill
// must not close the bill too).
const modalStack = [];
export function Modal({ title, onClose, children, footer, wide, xl }) {
  const me = useRef({});
  useEffect(() => {
    const id = me.current;
    modalStack.push(id);
    return () => { const i = modalStack.indexOf(id); if (i >= 0) modalStack.splice(i, 1); };
  }, []);
  useEffect(() => {
    const k = e => e.key === 'Escape' && modalStack[modalStack.length - 1] === me.current && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={e => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal ${xl ? 'modal-xl' : wide ? 'modal-wide' : ''}`} role="dialog" aria-label={title}>
        <header className="modal-head"><h3>{title}</h3><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return <div className="tabs" role="tablist">{tabs.map(t => <button key={t.value} role="tab" aria-selected={value === t.value} className={`tab ${value === t.value ? 'on' : ''}`} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

export function Table({ cols, rows, empty = 'Nothing here yet.', onRow, keyField = 'id', foot }) {
  if (!rows) return <div className="muted pad">Loading…</div>;
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead><tr>{cols.map(c => <th key={c.key || c.label} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r[keyField] ?? i} onClick={onRow ? () => onRow(r) : undefined} className={onRow ? 'clickable' : ''}>
              {cols.map(c => <td key={c.key || c.label} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : r[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
        {foot && <tfoot><tr>{cols.map((c, i) => <td key={i} className={c.num ? 'num' : ''}>{foot[c.key] ?? ''}</td>)}</tr></tfoot>}
      </table>
    </div>
  );
}

// Toasts
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastHost({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, tone = 'ok') => {
    const id = Math.random();
    setItems(x => [...x, { id, msg, tone }]);
    setTimeout(() => setItems(x => x.filter(i => i.id !== id)), 3800);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite">{items.map(t => <div key={t.id} className={`toast toast-${t.tone}`}>{t.msg}</div>)}</div>
    </ToastCtx.Provider>
  );
}

// Supervisor approval ("two-person rule"): asks for a manager or owner PIN.
const ApproveCtx = createContext(async () => null);
export const useApprove = () => useContext(ApproveCtx);
export function ApproveHost({ children }) {
  const [req, setReq] = useState(null);
  const [pin, setPin] = useState('');
  const [err, setErr] = useState('');
  const ask = useCallback(reason => new Promise(resolve => { setPin(''); setErr(''); setReq({ reason, resolve }); }), []);
  const submit = async e => {
    e?.preventDefault();
    const h = await hashPin(pin);
    const u = (await db.users.toArray()).find(x => x.pinHash === h && ['owner', 'manager'].includes(x.role));
    if (!u) { setErr('That PIN is not a manager or owner PIN.'); setPin(''); return; }
    req.resolve(u); setReq(null);
  };
  return (
    <ApproveCtx.Provider value={ask}>
      {children}
      {req && (
        <Modal title="Manager approval needed" onClose={() => { req.resolve(null); setReq(null); }}
          footer={<><Btn onClick={() => { req.resolve(null); setReq(null); }}>Cancel</Btn><Btn kind="primary" onClick={submit}>Approve</Btn></>}>
          <form onSubmit={submit} className="stack">
            <p>{req.reason}</p>
            <Input label="Manager or owner PIN" type="password" inputMode="numeric" autoFocus value={pin} onChange={e => setPin(e.target.value)} id="approve-pin" />
            {err && <p className="err">{err}</p>}
          </form>
        </Modal>
      )}
    </ApproveCtx.Provider>
  );
}

// "Are you sure" built into the page (browser confirm() is blocked in some viewers).
const ConfirmCtx = createContext(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);
export function ConfirmHost({ children }) {
  const [req, setReq] = useState(null);
  const ask = useCallback((message, okLabel = 'Yes') => new Promise(resolve => setReq({ message, okLabel, resolve })), []);
  const done = v => { req.resolve(v); setReq(null); };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {req && <Modal title="Please confirm" onClose={() => done(false)} footer={<><Btn onClick={() => done(false)}>Cancel</Btn><Btn kind="primary" onClick={() => done(true)}>{req.okLabel}</Btn></>}><p>{req.message}</p></Modal>}
    </ConfirmCtx.Provider>
  );
}

export function useDebounced(v, ms = 200) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

export function PageHead({ title, sub, actions }) {
  return <div className="page-head"><div><h1>{title}</h1>{sub && <p className="muted">{sub}</p>}</div><div className="row gap-s wrap">{actions}</div></div>;
}

export function SearchBox({ value, onChange, placeholder = 'Search', autoFocus, inputRef }) {
  return <input ref={inputRef} className="input search" type="search" placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} autoFocus={autoFocus} aria-label={placeholder} />;
}

export function Bar({ value, max, tone = 'accent' }) {
  const pct = max ? Math.max(2, Math.min(100, (value / max) * 100)) : 0;
  return <div className="bar"><div className={`bar-fill bar-${tone}`} style={{ width: pct + '%' }} /></div>;
}

export function useHotkeys(map, deps = []) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    const h = e => { const f = ref.current[e.key]; if (f) { e.preventDefault(); f(e); } };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
