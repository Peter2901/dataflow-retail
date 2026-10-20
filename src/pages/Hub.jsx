// "Smart & AI" — one place for every smart tool in the app.
// Each card says honestly how it works: "Free" tools are plain code on this device;
// "AI if needed" tools try free code first and call AI only when the code is not sure.
import React, { useEffect, useState } from 'react';
import { useApp, useLive, PageHead, Card, Btn, Badge } from '../ui/kit.jsx';
import { aiConfig, aiUsageThisMonth } from '../lib/smartai.js';
import { scanUsageThisMonth } from '../lib/billreader.js';
import { TodoList } from './Smart.jsx';

// page = where the card opens; param = which tab / tool on that page.
export const HUB_TOOLS = [
  { id: 'todo', kind: 'free', title: 'To-do today', text: 'What needs doing first, ranked by money at stake.', page: 'smart', param: { tab: 'todo' } },
  { id: 'expiry', kind: 'free', title: 'Expiry & dead stock', text: 'Discount, return to supplier or write off — before it is too late.', page: 'smart', param: { tab: 'expiry' } },
  { id: 'festivals', kind: 'free', title: 'Festival planning', text: 'What to stock up before each festival (Odisha + national).', page: 'smart', param: { tab: 'festivals' } },
  { id: 'customers', kind: 'free', title: 'Customers to call back', text: 'Regulars not seen lately and monthly items due now.', page: 'smart', param: { tab: 'customers' } },
  { id: 'udhaar', kind: 'free', title: 'Udhaar recovery', text: 'Who to remind first, with a UPI link in the message.', page: 'smart', param: { tab: 'udhaar' } },
  { id: 'staff', kind: 'free', title: 'Staff alerts', text: 'Too many price changes, cancelled bills, returns or drawer opens.', page: 'smart', param: { tab: 'staff' } },
  { id: 'weekly', kind: 'free', title: 'Weekly report', text: 'One short summary to share on WhatsApp.', page: 'smart', param: { tab: 'weekly' } },
  { id: 'pchecks', kind: 'free', title: 'Purchase checks', text: 'Rate hikes, duplicate bills, missing schemes, cheaper supplier.', page: 'purchases', param: { tab: 'bills' } },
  { id: 'dups', kind: 'free', title: 'Duplicate products', text: 'Find the same item saved twice and merge it.', page: 'products', param: { dups: true } },
  { id: 'gst', kind: 'free', title: 'GST Saathi', text: 'Due dates, checks before filing, GSTR-1 file, 2B match, 3B summary.', page: 'gst' },
  { id: 'orders', kind: 'free', title: 'WhatsApp orders', text: 'Customer orders to pack, and supplier orders in their language.', page: 'orders' },
  { id: 'scan', kind: 'ai', title: 'Smart Scan bill photo', text: 'Photo of a supplier bill → purchase entry. QR and offline reading first.', page: 'purchases', param: { newBill: true } },
  { id: 'voice', kind: 'ai', title: 'Speak purchase lines', text: '"Amul butter 20 piece 52 rupaye" → one bill line.', page: 'purchases', param: { newBill: true } },
  { id: 'pack', kind: 'ai', title: 'New product from pack photo', text: 'Name, MRP and barcode read from the packet.', page: 'products', param: { quick: true } },
  { id: 'hsn', kind: 'ai', title: 'HSN & GST hint', text: 'Suggests the code from similar items; you confirm the rate.', page: 'products' },
  { id: 'khata', kind: 'ai', title: 'Paper khata photo', text: 'Old udhaar notebook page → customer dues.', page: 'smart', param: { tab: 'udhaar' } },
  { id: 'ask', kind: 'ai', title: 'Ask your shop', text: 'Ask in Hinglish, Hindi or Odia. Answers come from your own data.', page: 'assistant' },
];

