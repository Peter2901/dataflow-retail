// Smart features worked out with plain code from the store's own data (free, offline):
// dead stock, expiry clearance, festival planning, staff alerts, customer habits,
// udhaar recovery, daily summary, morning to-do and the weekly report.
import { db, getSettings } from '../db.js';
import { dueDates, daysTo, monthKey, monthLabel, DEFAULT_RULES } from './gst.js';
import { r2, sum, groupBy, daysBetween, localISO, addDays } from './util.js';
import { stockMap, daysLeft, DEFAULT_EXPIRY } from './stock.js';
import { customerAgeing, partyBalances } from './parties.js';
import { reorderSuggestions } from './purchasing.js';
import { lastDays, daySumsBetween, combine } from './daysums.js';

const DAY = 864e5;
const sg = s => (s.type === 'return' ? -1 : 1);
const productMap = async () => Object.fromEntries((await db.products.toArray()).map(p => [p.id, p]));
const marginPct = p => { const tx = p.price / (1 + (p.gst || 0) / 100); return tx > 0 && p.cost > 0 ? (tx - p.cost) / tx : 0; };

/** Qty sold per product per day over the last `days` (returns subtracted). Read from the day totals. */
export async function salesSpeed(storeId, days = 30) {
  const { items } = combine(await lastDays(storeId, days));
  const daily = {}, last = {};
  for (const [pid, v] of Object.entries(items)) { daily[pid] = Math.max(0, v[0]) / days; if (v[3]) last[pid] = v[3]; }
  return { daily, last };
}

// ───────────── Dead stock
export async function deadStock(storeId, days = 60) {
  const pm = await productMap();
  const stock = await stockMap(storeId);
  const { items } = combine(await lastDays(storeId, days));
  const sold = new Set(Object.entries(items).filter(([, v]) => v[2] > 0).map(([pid]) => pid));
  const sp30 = await salesSpeed(storeId, 30);
  const batches = (await db.batches.where('storeId').equals(storeId).toArray()).filter(b => b.status === 'active' && b.qty > 0);
  const oldest = {};
  batches.forEach(b => { oldest[b.productId] = Math.min(oldest[b.productId] || Infinity, b.receivedAt || Date.now()); });
  const suppliers = Object.fromEntries((await db.suppliers.toArray()).map(s => [s.id, s]));
  // Best seller per category, for combo ideas.
  const bestIn = {};
  Object.entries(sp30.daily).forEach(([id, d]) => { const p = pm[id]; if (!p) return; const c = p.category || 'Other'; if (!bestIn[c] || d > bestIn[c].d) bestIn[c] = { p, d }; });
  const out = [];
  for (const [id, qty] of Object.entries(stock)) {
    const p = pm[id];
    if (!p || p.active === false || qty <= 0 || sold.has(id)) continue;
    const age = oldest[id] ? Math.round((Date.now() - oldest[id]) / DAY) : days;
    if (age < days) continue;                       // arrived recently: give it time
    const value = r2(qty * (p.cost || 0));
    const m = marginPct(p);
    const ideas = [];
    const sup = suppliers[p.vendorId];
    if (sup?.returnDays) ideas.push(`Ask ${sup.name} to take it back or swap it.`);
    const best = bestIn[p.category || 'Other'];
    if (best && best.p.id !== id) ideas.push(`Combo with ${best.p.name} (sells ${r2(best.d)}/day).`);
    const pct = Math.max(5, Math.min(25, Math.floor((m * 100 - 3) / 5) * 5));
    if (m > 0.08) ideas.push(`${pct}% off still keeps a profit (margin ${Math.round(m * 100)}%).`);
    else ideas.push('Margin is thin: move it to the front shelf / billing counter instead of a discount.');
    out.push({ product: p, qty, value, days: age, ideas, discount: m > 0.08 ? pct : 0 });
  }
  return out.sort((a, b) => b.value - a.value);
}

