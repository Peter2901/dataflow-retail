// Ready-to-send WhatsApp texts in English, Hindi and Odia (plain code, no AI).
// Odia and Hindi wording should be checked once by a native speaker before wide use.
export const LANGS = [{ value: 'en', label: 'English' }, { value: 'hi', label: 'हिंदी' }, { value: 'or', label: 'ଓଡ଼ିଆ' }];

const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => (v[k] ?? ''));
const money = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');

const T = {
  udhaar_polite: {
    en: 'Namaste {name}, a gentle reminder from {store}: {amt} is pending on your account.{upi} Thank you!',
    hi: 'नमस्ते {name} जी, {store} की ओर से याद दिला रहे हैं: आपके खाते में {amt} बाकी है।{upi} धन्यवाद!',
    or: 'ନମସ୍କାର {name}, {store} ତରଫରୁ ମନେ ପକାଉଛୁ: ଆପଣଙ୍କ ଖାତାରେ {amt} ବାକି ଅଛି।{upi} ଧନ୍ୟବାଦ!',
  },
  udhaar_firm: {
    en: 'Dear {name}, {amt} has been pending at {store} for {days} days. Please clear it this week.{upi}',
    hi: 'प्रिय {name} जी, {store} में आपके {amt} पिछले {days} दिनों से बाकी हैं। कृपया इस हफ्ते भुगतान करें।{upi}',
    or: 'ପ୍ରିୟ {name}, {store} ରେ ଆପଣଙ୍କ {amt} {days} ଦିନ ହେଲା ବାକି ଅଛି। ଦୟାକରି ଏହି ସପ୍ତାହରେ ଦେଇଦିଅନ୍ତୁ।{upi}',
  },
  upi_line: { en: ' Pay by UPI: {link}', hi: ' UPI से भुगतान: {link}', or: ' UPI ରେ ଦିଅନ୍ତୁ: {link}' },
  winback: {
    en: 'Hello {name}! We miss you at {store}. Your usual items are in stock{offer}. See you soon!',
    hi: 'नमस्ते {name} जी! {store} में आपकी कमी महसूस हो रही है। आपका रोज़ का सामान उपलब्ध है{offer}। जल्दी आइए!',
    or: 'ନମସ୍କାର {name}! {store} ରେ ଆପଣଙ୍କୁ ମନେ ପଡୁଛି। ଆପଣଙ୍କ ନିତିଦିନିଆ ଜିନିଷ ଉପଲବ୍ଧ ଅଛି{offer}। ଶୀଘ୍ର ଆସନ୍ତୁ!',
  },
  winback_offer: { en: ' — {pct}% off on your next bill this week', hi: ' — इस हफ्ते अगले बिल पर {pct}% छूट', or: ' — ଏହି ସପ୍ତାହରେ ପରବର୍ତ୍ତୀ ବିଲରେ {pct}% ରିହାତି' },
  ration: {
    en: 'Hello {name}, time to restock {items}? Reply here and we will keep it ready at {store}.',
    hi: 'नमस्ते {name} जी, क्या {items} फिर से चाहिए? यहाँ जवाब दें, हम {store} में तैयार रखेंगे।',
    or: 'ନମସ୍କାର {name}, {items} ପୁଣି ଦରକାର କି? ଏଠାରେ ଜଣାନ୍ତୁ, {store} ରେ ପ୍ରସ୍ତୁତ ରଖିବୁ।',
  },
  po_head: { en: '*Purchase order {no}*\nFrom: {store}{gstin}\nTo: {supplier}\nDate: {date}', hi: '*खरीद आदेश {no}*\nसे: {store}{gstin}\nको: {supplier}\nतारीख: {date}', or: '*କ୍ରୟ ଆଦେଶ {no}*\nଠାରୁ: {store}{gstin}\nପାଇଁ: {supplier}\nତାରିଖ: {date}' },
  po_foot: { en: 'Approx. total {total} incl. GST.\nPlease confirm the delivery date. Thank you.', hi: 'लगभग कुल {total} (GST सहित)।\nकृपया डिलीवरी की तारीख बताएं। धन्यवाद।', or: 'ପ୍ରାୟ ମୋଟ {total} (GST ସହିତ)।\nଦୟାକରି ଡେଲିଭରି ତାରିଖ ଜଣାନ୍ତୁ। ଧନ୍ୟବାଦ।' },
  unit_pcs: { en: 'pcs', hi: 'पीस', or: 'ପିସ୍' },
  unit_case: { en: 'case', hi: 'केस', or: 'କେସ୍' },
};