const HUB_ICON = {
  todo: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  expiry: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  festivals: '<path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4Z"/><path d="M6 17l.7 1.8 1.8.7-1.8.7L6 22l-.7-1.8-1.8-.7 1.8-.7Z"/>',
  customers: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M16 5.5a3 3 0 0 1 0 5.8"/>',
  udhaar: '<path d="M13.4 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7.4"/><path d="M2 6h4M2 10h4M2 14h4M2 18h4"/>',
  staff: '<circle cx="12" cy="7" r="3.5"/><path d="M5 21a7 7 0 0 1 14 0"/>',
  weekly: '<path d="M4 20V4"/><path d="M4 20h16"/><path d="M8 16l3-4 3 2 4-6"/>',
  pchecks: '<path d="M6 6h15l-1.5 9h-12z"/><path d="M6 6 5 3H2"/><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/>',
  dups: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  gst: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/><path d="M10 13h6M10 17h6"/>',
  orders: '<path d="M21 11.5a8.4 8.4 0 0 1-1.1 4.2L21 21l-5.3-1.1A8.5 8.5 0 1 1 21 11.5Z"/>',
  scan: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M4 12h16"/>',
  voice: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  pack: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="12" cy="12" r="3.2"/><path d="M8 5l1.2-2h5.6L16 5"/>',
  hsn: '<path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/>',
  khata: '<path d="M4 5h16v14H4z"/><path d="M7 9h10M7 13h7"/>',
  ask: '<path d="M21 11.5a8.4 8.4 0 0 1-1.1 4.2L21 21l-5.3-1.1A8.5 8.5 0 1 1 21 11.5Z"/><path d="M9 10h6M9 13h4"/>',
};
const KIND = { free: { tone: 'ok', label: 'Free' }, ai: { tone: 'accent', label: 'AI if needed' } };

export default function Hub() {
  const { go, canOpen, user } = useApp();
  const [conf, setConf] = useState(null);
  const scans = useLive(() => scanUsageThisMonth(), [], null);
  useEffect(() => { aiConfig().then(setConf).catch(() => setConf({ ai: 'off' })); }, []);
  const ai = aiUsageThisMonth();
  const aiOn = conf && conf.ai !== 'off' && conf.url && conf.key;
  const tools = HUB_TOOLS.filter(t => canOpen(t.page));
  const section = kind => tools.filter(t => t.kind === kind);

  return (
    <div className="stack">
      <PageHead title="Smart & AI" sub="Every smart tool in one place. Free tools run on this device. AI is used only when plain code is not sure." />

      <div className="grid g2">
        <Card title="Top to-do" actions={<Btn size="sm" onClick={() => go('smart', { tab: 'todo' })}>See all</Btn>}>
          <TodoList limit={3} />
        </Card>
        <Card title="AI this month" actions={user.role === 'owner' && <Btn size="sm" onClick={() => go('settings', { tab: 'scan' })}>AI settings</Btn>}>
          <div className="stack-s">
            <div className="row gap-s"><span className={`dot ${aiOn ? '' : 'off'}`} /><b>{conf === null ? 'Checking…' : aiOn ? 'AI is on' : 'AI is off'}</b>
              {conf && !aiOn && <span className="small muted">— all free tools still work.</span>}</div>
            {scans && <div className="small">Bills scanned: <b>{scans.bills}</b> · read free: <b>{scans.free}</b> · needed AI: <b>{scans.ai}</b></div>}
            <div className="small muted">AI calls from this device: {ai.calls || 0}</div>
          </div>
        </Card>
      </div>

      {['free', 'ai'].map(kind => section(kind).length > 0 && (
        <section key={kind} className="stack-s">
          <h2 className="hub-head">{kind === 'free' ? 'Free — works offline' : 'Free first, AI only if needed'}</h2>
          <div className="hub-grid">
            {section(kind).map(t => (
              <button key={t.id} className={`hub-card hub-${kind}`} onClick={() => go(t.page, t.param || null)}>
                <span className="row between"><span className={`hub-icon hub-icon-${kind}`}><svg viewBox="0 0 24 24" aria-hidden="true" dangerouslySetInnerHTML={{ __html: HUB_ICON[t.id] || HUB_ICON.todo }} /></span><Badge tone={KIND[kind].tone}>{KIND[kind].label}</Badge></span>
                <b>{t.title}</b>
                <span className="small muted">{t.text}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