// ───────────── Expiry clearance plan
/** For every batch that will not sell before expiry: discount, return to supplier, or write off — whichever loses least. */
export async function clearancePlan(storeId, cfg = DEFAULT_EXPIRY) {
  const pm = await productMap();
  const { daily } = await salesSpeed(storeId, 30);
  const suppliers = Object.fromEntries((await db.suppliers.toArray()).map(s => [s.id, s]));
  const batches = (await db.batches.where('storeId').equals(storeId).toArray()).filter(b => b.status === 'active' && b.qty > 0 && b.expiry);
  const byProduct = groupBy(batches, b => b.productId);
  const out = [];
  for (const [pid, bs] of Object.entries(byProduct)) {
    const p = pm[pid]; if (!p) continue;
    let sellable = 0;
    for (const b of bs.sort((x, y) => String(x.expiry).localeCompare(String(y.expiry)))) {   // FEFO: older batch sells first
      const dl = daysLeft(b.expiry);
      if (dl > 90) { sellable += b.qty; continue; }
      const d = daily[pid] || 0;
      const willSell = Math.max(0, Math.min(b.qty, d * Math.max(0, dl) - sellable));
      sellable += willSell;
      const unsold = r2(b.qty - willSell);
      if (dl < 0) { out.push({ product: p, batch: b, dl, unsold: b.qty, action: 'writeoff', text: 'Expired: take it off the shelf and write it off (or return if the supplier accepts expired stock).', loss: r2(b.qty * b.cost), saves: 0 }); continue; }
      if (unsold <= 0.5) continue;
      const sup = suppliers[p.vendorId];
      const returnBy = sup?.returnDays ? localISO(addDays(new Date(b.expiry), -sup.returnDays)) : null;
      const canReturn = !!returnBy && daysBetween(new Date(), new Date(returnBy)) >= 0;
      const lossIfNothing = r2(unsold * b.cost);
      // Discount needed: the closer the expiry, the deeper — but a price above cost when there is time.
      const pct = dl <= 7 ? 40 : dl <= 15 ? 30 : dl <= 30 ? 20 : dl <= 60 ? 10 : 5;
      const taxable = p.price / (1 + (p.gst || 0) / 100);
      const netAfter = taxable * (1 - pct / 100);
      const lossWithDiscount = r2(unsold * Math.max(0, b.cost - netAfter));
      if (canReturn && (lossWithDiscount > 0 || dl <= 30)) {
        out.push({ product: p, batch: b, dl, unsold, action: 'return', returnBy, supplier: sup, text: `Return ${unsold} to ${sup.name} by ${returnBy} — you get the cost back (₹${Math.round(unsold * b.cost)}).`, loss: 0, saves: lossIfNothing });
      } else {
        out.push({ product: p, batch: b, dl, unsold, action: 'discount', pct, text: `${pct}% off this week. At ~${r2(daily[pid] || 0)}/day, about ${unsold} would otherwise be left at expiry.${lossWithDiscount > 0 ? ` Below cost, but loses ₹${Math.round(lossWithDiscount)} instead of ₹${Math.round(lossIfNothing)}.` : ''}`, loss: lossWithDiscount, saves: r2(lossIfNothing - lossWithDiscount) });
      }
    }
  }
  return out.sort((a, b) => b.saves - a.saves || a.dl - b.dl);
}

