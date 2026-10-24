import * as esbuild from '/opt/npm-tools/node_modules/esbuild/lib/main.js';
const S = process.argv[2];
await esbuild.build({ entryPoints: [S + '/dups/entry.js'], bundle: true, outfile: S + '/dups/bundle.mjs', format: 'esm', platform: 'node', loader: { '.js': 'jsx' }, alias: { dexie: S + '/deps/dexie/dist/dexie.mjs', 'tesseract.js': S + '/stubs/tesseract.js', jsqr: S + '/stubs/jsqr.js', qrcode: S + '/stubs/qrcode.js', jsbarcode: S + '/stubs/jsbarcode.js', xlsx: S + '/stubs/xlsx.js' }, plugins: [{ name: 'raw', setup(b) { b.onResolve({ filter: /\?raw$/ }, a => ({ path: a.path, namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, () => ({ contents: 'export default ""', loader: 'js' })); } }], logLevel: 'error' });
process.argv[2] = process.argv[3];
await import(S + '/dups/bundle.mjs');
