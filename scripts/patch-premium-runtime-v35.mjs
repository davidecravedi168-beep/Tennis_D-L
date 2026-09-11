import fs from 'node:fs';

const file='premium-shell-v1.js';
let s=fs.readFileSync(file,'utf8');
const original=s;

// Normalize selectors to exactly the collection helper, even if an earlier
// non-idempotent patch accidentally produced $$$().
s=s.replace(/const nodes=\$+\('\[data-photo\]',root\)\.filter\(/g,()=>"const nodes=$$('[data-photo]',root).filter(");
s=s.replace(/\$+\('\.tp-nav button'\)\.forEach\(/g,()=>"$$('.tp-nav button').forEach(");

s=s.replace(/const VERSION='TEP_FULL_PREMIUM_UI_V3_[45]';/,"const VERSION='TEP_FULL_PREMIUM_UI_V3_5';");
s=s.replace(/window\.__TEP_FULL_PREMIUM_UI_V3[45]/g,'window.__TEP_FULL_PREMIUM_UI_V35');

// Normalize every portrait URL before assigning it. This also repairs stale
// localStorage entries created with the thumb.wikimedia.org host, which the CSP
// intentionally does not allow.
const tryOld="async function tryImage(el,img,src){return new Promise(resolve=>";
const tryNew="async function tryImage(el,img,src){src=String(src||'').replace('https://thumb.wikimedia.org/','https://upload.wikimedia.org/');return new Promise(resolve=>";
if(s.includes(tryOld))s=s.replace(tryOld,tryNew);

const summaryOld="if(src)out.push(src)";
const summaryNew="if(src)out.push(String(src).replace('https://thumb.wikimedia.org/','https://upload.wikimedia.org/'))";
s=s.split(summaryOld).join(summaryNew);
const searchOld="if(src&&!out.includes(src))out.push(src)";
const searchNew="if(src&&!out.includes(src))out.push(String(src).replace('https://thumb.wikimedia.org/','https://upload.wikimedia.org/'))";
s=s.split(searchOld).join(searchNew);

const navBad=/(?<!\$)\$\('\.tp-nav button'\)\.forEach\(|\$\$\$+\('\.tp-nav button'\)\.forEach\(/;
if(!s.includes("const nodes=$$('[data-photo]',root).filter("))throw new Error('portrait selector repair missing');
if(navBad.test(s))throw new Error('nav selector normalization failed');
if((s.match(/\$\$\('\.tp-nav button'\)\.forEach\(/g)||[]).length<2)throw new Error('nav selector repair incomplete');
if(!s.includes("TEP_FULL_PREMIUM_UI_V3_5"))throw new Error('V3.5 version marker missing');
if(!s.includes("src=String(src||'').replace('https://thumb.wikimedia.org/','https://upload.wikimedia.org/')"))throw new Error('portrait URL normalization missing');

if(s!==original){fs.writeFileSync(file,s);console.log('PREMIUM_RUNTIME_V35_PATCHED')}else console.log('PREMIUM_RUNTIME_V35_ALREADY_PATCHED');
