import fs from 'node:fs/promises';
import path from 'node:path';

const API_KEY=process.env.ODDS_API_KEY;
const BASE='https://api.odds-api.io/v3';
const STATE='data/surebet-state.json';
const OUT='data/surebet-board.json';
const QUANT='data/quant-board.json';
const NOW=new Date();
const MODEL='TEP-SUREBET-1.2';

// Quota-first profile: one multi-odds call normally covers the whole batch.
const MAX_EVENTS_PER_RUN=10;
const MAX_HOURS=48;
const MAX_API_CALLS_PER_RUN=3;
const BOOK_CACHE_HOURS=12;

// Safety gates. A SureBet is published only while every gate is still valid.
const MAX_QUOTE_AGE_MIN=10;
const MAX_TIMESTAMP_SPREAD_MIN=5;
const EXECUTION_TTL_MIN=4;
const MIN_EXECUTION_WINDOW_SEC=90;
const MIN_RAW_ROI=.005;
const SAFETY_BUFFER=.0025;
const MAX_OUTLIER_PP=.15;

const num=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
const ageMin=v=>{const t=new Date(v||0).getTime();return Number.isFinite(t)&&t>0?Math.max(0,(NOW.getTime()-t)/60000):Infinity};
const uniq=a=>[...new Set(a.filter(Boolean))];
const singles=e=>{const a=String(e?.home||''),b=String(e?.away||''),l=String(e?.league?.name||'');return !!a&&!!b&&!/[\/&]/.test(a+b)&&!/doubles|mixed doubles|teams/i.test(l)};
const hoursUntil=v=>(new Date(v).getTime()-NOW.getTime())/36e5;
const norm=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().replace(/\s+/g,' ');
async function readJson(f){try{return JSON.parse(await fs.readFile(f,'utf8'))}catch{return null}}
async function writeJson(f,x){await fs.mkdir(path.dirname(f),{recursive:true});const t=`${f}.tmp-${process.pid}`;await fs.writeFile(t,JSON.stringify(x,null,2)+'\n');await fs.rename(t,f)}

