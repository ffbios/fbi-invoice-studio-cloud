const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const dir = path.join(root, 'deploy');
const names = fs.readdirSync(dir);
const parts = names.filter(function (n) { return n.indexOf('index.part.') === 0; });
parts.sort(function (a, b) { return a.localeCompare(b, undefined, { numeric: true }); });
if (!parts.length) throw new Error('Invoice Studio source parts are missing');
let html = parts.map(function (n) { return fs.readFileSync(path.join(dir, n), 'utf8'); }).join('');
// Feature modules kept in their own files and added to the end of the page.
const extras = ['momo-ui.html', 'notify-ui.html'].filter(function (n) { return fs.existsSync(path.join(root, n)); });
extras.forEach(function (n) { html += '\n' + fs.readFileSync(path.join(root, n), 'utf8'); });
fs.writeFileSync(path.join(root, 'index.html'), html, 'utf8');
console.log('Built index.html from ' + parts.length + ' source parts' + (extras.length ? ' + ' + extras.join(', ') : '') + ' (' + html.length + ' bytes).');
