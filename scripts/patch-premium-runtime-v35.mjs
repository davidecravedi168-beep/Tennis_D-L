import fs from 'node:fs';

const file='premium-shell-v1.js';
let s=fs.readFileSync(file,'utf8');
const original=s;

const replacements=[
  ["const nodes=$('[data-photo]',root).filter(","const nodes=$$('[data-photo]',root).filter("],
  ["$('.tp-nav button').forEach(","$$('.tp-nav button').forEach("]
];
for(const [oldValue,newValue] of replacements){
  s=s.split(oldValue).join(newValue);
}

s=s.replace("const VERSION='TEP_FULL_PREMIUM_UI_V3_4';","const VERSION='TEP_FULL_PREMIUM_UI_V3_5';");
s=s.replace(/window\.__TEP_FULL_PREMIUM_UI_V34/g,'window.__TEP_FULL_PREMIUM_UI_V35');

if(s.includes("const nodes=$('[data-photo]',root).filter("))throw new Error('portrait selector bug still present');
if(s.includes("$('.tp-nav button').forEach("))throw new Error('nav selector bug still present');
if(!s.includes("const nodes=$$('[data-photo]',root).filter("))throw new Error('portrait selector repair missing');
if((s.match(/\$\$\('\.tp-nav button'\)\.forEach\(/g)||[]).length<2)throw new Error('nav selector repair incomplete');
if(!s.includes("TEP_FULL_PREMIUM_UI_V3_5"))throw new Error('V3.5 version marker missing');

if(s!==original){fs.writeFileSync(file,s);console.log('PREMIUM_RUNTIME_V35_PATCHED')}else console.log('PREMIUM_RUNTIME_V35_ALREADY_PATCHED');
