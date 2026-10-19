// Shared helpers: money in paise, dates, ids, hashing, barcode checks.

export const uid = (p = '') => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Money is kept in rupees with 2 decimals; calculations go through paise to avoid float errors.
export const toPaise = r => Math.round((Number(r) || 0) * 100);
export const fromPaise = p => Math.round(p) / 100;
export const r2 = v => Math.round((Number(v) + Number.EPSILON) * 100) / 100;

export const inr = (v, dec = 2) =>
  '₹' + (Number(v) || 0).toLocaleString('en-IN', { minimumFractionDigits: dec, maximumFractionDigits: dec });
export const num = (v, dec = 0) => (Number(v) || 0).toLocaleString('en-IN', { maximumFractionDigits: dec, minimumFractionDigits: dec });

// Local (India) calendar date as YYYY-MM-DD. toISOString() alone would give the UTC date.
export const localISO = d => { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); };
export const todayISO = () => localISO(new Date());
export const dayStart = (d = new Date()) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
export const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const daysBetween = (a, b) => Math.round((dayStart(new Date(b)) - dayStart(new Date(a))) / 86400000);
export const fmtDate = ts => ts ? new Date(ts).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
export const fmtDT = ts => ts ? new Date(ts).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';

// Indian financial year: 1 April to 31 March.
export function fyOf(d = new Date()) {
  const x = new Date(d);
  const y = x.getMonth() >= 3 ? x.getFullYear() : x.getFullYear() - 1;
  return { start: new Date(y, 3, 1), end: new Date(y + 1, 2, 31, 23, 59, 59), short: String(y).slice(2) + String(y + 1).slice(2), label: `${y}-${String(y + 1).slice(2)}` };
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function hashPin(pin, salt = 'dfr') { return sha256(salt + ':' + pin); }

// EAN-13 / EAN-8 / UPC-A modulo-10 check digit.
export function validEAN(code) {
  const s = String(code || '').trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const check = digits.pop();
  let sum = 0;
  digits.reverse().forEach((d, i) => (sum += d * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10 === check;
}

export function eanCheckDigit(first12) {
  const d = String(first12).split('').map(Number).reverse();
  let sum = 0;
  d.forEach((x, i) => (sum += x * (i % 2 === 0 ? 3 : 1)));
  return (10 - (sum % 10)) % 10;
}

// GSTIN format + Mod-36 checksum.
export function validGSTIN(g) {
  const s = String(g || '').toUpperCase().trim();
  if (!/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(s)) return false;
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const v = chars.indexOf(s[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(v / 36) + (v % 36);
  }
  return chars[(36 - (sum % 36)) % 36] === s[14];
}

export const sum = (arr, f = x => x) => arr.reduce((a, b) => a + (Number(f(b)) || 0), 0);
export const groupBy = (arr, f) => arr.reduce((m, x) => { const k = f(x); (m[k] = m[k] || []).push(x); return m; }, {});

export function waLink(phone, text) {
  const p = String(phone || '').replace(/\D/g, '');
  const full = p.length === 10 ? '91' + p : p;
  return `https://wa.me/${full}?text=${encodeURIComponent(text)}`;
}

export function upiLink({ vpa, name, amount, note }) {
  const q = new URLSearchParams({ pa: vpa, pn: name, am: Number(amount).toFixed(2), cu: 'INR', tn: note || '' });
  return 'upi://pay?' + q.toString();
}

export const maskPhone = p => { const s = String(p || ''); return s.length >= 10 ? s.slice(0, 2) + '******' + s.slice(-2) : s; };

export function download(filename, data, mime = 'application/octet-stream') {
  // Standalone: a normal file download. Inside a claude.ai artifact, the page uses the downloads capability instead.
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  if (window.__dfrDownloads) return window.__dfrDownloads.save({ filename, data: blob }).catch(() => {});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export const inArtifact = () => { try { return window.self !== window.top; } catch { return true; } };