// ───────────── Festival planning
// Dates checked from published 2025–2027 calendars. The owner can add or correct dates.
export const FESTIVALS = [
  { id: 'sankranti', name: 'Makar Sankranti', region: 'all', dates: { 2025: '2025-01-14', 2026: '2026-01-14', 2027: '2027-01-15' }, keys: ['til', 'sesame', 'jaggery', 'gud', 'chikki', 'peanut', 'groundnut', 'rice', 'kite'] },
  { id: 'holi', name: 'Holi', region: 'all', dates: { 2025: '2025-03-14', 2026: '2026-03-04', 2027: '2027-03-22' }, keys: ['colour', 'color', 'gulal', 'sweet', 'namkeen', 'chips', 'papad', 'soft drink', 'cold drink', 'juice', 'maida', 'sugar', 'khoya', 'ghee'] },
  { id: 'eid', name: 'Eid al-Fitr', region: 'all', dates: { 2025: '2025-03-31', 2026: '2026-03-21', 2027: '2027-03-10' }, keys: ['sewai', 'vermicelli', 'dates', 'khajur', 'dry fruit', 'cashew', 'kaju', 'almond', 'badam', 'milk', 'sugar', 'ghee', 'basmati'] },
  { id: 'raja', name: 'Raja Parba', region: 'OD', dates: { 2025: '2025-06-15', 2026: '2026-06-15', 2027: '2027-06-15' }, keys: ['rice flour', 'jaggery', 'gud', 'coconut', 'sweet', 'sugar', 'ghee', 'oil', 'betel', 'paan'] },
  { id: 'rathyatra', name: 'Rath Yatra', region: 'OD', dates: { 2025: '2025-06-27', 2026: '2026-07-16', 2027: '2027-07-05' }, keys: ['coconut', 'sugar', 'ghee', 'sweet', 'rice', 'agarbatti', 'camphor', 'incense'] },
  { id: 'rakhi', name: 'Raksha Bandhan', region: 'all', dates: { 2025: '2025-08-09', 2026: '2026-08-28', 2027: '2027-08-17' }, keys: ['rakhi', 'sweet', 'chocolate', 'dry fruit', 'cashew', 'kaju', 'gift'] },
  { id: 'janmashtami', name: 'Janmashtami', region: 'all', dates: { 2025: '2025-08-16', 2026: '2026-09-04', 2027: '2027-08-25' }, keys: ['butter', 'makhan', 'curd', 'milk', 'sugar', 'dry fruit', 'ghee', 'sweet'] },
  { id: 'ganesh', name: 'Ganesh Chaturthi', region: 'all', dates: { 2025: '2025-08-27', 2026: '2026-09-14', 2027: '2027-09-04' }, keys: ['modak', 'coconut', 'jaggery', 'rice flour', 'ghee', 'sweet', 'agarbatti', 'camphor'] },
  { id: 'nuakhai', name: 'Nuakhai', region: 'OD', dates: { 2025: '2025-08-28', 2026: '2026-09-15', 2027: '2027-09-05' }, keys: ['rice', 'chuda', 'poha', 'jaggery', 'gud', 'coconut', 'milk', 'ghee', 'sugar', 'sweet'] },
  { id: 'navratri', name: 'Navratri / Durga Puja', region: 'all', dates: { 2025: '2025-09-22', 2026: '2026-10-11', 2027: '2027-09-30' }, keys: ['sabudana', 'kuttu', 'singhara', 'rajgira', 'sendha', 'rock salt', 'makhana', 'peanut', 'groundnut', 'ghee', 'sugar', 'coconut', 'agarbatti', 'camphor', 'incense'] },
  { id: 'diwali', name: 'Diwali', region: 'all', dates: { 2025: '2025-10-20', 2026: '2026-11-08', 2027: '2027-10-29' }, keys: ['dry fruit', 'kaju', 'cashew', 'almond', 'badam', 'raisin', 'kishmish', 'ghee', 'sweet', 'sugar', 'besan', 'maida', 'oil', 'candle', 'diya', 'agarbatti', 'chocolate', 'namkeen', 'gift'] },
  { id: 'chhath', name: 'Chhath Puja', region: 'all', dates: { 2025: '2025-10-27', 2026: '2026-11-15', 2027: '2027-11-04' }, keys: ['sugarcane', 'banana', 'coconut', 'jaggery', 'gud', 'wheat', 'atta', 'ghee', 'rice', 'fruit'] },
  { id: 'kartik', name: 'Kartik Purnima / Boita Bandana', region: 'OD', dates: { 2025: '2025-11-05', 2026: '2026-11-24', 2027: '2027-11-14' }, keys: ['banana', 'coconut', 'sweet', 'ghee', 'camphor', 'diya', 'candle'] },
  { id: 'christmas', name: 'Christmas', region: 'all', dates: { 2025: '2025-12-25', 2026: '2026-12-25', 2027: '2027-12-25' }, keys: ['cake', 'plum', 'chocolate', 'cookie', 'biscuit', 'candle'] },
];
const REGION_OF_STATE = { 21: 'OD', 24: 'GJ' };

