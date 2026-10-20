// Store & owner details — filled once; printed on every bill and used for GST, UPI and WhatsApp.
import React, { useMemo, useState } from 'react';
import { setSetting } from '../db.js';
import { useApp, useToast, PageHead, Card, Btn, Input, Select, Badge } from '../ui/kit.jsx';
import { validGSTIN } from '../lib/util.js';
import { audit } from '../lib/sales.js';

export const STATES = [
  ['01', 'Jammu & Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'], ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'],
  ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'], ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'], ['20', 'Jharkhand'], ['21', 'Odisha'],
  ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'], ['26', 'Dadra & Nagar Haveli and Daman & Diu'], ['27', 'Maharashtra'],
  ['29', 'Karnataka'], ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'], ['35', 'Andaman & Nicobar'],
  ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'], ['97', 'Other territory'],
];
const KEYS = ['storeName', 'storeNameLocal', 'address', 'city', 'pin', 'stateCode', 'phone', 'logo', 'ownerName', 'ownerMobile', 'ownerPhone', 'ownerEmail',
  'gstin', 'legalName', 'fssai', 'shopLicence', 'caContact', 'upiVpa', 'upiName', 'billFooter', 'billNames'];
const MUST = { storeName: 'store name', address: 'address', city: 'city', pin: 'PIN code', stateCode: 'state', phone: 'store phone', ownerName: 'owner name',
  ownerMobile: 'owner mobile', gstin: 'GSTIN', legalName: 'legal name', upiVpa: 'UPI ID' };

// Shrink the logo so it stays small enough to sync to every counter.
function shrinkImage(file, max = 160) {
  return new Promise((ok, bad) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src); ok(c.toDataURL('image/png'));
    };
    img.onerror = bad; img.src = URL.createObjectURL(file);
  });
}

