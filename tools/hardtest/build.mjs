import * as esbuild from '/opt/npm-tools/node_modules/esbuild/lib/main.js';
import fs from 'fs';
const S = process.argv[2], mode = process.argv[3] || 'production', OUT = process.argv[4] || (S + '/site');
const N = '/opt/npm-tools/node_modules/';
const alias = { dexie: S + '/deps/dexie/dist/dexie.mjs', jsbarcode: S + '/stubs/jsbarcode.js', qrcode: S + '/stubs/qrcode.js', jsqr: S + '/stubs/jsqr.js', xlsx: S + '/stubs/xlsx.js', 'tesseract.js': S + '/stubs/tesseract.js' };
const raw = { name: 'raw', setup(b) {
  b.onResolve({ filter: /\?raw$/ }, a => ({ path: new URL(a.path.replace(/\?raw$/, ''), 'file://' + a.resolveDir + '/').pathname, namespace: 'raw' }));
  b.onLoad({ filter: /.*/, namespace: 'raw' }, a => ({ contents: 'export default ' + JSON.stringify(fs.readFileSync(a.path, 'utf8')), loader: 'js' }));
} };
const res = { name: 'res', setup(b) {
  b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, a => ({ path: require_(a.path) }));
  for (const [k, v] of Object.entries(alias)) b.onResolve({ filter: new RegExp('^' + k.replace('.', '\\.') + '$') }, () => ({ path: v }));
} };
import { createRequire } from 'module';
const req = createRequire(N + 'x.js'); const require_ = p => req.resolve(p);
await esbuild.build({ entryPoints: ['/home/claude/dataflow-retail/src/main.jsx'], bundle: true, outdir: OUT, format: 'esm', splitting: true, jsx: 'automatic', jsxImportSource: N + 'react',
  loader: { '.js': 'jsx', '.png': 'dataurl', '.svg': 'dataurl' }, define: { 'import.meta.env.MODE': JSON.stringify(mode), 'import.meta.env.DEV': 'true', 'process.env.NODE_ENV': '"development"', 'import.meta.env.BASE_URL': '"/"' },
  plugins: [raw, res], logLevel: 'warning', sourcemap: 'inline' });
fs.writeFileSync(OUT + '/index.html', '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="main.css"></head><body><div id="root"></div><script type="module" src="main.js"></script></body></html>');
console.log('built', mode);