export async function festivalList() {
  const s = await getSettings();
  const extra = s.festivals || [];                    // owner's own / corrected dates: [{ id, name, date, keys }]
  const region = REGION_OF_STATE[Number(s.stateCode)] || '';
  const base = FESTIVALS.filter(f => f.region === 'all' || f.region === region).map(f => ({ ...f }));
  for (const e of extra) {
    const f = base.find(x => x.id === e.id);
    if (f) f.dates = { ...f.dates, [e.date.slice(0, 4)]: e.date };
    else base.push({ id: e.id, name: e.name, region: 'own', dates: { [e.date.slice(0, 4)]: e.date }, keys: e.keys || [] });
  }
  return base;
}

/** Festivals in the next `ahead` days, with what to stock, from last year's sales (or the festival's usual items). */
export async function festivalPlan(storeId, ahead = 45) {
  const fests = await festivalList();
  const pm = await productMap();
  const stock = await stockMap(storeId);
  const today = new Date();
  const year = today.getFullYear();
  const out = [];
  const { daily } = await salesSpeed(storeId, 30);
  for (const f of fests) {
    const next = [f.dates[year], f.dates[year + 1]].filter(Boolean).find(d => daysBetween(today, new Date(d)) >= -1);
    if (!next) continue;
    const inDays = daysBetween(today, new Date(next));
    if (inDays > ahead) continue;
    const lastYear = f.dates[Number(next.slice(0, 4)) - 1];
    const items = [];
    let basis = 'usual';
    if (lastYear) {
      // Last year's 10 days before the festival vs the 30 days before that — from the day totals.
      const end = new Date(lastYear).getTime() + DAY, start = end - 10 * DAY, baseStart = start - 30 * DAY;
      const qty = list => Object.fromEntries(Object.entries(combine(list).items).map(([pid, v]) => [pid, v[0]]));
      const span = await daySumsBetween(storeId, localISO(new Date(baseStart)), localISO(new Date(end - DAY)));
      const win = qty(span.filter(d => new Date(d.day + 'T12:00:00').getTime() >= start));
      const base = qty(span.filter(d => new Date(d.day + 'T12:00:00').getTime() < start));
      for (const [id, q] of Object.entries(win)) {
        const p = pm[id]; if (!p || q < 3) continue;
        const usual = ((base[id] || 0) / 30) * 10;
        const x = usual > 0 ? q / usual : 3;
        if (x < 1.4) continue;
        const need = Math.max(0, Math.ceil(q * 1.1 - (stock[id] || 0)));
        items.push({ product: p, lastYearQty: r2(q), times: r2(x), onHand: stock[id] || 0, order: need });
      }
      if (items.length) basis = 'lastyear';
    }
    if (!items.length) {
      const keys = (f.keys || []).map(k => k.toLowerCase());
      for (const p of Object.values(pm)) {
        if (p.active === false) continue;
        const n = `${p.name} ${p.category || ''}`.toLowerCase();
        if (!keys.some(k => n.includes(k))) continue;
        const d = daily[p.id] || 0;
        const need = Math.max(0, Math.ceil(d * 10 * 1.8 - (stock[p.id] || 0)));
        items.push({ product: p, lastYearQty: null, times: null, onHand: stock[p.id] || 0, order: need });
      }
    }
    out.push({ festival: f, date: next, inDays, basis, items: items.sort((a, b) => (b.order * b.product.cost) - (a.order * a.product.cost)) });
  }
  return out.sort((a, b) => a.inDays - b.inDays);
}

