import fs from 'node:fs';

const file='index.html';
let s=fs.readFileSync(file,'utf8');
const original=s;
const old="async function fetchJSON(url){const c=new AbortController(),timer=setTimeout(()=>c.abort(),FETCH_TIMEOUT);try{const r=await fetch(url,{cache:'no-cache',signal:c.signal,headers:{Accept:'application/json'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(timer)}}";
const neu="async function fetchJSON(url){const c=new AbortController(),timer=setTimeout(()=>c.abort(),FETCH_TIMEOUT);const sep=url.includes('?')?'&':'?';const fresh=url+sep+'v='+Date.now();try{const r=await fetch(fresh,{cache:'no-store',signal:c.signal,headers:{Accept:'application/json','Cache-Control':'no-cache'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json()}finally{clearTimeout(timer)}}";
if(s.includes(old))s=s.replace(old,neu);
else if(!s.includes("const fresh=url+sep+'v='+Date.now()"))throw new Error('fetchJSON contract changed; refusing blind patch');

const marker='TENNIS_REFRESH_RESILIENCE_R1';
if(!s.includes(marker))s=s.replace('</script>\n</body>','// TENNIS_REFRESH_RESILIENCE_R1\n</script>\n</body>');

const premiumCsp="style-src 'self' 'unsafe-inline'; img-src 'self' data: https://commons.wikimedia.org https://upload.wikimedia.org; connect-src 'self' https://en.wikipedia.org https://www.wikidata.org;";
const cspRe=/style-src (?:'self' )?'unsafe-inline'; img-src 'self' data:(?: https:\/\/commons\.wikimedia\.org https:\/\/upload\.wikimedia\.org)?; connect-src 'self'(?: https:\/\/en\.wikipedia\.org)?(?: https:\/\/www\.wikidata\.org)?;/;
if(cspRe.test(s))s=s.replace(cspRe,premiumCsp);
else if(!s.includes(premiumCsp))throw new Error('CSP contract changed; refusing blind premium patch');

const photoTag='<script src="player-photos.js?v=20260911-v35"></script>';
const premiumTag='<script src="premium-shell-v1.js?v=20260911-v35-runtime-fix"></script>';
s=s.replace(/\s*<script src="player-photos\.js\?v=[^"]+"><\/script>\s*/g,'\n');
s=s.replace(/<script src="premium-shell-v1\.js\?v=[^"]+"><\/script>/g,premiumTag);
if(!s.includes(premiumTag))s=s.replace('</body>',`${photoTag}\n${premiumTag}\n</body>`);
else s=s.replace(premiumTag,`${photoTag}\n${premiumTag}`);

const runtimeTags=[
  '<script src="tennis-quant-math-v13.js?v=13.0"></script>',
  '<script src="tennis-quant-lab-v13.js?v=13.2-pro-metrics-premium-20260911"></script>',
  '<script src="tennis-quality-governance-v14.js?v=14.0"></script>'
];
s=s.replace(/<script src="tennis-quant-math-v13\.js\?v=[^"]+"><\/script>\s*/g,'');
s=s.replace(/<script src="tennis-quant-lab-v13\.js\?v=[^"]+"><\/script>\s*/g,'');
s=s.replace(/<script src="tennis-quality-governance-v14\.js\?v=[^"]+"><\/script>\s*/g,'');
const runtimeBlock=runtimeTags.join('\n');
if(!s.includes(photoTag)||!s.includes(premiumTag))throw new Error('V3.5 shell wiring missing');
s=s.replace(photoTag,`${runtimeBlock}\n${photoTag}`);

for(const required of ["cache:'no-store'","const fresh=url+sep+'v='+Date.now()",marker,'setInterval(()=>sync(),180000)',premiumCsp,photoTag,premiumTag,...runtimeTags]){
  if(!s.includes(required))throw new Error('missing refresh resilience marker: '+required);
}
for(const tag of [...runtimeTags,photoTag,premiumTag]){
  const count=s.split(tag).length-1;
  if(count!==1)throw new Error(`runtime tag count invalid (${count}): ${tag}`);
}
if(s!==original){fs.writeFileSync(file,s);console.log('Tennis refresh resilience + premium V3.5 runtime wiring normalized')}else console.log('Tennis premium V3.5 runtime wiring already normalized');
