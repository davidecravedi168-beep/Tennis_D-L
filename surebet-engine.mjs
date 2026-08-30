import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.ODDS_API_KEY;
const BASE='https://api.odds-api.io/v3';
const STATE='data/surebet-state.json';
const OUT='data/surebet-board.json';
const QUANT='data/quant-board.json';
const NOW=new Date();
const MODEL='TEP-SUREBET-1.1';
const MAX_EVENTS_PER_RUN=10;
const MAX_HOURS=48;
const MAX_QUOTE_AGE_MIN=15;
const MAX_TIMESTAMP_SPREAD_MIN=10;
const MIN_RAW_ROI=.005;
const SAFETY_BUFFER=.0025;
const MAX_OUTLIER_PP=.18;

const num=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
const ageMin=v=>{const t=new Date(v||0).getTime();return Number.isFinite(t)&&t>0?Math.max(0,(NOW-t)/60000):Infinity};
const uniq=a=>[...new Set(a.filter(Boolean))];
const singles=e=>{const a=String(e?.home||''),b=String(e?.away||''),l=String(e?.league?.name||'');return !!a&&!!b&&!/[\/&]/.test(a+b)&&!/doubles|mixed doubles|teams/i.test(l)};
const hoursUntil=v=>(new Date(v)-NOW)/36e5;
async function readJson(f){try{return JSON.parse(await fs.readFile(f,'utf8'))}catch{return null}}
async function writeJson(f,x){await fs.mkdir(path.dirname(f),{recursive:true});const t=`${f}.tmp-${process.pid}`;await fs.writeFile(t,JSON.stringify(x,null,2)+'\n');await fs.rename(t,f)}