// ───────────── Staff: cashier alerts and cash shortfalls
const RISKY = { price_override: 'Price changed', bill_cancel: 'Bills cancelled', drawer_open: 'Drawer opened without a sale' };
export async function staffAlerts(storeId, days = 30) {
  const since = Date.now() - days * DAY;
  const { cashiers } = combine(await lastDays(storeId, days));
  const audits = (await db.audit.where('ts').above(since).toArray()).filter(a => RISKY[a.action]);
  const people = {};
  const P = n => (people[n] = people[n] || { name: n, bills: 0, returns: 0, returnValue: 0, risky: {} });
  Object.entries(cashiers).forEach(([who, v]) => { const p = P(who); p.bills += v[0]; p.returns += v[1]; p.returnValue = r2(p.returnValue + v[2]); });
  audits.forEach(a => { const p = P(a.userName || 'Unknown'); p.risky[a.action] = (p.risky[a.action] || 0) + 1; });
  const list = Object.values(people);
  const totalBills = sum(list, p => p.bills) || 1;
  const avg = k => (k === 'returns' ? sum(list, p => p.returns) : sum(list, p => p.risky[k] || 0)) / totalBills;
  const alerts = [];
  for (const p of list) {
    const per = n => (p.bills ? n / p.bills : n);
    for (const k of [...Object.keys(RISKY), 'returns']) {
      const n = k === 'returns' ? p.returns : (p.risky[k] || 0);
      const a = avg(k);
      if (n >= 3 && (a === 0 || per(n) >= 2 * a)) alerts.push({ person: p.name, kind: k === 'returns' ? 'Returns' : RISKY[k], count: n, bills: p.bills, text: `${p.name}: ${n} × ${(k === 'returns' ? 'returns' : RISKY[k]).toLowerCase()} in ${days} days on ${p.bills} bills — ${a ? `${r2(per(n) / a)}× the store average` : 'others have none'}.` });
    }
  }
  // Cash short at shift close, again and again for the same person or counter.
  const shifts = (await db.shifts.toArray()).filter(s => s.closedAt && s.closedAt >= Date.now() - 14 * DAY && s.storeId === storeId);
  const shortBy = groupBy(shifts.filter(s => (s.variance || 0) < -50), s => `${s.userName || s.userId} · ${s.counter || s._oc || ''}`);
  for (const [who, list2] of Object.entries(shortBy)) {
    const total = r2(sum(list2, s => -s.variance));
    if (list2.length >= 3 || total >= 500) alerts.push({ person: who, kind: 'Cash short', count: list2.length, text: `${who}: cash short on ${list2.length} shift(s) in 14 days, ₹${Math.round(total)} in total.` });
  }
  return { people: list.sort((a, b) => b.bills - a.bills), alerts };
}

