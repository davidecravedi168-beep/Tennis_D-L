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

for(const required of ["cache:'no-store'","const fresh=url+sep+'v='+Date.now()",marker,'setInterval(()=>sync(),180000)']){
  if(!s.includes(required)) throw new Error('missing refresh resilience marker: '+required);
}
if(s!==original){fs.writeFileSync(file,s);console.log('Tennis refresh resilience applied')}else console.log('Tennis refresh resilience already applied');
