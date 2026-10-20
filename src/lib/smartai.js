// The app's single door to AI. Every smart feature tries plain code first and calls this only
// when code could not solve it. The AI runs in the store's own Supabase function "dataflow-ai"
// (the key stays in Supabase). Settings › AI & Smart Scan can turn it off: then the free code
// paths are all the store gets, and nothing breaks.
import { getSettings } from '../db.js';

export async function aiConfig() {
  const s = await getSettings();
  const ss = s.smartScan || {};
  return { url: (s.syncUrl || '').replace(/\/+$/, ''), key: s.syncKey || '', ai: ss.ai || 'off', scanKey: ss.scanKey || '', storeGstin: s.gstin || '', storeName: s.storeName || '' };
}

export const aiOn = async () => { const c = await aiConfig(); return c.ai !== 'off' && !!c.url && !!c.key; };

export class AIOff extends Error { constructor() { super('AI is off for this store (Settings › AI & Smart Scan).'); this.code = 'ai_off'; } }

function track(usage) {
  try {
    const m = new Date().toISOString().slice(0, 7);
    const u = JSON.parse(localStorage.getItem('dfr_ai_usage') || '{}');
    const cur = u.month === m ? u : { month: m, calls: 0, tokens: 0 };
    cur.calls++; cur.tokens += (usage?.input || 0) + (usage?.output || 0);
    localStorage.setItem('dfr_ai_usage', JSON.stringify(cur));
  } catch { /* ignore */ }
}
export function aiUsageThisMonth() {
  try { const u = JSON.parse(localStorage.getItem('dfr_ai_usage') || '{}'); return u.month === new Date().toISOString().slice(0, 7) ? u : { calls: 0, tokens: 0 }; } catch { return { calls: 0, tokens: 0 }; }
}

/** task: bill | pack | khata | voice | hsn | route. images: data URLs. Returns { data, usage, provider, model }. */
export async function askAI(task, payload = {}, images = [], conf = null) {
  const c = conf || await aiConfig();
  if (c.ai === 'off') throw new AIOff();
  if (!c.url || !c.key) throw new Error('AI needs the cloud set up first (Settings › Cloud sync).');
  const res = await fetch(`${c.url}/functions/v1/dataflow-ai`, {
    method: 'POST',
    headers: { apikey: c.key, Authorization: 'Bearer ' + c.key, 'Content-Type': 'application/json', ...(c.scanKey ? { 'x-scan-key': c.scanKey } : {}) },
    body: JSON.stringify({ task, images, storeGstin: c.storeGstin, ...payload }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || (res.status === 404 ? 'The AI function is not set up in Supabase yet (Settings › AI & Smart Scan).' : `AI failed (${res.status}).`));
  track(body.usage);
  return body;
}

/** Shrinks a photo for AI or OCR. */
export async function photoToCanvas(file, maxSide = 1600) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}
export const canvasJpeg = (c, q = 0.82) => c.toDataURL('image/jpeg', q);
