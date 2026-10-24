// Product search that understands Hindi / Odia / Hinglish names and typing mistakes.
// Plain code and a built-in word list: instant and offline at the counter.
import { simProfile, simScore } from './match.js';

// English word → other names people type or say (Hinglish, Hindi, Odia).
const WORDS = {
  sugar: ['chini', 'cheeni', 'shakkar', 'चीनी', 'शक्कर', 'ଚିନି'],
  salt: ['namak', 'lun', 'नमक', 'ଲୁଣ'],
  rice: ['chawal', 'chaawal', 'chaul', 'चावल', 'ଚାଉଳ'],
  atta: ['aata', 'wheat flour', 'gehu', 'आटा', 'ଅଟା'],
  dal: ['daal', 'lentil', 'pulses', 'दाल', 'ଡାଲି'],
  toor: ['arhar', 'tuvar', 'तूर', 'अरहर'],
  oil: ['tel', 'तेल', 'ତେଲ'],
  ghee: ['ghi', 'घी', 'ଘିଅ'],
  milk: ['doodh', 'dudh', 'दूध', 'ଦୁଧ'],
  curd: ['dahi', 'yogurt', 'दही', 'ଦହି'],
  butter: ['makhan', 'makkhan', 'मक्खन', 'ଲହୁଣୀ'],
  paneer: ['cottage cheese', 'पनीर', 'ଛେନା', 'chhena'],
  tea: ['chai', 'chai patti', 'चाय', 'ଚା'],
  coffee: ['कॉफी', 'କଫି'],
  coriander: ['dhaniya', 'dhania', 'धनिया', 'ଧନିଆ'],
  turmeric: ['haldi', 'हल्दी', 'ହଳଦୀ'],
  chilli: ['mirchi', 'mirch', 'chili', 'मिर्च', 'ଲଙ୍କା', 'lanka'],
  cumin: ['jeera', 'jira', 'जीरा', 'ଜିରା'],
  mustard: ['sarson', 'rai', 'सरसों', 'ସୋରିଷ', 'sorisa'],
  onion: ['pyaz', 'pyaaz', 'kanda', 'प्याज', 'ପିଆଜ', 'piaja'],
  potato: ['aloo', 'alu', 'आलू', 'ଆଳୁ'],
  tomato: ['tamatar', 'टमाटर', 'ଟମାଟୋ'],
  garlic: ['lahsun', 'lehsun', 'लहसुन', 'ରସୁଣ', 'rasuna'],
  ginger: ['adrak', 'अदरक', 'ଅଦା', 'ada'],
  soap: ['sabun', 'साबुन', 'ସାବୁନ'],
  detergent: ['surf', 'washing powder', 'कपड़े धोने'],
  egg: ['anda', 'ande', 'अंडा', 'ଅଣ୍ଡା'],
  jaggery: ['gud', 'gur', 'गुड़', 'ଗୁଡ'],
  semolina: ['suji', 'sooji', 'rava', 'rawa', 'सूजी', 'ସୁଜି'],
  besan: ['gram flour', 'बेसन', 'ବେସନ'],
  maida: ['all purpose flour', 'मैदा', 'ମଇଦା'],
  poha: ['chuda', 'flattened rice', 'पोहा', 'ଚୁଡ଼ା'],
  vermicelli: ['sewai', 'seviyan', 'सेवई'],
  peanut: ['moongfali', 'mungfali', 'groundnut', 'मूंगफली', 'ଚିନାବାଦାମ'],
  cashew: ['kaju', 'काजू', 'କାଜୁ'],
  almond: ['badam', 'बादाम', 'ବାଦାମ'],
  raisin: ['kishmish', 'किशमिश'],
  biscuit: ['biskut', 'biskit', 'biscut', 'बिस्कुट', 'ବିସ୍କୁଟ'],
  bread: ['pav', 'double roti', 'ब्रेड', 'ପାଉଁରୁଟି'],
  matchbox: ['machis', 'माचिस'],
  toothpaste: ['manjan', 'टूथपेस्ट'],
  incense: ['agarbatti', 'dhoop', 'अगरबत्ती', 'ଧୂପ'],
  camphor: ['kapur', 'kapoor', 'कपूर', 'କର୍ପୂର'],
  coconut: ['nariyal', 'narial', 'नारियल', 'ନଡ଼ିଆ'],
  banana: ['kela', 'केला', 'କଦଳୀ'],
  sesame: ['til', 'तिल', 'ରାଶି'],
  cardamom: ['elaichi', 'इलायची', 'ଅଳେଇଚ'],
  clove: ['laung', 'लौंग', 'ଲବଙ୍ଗ'],
  pepper: ['kali mirch', 'काली मिर्च', 'ଗୋଲମରିଚ'],
  tamarind: ['imli', 'इमली', 'ତେନ୍ତୁଳି'],
  noodles: ['maggi', 'नूडल्स'],
  chips: ['wafers', 'चिप्स'],
  water: ['pani', 'पानी', 'ପାଣି'],
  candle: ['mombatti', 'मोमबत्ती'],
};

