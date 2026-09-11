import fs from 'node:fs';
import vm from 'node:vm';

const OUT='player-photos.js';
const readJson=p=>{try{return JSON.parse(fs.readFileSync(p,'utf8'))}catch{return null}};
const pretty=raw=>{const s=String(raw||'').trim();if(!s)return'';if(s.includes(',')){const [last,...rest]=s.split(',');return `${rest.join(',').trim()} ${last.trim()}`.trim()}return s};
const invalid=n=>!n||/^(wsf|r16p|qf|sf)\d+/i.test(n)||/^tbd$/i.test(n);

function currentCatalog(){
  if(!fs.existsSync(OUT))return{};
  try{const box={window:{}};vm.runInNewContext(fs.readFileSync(OUT,'utf8'),box);return box.window.__TEP_PLAYER_PHOTOS__||{}}catch{return{}}
}

function collectNames(){
  const board=readJson('data/quant-board.json')||{};
  const live=readJson('data/live-board.json')||{};
  const rows=[...(Array.isArray(board.upcoming)?board.upcoming:[]),...(Array.isArray(board.radar)?board.radar.slice(0,40):[]),...(Array.isArray(live.events)?live.events.slice(0,30):[])];
  const out=[];
  for(const r of rows){
    for(const raw of [r?.player_a,r?.player_b,r?.home,r?.away]){
      const n=pretty(raw);if(invalid(n)||out.includes(n))continue;out.push(n);
    }
  }
  return out.slice(0,80);
}

async function fetchJson(url,timeout=6500){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),timeout);
  try{const r=await fetch(url,{signal:c.signal,headers:{Accept:'application/json','User-Agent':'TennisEdgePro/1.0'}});if(!r.ok)return null;return await r.json()}catch{return null}finally{clearTimeout(t)}
}

async function verifyImage(url){
  if(!url)return'';
  const c=new AbortController(),t=setTimeout(()=>c.abort(),6500);
  try{
    let r=await fetch(url,{method:'HEAD',redirect:'follow',signal:c.signal,headers:{'User-Agent':'TennisEdgePro/1.0'}});
    if(!r.ok||!String(r.headers.get('content-type')||'').toLowerCase().startsWith('image/')){
      r=await fetch(url,{method:'GET',redirect:'follow',signal:c.signal,headers:{Range:'bytes=0-1023','User-Agent':'TennisEdgePro/1.0'}});
    }
    const type=String(r.headers.get('content-type')||'').toLowerCase();
    return r.ok&&type.startsWith('image/')?r.url:'';
  }catch{return''}finally{clearTimeout(t)}
}

async function resolvePhoto(name){
  const title=encodeURIComponent(name.replace(/\s+/g,'_'));
  const summary=await fetchJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`);
  for(const u of [summary?.thumbnail?.source,summary?.originalimage?.source]){const v=await verifyImage(u);if(v)return v}

  const q=encodeURIComponent(name);
  const search=await fetchJson(`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${q}&language=en&uselang=en&limit=8&format=json&origin=*`);
  const hit=(search?.search||[]).find(x=>/tennis/i.test(String(x?.description||'')));
  if(hit?.id){
    const ent=await fetchJson(`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${encodeURIComponent(hit.id)}&props=claims&format=json&origin=*`);
    const file=ent?.entities?.[hit.id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if(file){
      const special=`https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(String(file).replace(/ /g,'_'))}?width=900`;
      const v=await verifyImage(special);if(v)return v;
    }
  }

  const wikiSearch=await fetchJson(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(name+' tennis')}&gsrlimit=5&prop=pageimages&piprop=thumbnail&pithumbsize=900&format=json&origin=*`);
  for(const p of Object.values(wikiSearch?.query?.pages||{})){const v=await verifyImage(p?.thumbnail?.source);if(v)return v}
  return'';
}

const names=collectNames();
const catalog={...currentCatalog()};
const missing=names.filter(n=>!catalog[n.toLowerCase()]);
let resolved=0;
const queue=[...missing];
const workers=Array.from({length:Math.min(6,queue.length||1)},async()=>{
  while(queue.length){
    const name=queue.shift();
    const url=await resolvePhoto(name);
    if(url){catalog[name.toLowerCase()]=url;resolved++;console.log('PHOTO_OK',name)}else console.log('PHOTO_MISS',name);
  }
});
await Promise.all(workers);
const ordered=Object.fromEntries(Object.entries(catalog).sort(([a],[b])=>a.localeCompare(b)));
fs.writeFileSync(OUT,`// Generated from public Wikimedia/Wikidata sources.\nwindow.__TEP_PLAYER_PHOTOS__=Object.freeze(${JSON.stringify(ordered,null,2)});\n`);
console.log(`PHOTO_CATALOG names=${names.length} total=${Object.keys(ordered).length} new=${resolved}`);
if(names.length&&Object.keys(ordered).length===0)process.exitCode=2;
