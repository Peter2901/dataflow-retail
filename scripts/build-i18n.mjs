// Rebuilds src/lib/i18n/hi.js and or.js from scripts/translations.tsv.
// To fix wording: open translations.tsv in Excel/Sheets (tab separated), change the hindi or odia
// column, save as tab-separated, then run:  node scripts/build-i18n.mjs
import fs from 'fs';
const rows = fs.readFileSync(new URL('./translations.tsv', import.meta.url), 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map(l => l.split('\t'));
const head = lang => `// ${lang} screen wording. Key = the English text exactly as on screen; {x} = a changing part.\n// Made from scripts/translations.tsv — edit that file, then run: node scripts/build-i18n.mjs\n// Please have a native ${lang} speaker check it once before wide use.\nexport default `;
for (const [i, lang, code] of [[1, 'Hindi', 'hi'], [2, 'Odia', 'or']]) {
  const obj = Object.fromEntries(rows.filter(r => r[0] && r[i]).map(r => [r[0].trim(), r[i].trim()]));
  fs.writeFileSync(new URL(`../src/lib/i18n/${code}.js`, import.meta.url), head(lang) + JSON.stringify(obj, null, 1) + ';\n');
  console.log(code, Object.keys(obj).length);
}