// Every spelling → its English word.
const TO_EN = {};
for (const [en, alts] of Object.entries(WORDS)) { TO_EN[en] = en; alts.forEach(a => (TO_EN[a.toLowerCase()] = en)); }

/** "chini 1kg" → ["sugar 1kg"]; also keeps the original text. */
export function expandQuery(q) {
  const raw = String(q || '').toLowerCase().trim();
  let en = raw;
  // multi-word names first
  for (const k of Object.keys(TO_EN).sort((a, b) => b.length - a.length)) {
    if (k.includes(' ') && en.includes(k)) en = en.split(k).join(TO_EN[k]);
  }
  en = en.split(/\s+/).map(w => TO_EN[w] || w).join(' ');
  return [...new Set([raw, en])];
}

/**
 * Smart search over products: exact codes, plain contains, other-language names, then typing mistakes.
 * Returns products ranked best first.
 */
// Lower-case search text per product, built once per product list (the list object stays the same between key presses).
const hayCache = new WeakMap(), profCache = new WeakMap();
// Name profiles for the typing-mistake pass, also built once per product list.
function profiles(products) {
  let h = profCache.get(products);
  if (!h) { h = new Map(); profCache.set(products, h); }
  return p => { let x = h.get(p); if (!x) { x = simProfile(p.name); h.set(p, x); } return x; };
}
function haystacks(products) {
  let h = hayCache.get(products);
  if (!h) { h = products.map(p => `${p.name} ${p.brand || ''} ${p.category || ''} ${p.localName || ''}`.toLowerCase()); hayCache.set(products, h); }
  return h;
}

// all: include products hidden from the counter (the Products page shows them too).
export function smartSearch(q, products, limit = 8, { all = false } = {}) {
  const s = String(q || '').trim();
  if (s.length < 2) return [];
  const lower = s.toLowerCase();
  const exact = products.filter(p => p.barcode === s || p.id.toLowerCase() === lower || (p.plu && p.plu === s));
  if (exact.length) return exact.slice(0, limit);
  const forms = expandQuery(s);
  const formWords = forms.map(f => f.split(/\s+/).filter(Boolean));
  const H = haystacks(products);
  const scored = [], rest = [];
  // Pass 1 — plain "contains" (cheap).
  for (let i = 0; i < products.length; i++) {
    const p = products[i];
    if (!all && p.active === false) continue;
    const hay = H[i];
    let score = 0;
    for (let k = 0; k < forms.length; k++) {
      const f = forms[k], words = formWords[k];
      if (hay.includes(f)) score = Math.max(score, 3);
      else if (words.every(w => hay.includes(w))) score = Math.max(score, 2.5);
      else if (words.some(w => w.length >= 3 && hay.includes(w))) score = Math.max(score, 1.2);
    }
    if (score >= 2) scored.push({ p, score: score + (p.name.toLowerCase().startsWith(lower) ? 0.5 : 0) });
    else rest.push({ p, score });
  }
  // Pass 2 — typing mistakes, only when pass 1 did not already find enough (a typo match scores at most 2,
  // below every "contains" match, so skipping it then gives the same list — just much faster on big stores).
  if (scored.length < limit) {
    const prof = profiles(products);
    const qProf = forms.map(simProfile);
    for (const { p, score: s0 } of rest) {
      let score = s0;
      if (s.length >= 3) {
        const pp = prof(p), words = pp.words;
        const typo = formWords.some(fw => fw.every(q => q.length < 4 || words.some(w => close(q, w))));
        if (typo) score = Math.max(score, 1.8);
        else { const best = Math.max(...qProf.map(f => simScore(f, pp))); if (best >= 0.6) score = Math.max(score, best * 2); }
      }
      if (score > 0) scored.push({ p, score: score + (p.name.toLowerCase().startsWith(lower) ? 0.5 : 0) });
    }
  } else rest.forEach(({ p, score }) => { if (score > 0) scored.push({ p, score }); });
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.p);
}

// Small typing-mistake check (edit distance), ignoring a plural "s".
function close(a, b) {
  a = a.replace(/s$/, ''); b = b.replace(/s$/, '');
  if (a === b) return true;
  const max = a.length >= 6 ? 2 : 1;
  if (Math.abs(a.length - b.length) > max) return false;
  // Two rows only, and stop as soon as no path can stay within `max` (same answer, far less work).
  let prev = new Array(b.length + 1), cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i; let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return false;
    [prev, cur] = [cur, prev];
  }
  return prev[b.length] <= max;
}
