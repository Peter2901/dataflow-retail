import React, { useEffect, useRef, useState } from 'react';
import { db } from '../db.js';
import { useApp, useLive, PageHead, Btn, Card } from '../ui/kit.jsx';
import { inr, r2, sum, groupBy, num } from '../lib/util.js';
import { stockMap, daysLeft } from '../lib/stock.js';
import { customerAgeing, partyBalances } from '../lib/parties.js';
import { getSample, askAssistant } from '../lib/ai.js';

// Tools the assistant can call. Each reads the store's own data in this browser.
function makeTools(storeId) {
  const salesIn = async (fromDays, toDays = 0) => {
    const a = Date.now() - fromDays * 864e5, b = Date.now() - toDays * 864e5;
    return (await db.sales.where('storeId').equals(storeId).toArray()).filter(s => s.ts >= a && s.ts <= b);
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
    { name: 'find_product', description: 'Look up a product by name or barcode: price, MRP, GST, HSN, stock, rack.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      execute: async ({ query }) => { const q = String(query).toLowerCase(); const st = await stockMap(storeId); return (await db.products.toArray()).filter(p => p.name.toLowerCase().includes(q) || p.barcode === q).slice(0, 5).map(p => ({ name: p.name, price: p.price, mrp: p.mrp, gst: p.gst, hsn: p.hsn, stock: st[p.id] || 0, rack: p.rack, cost: p.cost })); } },
  ];
}

const QUICK = [
  ['How are sales today?', 'sales_summary', { days: 1 }],
  ['What will run out soon?', 'low_stock', {}],
  ['What is expiring this week?', 'expiring', { days: 7 }],
  ['Who owes us money?', 'customer_dues', {}],
  ['Best sellers this week', 'top_items', { days: 7, limit: 8 }],
  ['Which category makes the most profit?', 'category_profit', { days: 30 }],
];

// Plain-language answers without AI (used when the AI is not connected).
function format(tool, data) {
  if (tool === 'sales_summary') return `Sales ${inr(data.netSales)} from ${data.bills} bills, estimated profit ${inr(data.profit)}.\n` + Object.entries(data.byPayment).map(([k, v]) => `${k.toUpperCase()} ${inr(v)}`).join(' · ');
  if (tool === 'low_stock') return data.length ? `${data.length} items are at or below reorder level:\n` + data.slice(0, 12).map(d => `• ${d.item}: ${num(d.onHand, 2)} left (reorder at ${d.reorderAt})`).join('\n') + '\n\nDraft the orders in Purchases › Orders to suppliers.' : 'Nothing is below its reorder level.';
  if (tool === 'expiring') return data.length ? data.sort((a, b) => a.daysLeft - b.daysLeft).map(d => `• ${d.item} (${d.batch}) — ${d.daysLeft < 0 ? 'EXPIRED' : d.daysLeft + ' days'} · ${num(d.qty, 2)} units · ${inr(d.valueAtCost)}`).join('\n') : 'Nothing expires in that time.';
  if (tool === 'customer_dues') return data.length ? data.sort((a, b) => b.due - a.due).map(d => `• ${d.customer}: ${inr(d.due)}${d.b90 ? ` (${inr(d.b90)} over 90 days)` : ''}`).join('\n') + '\n\nSend reminders from Credit & dues.' : 'No customer owes money.';
  if (tool === 'top_items') return data.map((d, i) => `${i + 1}. ${d.item} — ${inr(d.sales)} (${num(d.qty, 1)} sold, profit ${inr(d.profit)})`).join('\n');
  if (tool === 'category_profit') return data.map(d => `• ${d.category}: profit ${inr(d.profit)} on sales ${inr(d.sales)}`).join('\n');
  return JSON.stringify(data, null, 2);
}

export default function Assistant() {
  const { storeId } = useApp();
  const ai = useLive(() => getSample(), [], null);
  const [msgs, setMsgs] = useState([{ role: 'assistant', content: 'Ask me about sales, stock, expiry, dues or GST. I read your store’s own data.' }]);
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
      if (ai && !quick) {
        setMsgs(m => [...m, { role: 'assistant', content: 'Thinking…' }]);
        const text = await askAssistant({ question, history: msgs.filter(m => m.content !== 'Thinking…').slice(1), tools: tools.current, onText: ({ text }) => setMsgs(m => [...m.slice(0, -1), { role: 'assistant', content: text }]) });
        setMsgs(m => [...m.slice(0, -1), { role: 'assistant', content: text }]);
      } else {
        const hit = quick || QUICK.find(([label]) => label.toLowerCase() === question.toLowerCase());
        const t = hit ? tools.current.find(x => x.name === hit[1]) : null;
        const ans = t ? format(hit[1], await t.execute(hit[2])) : 'I can answer the questions in the buttons below without AI. To ask anything in your own words, open this page in Claude (the AI connects there) or add an AI key to the installed app.';
        setMsgs(m => [...m, { role: 'assistant', content: ans }]);
      }
    } catch (e) {
      setMsgs(m => [...m.filter(x => x.content !== 'Thinking…'), { role: 'assistant', content: e?.code === 'rate_limited' ? 'Too many questions just now. Try again in a minute.' : e?.code === 'not_granted' ? 'AI was not allowed for this page. You can still use the quick questions.' : 'Something went wrong getting that answer. Try a quick question below.' }]);
    }
    setBusy(false);
  };

  return (
    <div className="stack" style={{ maxWidth: 860 }}>
      <PageHead title="AI assistant" sub={ai ? 'Ask in English or Hindi. Answers come from your store’s live data.' : 'Quick answers from your data. Free-form questions need the AI connection.'} />
      <Card>
        <div className="chat" aria-live="polite">
          {msgs.map((m, i) => <div key={i} className={`msg ${m.role === 'user' ? 'me' : 'ai'}`}>{m.content}</div>)}
          <div ref={end} />
        </div>
      </Card>
      <div className="chips">{QUICK.map(x => <button key={x[0]} className="chip" disabled={busy} onClick={() => ask(x[0], x)}>{x[0]}</button>)}</div>
      <form className="row gap-s" onSubmit={e => { e.preventDefault(); ask(q); }}>
        <input className="input grow" value={q} onChange={e => setQ(e.target.value)} placeholder={ai ? 'e.g. Compare dairy profit this week vs last week' : 'Type one of the quick questions'} aria-label="Question" id="ai-q" />
        <Btn kind="primary" type="submit" disabled={busy || !q.trim()}>Ask</Btn>
      </form>
      <p className="small muted">Billing never depends on the assistant — the counter works the same with or without it.</p>
    </div>
  );
}
