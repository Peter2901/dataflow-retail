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
                <span className="row between"><b>{t.title}</b><Badge tone={KIND[kind].tone}>{KIND[kind].label}</Badge></span>
                <span className="small muted">{t.text}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
