import fs from 'node:fs/promises';
const FILE='data/surebet-cache.json';
export async function readCache(){try{return JSON.parse(await fs.readFile(FILE,'utf8'))}catch{return {events:{}}}}
export async function rememberOdds(raw,source='quant'){
  const list=Array.isArray(raw)?raw:raw?.data||raw?.events||[];
  if(!Array.isArray(list))return;
  const cache=await readCache(),now=Date.now();cache.events||={};
  for(const obj of list){
    const id=String(obj?.id??obj?.eventId??'');if(!id||!obj.home||!obj.away)continue;
    // Replace the whole snapshot, including withdrawals; never revive an old price.
    const bookmakers={};
    for(const [book,markets] of Object.entries(obj.bookmakers||{})){
      if(!Array.isArray(markets))continue;
      bookmakers[book]=markets.filter(m=>['ml','totals (games)','spread (games)'].includes(String(m.name).trim().toLowerCase())).map(m=>({name:m.name,updatedAt:m.updatedAt||null,odds:(Array.isArray(m.odds)?m.odds:[]).slice(0,80).map(o=>({home:o.home,away:o.away,draw:o.draw,over:o.over,under:o.under,hdp:o.hdp,max:o.max,updatedAt:o.updatedAt||null}))}));
    }
    cache.events[id]={fetched_at:new Date(now).toISOString(),source,odds:{id,home:obj.home,away:obj.away,date:obj.date,status:obj.status,sport:obj.sport,league:obj.league,bookmakers}};
  }
  cache.events=Object.fromEntries(Object.entries(cache.events).filter(([,e])=>now-Date.parse(e.fetched_at)<48*3600000).sort((a,b)=>Date.parse(b[1].fetched_at)-Date.parse(a[1].fetched_at)).slice(0,300));
  cache.updated_at=new Date(now).toISOString();await fs.mkdir('data',{recursive:true});await fs.writeFile(`${FILE}.tmp`,JSON.stringify(cache)+'\n');await fs.rename(`${FILE}.tmp`,FILE);
}