// ───────────── Customers: not seen lately, monthly ration
export async function customerHabits(storeId) {
  // Per customer: the days they came, what they spent, which items on which days — from the day totals.
  const per = {};
  for (const d of await lastDays(storeId, 200)) {
    for (const [cid, v] of Object.entries(d.custs)) { const x = (per[cid] ||= { days: [], spend: 0, items: {} }); x.days.push(d.day); x.spend += v[1]; }
    for (const [cid, pids] of Object.entries(d.custItems || {})) { const x = (per[cid] ||= { days: [], spend: 0, items: {} }); pids.forEach(pid => (x.items[pid] ||= new Set()).add(d.day)); }
  }
  const ids = Object.keys(per);
  const cm = Object.fromEntries((await db.customers.bulkGet(ids)).filter(Boolean).map(c => [c.id, c]));
  const pm = await productMap();
  const notSeen = [], ration = [];
  for (const [cid, info] of Object.entries(per)) {
    const c = cm[cid]; if (!c) continue;
    const days = [...new Set(info.days)].sort();
    if (days.length >= 3) {
      const gaps = days.slice(1).map((d, i) => daysBetween(new Date(days[i]), new Date(d)));
      const avgGap = sum(gaps) / gaps.length;
      const since = daysBetween(new Date(days[days.length - 1]), new Date());
      if (since > Math.max(14, 2 * avgGap) && since < 180) notSeen.push({ customer: c, avgGap: Math.round(avgGap), since, spend: r2(info.spend), visits: days.length });
    }
    // Same item bought on 3+ different days → its usual interval.
    const byItem = info.items;
    const due = [];
    for (const [pid, set] of Object.entries(byItem)) {
      const d = [...set].sort();
      if (d.length < 3) continue;
      const gaps = d.slice(1).map((x, i) => daysBetween(new Date(d[i]), new Date(x)));
      const every = sum(gaps) / gaps.length;
      if (every < 6) continue;
      const nextDue = addDays(new Date(d[d.length - 1]), Math.round(every));
      const until = daysBetween(new Date(), nextDue);
      if (until <= 2 && until >= -7 && pm[pid]) due.push({ product: pm[pid], every: Math.round(every), until });
    }
    if (due.length) ration.push({ customer: c, items: due });
  }
  return { notSeen: notSeen.sort((a, b) => b.spend - a.spend), ration };
}

