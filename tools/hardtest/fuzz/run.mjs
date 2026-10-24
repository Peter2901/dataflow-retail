import * as esbuild from '/opt/npm-tools/node_modules/esbuild/lib/main.js';
const S = process.argv[2];
await esbuild.build({ entryPoints: [S + '/fuzz/fuzz.entry.js'], bundle: true, outfile: S + '/fuzz/fuzz.bundle.mjs', format: 'esm', platform: 'node', loader: { '.js': 'jsx' },
  alias: { dexie: S + '/deps/dexie/dist/dexie.mjs' }, plugins: [{ name: 'raw', setup(b) { b.onResolve({ filter: /\?raw$/ }, a => ({ path: a.path, namespace: 'raw' })); b.onLoad({ filter: /.*/, namespace: 'raw' }, () => ({ contents: 'export default ""', loader: 'js' })); } }], logLevel: 'warning' });
await import(S + '/fuzz/fuzz.bundle.mjs');