export default function Store() {
  const { settings, user } = useApp();
  const toast = useToast();
  const [f, setF] = useState(() => ({ billNames: 'local', billFooter: 'Thank you! Visit again.', ...Object.fromEntries(KEYS.map(k => [k, settings[k] ?? ''])), filing: settings.gstFiling?.qrmp ? 'q' : settings.gstFiling?.composition ? 'c' : 'm' }));
  const on = k => e => setF(x => ({ ...x, [k]: e.target.value }));
  const missing = useMemo(() => Object.entries(MUST).filter(([k]) => !String(f[k] || '').trim()).map(([, v]) => v), [f]);
  const gstOk = !f.gstin || validGSTIN(f.gstin);
  const canEdit = user.role === 'owner';

  const save = async () => {
    if (!gstOk) return toast('That GSTIN does not pass the check.', 'bad');
    if (f.pin && !/^\d{6}$/.test(f.pin)) return toast('PIN code must be 6 digits.', 'bad');
    for (const k of ['phone', 'ownerMobile', 'ownerPhone']) if (f[k] && String(f[k]).replace(/\D/g, '').length < 10) return toast('Phone numbers need 10 digits.', 'bad');
    if (f.gstin && f.stateCode && f.gstin.slice(0, 2) !== f.stateCode) return toast(`The GSTIN starts with ${f.gstin.slice(0, 2)} but the state is ${f.stateCode}. Pick the right state.`, 'bad');
    for (const k of KEYS) await setSetting(k, k === 'gstin' ? String(f[k] || '').toUpperCase() : f[k]);
    await setSetting('gstFiling', { ...(settings.gstFiling || {}), qrmp: f.filing === 'q', composition: f.filing === 'c' });
    await audit('settings', { section: 'store' }, user);
    toast('Saved.');
  };
  const pickLogo = async e => {
    const file = e.target.files?.[0]; if (!file) return;
    try { const url = await shrinkImage(file); setF(x => ({ ...x, logo: url })); } catch { toast('Could not read that image.', 'bad'); }
  };
  const done = Object.keys(MUST).length - missing.length;
  const state = STATES.find(s => s[0] === f.stateCode);

  return (
    <div className="stack">
      <PageHead title="Store & owner details" sub="Fill this once. It prints on every bill and is used for GST, UPI and WhatsApp messages."
        actions={<><Badge tone={missing.length ? 'accent' : 'ok'}>{`${done} of ${Object.keys(MUST).length} must-fill done`}</Badge>{canEdit && <Btn kind="primary" onClick={save}>Save details</Btn>}</>} />
      {!canEdit && <div className="note">Only the owner can change these details.</div>}

      <div className="store-layout">
        <div className="stack">
          <Card title="Store">
            <div className="grid g2">
              <Input label="Store name *" value={f.storeName} onChange={on('storeName')} id="sd-name" />
              <Input label="Store name in Hindi / Odia (on bill)" value={f.storeNameLocal} onChange={on('storeNameLocal')} id="sd-local" />
              <Input label="Address *" value={f.address} onChange={on('address')} placeholder="Shop no., street, area" className="span2" id="sd-addr" />
              <Input label="City *" value={f.city} onChange={on('city')} id="sd-city" />
              <div className="grid g2">
                <Input label="PIN code *" value={f.pin} onChange={on('pin')} inputMode="numeric" maxLength={6} id="sd-pin" />
                <Select label="State *" value={f.stateCode} onChange={on('stateCode')} options={[{ value: '', label: 'Choose' }, ...STATES.map(([c, n]) => ({ value: c, label: `${n} (${c})` }))]} id="sd-state" />
              </div>
              <Input label="Store phone *" value={f.phone} onChange={on('phone')} type="tel" id="sd-phone" />
              <div className="field">
                <span className="field-label">Logo (on bill)</span>
                <div className="row gap-s">
                  {f.logo && <img src={f.logo} alt="Store logo" style={{ width: 40, height: 40, objectFit: 'contain', borderRadius: 8, border: '1px solid var(--line)' }} />}
                  <label className="btn btn-sm">{f.logo ? 'Change logo' : 'Upload logo'}<input type="file" accept="image/*" hidden onChange={pickLogo} /></label>
                  {f.logo && <Btn size="sm" onClick={() => setF(x => ({ ...x, logo: '' }))}>Remove</Btn>}
                </div>
              </div>
            </div>
          </Card>

          <Card title="Owner">
            <div className="grid g2">
              <Input label="Owner name *" value={f.ownerName} onChange={on('ownerName')} id="sd-owner" />
              <Input label="Mobile *" value={f.ownerMobile} onChange={on('ownerMobile')} type="tel" id="sd-omob" />
              <Input label="WhatsApp for daily summary" value={f.ownerPhone} onChange={on('ownerPhone')} type="tel" placeholder="Same as mobile" id="sd-owa" />
              <Input label="Email (for reports)" value={f.ownerEmail} onChange={on('ownerEmail')} type="email" id="sd-omail" />
            </div>
          </Card>

          <Card title="GST & licences">
            <div className="grid g2">
              <Input label="GSTIN *" value={f.gstin} onChange={e => setF(x => ({ ...x, gstin: e.target.value.toUpperCase(), stateCode: validGSTIN(e.target.value) ? e.target.value.slice(0, 2) : x.stateCode }))}
                hint={!f.gstin ? '15 characters' : gstOk ? 'GSTIN looks right' : 'This GSTIN does not pass the check'} maxLength={15} id="sd-gstin" />
              <Input label="Legal name (as on GST certificate) *" value={f.legalName} onChange={on('legalName')} id="sd-legal" />
              <Select label="How you file GST" value={f.filing} onChange={on('filing')} options={[{ value: 'm', label: 'Monthly' }, { value: 'q', label: 'Quarterly (QRMP)' }, { value: 'c', label: 'Composition scheme' }]} id="sd-filing" />
              <Input label="FSSAI licence no." value={f.fssai} onChange={on('fssai')} placeholder="14 digits" id="sd-fssai" />
              <Input label="Shop & establishment no." value={f.shopLicence} onChange={on('shopLicence')} placeholder="Optional" id="sd-shop" />
              <Input label="Your CA / accountant (name, phone)" value={f.caContact} onChange={on('caContact')} placeholder="Optional" id="sd-ca" />
            </div>
          </Card>

          <Card title="Payments & bill">
            <div className="grid g2">
              <Input label="UPI ID *" value={f.upiVpa} onChange={on('upiVpa')} placeholder="shopname@bank" id="sd-upi" />
              <Input label="Name shown in UPI apps" value={f.upiName} onChange={on('upiName')} id="sd-upiname" />
              <Input label="Thank-you line on bill" value={f.billFooter} onChange={on('billFooter')} id="sd-footer" />
              <Select label="Item names on bill" value={f.billNames} onChange={on('billNames')} options={[{ value: 'local', label: 'English + Hindi/Odia name' }, { value: 'none', label: 'English only' }]} id="sd-names" />
            </div>
            <p className="small muted" style={{ marginTop: 8 }}>Counter codes (T1, T2…) and bill numbers are in Settings › Store & GST on each counter.</p>
          </Card>
        </div>

        <aside className="stack">
          <Card title="How your bill top looks">
            <div className="bill-preview" data-no-t>
              {f.logo && <img src={f.logo} alt="" style={{ width: 40, height: 40, objectFit: 'contain' }} />}
              <b style={{ fontSize: 13 }}>{(f.storeName || '[STORE NAME]').toUpperCase()}</b>
              {f.storeNameLocal && <div className="loc">{f.storeNameLocal}</div>}
              <div>{[f.address || '[ADDRESS]', f.city, f.pin].filter(Boolean).join(', ')}</div>
              {state && <div>{state[1]}</div>}
              <div>Ph: {f.phone || '[STORE PHONE]'}</div>
              <div>GSTIN: {f.gstin || '[GSTIN]'}</div>
              {f.fssai && <div>FSSAI: {f.fssai}</div>}
              <b style={{ marginTop: 4 }}>TAX INVOICE</b>
            </div>
          </Card>
          {missing.length > 0
            ? <div className="note note-warn"><b>Still needed:</b> {missing.join(', ')}. Billing works without them, but a GST bill needs the address and GSTIN, and GST Saathi checks them before filing.</div>
            : <div className="note">All must-fill details are done.</div>}
        </aside>
      </div>
    </div>
  );
}