// ───────────── Udhaar recovery
export async function udhaarPlan() {
  const ageing = await customerAgeing();
  const cm = Object.fromEntries((await db.customers.bulkGet(Object.keys(ageing))).filter(Boolean).map(c => [c.id, c]));
  const reminders = await db.audit.where('action').anyOf('udhaar_reminder', 'reminder').toArray();
  const out = [];
  for (const [cid, a] of Object.entries(ageing)) {
    const c = cm[cid]; if (!c) continue;
    const mine = reminders.filter(r => r.detail?.customerId === cid || r.detail?.customer === c.name).sort((x, y) => y.ts - x.ts);
    const age = a.oldest ? daysBetween(new Date(a.oldest), new Date()) : 0;
    const sinceLast = mine[0] ? daysBetween(new Date(mine[0].ts), new Date()) : null;
    let level = 'polite', next = 'Send a polite reminder';
    if (mine.length >= 2 && age > 30) { level = 'call'; next = 'Call them — two reminders already sent'; }
    else if (mine.length >= 1 && (sinceLast ?? 99) >= 7) { level = 'firm'; next = 'Send a firm reminder'; }
    else if (mine.length >= 1) { level = 'wait'; next = `Reminded ${sinceLast} day(s) ago — wait`; }
    out.push({ customer: c, due: a.due, age, reminders: mine.length, sinceLast, level, next, priority: r2(a.due * (1 + age / 30)) });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

// ───────────── Daily summary
export async function dailySummary(storeId, at = new Date()) {
  const start = new Date(at); start.setHours(0, 0, 0, 0);
  const cut = at.getTime() - start.getTime();                       // compare up to the same time of day
  const lwStart = start.getTime() - 7 * DAY;
  // Only today's bills and the same day last week (not the 6 days between).
  const day = async t0 => (await db.sales.where('ts').between(t0, t0 + cut + 1, true, true).toArray()).filter(s => s.storeId === storeId && s.status !== 'void');
  const all = [...await day(lwStart), ...await day(start.getTime())];
  const pm = await productMap();
  const pick = (from, to) => all.filter(s => s.ts >= from && s.ts < to);
  const today = pick(start.getTime(), start.getTime() + cut + 1);
  const lw = pick(lwStart, lwStart + cut + 1);
  const total = ss => r2(sum(ss, s => sg(s) * s.totals.payable));
  const byCat = ss => { const m = {}; ss.forEach(s => s.lines.forEach(l => { const c = pm[l.productId]?.category || 'Other'; m[c] = r2((m[c] || 0) + sg(s) * l.total); })); return m; };
  const a = byCat(today), b = byCat(lw);
  const moves = [...new Set([...Object.keys(a), ...Object.keys(b)])].map(c => ({ cat: c, diff: r2((a[c] || 0) - (b[c] || 0)) })).filter(m => Math.abs(m.diff) >= 200).sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
  const profit = r2(sum(today, s => sg(s) * sum(s.lines, l => l.taxable - l.qty * (l.cost || 0))));
  return { today: total(today), lastWeek: total(lw), bills: today.filter(s => s.type === 'sale').length, lastWeekBills: lw.filter(s => s.type === 'sale').length, profit, moves };
}

// ───────────── Weekly report
export async function weeklyReport(storeId) {
  // Last 7 days (today included) vs the 7 before, from the day totals.
  const days = await lastDays(storeId, 14);
  const pm = await productMap();
  const wk = combine(days.slice(7)), prev = combine(days.slice(0, 7));
  const top = Object.entries(wk.items).map(([pid, v]) => ({ name: pm[pid]?.name || pid, qty: v[0], sales: r2(v[1]) })).sort((a, b) => b.sales - a.sales).slice(0, 5);
  const cats = {};
  Object.entries(wk.items).forEach(([pid, v]) => { const c = pm[pid]?.category || 'Other'; cats[c] = r2((cats[c] || 0) + v[1]); });
  const dues = r2(sum(Object.values(await partyBalances('cust')).filter(v => v > 0)));
  const dead = await deadStock(storeId);
  return { sales: wk.total, prevSales: prev.total, profit: wk.profit, bills: wk.bills, top, cats: Object.entries(cats).sort((a, b) => b[1] - a[1]), dues, deadValue: r2(sum(dead, d => d.value)), deadCount: dead.length };
}

export function weeklyText(w, storeName) {
  const ch = w.prevSales ? Math.round(((w.sales - w.prevSales) / w.prevSales) * 100) : null;
  const inr = v => '₹' + Math.round(v).toLocaleString('en-IN');
  return [`*${storeName} — last 7 days*`, `Sales ${inr(w.sales)}${ch !== null ? ` (${ch >= 0 ? '+' : ''}${ch}% vs the week before)` : ''} · ${w.bills} bills · profit ~${inr(w.profit)}`, '',
    '*Best sellers*', ...w.top.map((t, i) => `${i + 1}. ${t.name} — ${inr(t.sales)}`), '',
    '*By category*', ...w.cats.slice(0, 5).map(([c, v]) => `• ${c}: ${inr(v)}`), '',
    `Udhaar to collect: ${inr(w.dues)}`, `Not selling (60+ days): ${w.deadCount} items, ${inr(w.deadValue)} stuck`].join('\n');
}

// ───────────── Morning to-do: everything that needs doing, biggest money first
export async function morningTodo(storeId) {
  const s = await getSettings();
  const cfg = s.expiry || DEFAULT_EXPIRY;
  const todo = [];
  const sm = Object.fromEntries((await db.suppliers.toArray()).map(x => [x.id, x]));
  const pm = await productMap();
  const reorder = (await reorderSuggestions(storeId, cfg)).filter(x => !x.hasOpenPO && !x.nearExpiry);
  for (const [sid, list] of Object.entries(groupBy(reorder, x => x.supplierId || 'none'))) {
    const lost = r2(sum(list, x => x.daily * (sm[sid]?.leadDays || 3) * (x.product.price || 0)));
    todo.push({ page: 'purchases', param: { tab: 'po' }, money: lost, text: `Order ${list.length} item(s) from ${sm[sid]?.name || 'a supplier'} — running low.` });
  }
  const clear = await clearancePlan(storeId, cfg);
  const ret = clear.filter(c => c.action === 'return'), disc = clear.filter(c => c.action === 'discount'), expd = clear.filter(c => c.action === 'writeoff');
  if (ret.length) todo.push({ page: 'smart', param: { tab: 'expiry' }, money: r2(sum(ret, c => c.saves)), text: `Return ${ret.length} near-expiry batch(es) to suppliers before the deadline.` });
  if (disc.length) todo.push({ page: 'smart', param: { tab: 'expiry' }, money: r2(sum(disc, c => c.saves)), text: `Put a discount on ${disc.length} item(s) that will not sell before expiry.` });
  if (expd.length) todo.push({ page: 'expiry', money: r2(sum(expd, c => c.loss)), text: `${expd.length} expired batch(es) still on the shelf — remove them today.` });
  const ud = (await udhaarPlan()).filter(u => u.level !== 'wait');
  if (ud.length) todo.push({ page: 'smart', param: { tab: 'udhaar' }, money: r2(sum(ud.slice(0, 5), u => u.due)), text: `Collect udhaar: ${ud.slice(0, 3).map(u => u.customer.name).join(', ')}${ud.length > 3 ? ` and ${ud.length - 3} more` : ''}.` });
  const dueBills = (await db.purchases.toArray()).filter(p => p.total - (p.paid || 0) > 0.5 && p.dueDate && daysBetween(new Date(), new Date(p.dueDate)) <= 3);
  if (dueBills.length) todo.push({ page: 'purchases', param: { tab: 'suppliers' }, money: r2(sum(dueBills, p => p.total - (p.paid || 0))), text: `${dueBills.length} supplier bill(s) due within 3 days.` });
  const fest = (await festivalPlan(storeId, 25)).filter(f => f.items.some(i => i.order > 0));
  for (const f of fest.slice(0, 2)) todo.push({ page: 'smart', param: { tab: 'festivals' }, money: r2(sum(f.items, i => i.order * (i.product.price || 0))), text: `${f.festival.name} in ${f.inDays} day(s): stock up on ${f.items.filter(i => i.order > 0).length} item(s).` });
  const staff = await staffAlerts(storeId);
  if (staff.alerts.length) todo.push({ page: 'smart', param: { tab: 'staff' }, money: 1000, text: `${staff.alerts.length} staff alert(s) to look at.` });
  // Backups: the Windows app makes one a day; elsewhere remind after 3 days (not on phones — the counter has the data).
  if (s.deviceMode !== 'mobile') {
    const age = s.backupAt ? Math.floor((Date.now() - s.backupAt) / 864e5) : null;
    if (age == null || age >= 3) todo.push({ page: 'setup', param: { tab: 'backup' }, money: 2000, text: age == null ? 'No backup made on this computer yet — download one (Import & setup › Backup).' : `Last backup was ${age} days ago — download a fresh one.` });
  }
  // GST due dates from GST Saathi's rule book; filed returns drop off the list.
  const lm = new Date(); lm.setDate(1); lm.setMonth(lm.getMonth() - 1);
  const key = monthKey(lm);
  for (const x of dueDates(key, { qrmp: !!s.gstFiling?.qrmp, stateCode: s.stateCode, rules: s.gstRules || DEFAULT_RULES })) {
    const n = daysTo(x.date);
    if (s.gstFiled?.[key]?.[x.id] || n > 5 || x.id === 'iff' || x.id === 'gstr9') continue;
    todo.push({ page: 'gst', money: n < 0 ? 5000 : 900, text: n < 0 ? `${x.label} for ${monthLabel(key)} is ${-n} day(s) late — file now to stop the late fee.` : `${x.label} for ${monthLabel(key)} is due ${n === 0 ? 'today' : `in ${n} day(s)`}.` });
  }
  void pm;
  return todo.sort((a, b) => b.money - a.money);
}
