import React, { useEffect, useRef, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, PageHead, Btn, Card } from '../ui/kit.jsx';
import { inr, r2, sum, groupBy, num, localISO } from '../lib/util.js';
import { stockMap, daysLeft } from '../lib/stock.js';
import { customerAgeing, partyBalances } from '../lib/parties.js';
import { askAI, aiOn } from '../lib/smartai.js';
import { smartSearch } from '../lib/search.js';
import { deadStock } from '../lib/insights.js';

// Tools the assistant can call. Each reads the store's own data in this browser.
function makeTools(storeId) {
  const salesIn = async (fromDays, toDays = 0) => {
    const a = Date.now() - fromDays * 864e5, b = Date.now() - toDays * 864e5;
    return (await db.sales.where('ts').between(a, b, true, true).toArray()).filter(s => s.storeId === storeId);
  };
  const sg = s => (s.type === 'return' ? -1 : 1);
  return [
    { name: 'sales_summary', description: 'Net sales, bills, profit and payment split for the last N days (1 = today so far). Returns totals.', inputSchema: { type: 'object', properties: { days: { type: 'number' } }, required: ['days'] },
      execute: async ({ days }) => { const ss = await salesIn(Number(days) || 1); const modes = {}; ss.forEach(s => s.payments.forEach(p => (modes[p.mode] = r2((modes[p.mode] || 0) + sg(s) * p.amount)))); return { netSales: r2(sum(ss, s => sg(s) * s.totals.payable)), bills: ss.filter(s => s.type === 'sale').length, profit: r2(sum(ss, s => sg(s) * sum(s.lines, l => l.taxable - l.qty * (l.cost || 0)))), byPayment: modes }; } },
    { name: 'top_items', description: 'Best-selling items over the last N days by sales value, with quantity and profit.', inputSchema: { type: 'object', properties: { days: { type: 'number' }, limit: { type: 'number' } } },
      execute: async ({ days = 7, limit = 10 }) => { const ss = await salesIn(Number(days)); const m = {}; ss.forEach(s => s.lines.forEach(l => { m[l.name] = m[l.name] || { item: l.name, qty: 0, sales: 0, profit: 0 }; m[l.name].qty += sg(s) * l.qty; m[l.name].sales = r2(m[l.name].sales + sg(s) * l.total); m[l.name].profit = r2(m[l.name].profit + sg(s) * (l.taxable - l.qty * (l.cost || 0))); })); return Object.values(m).sort((a, b) => b.sales - a.sales).slice(0, Number(limit)); } },
    { name: 'category_profit', description: 'Sales and profit by product category over the last N days.', inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
      execute: async ({ days = 30 }) => { const ss = await salesIn(Number(days)); const pm = Object.fromEntries((await db.products.toArray()).map(p => [p.id, p.category])); const lines = ss.flatMap(s => s.lines.map(l => ({ ...l, s: sg(s) }))); return Object.entries(groupBy(lines, l => pm[l.productId] || 'Other')).map(([c, ls]) => ({ category: c, sales: r2(sum(ls, l => l.s * l.total)), profit: r2(sum(ls, l => l.s * (l.taxable - l.qty * (l.cost || 0)))) })).sort((a, b) => b.profit - a.profit); } },
    { name: 'low_stock', description: 'Items at or below their reorder level, with on-hand quantity.',
      execute: async () => { const st = await stockMap(storeId); return (await db.products.toArray()).filter(p => (st[p.id] || 0) <= p.reorderMin).map(p => ({ item: p.name, onHand: st[p.id] || 0, reorderAt: p.reorderMin })); } },
    { name: 'expiring', description: 'Batches expiring within N days (negative days = already expired), with quantity and value at cost.', inputSchema: { type: 'object', properties: { days: { type: 'number' } } },
      execute: async ({ days = 30 }) => { const pm = Object.fromEntries((await db.products.toArray()).map(p => [p.id, p.name])); return (await db.batches.where('storeId').equals(storeId).toArray()).filter(b => b.status === 'active' && b.qty > 0 && b.expiry && daysLeft(b.expiry) <= Number(days)).map(b => ({ item: pm[b.productId], batch: b.batchNo, expiry: b.expiry, daysLeft: daysLeft(b.expiry), qty: b.qty, valueAtCost: r2(b.qty * b.cost) })); } },
    { name: 'customer_dues', description: 'Customers who owe money (credit/udhaar), with ageing buckets.',
      execute: async () => { const a = await customerAgeing(); const cm = Object.fromEntries((await db.customers.toArray()).map(c => [c.id, c.name])); return Object.entries(a).map(([id, x]) => ({ customer: cm[id], ...x })); } },
    { name: 'supplier_dues', description: 'Amount owed to each supplier and unpaid bills with due dates.',
      execute: async () => { const b = await partyBalances('supp'); const sm = Object.fromEntries((await db.suppliers.toArray()).map(s => [s.id, s.name])); const pur = (await db.purchases.toArray()).filter(p => p.total - (p.paid || 0) > 0.5).map(p => ({ supplier: sm[p.supplierId], bill: p.billNo, unpaid: r2(p.total - (p.paid || 0)), due: p.dueDate })); return { owed: Object.entries(b).map(([id, v]) => ({ supplier: sm[id], owed: -v })), unpaidBills: pur }; } },
    { name: 'dead_stock', description: 'Items with stock that did not sell in the last 60 days, and the money stuck in them.',
      execute: async () => (await deadStock(storeId)).map(d => ({ item: d.product.name, qty: d.qty, value: d.value, idea: d.ideas[0] })) },
    { name: 'gst_month', description: 'GST this month so far: tax collected on sales and GST paid on purchases (input credit), and the difference.',
      execute: async () => { const m0 = new Date(); m0.setDate(1); m0.setHours(0, 0, 0, 0); const ss = (await salesIn(Math.ceil((Date.now() - m0) / 864e5) + 0.01)).filter(s => s.ts >= m0.getTime()); const out = r2(sum(ss, s => sg(s) * (s.totals.cgst + s.totals.sgst + s.totals.igst))); const month = localISO(m0).slice(0, 7); const inp = r2(sum((await db.purchases.toArray()).filter(p => String(p.date).slice(0, 7) === month), p => p.tax)); return { outputTax: out, inputCredit: inp, toPay: r2(out - inp) }; } },
    { name: 'find_product', description: 'Look up a product by name or barcode: price, MRP, GST, HSN, stock, rack.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async ({ query }) => { const st = await stockMap(storeId); return smartSearch(String(query || ''), await db.products.toArray(), 5).map(p => ({ name: p.name, price: p.price, mrp: p.mrp, gst: p.gst, hsn: p.hsn, stock: st[p.id] || 0, rack: p.rack, cost: p.cost })); } },
  ];
}

const QUICK = [
  ['How are sales today?', 'sales_summary', { days: 1 }],
  ['What will run out soon?', 'low_stock', {}],
  ['What is expiring this week?', 'expiring', { days: 7 }],
  ['Who owes us money?', 'customer_dues', {}],
  ['Best sellers this week', 'top_items', { days: 7, limit: 8 }],
  ['Which category makes the most profit?', 'category_profit', { days: 30 }],
  ['What is not selling?', 'dead_stock', {}],
  ['GST this month', 'gst_month', {}],
  ['Supplier dues', 'supplier_dues', {}],
];

// Plain-language answers without AI (used when the AI is not connected).
function format(tool, data) {
  if (tool === 'sales_summary') return `Sales ${inr(data.netSales)} from ${data.bills} bills, estimated profit ${inr(data.profit)}.\n` + Object.entries(data.byPayment).map(([k, v]) => `${k.toUpperCase()} ${inr(v)}`).join(' · ');
  if (tool === 'low_stock') return data.length ? `${data.length} items are at or below reorder level:\n` + data.slice(0, 12).map(d => `• ${d.item}: ${num(d.onHand, 2)} left (reorder at ${d.reorderAt})`).join('\n') + '\n\nDraft the orders in Purchases › Orders to suppliers.' : 'Nothing is below its reorder level.';
  if (tool === 'expiring') return data.length ? data.sort((a, b) => a.daysLeft - b.daysLeft).map(d => `• ${d.item} (${d.batch}) — ${d.daysLeft < 0 ? 'EXPIRED' : d.daysLeft + ' days'} · ${num(d.qty, 2)} units · ${inr(d.valueAtCost)}`).join('\n') : 'Nothing expires in that time.';
  if (tool === 'customer_dues') return data.length ? data.sort((a, b) => b.due - a.due).map(d => `• ${d.customer}: ${inr(d.due)}${d.b90 ? ` (${inr(d.b90)} over 90 days)` : ''}`).join('\n') + '\n\nSend reminders from Credit & dues.' : 'No customer owes money.';
  if (tool === 'top_items') return data.map((d, i) => `${i + 1}. ${d.item} — ${inr(d.sales)} (${num(d.qty, 1)} sold, profit ${inr(d.profit)})`).join('\n');
  if (tool === 'category_profit') return data.map(d => `• ${d.category}: profit ${inr(d.profit)} on sales ${inr(d.sales)}`).join('\n');
  if (tool === 'supplier_dues') return data.unpaidBills.length ? `You owe suppliers:\n` + data.owed.filter(o => o.owed > 0.5).sort((a, b) => b.owed - a.owed).map(o => `• ${o.supplier}: ${inr(o.owed)}`).join('\n') + `\n\nNext due: ` + data.unpaidBills.sort((a, b) => String(a.due).localeCompare(String(b.due))).slice(0, 3).map(b => `${b.supplier} ${inr(b.unpaid)} on ${b.due}`).join(' · ') : 'You owe no supplier anything.';
  if (tool === 'dead_stock') return data.length ? `${data.length} items did not sell in 60 days (${inr(sum(data, d => d.value))} stuck):\n` + data.slice(0, 10).map(d => `• ${d.item}: ${num(d.qty, 2)} in stock, ${inr(d.value)} — ${d.idea}`).join('\n') + '\n\nMore in Smart insights › Expiry & dead stock.' : 'Everything in stock sold at least once in the last 60 days.';
  if (tool === 'gst_month') return `This month so far: GST collected on sales ${inr(data.outputTax)}, GST paid on purchase bills ${inr(data.inputCredit)}.\nRough GST to pay: ${inr(Math.max(0, data.toPay))}${data.toPay < 0 ? ` (credit of ${inr(-data.toPay)} carries forward)` : ''}.\nThis is a guide — your CA files the real return.`;
  if (tool === 'find_product') return data.length ? data.map(p => `• ${p.name}: price ${inr(p.price)} (MRP ${inr(p.mrp)}), GST ${p.gst}%, stock ${num(p.stock, 2)}${p.rack ? `, rack ${p.rack}` : ''}`).join('\n') : 'No product found with that name.';
  return JSON.stringify(data, null, 2);
}

// Plain-code understanding of a question (English, Hinglish, Hindi, Odia). AI is only asked when this fails.
const INTENTS = [
  ['supplier_dues', /(supplier|distributor|vendor|dena hai|देना है|kisko dena|payment due)/i],
  ['dead_stock', /(not selling|nahi bik|नहीं बिक|dead stock|slow moving|ବିକୁନି)/i],
  ['top_items', /(best|top|sabse zyada|सबसे ज़्यादा|सबसे ज्यादा|zyada bik|fast moving|ଅଧିକ ବିକ୍ରି)/i],
  ['category_profit', /(profit|munafa|मुनाफ़ा|मुनाफा|ଲାଭ|margin)/i],
  ['gst_month', /(\bgst\b|\btax\b|टैक्स|जीएसटी)/i],
  ['low_stock', /(low stock|khatam|ख़त्म|खत्म|out of stock|run out|reorder|kam stock|कम स्टॉक|ଶେଷ|order karna)/i],
  ['expiring', /(expir|एक्सपायर|kharab|ମିଆଦ|date over)/i],
  ['customer_dues', /(udhaar|udhar|उधार|baki|बाकी|ବାକି|\bowe|dues|credit)/i],
  ['sales_summary', /(sale|sales|bikri|बिक्री|ବିକ୍ରି|kitna bika|revenue|collection|galla|गल्ला|business)/i],
  ['find_product', /(price|rate|daam|दाम|ଦାମ|stock of|kitna stock|how many|kitne)/i],
];
function daysIn(q) {
  const n = q.match(/(\d+)\s*(din|days?|दिन|ଦିନ)/i);
  if (n) return Number(n[1]);
  if (/(month|mahin|महीन|ମାସ)/i.test(q)) return 30;
  if (/(week|hafta|हफ्त|सप्ताह|ସପ୍ତାହ)/i.test(q)) return 7;
  return 1;
}
function understand(q) {
  const hit = INTENTS.find(([, re]) => re.test(q));
  if (!hit) return null;
  const id = hit[0];
  const days = daysIn(q);
  if (id === 'find_product') return [id, { query: q.replace(/(what is|the|of|price|rate|daam|दाम|ଦାମ|stock|kitna|kitne|how many|do we have|hai|है|kya|\?)/gi, ' ').replace(/\s+/g, ' ').trim() }];
  if (id === 'expiring') return [id, { days: days === 1 ? 7 : days }];
  if (id === 'top_items') return [id, { days: days === 1 ? 7 : days, limit: 8 }];
  if (id === 'category_profit') return [id, { days: days === 1 ? 30 : days }];
  return [id, { days }];
}

export default function Assistant() {
  const { storeId } = useApp();
  const ai = useLive(() => aiOn(), [], false);
  const [msgs, setMsgs] = useState([{ role: 'assistant', content: 'Ask me about sales, stock, expiry, dues or GST — in English, हिंदी or ଓଡ଼ିଆ. I read your store’s own data.' }]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const tools = useRef(makeTools(storeId));
  const end = useRef();
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs]);

  const ask = async (question, quick) => {
    if (!question.trim() || busy) return;
    setMsgs(m => [...m, { role: 'user', content: question }]);
    setQ(''); setBusy(true);
    try {
      let route = quick ? [quick[1], quick[2]] : understand(question);
      let viaAI = false;
      if (!route && ai) {
        // Code could not tell which report answers this: AI only picks the report; the numbers come from the app.
        setMsgs(m => [...m, { role: 'assistant', content: 'Thinking…' }]);
        const r = await askAI('route', { question, reports: tools.current.map(t => ({ id: t.name, about: t.description })) });
        const rep = r.data?.report;
        if (rep && rep !== 'none' && tools.current.some(t => t.name === rep)) { route = [rep, Object.fromEntries(Object.entries(r.data.params || {}).filter(([, v]) => v != null))]; viaAI = true; }
        setMsgs(m => m.filter(x => x.content !== 'Thinking…'));
      }
      const t = route ? tools.current.find(x => x.name === route[0]) : null;
      const ans = t ? format(route[0], await t.execute(route[1] || {})) + (viaAI ? '\n\n(Question understood with AI; numbers from your own data.)' : '')
        : `I could not match that to a report.${ai ? '' : ' (AI is off.)'} Try: sales today, best sellers this week, profit this month, what will run out, expiring this week, who owes us, supplier dues, not selling, GST this month, or “price of sugar”.`;
      setMsgs(m => [...m, { role: 'assistant', content: ans }]);
    } catch (e) {
      setMsgs(m => [...m.filter(x => x.content !== 'Thinking…'), { role: 'assistant', content: 'Something went wrong getting that answer: ' + (e.message || '') }]);
    }
    setBusy(false);
  };

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <PageHead title="Ask your shop" sub="Ask in English, Hindi, Hinglish or Odia. Answers always come from your own data; AI is only used to understand an unusual question." />
      <Card>
        <div className="chat" aria-live="polite">
          {msgs.map((m, i) => <div key={i} className={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>{m.content}</div>)}
          <div ref={end} />
        </div>
      </Card>
      <div className="chips">{QUICK.map(x => <button key={x[0]} className="chip" disabled={busy} onClick={() => ask(x[0], x)}>{x[0]}</button>)}</div>
      <form className="row gap-s" onSubmit={e => { e.preventDefault(); ask(q); }}>
        <input className="input grow" value={q} onChange={e => setQ(e.target.value)} placeholder="e.g. is hafte sabse zyada kya bika? · price of chini · who owes us"  aria-label="Question" id="ai-q" />
        <Btn kind="primary" type="submit" disabled={busy || !q.trim()}>Ask</Btn>
      </form>
      <p className="small muted">Billing never depends on the assistant — the counter works the same with or without it.</p>
    </div>
  );
}