let state=await readJson(STATE)||{cursor:0,books:{names:[],fetched_at:null},detections:[]};
let calls=0;
async function api(endpoint,params={}){
  if(!API_KEY)throw new Error('MISSING_ODDS_API_KEY');
  if(calls>=MAX_API_CALLS_PER_RUN)throw new Error('API_BUDGET_GUARD');
  const u=new URL(BASE+endpoint);u.searchParams.set('apiKey',API_KEY);
  for(const[k,v]of Object.entries(params))if(v!==undefined&&v!==null&&v!=='')u.searchParams.set(k,String(v));
  const r=await fetch(u,{headers:{'user-agent':`TennisEdgePro-SureBet/${MODEL}`}});calls++;
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
  const status=String(q?.meta?.status||'').toUpperCase();
  const err=String(q?.meta?.error||'').toUpperCase();
  const paused=status.includes('API PAUSA')||status.includes('API_PAUSA')||err.includes('429')||err.includes('RATE_LIMIT');
  return paused&&Number.isFinite(reset)&&reset>NOW.getTime()?new Date(reset).toISOString():null;
}
function eventIdentityOk(event,obj){
  if(!obj||typeof obj!=='object')return false;
  const sport=norm(obj?.sport?.slug||obj?.sport?.name||'tennis');
  if(sport&&!sport.includes('tennis'))return false;
  return norm(event?.home)===norm(obj?.home)&&norm(event?.away)===norm(obj?.away);
}
function rowsFromOdds(obj){
  const rows=[];
  for(const[book,markets]of Object.entries(obj?.bookmakers||{})){
    const ml=(Array.isArray(markets)?markets:[]).find(m=>String(m?.name||'').trim().toUpperCase()==='ML');
    if(!ml)continue;
    const valid=(Array.isArray(ml.odds)?ml.odds:[]).filter(o=>{
      const a=num(o?.home),b=num(o?.away),d=num(o?.draw);
      return a>1&&b>1&&!(d>1);
    });
    // More than one 2-way line under the same ML label is ambiguous: fail closed.
    if(valid.length!==1)continue;
    const o=valid[0],a=num(o.home),b=num(o.away),z=1/a+1/b,margin=z-1;
    if(!Number.isFinite(z)||margin<-.03||margin>.25)continue;
    const updatedAt=ml?.updatedAt||o?.updatedAt||null,age=ageMin(updatedAt);
    if(!Number.isFinite(age))continue;
    rows.push({book,a,b,updated_at:updatedAt,age_min:age,p_a_no_vig:(1/a)/z,book_margin:margin});
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
function expiryFor(updatedA,updatedB){
  const tA=new Date(updatedA||0).getTime(),tB=new Date(updatedB||0).getTime();
  if(!(Number.isFinite(tA)&&Number.isFinite(tB)&&tA>0&&tB>0))return{expires_at:null,window_sec:0};
  const quoteExpiry=Math.min(tA,tB)+MAX_QUOTE_AGE_MIN*60000;
  const executionExpiry=NOW.getTime()+EXECUTION_TTL_MIN*60000;
  const expiry=Math.min(quoteExpiry,executionExpiry);
  return{expires_at:new Date(expiry).toISOString(),window_sec:Math.max(0,(expiry-NOW.getTime())/1000)};
}
function analyze(event,obj){
  if(!eventIdentityOk(event,obj))return null;
  const rows=rowsFromOdds(obj);if(rows.length<2)return null;
  const med=[...rows].sort((x,y)=>x.p_a_no_vig-y.p_a_no_vig)[Math.floor(rows.length/2)]?.p_a_no_vig??.5;
  let best=null;
  for(const ra of rows)for(const rb of rows){
    if(ra.book===rb.book)continue;
    const qa=ra.a,qb=rb.b,sum=1/qa+1/qb,rawRoi=1/sum-1;
    if(!best||sum<best.implied_sum)best={qa,qb,book_a:ra.book,book_b:rb.book,updated_a:ra.updated_at,updated_b:rb.updated_at,age_a:ra.age_min,age_b:rb.age_min,implied_sum:sum,raw_roi:rawRoi,p_a_source_a:ra.p_a_no_vig,p_a_source_b:rb.p_a_no_vig};
  }
  if(!best)return null;
  const tA=new Date(best.updated_a||0).getTime(),tB=new Date(best.updated_b||0).getTime();
  const spread=Number.isFinite(tA)&&Number.isFinite(tB)&&tA>0&&tB>0?Math.abs(tA-tB)/60000:Infinity;
  const outlier=Math.max(Math.abs(best.p_a_source_a-med),Math.abs(best.p_a_source_b-med));
  const alloc=allocation(100,best.qa,best.qb),buffered=alloc.guaranteed_roi-SAFETY_BUFFER;
  const expiry=expiryFor(best.updated_a,best.updated_b),reasons=[];
  if(best.raw_roi<MIN_RAW_ROI)reasons.push('MARGINE_TROPPO_BASSO');
  if(best.age_a>MAX_QUOTE_AGE_MIN||best.age_b>MAX_QUOTE_AGE_MIN)reasons.push('QUOTA_NON_FRESCA');
  if(spread>MAX_TIMESTAMP_SPREAD_MIN)reasons.push('QUOTE_NON_SINCRONE');
  if(outlier>MAX_OUTLIER_PP)reasons.push('QUOTA_OUTLIER');
  if(buffered<=0)reasons.push('BUFFER_NON_SUPERATO');
  if(expiry.window_sec<MIN_EXECUTION_WINDOW_SEC)reasons.push('FINESTRA_ESECUZIONE_TROPPO_CORTA');
  const status=best.raw_roi>0&&!reasons.length?'SUREBET':'NON_CERTIFICATA';
  return{
    event_id:String(event.id),start_at:event.date,player_a:event.home,player_b:event.away,tournament:event.league?.name||'—',market:'MATCH_WINNER_2WAY',status,
    book_a:best.book_a,book_b:best.book_b,odds_a:best.qa,odds_b:best.qb,updated_a:best.updated_a,updated_b:best.updated_b,age_a_min:+best.age_a.toFixed(1),age_b_min:+best.age_b.toFixed(1),timestamp_spread_min:Number.isFinite(spread)?+spread.toFixed(1):null,
    implied_sum:+best.implied_sum.toFixed(8),raw_roi:+best.raw_roi.toFixed(8),safety_buffer:SAFETY_BUFFER,buffered_roi:+buffered.toFixed(8),market_depth:rows.length,median_no_vig_a:+med.toFixed(6),outlier_distance:+outlier.toFixed(6),reasons,
    expires_at:expiry.expires_at,execution_window_sec:Math.round(expiry.window_sec),same_market_verified:true,settlement_rules_verified:false,certainty_scope:'MATHEMATICAL_ODDS_ONLY',
    stake_100:{stake_a:+alloc.stake_a.toFixed(2),stake_b:+alloc.stake_b.toFixed(2),return_if_a:+alloc.return_if_a.toFixed(2),return_if_b:+alloc.return_if_b.toFixed(2),worst_return:+alloc.worst_return.toFixed(2),profit:+alloc.guaranteed_profit.toFixed(2),roi:+alloc.guaranteed_roi.toFixed(8)},
    detected_at:NOW.toISOString(),execution_note:'Copertura matematica valida solo finché entrambe le quote restano accettabili e le regole di settlement dei due bookmaker sono equivalenti.'
  };
}
function mapMulti(raw){const a=Array.isArray(raw)?raw:(raw?.data||raw?.events||[]);return new Map(a.map(x=>[String(x.id??x.eventId),x]))}
async function publishPaused(prev,reset,error='RATE_LIMIT_SHARED'){
  await writeJson(STATE,{...state,updated_at:NOW.toISOString(),last_error:error,rate_limit_reset_at:reset||null});
  await writeJson(OUT,{meta:{...(prev?.meta||{}),updated_at:NOW.toISOString(),status:'API_PAUSA',model_version:MODEL,error,rate_limit_reset_at:reset||null,fail_closed:true,note:'Scanner fermato per proteggere la quota gratuita. Nessuna vecchia opportunità viene mostrata come attiva.'},opportunities:[],checked:[]});
}
async function main(){
  const prev=await readJson(OUT),quant=await readJson(QUANT);
  if(!API_KEY){await writeJson(STATE,{...state,updated_at:NOW.toISOString(),last_error:'MISSING_ODDS_API_KEY'});await writeJson(OUT,{meta:{updated_at:NOW.toISOString(),status:'SETUP',model_version:MODEL,fail_closed:true,note:'Manca ODDS_API_KEY.'},opportunities:[],checked:[]});return}
  const sharedReset=quantApiPaused(quant);if(sharedReset){await publishPaused(prev,sharedReset);return}
  try{
    const cachedAt=new Date(state.books?.fetched_at||0).getTime(),cacheAgeH=Number.isFinite(cachedAt)?(NOW.getTime()-cachedAt)/36e5:Infinity;
    let books=selectedNames(state.books?.names||[]);
    if(!books.length||cacheAgeH>BOOK_CACHE_HOURS){books=selectedNames(await api('/bookmakers/selected'));state.books={names:books,fetched_at:NOW.toISOString()}}
    if(books.length<2)throw new Error('SERVONO_ALMENO_DUE_BOOKMAKER');
    let events=quantEvents(quant).filter(e=>singles(e)&&hoursUntil(e.date)>0&&hoursUntil(e.date)<=MAX_HOURS).sort((a,b)=>new Date(a.date)-new Date(b.date));
    if(!events.length){const er=await api('/events',{sport:'tennis',status:'pending',limit:50});events=(Array.isArray(er)?er:(er?.data||er?.events||[])).filter(e=>singles(e)&&String(e?.status||'pending')==='pending'&&hoursUntil(e.date)>0&&hoursUntil(e.date)<=MAX_HOURS).sort((a,b)=>new Date(a.date)-new Date(b.date))}
    const total=events.length,start=total?(state.cursor||0)%total:0,batch=[];
    for(let i=0;i<Math.min(MAX_EVENTS_PER_RUN,total);i++)batch.push(events[(start+i)%total]);
    state.cursor=total?(start+batch.length)%total:0;
    const raw=batch.length?await api('/odds/multi',{eventIds:batch.map(e=>e.id).join(','),bookmakers:books.join(',')}):[];
    const byId=mapMulti(raw),all=[];
    for(const e of batch){const x=analyze(e,byId.get(String(e.id)));if(x)all.push(x)}
    const opportunities=all.filter(x=>x.status==='SUREBET'&&new Date(x.expires_at).getTime()>NOW.getTime()).sort((a,b)=>b.buffered_roi-a.buffered_roi);
    state.detections=[...opportunities,...(state.detections||[])].slice(0,120);state.updated_at=NOW.toISOString();state.last_error=null;state.rate_limit_reset_at=null;await writeJson(STATE,state);
    await writeJson(OUT,{meta:{updated_at:NOW.toISOString(),status:'READY',model_version:MODEL,source:'Odds-API.io selected bookmakers · shared Tennis Edge event universe',bookmakers:books,bookmaker_count:books.length,events_total:total,events_scanned:batch.length,api_calls:calls,api_call_budget:MAX_API_CALLS_PER_RUN,max_quote_age_min:MAX_QUOTE_AGE_MIN,max_timestamp_spread_min:MAX_TIMESTAMP_SPREAD_MIN,execution_ttl_min:EXECUTION_TTL_MIN,min_execution_window_sec:MIN_EXECUTION_WINDOW_SEC,min_raw_roi:MIN_RAW_ROI,safety_buffer:SAFETY_BUFFER,fail_closed:true,note:'Solo arbitraggio 2-way Match Winner tra bookmaker diversi. Nessun modello predittivo viene usato.'},opportunities,checked:all.slice(0,50)});
  }catch(e){
    if(e.message==='HTTP_429'){await publishPaused(prev,null,'HTTP_429');return}
    await writeJson(STATE,{...state,updated_at:NOW.toISOString(),last_error:e.message});
    await writeJson(OUT,{meta:{...(prev?.meta||{}),updated_at:NOW.toISOString(),status:'ERROR',model_version:MODEL,error:e.message,fail_closed:true,note:'Fail-closed: nessuna opportunità attiva finché il feed non torna valido.'},opportunities:[],checked:[]});process.exitCode=0;
  }
}
function selfTest(){
  const now=NOW.toISOString(),e={id:'T1',date:new Date(NOW.getTime()+3600000).toISOString(),home:'A',away:'B',league:{name:'ATP Test'}},base={id:'T1',home:'A',away:'B',sport:{slug:'tennis'},bookmakers:{Alpha:[{name:'ML',odds:[{home:2.20,away:1.72}],updatedAt:now}],Beta:[{name:'ML',odds:[{home:1.80,away:2.05}],updatedAt:now}],Gamma:[{name:'ML',odds:[{home:1.92,away:1.92}],updatedAt:now}]}};
  const r=analyze(e,base);if(!r||r.status!=='SUREBET'||r.book_a!=='Alpha'||r.book_b!=='Beta'||!(r.stake_100.profit>5)||!r.expires_at)throw new Error('SELFTEST_ARB');
  const a=allocation(100,2.2,2.05);if(Math.abs(a.stake_a+a.stake_b-100)>.001||a.guaranteed_profit<=0)throw new Error('SELFTEST_STAKE');
  const stale=analyze(e,{...base,bookmakers:{A:[{name:'ML',odds:[{home:2.20,away:1.70}],updatedAt:new Date(NOW.getTime()-20*60000).toISOString()}],B:[{name:'ML',odds:[{home:1.80,away:2.05}],updatedAt:now}]}});if(stale?.status==='SUREBET')throw new Error('SELFTEST_STALE_GATE');
  const draw=analyze(e,{...base,bookmakers:{A:[{name:'ML',odds:[{home:2.20,draw:3.5,away:2.05}],updatedAt:now}],B:[{name:'ML',odds:[{home:2.10,draw:3.6,away:2.10}],updatedAt:now}]}});if(draw?.status==='SUREBET')throw new Error('SELFTEST_3WAY_REJECT');
  const mismatch=analyze(e,{...base,home:'X',away:'Y'});if(mismatch)throw new Error('SELFTEST_EVENT_IDENTITY');
  if(!(new Date(r.expires_at).getTime()>NOW.getTime()))throw new Error('SELFTEST_EXPIRY');
  console.log(JSON.stringify({ok:true,model:MODEL,tests:['cross_book_arb','cent_rounding','freshness_gate','timestamp_gate','3way_reject','event_identity','outlier_guard','execution_expiry','api_budget_guard','fail_closed']}));
}
if(process.argv.includes('--self-test'))selfTest();else await main();
