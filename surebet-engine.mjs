import fs from 'node:fs/promises';
import { POLICY, analyzeMarkets, prioritize, timestamp } from './scripts/surebet-core.mjs';
import { readCache, rememberOdds } from './scripts/surebet-cache.mjs';
import { budgetFetch, budgetState, LIMITS } from './scripts/odds-budget.mjs';
const NOW=Date.now(),MODEL='TEP-SUREBET-2.0',REUSE=process.argv.includes('--reuse-only');
const read=async f=>{try{return JSON.parse(await fs.readFile(f,'utf8'))}catch{return null}};
const write=async(f,x)=>{await fs.mkdir('data',{recursive:true});await fs.writeFile(f+'.tmp',JSON.stringify(x,null,2)+'\n');await fs.rename(f+'.tmp',f)};
const eligible=e=>e.id&&e.home&&e.away&&!/[\/&]/.test(e.home+e.away)&&!/doubles|teams/i.test(e.league?.name||'')&&timestamp(e.date)>NOW&&timestamp(e.date)<=NOW+48*3600000;
const list=x=>Array.isArray(x)?x:x?.data||x?.events||[];
let calls=0;
async function api(endpoint,params={}){
  if(!process.env.ODDS_API_KEY)throw new Error('MISSING_ODDS_API_KEY');
  if(calls>=3)throw new Error('RUN_BUDGET_GUARD');
  const u=new URL('https://api.odds-api.io/v3'+endpoint);u.searchParams.set('apiKey',process.env.ODDS_API_KEY);
  for(const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  const r=await budgetFetch(u,{},'surebet');calls++;
  if(!r.ok)throw new Error(r.status===429?'RATE_LIMIT_429':`HTTP_${r.status}`);
  return r.json();
}
async function main(){
  const state=await read('data/surebet-state.json')||{cursor:0,books:{names:[]}},q=await read('data/quant-board.json');
  let cache=await readCache(),error=null,scanned=0;
  const universe=new Map();
  for(const x of [...(q?.upcoming||[]),...(q?.radar||[])]){const e={id:String(x.event_id||x.id||''),home:x.player_a||x.home,away:x.player_b||x.away,date:x.start_at||x.date,league:{name:x.tournament||x.league?.name}};if(eligible(e))universe.set(e.id,e)}
  for(const x of Object.values(cache.events||{})){const e=x.odds;if(eligible(e)&&!universe.has(e.id))universe.set(e.id,e)}
  if(!REUSE)try{
    let books=state.books?.names||[];
    if(!books.length||NOW-timestamp(state.books?.fetched_at)>12*3600000){const raw=await api('/bookmakers/selected');books=[...new Set((Array.isArray(raw)?raw:raw?.bookmakers||raw?.selected||raw?.data||[]).map(b=>typeof b==='string'?b:b.name||b.bookmaker||b.slug).filter(Boolean))];state.books={names:books,fetched_at:new Date(NOW).toISOString()}}
    if(books.length<2)throw new Error('SERVONO_ALMENO_DUE_BOOKMAKER');
    if(!universe.size)for(const e of list(await api('/events',{sport:'tennis',status:'pending',limit:50})))if(eligible(e))universe.set(String(e.id),e);
    // Reserve only the pages that fit after discovery; never exceed three calls.
    const limit=Math.min(20,Math.max(0,3-calls)*10),batch=prioritize([...universe.values()],cache.events,state.cursor,limit,NOW);
    for(let i=0;i<batch.length;i+=10){const page=batch.slice(i,i+10),raw=await api('/odds/multi',{eventIds:page.map(e=>e.id).join(','),bookmakers:books.join(',')});
      // A missing event invalidates its old snapshot, too.
      const returned=new Set(list(raw).map(x=>String(x.id??x.eventId)));
      await rememberOdds([...list(raw),...page.filter(e=>!returned.has(String(e.id))).map(e=>({...e,bookmakers:{}}))],'surebet');scanned+=page.length;
    }
    state.cursor=(state.cursor||0)+5;
  }catch(e){error=e.message}
  cache=await readCache();const checked=[];
  for(const e of universe.values())for(const row of analyzeMarkets(e,cache.events?.[e.id]?.odds,NOW))checked.push({...row,source:cache.events[e.id].source});
  checked.sort((a,b)=>Number(b.status==='SUREBET')-Number(a.status==='SUREBET')||(b.raw_roi??-1)-(a.raw_roi??-1));
  const status=error?(/BUDGET|RATE_LIMIT/.test(error)?'API_PAUSA':error==='MISSING_ODDS_API_KEY'?'SETUP':'ERROR'):'READY';
  const opportunities=status==='READY'?checked.filter(r=>r.status==='SUREBET'):[];
  const budget=await budgetState(),counts={};for(const row of checked)for(const reason of row.reasons)counts[reason]=(counts[reason]||0)+1;
  state.updated_at=new Date(NOW).toISOString();state.last_error=error;
  await write('data/surebet-state.json',state);
  await write('data/surebet-board.json',{meta:{updated_at:new Date(NOW).toISOString(),status,error,model_version:MODEL,source:REUSE?'Quote condivise Quant / Live · nessuna chiamata aggiuntiva':'Odds-API.io · quote condivise e scansione mirata',bookmakers:state.books?.names||[],bookmaker_count:state.books?.names?.length||0,events_total:universe.size,events_scanned:scanned,events_compared:new Set(checked.filter(r=>r.market_depth>=2).map(r=>r.event_id)).size,events_with_quotes:new Set(checked.map(r=>r.event_id)).size,markets_compared:checked.filter(r=>r.market_depth>=2).length,api_calls:calls,api_call_budget:3,shared_requests_24h:budget.requests.length,shared_budget_24h:LIMITS.daily,scanner_budget_24h:LIMITS.surebet,rejection_counts:counts,max_quote_age_min:POLICY.maxAge,max_timestamp_spread_min:POLICY.maxSpread,execution_ttl_min:POLICY.ttl,min_execution_window_sec:POLICY.minWindow,min_raw_roi:POLICY.minRoi,safety_buffer:POLICY.buffer,fail_closed:true,note:'ML, totali e handicap game a mezze linee identiche. Le regole di ritiro e annullamento richiedono verifica presso i bookmaker.'},opportunities,checked});
  console.log(JSON.stringify({status,api_calls:calls,compared:checked.length,opportunities:opportunities.length,error}));
}
if(process.argv.includes('--self-test'))await import('./scripts/test-surebet.mjs');else await main();