let state=await readJson(STATE)||{cursor:0,books:{names:[],fetched_at:null},detections:[]};
let calls=0;
async function api(endpoint,params={}){
  if(!API_KEY)throw new Error('MISSING_ODDS_API_KEY');
  const u=new URL(BASE+endpoint);u.searchParams.set('apiKey',API_KEY);
  for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,String(v));
  const r=await fetch(u,{headers:{'user-agent':'TennisEdgePro-SureBet/1.1'}});calls++;
  if(r.status===429)throw new Error('HTTP_429');
  if(!r.ok)throw new Error(`${endpoint} HTTP ${r.status}`);
  return r.json();
}
function selectedNames(x){
  const a=Array.isArray(x)?x:(x?.bookmakers||x?.selected||x?.data||[]);
  return uniq(a.map(v=>typeof v==='string'?v:(v?.name||v?.bookmaker||v?.slug)));
}
function quantEvents(q){
  const src=[...(Array.isArray(q?.upcoming)?q.upcoming:[]),...(Array.isArray(q?.radar)?q.radar:[])],seen=new Set(),out=[];
  for(const x of src){
    const id=String(x?.event_id||x?.id||'');if(!id||seen.has(id))continue;seen.add(id);
    out.push({id,date:x?.start_at||x?.date,home:x?.player_a||x?.home,away:x?.player_b||x?.away,league:{name:x?.tournament||x?.league?.name||'Tennis'}});
  }
  return out;
}
function quantApiPaused(q){
  const reset=new Date(q?.meta?.rate_limit_reset_at||0).getTime();
  const paused=String(q?.meta?.status||'').includes('API PAUSA')||String(q?.meta?.error||'').includes('429');
  return paused&&Number.isFinite(reset)&&reset>NOW.getTime()?new Date(reset).toISOString():null;
}
function rowsFromOdds(obj){
  const rows=[];
  for(const[book,markets]of Object.entries(obj?.bookmakers||{})){
    const ml=(markets||[]).find(m=>String(m?.name||'').toUpperCase()==='ML');
    const o=ml?.odds?.[0];
    const a=num(o?.home),b=num(o?.away);if(!(a>1&&b>1))continue;
    const z=1/a+1/b,margin=z-1;if(margin<-.03||margin>.30)continue;
    const updatedAt=ml?.updatedAt||o?.updatedAt||null;
    rows.push({book,a,b,updated_at:updatedAt,age_min:ageMin(updatedAt),p_a_no_vig:(1/a)/z,book_margin:margin});
  }
  return rows;
}
function allocation(total,qa,qb){
  const cents=Math.max(2,Math.round(total*100)),s=1/qa+1/qb;
  const theoretical=total*(1/qa)/s,base=Math.round(theoretical*100);let best=null;
  for(let ca=Math.max(1,base-8);ca<=Math.min(cents-1,base+8);ca++){
    const cb=cents-ca,sa=ca/100,sb=cb/100,ra=sa*qa,rb=sb*qb,worst=Math.min(ra,rb);
    if(!best||worst>best.worst_return)best={stake_a:sa,stake_b:sb,return_if_a:ra,return_if_b:rb,worst_return:worst};
  }
  const spent=best.stake_a+best.stake_b,profit=best.worst_return-spent;
  return{...best,total:spent,guaranteed_profit:profit,guaranteed_roi:profit/spent};
}
function analyze(event,obj){
  const rows=rowsFromOdds(obj);if(rows.length<2)return null;
  const med=[...rows].sort((x,y)=>x.p_a_no_vig-y.p_a_no_vig)[Math.floor(rows.length/2)]?.p_a_no_vig??.5;
  let best=null;
  for(const ra of rows)for(const rb of rows){
    if(ra.book===rb.book)continue;
    const qa=ra.a,qb=rb.b,sum=1/qa+1/qb,rawRoi=1/sum-1;
    if(!best||sum<best.implied_sum)best={qa,qb,book_a:ra.book,book_b:rb.book,updated_a:ra.updated_at,updated_b:rb.updated_at,age_a:ra.age_min,age_b:rb.age_min,implied_sum:sum,raw_roi:rawRoi,p_a_no_vig:ra.p_a_no_vig,p_b_source:rb.p_a_no_vig};
  }
  if(!best)return null;
  const tA=new Date(best.updated_a||0).getTime(),tB=new Date(best.updated_b||0).getTime();
  const spread=Number.isFinite(tA)&&Number.isFinite(tB)&&tA>0&&tB>0?Math.abs(tA-tB)/60000:Infinity;
  const outlier=Math.max(Math.abs(best.p_a_no_vig-med),Math.abs(best.p_b_source-med));
  const reasons=[];
  if(best.raw_roi<MIN_RAW_ROI)reasons.push('MARGINE_TROPPO_BASSO');
  if(!Number.isFinite(best.age_a)||!Number.isFinite(best.age_b)||best.age_a>MAX_QUOTE_AGE_MIN||best.age_b>MAX_QUOTE_AGE_MIN)reasons.push('QUOTA_NON_FRESCA');
  if(spread>MAX_TIMESTAMP_SPREAD_MIN)reasons.push('QUOTE_NON_SINCRONE');
  if(outlier>MAX_OUTLIER_PP)reasons.push('QUOTA_OUTLIER');
  const alloc=allocation(100,best.qa,best.qb),buffered=alloc.guaranteed_roi-SAFETY_BUFFER;
  if(buffered<=0)reasons.push('BUFFER_NON_SUPERATO');
  const status=best.raw_roi>0&&!reasons.length?'SUREBET':'NON_CERTIFICATA';
  return{
    event_id:String(event.id),start_at:event.date,player_a:event.home,player_b:event.away,tournament:event.league?.name||'—',market:'MATCH_WINNER',status,
    book_a:best.book_a,book_b:best.book_b,odds_a:best.qa,odds_b:best.qb,updated_a:best.updated_a,updated_b:best.updated_b,age_a_min:Number.isFinite(best.age_a)?+best.age_a.toFixed(1):null,age_b_min:Number.isFinite(best.age_b)?+best.age_b.toFixed(1):null,timestamp_spread_min:Number.isFinite(spread)?+spread.toFixed(1):null,
    implied_sum:+best.implied_sum.toFixed(8),raw_roi:+best.raw_roi.toFixed(8),safety_buffer:SAFETY_BUFFER,buffered_roi:+buffered.toFixed(8),market_depth:rows.length,median_no_vig_a:+med.toFixed(6),outlier_distance:+outlier.toFixed(6),reasons,
    stake_100:{stake_a:+alloc.stake_a.toFixed(2),stake_b:+alloc.stake_b.toFixed(2),return_if_a:+alloc.return_if_a.toFixed(2),return_if_b:+alloc.return_if_b.toFixed(2),worst_return:+alloc.worst_return.toFixed(2),profit:+alloc.guaranteed_profit.toFixed(2),roi:+alloc.guaranteed_roi.toFixed(8)},
    detected_at:NOW.toISOString(),execution_note:'Copertura matematica valida solo se entrambe le puntate vengono accettate alle quote indicate e il regolamento di settlement è equivalente.'
  };
}
function mapMulti(raw){const a=Array.isArray(raw)?raw:(raw?.data||raw?.events||[]);return new Map(a.map(x=>[String(x.id??x.eventId),x]))}
async function publishPaused(prev,reset,error='RATE_LIMIT_SHARED'){
  await writeJson(STATE,{...state,updated_at:NOW.toISOString(),last_error:error,rate_limit_reset_at:reset||null});
  await writeJson(OUT,{meta:{...(prev?.meta||{}),updated_at:NOW.toISOString(),status:'API_PAUSA',model_version:MODEL,error,rate_limit_reset_at:reset||null,note:'Scanner fermato per proteggere la quota gratuita. Nessuna vecchia opportunità viene mostrata come attiva.'},opportunities:[],checked:[]});
}
async function main(){
  const prev=await readJson(OUT),quant=await readJson(QUANT);
  if(!API_KEY){await writeJson(STATE,{...state,updated_at:NOW.toISOString(),last_error:'MISSING_ODDS_API_KEY'});await writeJson(OUT,{meta:{updated_at:NOW.toISOString(),status:'SETUP',model_version:MODEL,note:'Manca ODDS_API_KEY.'},opportunities:[],checked:[]});return}
  const sharedReset=quantApiPaused(quant);if(sharedReset){await publishPaused(prev,sharedReset);return}
  try{
    let books=selectedNames(state.books?.names||quant?.meta?.bookmakers||[]);
    if(!books.length){books=selectedNames(await api('/bookmakers/selected'));state.books={names:books,fetched_at:NOW.toISOString()}}
    else state.books={names:books,fetched_at:state.books?.fetched_at||NOW.toISOString()};
    if(books.length<2)throw new Error('SERVONO_ALMENO_DUE_BOOKMAKER');
    let events=quantEvents(quant).filter(e=>singles(e)&&hoursUntil(e.date)>0&&hoursUntil(e.date)<=MAX_HOURS).sort((a,b)=>new Date(a.date)-new Date(b.date));
    if(!events.length){const er=await api('/events',{sport:'tennis'});events=(Array.isArray(er)?er:(er?.data||er?.events||[])).filter(e=>singles(e)&&String(e?.status||'pending')==='pending'&&hoursUntil(e.date)>0&&hoursUntil(e.date)<=MAX_HOURS).sort((a,b)=>new Date(a.date)-new Date(b.date))}
    const total=events.length,start=total?(state.cursor||0)%total:0,batch=[];for(let i=0;i<Math.min(MAX_EVENTS_PER_RUN,total);i++)batch.push(events[(start+i)%total]);state.cursor=total?(start+batch.length)%total:0;
    const raw=batch.length?await api('/odds/multi',{eventIds:batch.map(e=>e.id).join(','),bookmakers:books.join(',')}):[];const byId=mapMulti(raw),all=[];
    for(const e of batch){const x=analyze(e,byId.get(String(e.id)));if(x)all.push(x)}
    const opportunities=all.filter(x=>x.status==='SUREBET').sort((a,b)=>b.buffered_roi-a.buffered_roi);
    state.detections=[...opportunities,...(state.detections||[])].slice(0,120);state.updated_at=NOW.toISOString();state.last_error=null;await writeJson(STATE,state);
    await writeJson(OUT,{meta:{updated_at:NOW.toISOString(),status:'READY',model_version:MODEL,source:'Odds-API.io selected bookmakers · shared Tennis Edge event universe',bookmakers:books,bookmaker_count:books.length,events_total:total,events_scanned:batch.length,api_calls:calls,max_quote_age_min:MAX_QUOTE_AGE_MIN,max_timestamp_spread_min:MAX_TIMESTAMP_SPREAD_MIN,min_raw_roi:MIN_RAW_ROI,safety_buffer:SAFETY_BUFFER,fail_closed:true,note:'Solo arbitraggio 2-way Match Winner tra bookmaker diversi. Nessun modello predittivo viene usato.'},opportunities,checked:all.slice(0,50)});
  }catch(e){
    if(e.message==='HTTP_429'){await publishPaused(prev,null,'HTTP_429');return}
    await writeJson(STATE,{...state,updated_at:NOW.toISOString(),last_error:e.message});
    await writeJson(OUT,{meta:{...(prev?.meta||{}),updated_at:NOW.toISOString(),status:'ERROR',model_version:MODEL,error:e.message,note:'Fail-closed: nessuna opportunità attiva finché il feed non torna valido.'},opportunities:[],checked:[]});process.exitCode=0;
  }
}
function selfTest(){
  const now=NOW.toISOString(),e={id:'T1',date:new Date(NOW.getTime()+3600000).toISOString(),home:'A',away:'B',league:{name:'ATP Test'}},o={bookmakers:{Alpha:[{name:'ML',odds:[{home:2.20,away:1.72}],updatedAt:now}],Beta:[{name:'ML',odds:[{home:1.80,away:2.05}],updatedAt:now}],Gamma:[{name:'ML',odds:[{home:1.92,away:1.92}],updatedAt:now}]}};
  const r=analyze(e,o);if(!r||r.status!=='SUREBET'||r.book_a!=='Alpha'||r.book_b!=='Beta'||!(r.stake_100.profit>5))throw new Error('SELFTEST_ARB');
  const a=allocation(100,2.2,2.05);if(Math.abs(a.stake_a+a.stake_b-100)>.001||a.guaranteed_profit<=0)throw new Error('SELFTEST_STAKE');
  const stale=analyze(e,{bookmakers:{A:[{name:'ML',odds:[{home:2.20,away:1.70}],updatedAt:new Date(NOW-20*60000).toISOString()}],B:[{name:'ML',odds:[{home:1.80,away:2.05}],updatedAt:now}]}});if(stale?.status==='SUREBET')throw new Error('SELFTEST_STALE_GATE');
  console.log(JSON.stringify({ok:true,model:MODEL,tests:['cross_book_arb','cent_rounding','freshness_gate','outlier_guard','fail_closed_stale']}));
}
if(process.argv.includes('--self-test'))selfTest();else await main();
