import React, { useState } from 'react';
import jsQR from 'jsqr';
import { db } from '../db.js';
import { useLive } from './kit.jsx';
import { parseCode } from '../owner/api.js';
import { connectDevice, pullUntilQuiet, syncOnce } from '../lib/sync.js';
import { photoToCanvas } from '../lib/smartai.js';

// Phone app, first open: connect to the store with the setup code from the counter.
export function Connect() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const go = async text => {
    setErr('');
    try {
      const c = parseCode(text);
      setBusy('Checking the code…');
      const res = await fetch(`${c.url}/rest/v1/records?select=id&limit=1`, { headers: { apikey: c.key, Authorization: 'Bearer ' + c.key, ...(c.shop ? { 'x-shop-key': c.shop } : {}) } });
      if (!res.ok) throw new Error(res.status === 401 ? 'The cloud did not accept this code. Make a new one on the counter.' : `The cloud replied ${res.status}.`);
      setBusy('Connecting…');
      await connectDevice(c, { terminal: 'P' + Math.random().toString(36).slice(2, 5).toUpperCase(), deviceMode: 'mobile' });
      setBusy('Downloading your store…');
      await pullUntilQuiet(40, (i) => setBusy(`Downloading your store… (${(i + 1) * 1000}+ records)`));
      // The local database was emptied and filled again under this screen: start the app afresh on it.
      setTimeout(() => window.location.reload(), 300);
      return;
    } catch (e) { setErr(e.message || 'Could not connect.'); }
    setBusy('');
  };
  const paste = async () => {
    try { const t = await navigator.clipboard.readText(); setCode(t); if (t.includes('DFR1.')) go(t); }
    catch { setErr('Long-press the box and choose Paste.'); }
  };
  const fromPhoto = async e => {
    const f = e.target.files?.[0]; if (!f) return;
    try {
      const c = await photoToCanvas(f, 1600);
      const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
      const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
      if (!qr?.data) throw new Error('No QR code found in that photo. Take it straight and close.');
      setCode(qr.data); go(qr.data);
    } catch (er) { setErr(er.message); }
  };
  return (
    <div className="connect"><div className="connect-box">
      <div className="row gap-s"><div className="brand-mark">DF</div><div><div className="brand-name">DataFlow Retail</div><div className="muted small">Phone app — everything except billing</div></div></div>
      <h1>Connect to your store</h1>
      <ol>
        <li>On the main counter open <b>Settings › Cloud sync › Phone app</b>.</li>
        <li>Share the code on WhatsApp to this phone and copy it — or take a photo of the QR.</li>
        <li>Paste it below. Your products, bills, customers and users download here.</li>
      </ol>
      <textarea className="input" rows={3} value={code} onChange={e => setCode(e.target.value)} placeholder="DFR1.…" aria-label="Setup code" />
      <div className="row gap-s wrap">
        <button className="btn btn-primary" disabled={!!busy || !code.trim()} onClick={() => go(code)}>Connect</button>
        <button className="btn" disabled={!!busy} onClick={paste}>Paste</button>
        <label className="btn">Photo of QR<input type="file" accept="image/*" capture="environment" hidden onChange={fromPhoto} /></label>
      </div>
      {busy && <p className="small">{busy}</p>}
      {err && <p className="err">{err}</p>}
    </div></div>
  );
}

// After connecting: wait until the store's users (PINs) have arrived, then the PIN screen opens.
export function Downloading() {
  const counts = useLive(async () => ({ users: await db.users.count(), products: await db.products.count(), sales: await db.sales.count() }), [], null);
  const [busy, setBusy] = useState(false);
  const retry = async () => { setBusy(true); await syncOnce(); await pullUntilQuiet(40); setBusy(false); };
  return (
    <div className="connect"><div className="connect-box">
      <h1>Downloading your store…</h1>
      {counts && <p className="small">{counts.products} products · {counts.sales} bills · {counts.users} users so far</p>}
      {counts && counts.products > 0 && counts.users === 0 && <p className="note note-warn small">Products arrived but no users yet. On the main counter open <b>Settings › Cloud sync › Phone app</b> once — it shares the users and store settings. Then tap Check again.</p>}
      <button className="btn btn-primary" disabled={busy} onClick={retry}>{busy ? 'Checking…' : 'Check again'}</button>
    </div></div>
  );
}
