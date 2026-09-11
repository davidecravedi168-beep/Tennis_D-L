import fs from 'node:fs';

const file='index.html';
let s=fs.readFileSync(file,'utf8');
const original=s;
const old="async function fetchJSON(url){const c=new AbortController(),timer=setTimeout(()=>c.abort(),FETCH_TIMEOUT);try{const r=await fetch(url,{cache:'no-cache',signal:c.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(timer)}}";
const neu="async function fetchJSON(url){const c=new AbortController(),timer=setTimeout(()=>c.abort(),FETCH_TIMEOUT);const sep=url.includes('?')?'&':'?';const fresh=url+sep+'v='+Date.now();try{const r=await fetch(fresh,{cache:'no-store',signal:c.signal,headers:{Accept:'application/json','Cache-Control':'no-cache'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(timer)}}";
if(s.includes(old)) s=s.replace(old,neu);
else if(!s.includes("const fresh=url+sep+'v='+Date.now()")) throw new Error('fetchJSON contract changed; refusing blind patch');

const marker='TENNIS_REFRESH_RESILIENCE_R1';
if(!s.includes(marker)) s=s.replace('</script>\n</body>','// TENNIS_REFRESH_RESILIENCE_R1\n</script>\n</body>');

const oldCsp="style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self';";
const premiumCsp="style-src 'self' 'unsafe-inline'; img-src 'self' data: https://commons.wikimedia.org https://upload.wikimedia.org; connect-src 'self' https://en.wikipedia.org;";
if(s.includes(oldCsp)) s=s.replace(oldCsp,premiumCsp);
else if(!s.includes(premiumCsp)) throw new Error('CSP contract changed; refusing blind premium patch');

const premiumTag='<script src="premium-shell-v1.js?v=20260911-r1"></script>';
const premiumRe=/<script src="premium-shell-v1\.js\?v=[^"]+"><\/script>/;
if(premiumRe.test(s)) s=s.replace(premiumRe,premiumTag);
else if(!s.includes(premiumTag)) s=s.replace('</body>',`${premiumTag}\n</body>`);

for(const required of [
  "cache:'no-store'",
  "const fresh=url+sep+'v='+Date.now()",
  marker,
  'setInterval(()=>sync(),180000)',
  premiumCsp,
  premiumTag
]){
  if(!s.includes(required)) throw new Error('missing refresh resilience marker: '+required);
}
if(s!==original){fs.writeFileSync(file,s);console.log('Tennis refresh resilience + premium shell applied')}else console.log('Tennis refresh resilience + premium shell already applied');