export const msg = (key, lang, vars) => fill((T[key] || {})[lang] || (T[key] || {}).en || '', vars);

export function udhaarText({ lang = 'en', name, store, amount, days, level = 'polite', upiLink }) {
  const upi = upiLink ? msg('upi_line', lang, { link: upiLink }) : '';
  return msg(level === 'polite' ? 'udhaar_polite' : 'udhaar_firm', lang, { name, store, amt: money(amount), days, upi });
}
export function winbackText({ lang = 'en', name, store, pct }) {
  return msg('winback', lang, { name, store, offer: pct ? msg('winback_offer', lang, { pct }) : '' });
}
export const rationText = ({ lang = 'en', name, store, items }) => msg('ration', lang, { name, store, items });

/** Purchase order for the supplier, in their language, in their units (cases when the carton size is known). */
export function poTextLang(po, supplier, settings, lang = 'en') {
  const lines = po.lines.map((l, i) => {
    const cp = Number(l.casePack) || 0;
    const q = cp > 1 && l.qty % cp === 0 ? `${l.qty / cp} ${msg('unit_case', lang, {})} (${l.qty} ${msg('unit_pcs', lang, {})})` : `${l.qty} ${msg('unit_pcs', lang, {})}`;
    return `${i + 1}. ${l.name} — ${q}`;
  }).join('\n');
  return `${msg('po_head', lang, { no: po.no, store: settings.storeName, gstin: settings.gstin ? ` (GSTIN ${settings.gstin})` : '', supplier: supplier?.name || '', date: po.date })}\n\n${lines}\n\n${msg('po_foot', lang, { total: '₹' + Number(po.total || 0).toFixed(2) })}`;
}

const DAYS = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  hi: ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'],
  or: ['ରବିବାର', 'ସୋମବାର', 'ମଙ୍ଗଳବାର', 'ବୁଧବାର', 'ଗୁରୁବାର', 'ଶୁକ୍ରବାର', 'ଶନିବାର'],
};

/** "Today ₹48,000 from 210 bills, 6% less than last Tuesday. Dairy ₹2,100 down; Staples ₹1,500 up." */
export function summaryText(s, lang = 'en') {
  const day = DAYS[lang][new Date().getDay()];
  const ch = s.lastWeek > 0 ? Math.round(((s.today - s.lastWeek) / s.lastWeek) * 100) : null;
  const moves = s.moves.slice(0, 2);
  if (lang === 'hi') {
    let t = `आज ${money(s.today)} की बिक्री, ${s.bills} बिल`;
    if (ch !== null) t += ` — पिछले ${day} से ${Math.abs(ch)}% ${ch >= 0 ? 'ज़्यादा' : 'कम'}`;
    t += '।';
    if (moves.length) t += ' ' + moves.map(m => `${m.cat} ${money(Math.abs(m.diff))} ${m.diff >= 0 ? 'ज़्यादा' : 'कम'}`).join('; ') + '।';
    if (s.profit) t += ` अनुमानित मुनाफ़ा ${money(s.profit)}।`;
    return t;
  }
  if (lang === 'or') {
    let t = `ଆଜି ${money(s.today)} ବିକ୍ରି, ${s.bills} ବିଲ୍`;
    if (ch !== null) t += ` — ଗତ ${day} ଠାରୁ ${Math.abs(ch)}% ${ch >= 0 ? 'ଅଧିକ' : 'କମ୍'}`;
    t += '।';
    if (moves.length) t += ' ' + moves.map(m => `${m.cat} ${money(Math.abs(m.diff))} ${m.diff >= 0 ? 'ଅଧିକ' : 'କମ୍'}`).join('; ') + '।';
    if (s.profit) t += ` ଆନୁମାନିକ ଲାଭ ${money(s.profit)}।`;
    return t;
  }
  let t = `Today ${money(s.today)} from ${s.bills} bills`;
  if (ch !== null) t += `, ${Math.abs(ch)}% ${ch >= 0 ? 'more' : 'less'} than last ${day}`;
  t += '.';
  if (moves.length) t += ' ' + moves.map(m => `${m.cat} ${money(Math.abs(m.diff))} ${m.diff >= 0 ? 'up' : 'down'}`).join('; ') + '.';
  if (s.profit) t += ` Estimated profit ${money(s.profit)}.`;
  return t;
}
