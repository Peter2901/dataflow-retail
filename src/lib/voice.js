// Spoken (or quickly typed) purchase lines: "amul butter 20 piece 52 rupaye", "चीनी 10 किलो 41 रुपये",
// "ଚିନି 10 କିଲୋ 41 ଟଙ୍କା". Plain code first; AI only when the code can't find the item or numbers.
import { matchLine } from './match.js';
import { smartSearch } from './search.js';
import { askAI, aiOn } from './smartai.js';

const DIGITS = { '०': 0, '१': 1, '२': 2, '३': 3, '४': 4, '५': 5, '६': 6, '७': 7, '८': 8, '९': 9, '୦': 0, '୧': 1, '୨': 2, '୩': 3, '୪': 4, '୫': 5, '୬': 6, '୭': 7, '୮': 8, '୯': 9 };
const NUMW = {
  ek: 1, do: 2, teen: 3, char: 4, chaar: 4, paanch: 5, panch: 5, chhe: 6, chhah: 6, saat: 7, aath: 8, nau: 9, das: 10, gyarah: 11, barah: 12, baarah: 12, pandrah: 15, solah: 16, bees: 20, pachchees: 25, pachees: 25, tees: 30, chalees: 40, pachas: 50, pachaas: 50, saath: 60, sau: 100,
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छः': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'बारह': 12, 'पंद्रह': 15, 'बीस': 20, 'पच्चीस': 25, 'तीस': 30, 'चालीस': 40, 'पचास': 50, 'सौ': 100,
  'ଏକ': 1, 'ଦୁଇ': 2, 'ତିନି': 3, 'ଚାରି': 4, 'ପାଞ୍ଚ': 5, 'ଛଅ': 6, 'ସାତ': 7, 'ଆଠ': 8, 'ନଅ': 9, 'ଦଶ': 10, 'ବାର': 12, 'ପନ୍ଦର': 15, 'କୋଡ଼ିଏ': 20, 'କୋଡିଏ': 20, 'ପଚିଶ': 25, 'ତିରିଶ': 30, 'ଚାଳିଶ': 40, 'ପଚାଶ': 50, 'ଶହେ': 100,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100,
};
const COUNT = /^(pieces?|pcs?|peace|nag|nos?|पीस|ପିସ୍|ପିସ|packets?|pkts?|पैकेट|ପ୍ୟାକେଟ|case|cases|cs|peti|पेटी|box|boxes|dabba|डिब्बा|carton|ctn|dozen|darjan|दर्जन)$/i;
const MEASURE = /^(kg|kgs|kilo|किलो|କିଲୋ|litre|liter|ltr|लीटर|ଲିଟର)$/i;
const CASEU = /^(case|cases|cs|peti|पेटी|box|boxes|dabba|डिब्बा|carton|ctn)$/i;
const RUPEE = /^(rupaye|rupaiye|rupees?|rs\.?|₹|रुपये|रुपए|रुपया|ଟଙ୍କା|tanka|taka|bhav|rate|@)$/i;
const FREE = /^(free|muft|फ्री|मुफ्त|ମାଗଣା|ফ্রি)$/i;

const toNum = w => {
  const d = String(w).replace(/[०-९୦-୯]/g, c => DIGITS[c]).replace(/^₹/, '');
  if (/^\d+(?:\.\d+)?$/.test(d)) return Number(d);
  return NUMW[w.toLowerCase()] ?? null;
};

/** → { text, qty, unit, rate, free } (null where not heard) */
export function parseSpoken(said) {
  const toks = String(said || '').replace(/[,]/g, ' ').replace(/(\d)(rs|₹)/gi, '$1 $2').replace(/₹\s*(\d)/g, '₹ $1').split(/\s+/).filter(Boolean);
  let qty = null, unit = null, rate = null, free = null;
  const used = new Set();
  const mark = (i, j) => { used.add(i); if (j != null) used.add(j); };
  toks.forEach((t, i) => {
    const n = toNum(t);
    if (n === null) return;
    const next = toks[i + 1] || '', prev = toks[i - 1] || '';
    if (FREE.test(next) || FREE.test(prev)) { free = n; mark(i, FREE.test(next) ? i + 1 : i - 1); return; }
    if (RUPEE.test(next) || RUPEE.test(prev)) { rate = n; mark(i, RUPEE.test(next) ? i + 1 : i - 1); return; }
    if (COUNT.test(next) && qty === null) { qty = n; unit = next.toLowerCase(); mark(i, i + 1); }
  });
  // "10 kilo" is the quantity only when no pieces/cases were said; otherwise it is the pack size ("salt 1 kg").
  toks.forEach((t, i) => {
    if (used.has(i)) return;
    const n = toNum(t);
    if (n === null || !MEASURE.test(toks[i + 1] || '')) return;
    if (qty === null) { qty = n; unit = toks[i + 1].toLowerCase(); mark(i, i + 1); }
    else { toks[i] = t + toks[i + 1]; toks[i + 1] = ''; }           // keep "1kg" in the item name
  });
  // Bare numbers: first = quantity, second = rate.
  toks.forEach((t, i) => {
    if (used.has(i)) return;
    const n = toNum(t);
    if (n === null || !t || /\d+(g|kg|ml|l)$/i.test(t)) return;
    const next = toks[i + 1] || '';
    if (/^(g|gm|gram|ml|kg|ltr|l)$/i.test(next) && qty !== null) return;   // "500 g" is the pack size
    if (qty === null && Number.isInteger(n) && !/^(g|gm|gram|ml)$/i.test(next)) { qty = n; used.add(i); }
    else if (rate === null && qty !== null) { rate = n; used.add(i); }
  });
  const text = toks.filter((t, i) => t && !used.has(i) && !RUPEE.test(t) && !FREE.test(t) && !COUNT.test(t)).join(' ').trim();
  return { text, qty, unit: unit ? (CASEU.test(unit) ? 'CS' : unit) : null, rate, free };
}

/** Parses, matches the item, and asks AI only if code failed. Returns { line, method } or throws. */
export async function voiceToLine(said, { supplierId, products, aliases }) {
  let p = parseSpoken(said);
  let m = p.text ? matchLine(p.text, { supplierId, products, aliases }) : { productId: '', match: 'none' };
  if (!m.productId && p.text) {                       // "chini" → Sugar: other-language names and typing mistakes
    const hit = smartSearch(p.text, products, 1)[0];
    if (hit) m = { productId: hit.id, match: 'check', score: 0.6 };
  }
  let method = 'free';
  if ((!m.productId || p.qty === null) && await aiOn()) {
    const r = await askAI('voice', { text: said });
    const it = r.data?.items?.[0];
    if (it) {
      p = { text: it.text || p.text, qty: it.qty ?? p.qty, unit: it.unit || p.unit, rate: it.rate ?? p.rate, free: it.free ?? p.free };
      m = matchLine(p.text, { supplierId, products, aliases });
      method = 'ai';
    }
  }
  return { parsed: p, match: m, method };
}

export const speechSupported = () => !!(window.SpeechRecognition || window.webkitSpeechRecognition);
export function listen(lang = 'hi-IN') {
  return new Promise((resolve, reject) => {
    const R = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!R) return reject(new Error('Voice is not available here. Use the microphone on your phone keyboard instead.'));
    const r = new R();
    r.lang = lang; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = e => resolve(e.results[0][0].transcript);
    r.onerror = e => reject(new Error(e.error === 'not-allowed' ? 'Microphone permission was refused.' : 'Did not catch that. Try again.'));
    r.start();
  });
}
