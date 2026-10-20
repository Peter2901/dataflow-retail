// Old paper credit book (khata) → customer dues. Free reading first; AI for handwriting.
// Every row is shown for checking before anything is saved.
import { db } from '../db.js';
import { uid } from './util.js';
import { post, partyAccount } from './accounts.js';
import { audit } from './sales.js';
import { ocrCanvas } from './billreader.js';
import { askAI, aiOn, photoToCanvas, canvasJpeg } from './smartai.js';

/** "Ramesh Kumar 9876543210 1,250" / "Sita Devi ₹450" → rows */
export function parseKhataText(text) {
  const rows = [];
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
    const m = l.match(/^(?:\d{1,3}[.)]?\s+)?([A-Za-zऀ-ॿ଀-୿][A-Za-zऀ-ॿ଀-୿ .']{1,40}?)\s+(?:(\d{10})\s+)?(?:rs\.?|₹|=|-)?\s*(\d{1,3}(?:,\d{2,3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:\/-)?$/i);
    if (!m) continue;
    if (/^(total|grand total|jama|jodh|kul|कुल|योग|ମୋଟ|balance|page)\b/i.test(m[1].trim())) continue;
    const amount = Number(m[3].replace(/,/g, ''));
    if (!(amount > 0) || amount > 500000) continue;
    rows.push({ name: m[1].trim(), phone: m[2] || '', amount });
  }
  return rows;
}

export async function readKhataPhoto(file, { forceAI = false, onStep = () => {} } = {}) {
  let rows = [];
  let method = 'free';
  if (!forceAI) {
    onStep('Reading the page on this device…');
    const text = await ocrCanvas(await photoToCanvas(file, 2400)).catch(() => '');
    rows = parseKhataText(text);
  }
  if ((forceAI || rows.length < 2) && await aiOn()) {
    onStep('Handwriting is hard — reading with AI…');
    const r = await askAI('khata', {}, [canvasJpeg(await photoToCanvas(file, 1600))]);
    rows = (r.data?.rows || []).filter(x => x.name && Number(x.amount) > 0).map(x => ({ name: String(x.name), phone: String(x.phone || '').replace(/\D/g, '').slice(-10), amount: Number(x.amount) }));
    method = 'ai';
  }
  return { rows, method };
}

/** Creates/links customers and posts their opening dues (same as the Excel balance import). */
export async function importCustomerDues(rows, user, ref = 'OPENING') {
  let n = 0;
  for (const r of rows) {
    const phone = String(r.phone || '').replace(/\D/g, '').slice(-10);
    let c = phone ? await db.customers.where('phone').equals(phone).first() : null;
    if (!c) c = (await db.customers.toArray()).find(x => x.name.trim().toLowerCase() === String(r.name).trim().toLowerCase()) || null;
    if (!c) {
      c = { id: uid('c_'), name: r.name, phone: phone || '0000000000', yearSpend: 0, lifeSpend: 0, points: 0, visits: 0, creditLimit: Math.max(2000, r.amount), gstin: '', consentWhatsApp: !!phone, createdAt: Date.now() };
      await db.customers.add(c);
    }
    if (r.amount > 0) { await post({ ref, type: 'opening', narration: `Opening due: ${c.name}`, lines: [{ acc: await partyAccount('cust', c), dr: r.amount }, { acc: 'capital', cr: r.amount }] }); n++; }
  }
  await audit('import_balances', { customers: rows.length, withDues: n, source: ref }, user);
  return n;
}
