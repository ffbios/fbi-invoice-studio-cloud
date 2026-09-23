const fs=require('node:fs');
const path=require('node:path');
const root=__dirname;
const dir=path.join(root,'deploy');
const parts=fs.readdirSync(dir).filter(n=>/^index\.part\.\d+$/.test(n)).sort();
if(!parts.length) throw new Error('Invoice Studio source parts are missing');
const html=parts.map(n=>fs.readFileSync(path.join(dir,n),'utf8')).join('');
fs.writeFileSync(path.join(root,'index.html'),html,'utf8');
console.log(`Built index.html from ${parts.length} source parts (${html.length} bytes).`);