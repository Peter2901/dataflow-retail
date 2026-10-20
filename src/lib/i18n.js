// Screen language: English, हिंदी or ଓଡ଼ିଆ, chosen per device (cashier in Odia, owner in English).
// How it works: the app is written in English; this layer swaps the screen wording using the
// word lists in ./i18n/hi.js and ./i18n/or.js. It never touches item names, customer names,
// numbers, typed text, table cells or printed bills (anything inside [data-no-t]).
// To add a phrase: add the English text exactly as on screen, with {x} for a changing part.

export const UI_LANGS = [{ value: 'en', label: 'English', short: 'EN' }, { value: 'hi', label: 'हिंदी', short: 'हि' }, { value: 'or', label: 'ଓଡ଼ିଆ', short: 'ଓ' }];
const LOADERS = { hi: () => import('./i18n/hi.js'), or: () => import('./i18n/or.js') };
const ATTRS = ['placeholder', 'aria-label', 'title'];
const SKIP = '[data-no-t],script,style,textarea,code,.mono,.receipt';

let lang = 'en';
let exact = new Map();
let patterns = [];
let observer = null;
const orig = new WeakMap();   // text node -> English text
const shown = new WeakMap();  // text node -> what we last wrote

function compile(dict) {
  exact = new Map(); patterns = [];
  for (const [en, tr] of Object.entries(dict)) {
    if (!en.includes('{')) { exact.set(en, tr); continue; }
    const names = [];
    const rx = en.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{(\w+)\\?\}/g, (_, n) => { names.push(n); return '(.+?)'; });
    patterns.push({ rx: new RegExp('^' + rx + '$'), names, tr });
  }
}

/** Translate one English phrase (also usable from code, e.g. in alerts). */
export function t(text) {
  if (lang === 'en' || !text) return text;
  const s = String(text);
  const key = s.trim();
  if (!key || !/[A-Za-z]/.test(key)) return s;
  let out = exact.get(key);
  if (out == null) {
    for (const p of patterns) {
      const m = key.match(p.rx);
      if (m) { const v = Object.fromEntries(p.names.map((n, i) => [n, exact.get(m[i + 1].trim()) ?? m[i + 1]])); out = p.tr.replace(/\{(\w+)\}/g, (_, n) => v[n] ?? ''); break; }
    }
  }
  if (out == null) return s;
  const lead = s.match(/^\s*/)[0], trail = s.match(/\s*$/)[0];
  return lead + out + trail;
}

// Table cells hold data (names, bill numbers); only badges, buttons and `.t` parts inside them are translated.
const skipEl = el => !el || !!el.closest(SKIP) || (!!el.closest('td') && !el.closest('.badge,button,.btn,.t'));

function doText(n) {
  const v = n.nodeValue;
  if (shown.get(n) === v) return;            // our own write
  if (skipEl(n.parentElement)) return;
  orig.set(n, v);
  const out = t(v);
  shown.set(n, out);
  if (out !== v) n.nodeValue = out;
}
function doAttrs(el) {
  if (skipEl(el)) return;
  for (const a of ATTRS) {
    const cur = el.getAttribute(a);
    if (cur == null) continue;
    const key = 'data-t-' + a, done = el.getAttribute(key + '-shown');
    if (done === cur) continue;
    el.setAttribute(key, cur);
    const out = t(cur);
    el.setAttribute(key + '-shown', out);
    if (out !== cur) el.setAttribute(a, out);
  }
}
function walk(root) {
  if (root.nodeType === 3) return doText(root);
  if (root.nodeType !== 1) return;
  if (root.closest && root.closest(SKIP)) return;
  doAttrs(root);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode: n => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? doText(n) : doAttrs(n);
}
function restore(root) {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (n.nodeType === 3) { const o = orig.get(n); if (o != null && shown.get(n) === n.nodeValue) n.nodeValue = o; shown.delete(n); orig.delete(n); continue; }
    for (const a of ATTRS) { const o = n.getAttribute('data-t-' + a); if (o != null) { n.setAttribute(a, o); n.removeAttribute('data-t-' + a); n.removeAttribute('data-t-' + a + '-shown'); } }
  }
}

/** Switch the screen language. Safe to call any time; 'en' turns translation off. */
export async function setUiLanguage(next) {
  const want = LOADERS[next] ? next : 'en';
  document.documentElement.lang = want === 'or' ? 'or' : want === 'hi' ? 'hi' : 'en';
  if (want === lang) return;
  if (observer) { observer.disconnect(); observer = null; }
  if (want === 'en') { lang = 'en'; restore(document.body); return; }
  const mod = await LOADERS[want]();
  restore(document.body);
  compile(mod.default);
  lang = want;
  walk(document.body);
  observer = new MutationObserver(list => {
    for (const m of list) {
      if (m.type === 'characterData') doText(m.target);
      else if (m.type === 'attributes') doAttrs(m.target);
      else m.addedNodes.forEach(walk);
    }
  });
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
export const uiLanguage = () => lang;
