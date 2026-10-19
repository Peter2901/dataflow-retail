// Builds the single-page version used for the claude.ai demo link (everything inlined).
import fs from 'fs';
const dist = 'dist/assets';
const files = fs.readdirSync(dist);
const js = fs.readFileSync(`${dist}/${files.find(f => f.endsWith('.js'))}`, 'utf8').replace(/<\/script/gi, '<\\/script');
const css = fs.readFileSync(`${dist}/${files.find(f => f.endsWith('.css'))}`, 'utf8');
fs.mkdirSync('artifact', { recursive: true });
fs.writeFileSync('artifact/index.html', `<title>DataFlow Retail</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap">
<style>${css}</style>
<div id="root"></div>
<script type="module">${js}</script>
`);
console.log('artifact/index.html', (fs.statSync('artifact/index.html').size / 1024).toFixed(0) + ' KB');
