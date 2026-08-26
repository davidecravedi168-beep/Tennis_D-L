import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const API_KEY=process.env.ODDS_API_KEY;
const BASE="https://api.odds-api.io/v3";
const OUT="data/quant-board.json";
const MODEL_VERSION="TENNIS-EDGE-QUANT-6.2";
const NOW=new Date();
const DAILY_CAP=460;          // free tier 500/day: 40-call safety reserve
const RUN_CAP=22;             // tighter per-run guard for hourly refresh
const LOCK_MIN_HOURS=1;
const LOCK_MAX_HOURS=36;
const RADAR_DAYS=7;
const MAX_NEW_PREDICTIONS_PER_RUN=120;
const MAX_SETTLEMENTS_PER_RUN=6;
const QUOTE_REFRESH_LIMIT=30;  // refresh relevant locked matches without changing Prediction Lock
const YEARS=[2023,2024,2025,2026];

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const norm=s=>String(s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9 ]/g," ").replace(/\s+/g," ").trim();
const nclean=s=>norm(s).replace(/\b(atp|wta|singles|men|women|mens|womens|qualification|qualifying|qualifier)\b/g," ").replace(/\s+/g," ").trim();
const median=a=>{const x=[...a].filter(Number.isFinite).sort((p,q)=>p-q);if(!x.length)return null;const m=Math.floor(x.length/2);return x.length%2?x[m]:(x[m-1]+x[m])/2};
const sigmoid=x=>1/(1+Math.exp(-x));
const logit=p=>Math.log(clamp(p,.001,.999)/(1-clamp(p,.001,.999)));
const hash=x=>crypto.createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0,12).toUpperCase();
const dayKey=d=>d.toISOString().slice(0,10);
const hoursUntil=d=>(new Date(d)-NOW)/3600000;

function parseResetAt(value){
  if(!value)return null;
  const raw=String(value).trim();
  if(/^\d+$/.test(raw)){
    const n=Number(raw);
    let ms;
    if(n>1e12)ms=n;
    else if(n>1e9)ms=n*1000;
    else ms=Date.now()+n*1000;
    const d=new Date(ms);
    return Number.isFinite(d.getTime())?d.toISOString():null;
  }
  const d=new Date(raw);
  return Number.isFinite(d.getTime())?d.toISOString():null;
}

function minutesUntil(iso){
  if(!iso)return null;
  const d=new Date(iso);
  if(!Number.isFinite(d.getTime()))return null;
  return Math.max(0,Math.ceil((d-NOW)/60000));
}

function rateLimitActive(){
  const reset=state?.rate_limit?.reset_at;
  return !!(reset&&new Date(reset)>NOW);
}

function rateLimitLabel(){
  const m=minutesUntil(state?.rate_limit?.reset_at);
  return m==null?"RATE LIMIT":m>0?`API PAUSA · ${m} MIN`:"API READY";
}

function csvParse(text){
  const rows=[];let row=[],field="",q=false;
  for(let i=0;i<text.length;i++){const c=text[i],n=text[i+1];
    if(q){if(c=='"'&&n=='"'){field+='"';i++}else if(c=='"')q=false;else field+=c}
    else{if(c=='"')q=true;else if(c==","){row.push(field);field=""}else if(c=="\n"){row.push(field);rows.push(row);row=[];field=""}else if(c!="\r")field+=c}
  }
  if(field.length||row.length){row.push(field);rows.push(row)}
  if(!rows.length)return[];
  const h=rows.shift();return rows.filter(r=>r.length>1).map(r=>{const o={};h.forEach((k,i)=>o[k]=r[i]??"");return o});
}
const num=v=>{const x=parseFloat(v);return Number.isFinite(x)?x:null};

async function loadState(){
  try{return JSON.parse(await fs.readFile(OUT,"utf8"))}
  catch{return {meta:{status:"SETUP"},radar:[],upcoming:[],history:[],observed_results:[],learning:{},usage:{day:dayKey(NOW),calls:0},cache:{}}}
}
async function saveState(s){
  await fs.mkdir(path.dirname(OUT),{recursive:true});
  await fs.writeFile(OUT,JSON.stringify(s,null,2)+"\n","utf8");
}

let state=await loadState();
state.usage=state.usage||{day:dayKey(NOW),calls:0};
if(state.usage.day!==dayKey(NOW))state.usage={day:dayKey(NOW),calls:0};
let runCalls=0;

async function api(endpoint,params={}){
  if(!API_KEY)throw new Error("MISSING_ODDS_API_KEY");
  if(rateLimitActive())throw new Error("RATE_LIMIT_WAIT");
  if(state.usage.calls>=DAILY_CAP)throw new Error("DAILY_BUDGET_GUARD");
  if(runCalls>=RUN_CAP)throw new Error("RUN_BUDGET_GUARD");

  const u=new URL(BASE+endpoint);
  u.searchParams.set("apiKey",API_KEY);

  Object.entries(params).forEach(([k,v])=>{
    if(v!==undefined&&v!==null&&v!==""){
      u.searchParams.set(k,String(v));
    }
  });

  const r=await fetch(u,{
    headers:{"user-agent":"TennisEdgePro/6.1"}
  });

  state.usage.calls++;
  runCalls++;

  const remainingRaw=
    r.headers.get("x-ratelimit-remaining")||
    r.headers.get("ratelimit-remaining");

  const resetRaw=
    r.headers.get("x-ratelimit-reset")||
    r.headers.get("ratelimit-reset")||
    r.headers.get("retry-after");

  const remaining=remainingRaw==null?null:Number(remainingRaw);
  const resetAt=parseResetAt(resetRaw);

  state.rate_limit={
    ...(state.rate_limit||{}),
    remaining:Number.isFinite(remaining)?remaining:(state.rate_limit?.remaining??null),
    reset_at:resetAt||(state.rate_limit?.reset_at??null),
    last_status:r.status,
    last_checked_at:NOW.toISOString()
  };

  if(r.status===429){
    if(!state.rate_limit.reset_at||new Date(state.rate_limit.reset_at)<=NOW){
      const fallback=new Date(NOW);
      fallback.setMinutes(60,15,0);
      state.rate_limit.reset_at=fallback.toISOString();
    }
    state.rate_limit.remaining=0;
    throw new Error("RATE_LIMIT_429");
  }

  if(!r.ok)throw new Error(`${endpoint} HTTP ${r.status}`);

  if(state.rate_limit.reset_at&&new Date(state.rate_limit.reset_at)<=NOW){
    state.rate_limit.reset_at=null;
  }

  return r.json();
}
async function fetchText(url){
  const r=await fetch(url,{headers:{"user-agent":"TennisEdgePro/6.1"}});
  if(!r.ok)throw new Error(`DATA HTTP ${r.status}`);
  return r.text();
}
function selectedNames(x){
  const a=Array.isArray(x)?x:(x?.bookmakers||x?.selected||x?.data||[]);
  return a.map(v=>typeof v==="string"?v:(v?.name||v?.bookmaker||v?.slug)).filter(Boolean).slice(0,2);
}
function isSinglesEvent(e){
  const a=String(e.home||""),b=String(e.away||""),league=String(e.league?.name||"");
  if(!a||!b)return false;
  if(/[\/&]/.test(a)||/[\/&]/.test(b))return false;
  if(/doubles|teams|mixed doubles/i.test(league))return false;
  return true;
}
function winnerSide(e){
  if(e?.status!=="settled")return null;
  const h=num(e.scores?.home),a=num(e.scores?.away);
  if(h==null||a==null||h===a)return null;
  return h>a?"A":"B";
}
function marketFromOdds(obj){
  if(!obj?.bookmakers)return null;
  const rows=[];
  for(const[book,markets]of Object.entries(obj.bookmakers)){
    const ml=(markets||[]).find(m=>String(m.name).toUpperCase()==="ML"),o=ml?.odds?.[0];
    const a=num(o?.home),b=num(o?.away);if(!(a>1&&b>1))continue;
    const total=1/a+1/b,margin=total-1;if(margin<-.03||margin>.25)continue;
    const updatedAt=ml?.updatedAt||o?.updatedAt||null;
    const t=updatedAt?new Date(updatedAt).getTime():NaN;
    rows.push({book,a,b,pA:(1/a)/total,margin,updatedAt,updatedMs:Number.isFinite(t)?t:null});
  }
  if(!rows.length)return null;
  const med=median(rows.map(r=>r.pA)),mad=median(rows.map(r=>Math.abs(r.pA-med)))||0;
  const use=rows.filter(r=>Math.abs(r.pA-med)<=Math.max(.06,mad*4)),r=use.length?use:rows;
  const consensus=median(r.map(x=>x.pA)),bestA=Math.max(...r.map(x=>x.a)),bestB=Math.max(...r.map(x=>x.b));
  const rowA=r.find(x=>x.a===bestA),rowB=r.find(x=>x.b===bestB);
  const age=x=>x?.updatedMs==null?null:Math.max(0,(NOW.getTime()-x.updatedMs)/60000);
  return{
    count:r.length,consensus,bestA,bestB,bestBookA:rowA?.book||"—",bestBookB:rowB?.book||"—",
    bestUpdatedA:rowA?.updatedAt||null,bestUpdatedB:rowB?.updatedAt||null,bestAgeA:age(rowA),bestAgeB:age(rowB),
    sd:Math.sqrt(r.reduce((s,x)=>s+(x.pA-consensus)**2,0)/r.length),
    margin:r.reduce((s,x)=>s+x.margin,0)/r.length,
    updated_books:r.filter(x=>x.updatedMs!=null).length
  };
}
function mapMultiOdds(raw){
  const arr=Array.isArray(raw)?raw:(raw?.data||raw?.events||[]);
  return new Map(arr.map(x=>[String(x.id??x.eventId),x]));
}
async function multiOdds(ids,bookmakers){
  const out=new Map();
  for(let i=0;i<ids.length;i+=10){
    const batch=ids.slice(i,i+10);
    const raw=await api("/odds/multi",{eventIds:batch.join(","),bookmakers:bookmakers.join(","),markets:"ML"});
    for(const [k,v] of mapMultiOdds(raw))out.set(k,v);
  }
  return out;
}

function currentMarketSnapshot(p,mkt){
  if(!p||!mkt)return p;
  const side=p.pick_side||p.candidate_side;
  const prob=Number.isFinite(p.pick_prob)?p.pick_prob:(Number.isFinite(p.candidate_prob)?p.candidate_prob:null);
  const odds=side==="A"?mkt.bestA:side==="B"?mkt.bestB:null;
  const book=side==="A"?mkt.bestBookA:side==="B"?mkt.bestBookB:null;
  const updated=side==="A"?mkt.bestUpdatedA:side==="B"?mkt.bestUpdatedB:null;
  const age=side==="A"?mkt.bestAgeA:side==="B"?mkt.bestAgeB:null;
  const ev=Number.isFinite(prob)&&Number.isFinite(odds)?prob*odds-1:null;
  return {...p,current_odds:Number.isFinite(odds)?odds:null,current_book:book||null,current_ev:Number.isFinite(ev)?ev:null,current_market_consensus_a:Number.isFinite(mkt.consensus)?mkt.consensus:null,current_market_books:mkt.count||0,current_odds_updated_at:updated||NOW.toISOString(),current_odds_age_min:Number.isFinite(age)?age:null,market_watch_status:"OBSERVED",prediction_lock_preserved:true};
}
async function refreshLockedMarkets(bookmakers){
  const rows=[...(state.upcoming||[])].filter(p=>new Date(p.start_at)>NOW).sort((a,b)=>{
    const av=(a.verdict==="STRONG VALUE"?3:a.verdict==="VALUE"?2:1),bv=(b.verdict==="STRONG VALUE"?3:b.verdict==="VALUE"?2:1);
    return bv-av || new Date(a.start_at)-new Date(b.start_at) || (b.confidence||0)-(a.confidence||0);
  }).slice(0,QUOTE_REFRESH_LIMIT);
  if(!rows.length||!bookmakers.length)return 0;
  const hourly=Number.isFinite(state.rate_limit?.remaining)?state.rate_limit.remaining:RUN_CAP;
  const safeCalls=Math.max(0,Math.min(RUN_CAP-runCalls-4,hourly-4,Math.ceil(rows.length/10)));
  if(safeCalls<=0)return 0;
  const ids=rows.slice(0,safeCalls*10).map(x=>String(x.event_id));
  const refreshed=await multiOdds(ids,bookmakers);
  let n=0;
  state.upcoming=(state.upcoming||[]).map(p=>{const raw=refreshed.get(String(p.event_id));if(!raw)return p;const mkt=marketFromOdds(raw);if(!mkt)return p;n++;return currentMarketSnapshot(p,mkt)});
  return n;
}

// ---------- historical quant data ----------
function dateNum(m){return +(m.tourney_date||0)}
function playerNameSet(rows){
  const s=new Set();for(const m of rows){if(m.winner_name)s.add(norm(m.winner_name));if(m.loser_name)s.add(norm(m.loser_name))}return s;
}

function buildPlayerHistoryIndex(rows){
  const out=new Map();
  for(const m of rows){
    const w=norm(m.winner_name),l=norm(m.loser_name);
    if(w){if(!out.has(w))out.set(w,[]);out.get(w).push(m)}
    if(l){if(!out.has(l))out.set(l,[]);out.get(l).push(m)}
  }
  for(const arr of out.values())arr.sort((a,b)=>dateNum(b)-dateNum(a));
  return out;
}
function pairKey(a,b){return a<b?`${a}|${b}`:`${b}|${a}`}
function buildH2HIndex(rows){
  const out=new Map();
  for(const m of rows){
    const w=norm(m.winner_name),l=norm(m.loser_name);if(!w||!l)continue;
    const k=pairKey(w,l);if(!out.has(k))out.set(k,[]);out.get(k).push(m);
  }
  for(const arr of out.values())arr.sort((a,b)=>dateNum(b)-dateNum(a));
  return out;
}
function buildNameResolver(names){
  const bySig=new Map();
  for(const n of names){
    const p=n.split(" ").filter(Boolean);if(p.length<2)continue;
    const sig=`${p[p.length-1]}|${p[0][0]||""}`;
    if(!bySig.has(sig))bySig.set(sig,[]);bySig.get(sig).push(n);
  }
  return bySig;
}
function resolveNameKey(name,tourData){
  const n=norm(name);if(tourData.names.has(n))return n;
  const p=n.split(" ").filter(Boolean);if(p.length<2)return null;
  const sig=`${p[p.length-1]}|${p[0][0]||""}`,c=tourData.nameResolver?.get(sig)||[];
  return c.length===1?c[0]:null;
}
function tennisDate(v){
  const s=String(v||"");if(!/^\d{8}$/.test(s))return null;
  const d=new Date(Date.UTC(+s.slice(0,4),+s.slice(4,6)-1,+s.slice(6,8),12));return Number.isFinite(d.getTime())?d:null;
}
function daysAgo(v){const d=tennisDate(v);return d?Math.max(0,(NOW-d)/86400000):9999}
function weightedWinRate(matches,key,halfLife=90,prior=4){
  let w=.5*prior,t=prior;
  for(const m of matches){const wt=Math.exp(-daysAgo(m.tourney_date)*Math.LN2/halfLife);t+=wt;if(norm(m.winner_name)===key)w+=wt}
  return t?w/t:.5;
}
function expected(ra,rb){return 1/(1+10**((rb-ra)/400))}
function buildRatings(rows){
  const global=new Map(),surfaces=new Map();
  const get=(m,k,d=1500)=>m.get(k)??d,set=(m,k,v)=>m.set(k,v);
  const ordered=[...rows].sort((a,b)=>dateNum(a)-dateNum(b));
  for(const x of ordered){
    const w=norm(x.winner_name),l=norm(x.loser_name);if(!w||!l)continue;
    const rw=get(global,w),rl=get(global,l),ew=expected(rw,rl),k=24;
    set(global,w,rw+k*(1-ew));set(global,l,rl+k*(0-(1-ew)));
    const sf=String(x.surface||"Unknown"),sm=surfaces.get(sf)||new Map(),sw=get(sm,w),sl=get(sm,l),es=expected(sw,sl),ks=28;
    set(sm,w,sw+ks*(1-es));set(sm,l,sl+ks*(0-(1-es)));surfaces.set(sf,sm);
  }
  return{global,surfaces};
}
function tournamentSurfaceIndex(rows){
  const m=new Map();
  for(const x of rows){if(x.tourney_name&&x.surface)m.set(nclean(x.tourney_name),x.surface)}
  return m;
}
function latestRankIndex(rows){
  const out=new Map();
  const ordered=[...rows].sort((a,b)=>dateNum(b)-dateNum(a));
  for(const m of ordered){
    const w=norm(m.winner_name),l=norm(m.loser_name);
    if(w&&!out.has(w)){
      const r=num(m.winner_rank),pts=num(m.winner_rank_points);
      out.set(w,{rank:r,points:pts});
    }
    if(l&&!out.has(l)){
      const r=num(m.loser_rank),pts=num(m.loser_rank_points);
      out.set(l,{rank:r,points:pts});
    }
  }
  return out;
}

function circuitPriority(event){
  const l=norm(event.league?.name||"");
  // Major circuits first. Explicit names catch cases where the API does not expose category.
  if(/australian open|roland garros|french open|wimbledon|us open/.test(l))return 120;
  if(/atp finals|wta finals/.test(l))return 112;
  if(/indian wells|miami|monte carlo|madrid|rome|roma|canada|montreal|toronto|cincinnati|shanghai|paris masters/.test(l))return 104;
  if(/\b(atp|wta)\b.*\b1000\b|\b1000\b.*\b(atp|wta)\b/.test(l))return 100;
  if(/\b(atp|wta)\b.*\b500\b|\b500\b.*\b(atp|wta)\b/.test(l))return 82;
  if(/\b(atp|wta)\b.*\b250\b|\b250\b.*\b(atp|wta)\b/.test(l))return 66;
  if(/\b(atp|wta)\b/.test(l)&&!/challenger|qualif|qualification/.test(l))return 60;
  if(/challenger/.test(l))return 34;
  if(/itf|futures|m15|m25|w15|w25|w35|w50|w75|w100/.test(l))return 10;
  return 22;
}

function athletePriority(name, tourData){
  if(!tourData)return 0;
  const key=resolveNameKey(name,tourData);if(!key)return 0;const rp=tourData.ranks?.get(key),rank=rp?.rank||null,elo=tourData.ratings?.global?.get(key)||1500;
  let score=0;
  if(rank){
    if(rank<=10)score+=62;
    else if(rank<=25)score+=50;
    else if(rank<=50)score+=38;
    else if(rank<=100)score+=24;
    else if(rank<=200)score+=10;
  }
  if(elo>=1950)score+=30;
  else if(elo>=1850)score+=22;
  else if(elo>=1750)score+=14;
  else if(elo>=1650)score+=7;
  if((rp?.points||0)>=4000)score+=12;
  else if((rp?.points||0)>=2000)score+=7;
  return score;
}

function eventPriority(event, hist){
  const tour=resolveTour(event,hist);
  const d=tour?hist[tour]:null;
  const a=athletePriority(event.home,d),b=athletePriority(event.away,d);
  const bothStrong=(a>=38&&b>=38)?22:(a>=24&&b>=24)?12:0;
  const starMatch=Math.max(a,b);
  const startSoon=Math.max(0,12-hoursUntil(event.date))*.35;
  return circuitPriority(event)+starMatch+(Math.min(a,b)*.35)+bothStrong+startSoon;
}

function fuzzySurface(event,index){
  const q=nclean(event.league?.name||event.tournament||"");
  if(index.has(q))return index.get(q);
  let best=null,score=0;
  const qt=new Set(q.split(" ").filter(x=>x.length>2));
  for(const [name,surface] of index){
    if(!name)continue;
    if(name.includes(q)||q.includes(name)){if(Math.min(name.length,q.length)>score){score=Math.min(name.length,q.length);best=surface}}
    else{
      const nt=new Set(name.split(" ").filter(x=>x.length>2)),inter=[...qt].filter(x=>nt.has(x)).length,union=new Set([...qt,...nt]).size,j=union?inter/union:0;
      if(j>.58&&j>score){score=j;best=surface}
    }
  }
  if(best)return best;
  const s=q;
  if(/wimbledon|halle|queens|eastbourne|stuttgart|hertogenbosch/.test(s))return"Grass";
  if(/roland garros|french open|rome|roma|madrid|monte carlo|barcelona|hamburg|munich|rio|buenos aires/.test(s))return"Clay";
  return"Hard";
}
function playerHistory(rows,name){
  const n=norm(name);
  return rows.filter(m=>norm(m.winner_name)===n||norm(m.loser_name)===n).sort((a,b)=>dateNum(b)-dateNum(a));
}
function bayesRate(w,n,k=8){return(w+.5*k)/(n+k)}
function metrics(rows,name,surface){
  const n=norm(name),all=playerHistory(rows,n),r20=all.slice(0,20),surf=all.filter(m=>m.surface===surface).slice(0,40),latest=all[0];
  let ownWon=0,ownPts=0,retWon=0,retPts=0,statN=0;
  r20.forEach(m=>{
    const w=norm(m.winner_name)===n,sv=num(w?m.w_svpt:m.l_svpt),fw=num(w?m.w_1stWon:m.l_1stWon),sw=num(w?m.w_2ndWon:m.l_2ndWon);
    const osv=num(w?m.l_svpt:m.w_svpt),ofw=num(w?m.l_1stWon:m.w_1stWon),osw=num(w?m.l_2ndWon:m.w_2ndWon);
    if(sv&&fw!=null&&sw!=null){ownPts+=sv;ownWon+=fw+sw;statN++}
    if(osv&&ofw!=null&&osw!=null){retPts+=osv;retWon+=osv-ofw-osw}
  });
  const isW=latest&&norm(latest.winner_name)===n;
  const recent7=all.filter(m=>daysAgo(m.tourney_date)<=7),recent14=all.filter(m=>daysAgo(m.tourney_date)<=14);
  return{
    n:all.length,rank:latest?num(isW?latest.winner_rank:latest.loser_rank):null,
    form:weightedWinRate(r20,n,75,4),form_long:weightedWinRate(all.slice(0,35),n,150,7),
    surfaceN:surf.length,surface:weightedWinRate(surf,n,210,8),
    serve:ownPts?ownWon/ownPts:null,ret:retPts?retWon/retPts:null,statN,
    workload7:recent7.reduce((s,m)=>s+(num(m.minutes)||90),0),workload14:recent14.reduce((s,m)=>s+(num(m.minutes)||90),0),
    matches7:recent7.length,matches14:recent14.length,last_match_days:latest?daysAgo(latest.tourney_date):null
  };
}
function h2h(rows,a,b,surface){
  const A=norm(a),B=norm(b),arr=rows.filter(m=>[norm(m.winner_name),norm(m.loser_name)].includes(A)&&[norm(m.winner_name),norm(m.loser_name)].includes(B)).sort((x,y)=>dateNum(y)-dateNum(x)).slice(0,12);
  let wa=0,wb=0,total=0;for(const m of arr){
    const years=Math.max(0,(+dayKey(NOW).replaceAll("-","")-dateNum(m))/10000),wt=Math.exp(-years/2.8)*(m.surface===surface?1.45:1);
    if(norm(m.winner_name)===A)wa+=wt;else wb+=wt;total+=wt;
  }
  return{n:arr.length,edge:total?(wa-wb)/total:0};
}

function metricsFast(tourData,key,surface){
  const all=tourData.byPlayer?.get(key)||[],r20=all.slice(0,20),surf=all.filter(m=>m.surface===surface).slice(0,40),latest=all[0];
  let ownWon=0,ownPts=0,retWon=0,retPts=0,statN=0;
  r20.forEach(m=>{
    const w=norm(m.winner_name)===key,sv=num(w?m.w_svpt:m.l_svpt),fw=num(w?m.w_1stWon:m.l_1stWon),sw=num(w?m.w_2ndWon:m.l_2ndWon);
    const osv=num(w?m.l_svpt:m.w_svpt),ofw=num(w?m.l_1stWon:m.w_1stWon),osw=num(w?m.l_2ndWon:m.w_2ndWon);
    if(sv&&fw!=null&&sw!=null){ownPts+=sv;ownWon+=fw+sw;statN++}
    if(osv&&ofw!=null&&osw!=null){retPts+=osv;retWon+=osv-ofw-osw}
  });
  const isW=latest&&norm(latest.winner_name)===key,recent7=all.filter(m=>daysAgo(m.tourney_date)<=7),recent14=all.filter(m=>daysAgo(m.tourney_date)<=14);
  return{
    n:all.length,rank:latest?num(isW?latest.winner_rank:latest.loser_rank):null,
    form:weightedWinRate(r20,key,75,4),form_long:weightedWinRate(all.slice(0,35),key,150,7),
    surfaceN:surf.length,surface:weightedWinRate(surf,key,210,8),serve:ownPts?ownWon/ownPts:null,ret:retPts?retWon/retPts:null,statN,
    workload7:recent7.reduce((s,m)=>s+(num(m.minutes)||90),0),workload14:recent14.reduce((s,m)=>s+(num(m.minutes)||90),0),
    matches7:recent7.length,matches14:recent14.length,last_match_days:latest?daysAgo(latest.tourney_date):null,
    last_surface:latest?.surface||null
  };
}
function adaptationContext(A,B,targetSurface){
  const one=p=>{
    const recent=Number.isFinite(p?.last_match_days)&&p.last_match_days<=10;
    const surfaceChange=!!(recent&&p?.last_surface&&targetSurface&&p.last_surface!==targetSurface);
    const denseLoad=(p?.matches7||0)>=5||(p?.workload7||0)>=540;
    return{surfaceChange,denseLoad,risk:(surfaceChange?1:0)+(denseLoad?1:0)};
  };
  const a=one(A),b=one(B);
  return{a,b,riskMax:Math.max(a.risk,b.risk),anySurfaceChange:a.surfaceChange||b.surfaceChange,anyDenseLoad:a.denseLoad||b.denseLoad};
}
function h2hFast(tourData,a,b,surface){
  const arr=(tourData.h2hIndex?.get(pairKey(a,b))||[]).slice(0,12);
  let wa=0,wb=0,total=0;
  for(const m of arr){
    const years=Math.max(0,(+dayKey(NOW).replaceAll("-","")-dateNum(m))/10000),wt=Math.exp(-years/2.8)*(m.surface===surface?1.45:1);
    if(norm(m.winner_name)===a)wa+=wt;else wb+=wt;total+=wt;
  }
  return{n:arr.length,edge:total?(wa-wb)/total:0};
}
async function loadQuantHistory(){
  const tours={atp:[],wta:[]};
  for(const tour of ["atp","wta"]){
    const repo=tour==="atp"?"tennis_atp":"tennis_wta";
    for(const y of YEARS){
      const url=`https://raw.githubusercontent.com/JeffSackmann/${repo}/master/${tour}_matches_${y}.csv`;
      try{tours[tour].push(...csvParse(await fetchText(url)))}catch(e){console.error("history",tour,y,e.message)}
    }
  }
  const today=+dayKey(NOW).replaceAll("-","");
  for(const k of Object.keys(tours))tours[k]=tours[k].filter(m=>dateNum(m)<=today);
  return{
    atp:(()=>{const names=playerNameSet(tours.atp);return{rows:tours.atp,names,nameResolver:buildNameResolver(names),byPlayer:buildPlayerHistoryIndex(tours.atp),h2hIndex:buildH2HIndex(tours.atp),ratings:buildRatings(tours.atp),ranks:latestRankIndex(tours.atp),surfaceIndex:tournamentSurfaceIndex(tours.atp)}})(),
    wta:(()=>{const names=playerNameSet(tours.wta);return{rows:tours.wta,names,nameResolver:buildNameResolver(names),byPlayer:buildPlayerHistoryIndex(tours.wta),h2hIndex:buildH2HIndex(tours.wta),ratings:buildRatings(tours.wta),ranks:latestRankIndex(tours.wta),surfaceIndex:tournamentSurfaceIndex(tours.wta)}})()
  };
}
function resolveTour(event,hist){
  const atpA=resolveNameKey(event.home,hist.atp),atpB=resolveNameKey(event.away,hist.atp);
  const wtaA=resolveNameKey(event.home,hist.wta),wtaB=resolveNameKey(event.away,hist.wta);
  const inATP=!!(atpA&&atpB),inWTA=!!(wtaA&&wtaB);
  if(inATP&&!inWTA)return"atp";if(inWTA&&!inATP)return"wta";
  const l=norm(event.league?.name);if(l.includes("wta"))return inWTA?"wta":null;if(l.includes("atp"))return inATP?"atp":null;
  return null;
}
function applyCalibration(p,cal){return cal?.active?clamp(sigmoid(cal.intercept+cal.slope*logit(p)),.08,.92):p}
function fitCalibrationRows(records,prev){
  const r=records.filter(x=>Number.isFinite(x.raw_p_a)).map(x=>({x:logit(x.raw_p_a),y:x.actual_side==="A"?1:0}));
  if(r.length<35)return{active:false,sample:r.length,intercept:prev?.intercept??0,slope:prev?.slope??1};
  let a=prev?.active?prev.intercept:0,b=prev?.active?prev.slope:1,lr=.022;
  for(let step=0;step<280;step++){
    let ga=0,gb=0;for(const z of r){const pr=sigmoid(a+b*z.x),er=pr-z.y;ga+=er;gb+=er*z.x}
    a=clamp(a-lr*(ga/r.length+.04*a),-.5,.5);b=clamp(b-lr*(gb/r.length+.04*(b-1)),.62,1.38);
  }
  return{active:true,sample:r.length,intercept:a,slope:b,updated_at:NOW.toISOString()};
}
function fitCalibrationSet(history,prev={}){
  const settled=(history||[]).filter(x=>x.status==="SETTLED"&&Number.isFinite(x.raw_p_a));
  const tour={},surface={};
  for(const t of["atp","wta"]){
    const tr=settled.filter(x=>x.tour===t);tour[t]=fitCalibrationRows(tr,prev?.tour?.[t]);
    for(const s of["Hard","Clay","Grass"]){
      const key=`${t}:${s}`;surface[key]=fitCalibrationRows(tr.filter(x=>x.surface===s),prev?.surface?.[key]);
    }
  }
  const global=fitCalibrationRows(settled,prev?.global);
  return{active:global.active||Object.values(tour).some(x=>x.active),sample:settled.length,global,tour,surface,updated_at:NOW.toISOString()};
}
function selectCalibration(set,tour,surface){
  const g=set?.surface?.[`${tour}:${surface}`];if(g?.active&&g.sample>=35)return{...g,scope:`${tour}:${surface}`};
  const t=set?.tour?.[tour];if(t?.active&&t.sample>=45)return{...t,scope:tour};
  const a=set?.global;if(a?.active&&a.sample>=60)return{...a,scope:"global"};
  return{active:false,sample:set?.sample||0,intercept:0,slope:1,scope:"none"};
}
function driftStatus(history){
  const settled=(history||[]).filter(x=>x.status==="SETTLED"&&Number.isFinite(x.brier));
  if(settled.length<20)return{health:"COLD",penalty:18,sample:settled.length,recentBrier:null,allBrier:settled.length?settled.reduce((s,x)=>s+x.brier,0)/settled.length:null};
  if(settled.length<50)return{health:"LEARNING",penalty:10,sample:settled.length,recentBrier:settled.slice(0,20).reduce((s,x)=>s+x.brier,0)/Math.min(20,settled.length),allBrier:settled.reduce((s,x)=>s+x.brier,0)/settled.length};
  const all=settled.reduce((s,x)=>s+x.brier,0)/settled.length,n=Math.min(50,settled.length),recent=settled.slice(0,n).reduce((s,x)=>s+x.brier,0)/n;
  if(recent>all+.03||recent>.27)return{health:"DRIFT",penalty:18,sample:settled.length,recentBrier:recent,allBrier:all};
  if(recent>all+.015)return{health:"WATCH",penalty:10,sample:settled.length,recentBrier:recent,allBrier:all};
  return{health:"HEALTHY",penalty:0,sample:settled.length,recentBrier:recent,allBrier:all};
}
function sportsCore(event,h,calSet,drift){
  const tour=resolveTour(event,h);if(!tour)return null;
  const d=h[tour],surface=fuzzySurface(event,d.surfaceIndex),keyA=resolveNameKey(event.home,d),keyB=resolveNameKey(event.away,d);if(!keyA||!keyB)return null;
  const A=metricsFast(d,keyA,surface),B=metricsFast(d,keyB,surface);if(A.n<6||B.n<6)return null;
  const HH=h2hFast(d,keyA,keyB,surface),eloA=d.ratings.global.get(keyA)??1500,eloB=d.ratings.global.get(keyB)??1500;
  const se=d.ratings.surfaces.get(surface)||new Map(),sEloA=se.get(keyA)??1500,sEloB=se.get(keyB)??1500;
  const rankTerm=A.rank&&B.rank?clamp(Math.log(B.rank/A.rank),-2,2):0,srA=(A.serve??.61)+(A.ret??.39),srB=(B.serve??.61)+(B.ret??.39);

  const strengthRaw=((eloA-eloB)/400)*1.18+rankTerm*.34;
  const surfaceRaw=((sEloA-sEloB)/400)*1.22+(A.surface-B.surface)*1.55;
  const restA=A.last_match_days==null?3:clamp(A.last_match_days,0,10),restB=B.last_match_days==null?3:clamp(B.last_match_days,0,10);
  const fatigueEdge=clamp((B.workload7-A.workload7)/500,-.45,.45)+clamp((restA-restB)/14,-.25,.25);
  const formRaw=(A.form-B.form)*2.25+(A.form_long-B.form_long)*.7+(srA-srB)*2.0+HH.edge*.46+fatigueEdge*.72;
  const modelA=sigmoid(strengthRaw),modelB=sigmoid(surfaceRaw),modelC=sigmoid(formRaw);
  const relA=1+(A.rank&&B.rank ? .15 : 0)+Math.min(.35,(A.n+B.n)/120);
  const relB=.7+Math.min(.5,Math.min(A.surfaceN,B.surfaceN)/30);
  const relC=.75+Math.min(.35,Math.min(A.statN,B.statN)/15)+Math.min(.15,(A.n+B.n)/160);
  const rawP=(modelA*relA+modelB*relB+modelC*relC)/(relA+relB+relC),shadowRaw=modelA*.34+modelB*.36+modelC*.30;
  const cal=selectCalibration(calSet,tour,surface),pA=applyCalibration(rawP,cal),pB=1-pA;
  const models=[modelA,modelB,modelC],sides=models.map(x=>x>=.5?"A":"B"),votesA=sides.filter(x=>x==="A").length,votesB=3-votesA;
  const majority=votesA>votesB?"A":"B",unanimous=votesA===3||votesB===3,dis=Math.max(...models)-Math.min(...models);
  const adaptation=adaptationContext(A,B,surface);

  let dq=40+(A.rank&&B.rank?10:0)+Math.min(15,(A.n+B.n)/7)+Math.min(12,Math.min(A.surfaceN,B.surfaceN)/2.2)+(A.statN&&B.statN?8:0)+Math.min(5,HH.n)-adaptation.riskMax*2;
  dq=clamp(dq,30,96);
  let sportsConf=clamp(38+dq*.5-(dis*100)*.75-(unanimous?0:10)-drift.penalty-adaptation.riskMax*3,24,94);sportsConf=Math.min(sportsConf,dq+2);
  const uncertainty=clamp(.025+(100-dq)*.00115+dis*.28+(drift.health==="DRIFT"?.035:drift.health==="WATCH"?.018:0)+adaptation.riskMax*.008,.035,.18);

  return{tour,d,surface,keyA,keyB,A,B,HH,eloA,eloB,sEloA,sEloB,srA,srB,fatigueEdge,adaptation,modelA,modelB,modelC,rawP,shadowRaw,cal,pA,pB,votesA,votesB,majority,unanimous,dis,dq,sportsConf,uncertainty};
}
function sportsReasons(core,side){
  const sgn=side==="A"?1:-1,r=[];
  const add=(label,v,t1,t2)=>{const z=sgn*v;if(z>=t2)r.push(`${label} ++`);else if(z>=t1)r.push(`${label} +`);else if(z<=-t2)r.push(`${label} --`);else if(z<=-t1)r.push(`${label} -`)};
  add("ELO",core.eloA-core.eloB,35,90);add("SURFACE",core.sEloA-core.sEloB,30,80);add("FORM",core.A.form-core.B.form,.035,.085);add("H2H",core.HH.edge,.18,.45);add("SERVE/RETURN",core.srA-core.srB,.025,.06);add("REST",core.fatigueEdge,.08,.20);
  return r.slice(0,6);
}
function buildPreview(event,h,calSet,drift){
  const c=sportsCore(event,h,calSet,drift);
  if(!c)return null;
  const favSide=c.pA>=.5?"A":"B",favName=favSide==="A"?event.home:event.away,favProb=Math.max(c.pA,c.pB),robustProb=Math.max(.5,favProb-c.uncertainty);
  let preStatus="PRE-ANALISI";
  const warnings=[];
  if(c.dq<55)warnings.push("DATI_LIMITATI");
  if(Math.min(c.A.surfaceN,c.B.surfaceN)<6)warnings.push("SURFACE_SAMPLE_LIMITATO");
  if(c.adaptation.anySurfaceChange)warnings.push("TRANSIZIONE_SUPERFICIE");
  if(c.adaptation.anyDenseLoad)warnings.push("CARICO_RECENTE_ELEVATO");
  if(c.dis>.14)warnings.push("MODELLI_IN_DISACCORDO");
  if(drift.health==="DRIFT")warnings.push("MODEL_DRIFT");
  if(c.unanimous&&c.dq>=68&&c.sportsConf>=66&&robustProb>=.56&&drift.health!=="DRIFT")preStatus="EARLY WATCH";
  if(c.dq<48||c.dis>.20)preStatus="DATA CAUTION";
  const marketPriority=eventPriority(event,h)+(preStatus==="EARLY WATCH"?35:0)+Math.max(0,(robustProb-.5)*100);
  const p={
    event_id:String(event.id),start_at:event.date,player_a:event.home,player_b:event.away,tournament:event.league?.name||"—",priority:Math.round(event._priority??eventPriority(event,h)),
    market_priority:Math.round(marketPriority),pre_status:preStatus,surface:c.surface,tour:c.tour,model_p_a:c.pA,model_p_b:c.pB,favorite_side:favSide,favorite_name:favName,
    favorite_prob:favProb,robust_prob:robustProb,uncertainty:c.uncertainty,confidence:c.sportsConf,data_quality:c.dq,engine_votes:`${Math.max(c.votesA,c.votesB)}/3`,engine_unanimous:c.unanimous,
    model_a_p:c.modelA,model_b_p:c.modelB,model_c_p:c.modelC,model_disagreement:c.dis,reason_codes:sportsReasons(c,favSide),warnings,market_checked:false,model_version:MODEL_VERSION
  };
  p.preview_id=hash(p);return p;
}
function buildPrediction(event,mkt,h,calSet,drift){
  const c=sportsCore(event,h,calSet,drift);if(!c)return null;
  const edgeA=c.pA-mkt.consensus,edgeB=c.pB-(1-mkt.consensus),evA=c.pA*mkt.bestA-1,evB=c.pB*mkt.bestB-1;
  let candidateSide,candidateName,candidateOdds,candidateBook,candidateEV,candidateEdge,candidateProb,candidateAge,candidateUpdated;
  if(evA>=evB){candidateSide="A";candidateName=event.home;candidateOdds=mkt.bestA;candidateBook=mkt.bestBookA;candidateEV=evA;candidateEdge=edgeA;candidateProb=c.pA;candidateAge=mkt.bestAgeA;candidateUpdated=mkt.bestUpdatedA}
  else{candidateSide="B";candidateName=event.away;candidateOdds=mkt.bestB;candidateBook=mkt.bestBookB;candidateEV=evB;candidateEdge=edgeB;candidateProb=c.pB;candidateAge=mkt.bestAgeB;candidateUpdated=mkt.bestUpdatedB}

  let dq=clamp(c.dq+(mkt.updated_books?4:0)+(mkt.count>=2?3:0),30,98);
  let conf=clamp(c.sportsConf-clamp(mkt.sd/.06,0,1)*8+(mkt.count>=2?2:0),22,95);conf=Math.min(conf,dq+2);
  const marketProb=candidateSide==="A"?mkt.consensus:(1-mkt.consensus),robustProb=Math.max(.01,candidateProb-c.uncertainty),robustEdge=robustProb-marketProb,robustEV=robustProb*candidateOdds-1;
  const ep=candidateEdge*100,evp=candidateEV*100,rep=robustEdge*100,revp=robustEV*100,hard=[];
  if(candidateEV<=0)hard.push("EV_NON_POSITIVO");
  if(robustEV<=0)hard.push("ROBUST_EV_NON_POSITIVO");
  if(candidateEdge<.018)hard.push("EDGE_TROPPO_BASSO");
  if(robustEdge<.006)hard.push("EDGE_NON_RESISTE_INcertezza".toUpperCase());
  if(dq<64)hard.push("DATI_INSUFFICIENTI");
  if(Math.min(c.A.n,c.B.n)<10)hard.push("STORICO_GIOCATORE_LIMITATO");
  if(Math.min(c.A.surfaceN,c.B.surfaceN)<5)hard.push("SURFACE_SAMPLE_LIMITATO");
  if(c.adaptation.riskMax>=2&&c.dis>.08)hard.push("TRANSIZIONE_SUPERFICIE_FATICA");
  if(c.dis>.13)hard.push("MODELLI_IN_DISACCORDO");
  if(mkt.sd>.06)hard.push("MERCATO_DISPERSO");
  if(Number.isFinite(candidateAge)&&candidateAge>75)hard.push("QUOTA_NON_FRESCA");
  if(Math.abs(c.pA-mkt.consensus)>.17)hard.push("SCOSTAMENTO_ESTREMO");
  if(drift.health==="DRIFT")hard.push("MODEL_DRIFT");
  if((drift.sample||0)<20)hard.push("MODELLO_COLD");

  let verdict="NO BET";
  if(!hard.length&&c.majority===candidateSide&&conf>=66&&dq>=66&&evp>=4&&ep>=2&&revp>=1&&rep>=.8)verdict="WATCH";
  if(!hard.length&&c.unanimous&&c.cal.active&&drift.health==="HEALTHY"&&conf>=75&&dq>=72&&evp>=6.5&&ep>=3.2&&revp>=2.2&&rep>=1.2&&c.dis<.095)verdict="VALUE";
  if(!hard.length&&c.unanimous&&c.cal.active&&(drift.sample||0)>=120&&drift.health==="HEALTHY"&&conf>=84&&dq>=84&&evp>=10&&ep>=5&&revp>=4&&rep>=2&&c.dis<.065&&Number.isFinite(candidateAge)&&candidateAge<=30)verdict="STRONG VALUE";
  if(drift.health==="LEARNING"&&verdict==="VALUE")verdict="WATCH";

  const official=verdict==="VALUE"||verdict==="STRONG VALUE",watch=verdict==="WATCH",reasons=sportsReasons(c,candidateSide);if(candidateEV>0)reasons.push(candidateEV>=.08?"EV ++":"EV +");
  const warnings=[...hard];if(!c.unanimous)warnings.push("CONSENSUS_2_SU_3");if(!Number.isFinite(candidateAge))warnings.push("FRESHNESS_NON_VERIFICABILE");if(!c.cal.active)warnings.push("CALIBRAZIONE_NON_ATTIVA");
  const payload={
    event_id:String(event.id),start_at:event.date,player_a:event.home,player_b:event.away,tournament:event.league?.name||"—",league_slug:event.league?.slug||null,priority:Math.round(event._priority??eventPriority(event,h)),
    surface:c.surface,tour:c.tour,raw_p_a:c.rawP,shadow_p_a:c.shadowRaw,p_a:c.pA,p_b:c.pB,uncertainty:c.uncertainty,probability_low:Math.max(.01,candidateProb-c.uncertainty),probability_high:Math.min(.99,candidateProb+c.uncertainty),
    model_a_p:c.modelA,model_b_p:c.modelB,model_c_p:c.modelC,model_a_name:"Strength",model_b_name:"Surface",model_c_name:"Form/Matchup",model_disagreement:c.dis,engine_votes:`${Math.max(c.votesA,c.votesB)}/3`,engine_majority:c.majority,engine_unanimous:c.unanimous,
    fair_a:1/c.pA,fair_b:1/c.pB,candidate_side:candidateSide,candidate_name:candidateName,candidate_prob:candidateProb,candidate_odds:candidateOdds,candidate_book:candidateBook,candidate_ev:candidateEV,candidate_edge:candidateEdge,robust_prob:robustProb,robust_ev:robustEV,robust_edge:robustEdge,
    pick_side:official?candidateSide:null,pick_name:official?candidateName:null,pick_prob:official?candidateProb:null,pick_odds:official?candidateOdds:null,pick_book:official?candidateBook:null,pick_ev:official?candidateEV:null,pick_edge:official?candidateEdge:null,
    watch_side:watch?candidateSide:null,watch_name:watch?candidateName:null,verdict,confidence:conf,sports_confidence:c.sportsConf,data_quality:dq,market_depth:mkt.count,market_consensus_a:mkt.consensus,market_sd:mkt.sd,market_margin:mkt.margin,market_updated_at:candidateUpdated,market_age_minutes:Number.isFinite(candidateAge)?candidateAge:null,
    rank_a:c.A.rank,rank_b:c.B.rank,elo_a:c.eloA,elo_b:c.eloB,surface_elo_a:c.sEloA,surface_elo_b:c.sEloB,form_a:c.A.form,form_b:c.B.form,surface_form_a:c.A.surface,surface_form_b:c.B.surface,surface_sample_a:c.A.surfaceN,surface_sample_b:c.B.surfaceN,h2h_n:c.HH.n,h2h_edge:c.HH.edge,serve_return_delta:c.srA-c.srB,workload7_a:c.A.workload7,workload7_b:c.B.workload7,matches7_a:c.A.matches7,matches7_b:c.B.matches7,rest_days_a:c.A.last_match_days,rest_days_b:c.B.last_match_days,last_surface_a:c.A.last_surface,last_surface_b:c.B.last_surface,surface_transition_a:c.adaptation.a.surfaceChange,surface_transition_b:c.adaptation.b.surfaceChange,dense_load_a:c.adaptation.a.denseLoad,dense_load_b:c.adaptation.b.denseLoad,adaptation_risk:c.adaptation.riskMax,
    reason_codes:reasons.slice(0,7),no_bet_reasons:hard,warnings:[...new Set(warnings)],calibration_sample:c.cal.sample,calibration_scope:c.cal.scope,calibration_active:!!c.cal.active,model_health:drift.health,model_version:MODEL_VERSION,predicted_at:NOW.toISOString(),locked:true,status:"LOCKED"
  };
  payload.audit_id=hash(payload);return payload;
}

async function closingMarket(eventId,bookmakers){
  try{
    const raw=await api("/historical/odds",{eventId,bookmakers:bookmakers.join(","),markets:"ML"});
    return marketFromOdds(raw);
  }catch(e){console.error("closing",eventId,e.message);return null}
}
async function settlePredictions(bookmakers){
  const hist=[...(state.history||[])],remaining=[];
  const due=(state.upcoming||[]).filter(p=>new Date(p.start_at)<NOW).slice(0,MAX_SETTLEMENTS_PER_RUN);
  const dueIds=new Set(due.map(p=>p.event_id));
  for(const p of state.upcoming||[]){
    if(!dueIds.has(p.event_id)){remaining.push(p);continue}
    try{
      const e=await api("/events/"+p.event_id);
      const actual=winnerSide(e);
      if(!actual){remaining.push(p);continue}
      const won=p.pick_side?p.pick_side===actual:null,profit=p.pick_side?(won?(p.pick_odds-1):-1):0,y=actual==="A"?1:0;
      let clv=null,closingOdds=null;
      if(p.pick_side&&bookmakers.length&&runCalls<Math.min(RUN_CAP-4,8)&&state.usage.calls<DAILY_CAP-4){
        const cm=await closingMarket(p.event_id,bookmakers);
        if(cm){closingOdds=p.pick_side==="A"?cm.bestA:cm.bestB;if(closingOdds>1)clv=p.pick_odds/closingOdds-1}
      }
      hist.unshift({...p,status:"SETTLED",settled_at:NOW.toISOString(),actual_side:actual,actual_winner:actual==="A"?p.player_a:p.player_b,pick_won:won,profit_units:profit,brier:(p.p_a-y)**2,log_loss:-(y*Math.log(clamp(p.p_a,.001,.999))+(1-y)*Math.log(clamp(1-p.p_a,.001,.999))),shadow_brier:Number.isFinite(p.shadow_p_a)?(p.shadow_p_a-y)**2:null,shadow_log_loss:Number.isFinite(p.shadow_p_a)?-(y*Math.log(clamp(p.shadow_p_a,.001,.999))+(1-y)*Math.log(clamp(1-p.shadow_p_a,.001,.999))):null,closing_odds:closingOdds,clv});
    }catch(e){console.error("settle",p.event_id,e.message);remaining.push(p)}
  }
  state.history=hist.slice(0,4000);state.upcoming=remaining;
}
function stats(history){
  const closed=(history||[]).filter(x=>x.status==="SETTLED"),picks=closed.filter(x=>x.pick_side&&(x.verdict==="VALUE"||x.verdict==="STRONG VALUE")),wins=picks.filter(x=>x.pick_won).length;
  const profit=picks.reduce((s,x)=>s+(num(x.profit_units)||0),0),clvs=picks.map(x=>num(x.clv)).filter(Number.isFinite),shadow=closed.map(x=>num(x.shadow_brier)).filter(Number.isFinite);
  const championBrier=closed.length?closed.reduce((s,x)=>s+(num(x.brier)||0),0)/closed.length:null,shadowBrier=shadow.length?shadow.reduce((a,b)=>a+b,0)/shadow.length:null;
  return{
    closed_matches:closed.length,closed_picks:picks.length,wins,hit_rate:picks.length?wins/picks.length:null,profit_units:profit,roi:picks.length?profit/picks.length:null,
    brier:championBrier,log_loss:closed.length?closed.reduce((s,x)=>s+(num(x.log_loss)||0),0)/closed.length:null,
    avg_clv:clvs.length?clvs.reduce((a,b)=>a+b,0)/clvs.length:null,clv_sample:clvs.length,
    shadow_brier:shadowBrier,shadow_sample:shadow.length,shadow_delta:championBrier!=null&&shadowBrier!=null?shadowBrier-championBrier:null
  };
}

function challengerEvaluation(history){
  const rows=(history||[]).filter(x=>x.status==="SETTLED"&&Number.isFinite(x.brier)&&Number.isFinite(x.shadow_brier));
  if(rows.length<80)return{status:"TESTING",sample:rows.length,note:"Serve più storico fuori campione."};
  const cb=rows.reduce((s,x)=>s+x.brier,0)/rows.length,sb=rows.reduce((s,x)=>s+x.shadow_brier,0)/rows.length;
  const cl=rows.filter(x=>Number.isFinite(x.log_loss)&&Number.isFinite(x.shadow_log_loss));
  const cLog=cl.length?cl.reduce((s,x)=>s+x.log_loss,0)/cl.length:null,sLog=cl.length?cl.reduce((s,x)=>s+x.shadow_log_loss,0)/cl.length:null;
  const brierGain=cb-sb,logGain=cLog!=null&&sLog!=null?cLog-sLog:null;
  let status="HOLD";
  if(rows.length>=150&&brierGain>=.004&&(logGain==null||logGain>=.006))status="ELIGIBLE";
  if(brierGain<=-.006||(logGain!=null&&logGain<=-.01))status="REJECTED";
  return{status,sample:rows.length,champion_brier:cb,challenger_brier:sb,brier_gain:brierGain,champion_log_loss:cLog,challenger_log_loss:sLog,log_loss_gain:logGain,note:status==="ELIGIBLE"?"Challenger migliore sui criteri minimi; non viene promosso automaticamente senza una nuova release.":"Nessuna auto-promozione: il Champion resta stabile."};
}
async function main(){
  if(rateLimitActive()){
    const mins=minutesUntil(state.rate_limit.reset_at);
    state.meta={
      ...(state.meta||{}),
      updated_at:NOW.toISOString(),
      status:rateLimitLabel(),
      source:"Odds-API.io Free + Jeff Sackmann",
      model_version:MODEL_VERSION,
      rate_limit_reset_at:state.rate_limit.reset_at,
      rate_limit_minutes:mins,
      api_hourly_remaining:state.rate_limit.remaining??0,
      api_usage_today:state.usage.calls,
      api_daily_guard:DAILY_CAP,
      note:"Rate-limit backoff attivo: nessuna chiamata API fino al reset."
    };
    await saveState(state);
    return;
  }

  if(!API_KEY){
    state.meta={...(state.meta||{}),updated_at:NOW.toISOString(),status:"SETUP",source:"Odds-API.io Free + Jeff Sackmann",model_version:MODEL_VERSION,note:"Create free ODDS_API_KEY secret. No paid service required."};
    await saveState(state);return;
  }
  let bookmakers=[];
  try{
    bookmakers=selectedNames(await api("/bookmakers/selected"));
    if(bookmakers.length<1)throw new Error("NO_SELECTED_BOOKMAKERS");
  }catch(e){
    state.meta={...(state.meta||{}),updated_at:NOW.toISOString(),status:"SETUP",source:"Odds-API.io Free + Jeff Sackmann",model_version:MODEL_VERSION,error:e.message,api_usage_today:state.usage.calls};
    await saveState(state);return;
  }

  await settlePredictions(bookmakers);

  const calibration=fitCalibrationSet(state.history,state.learning?.calibration);
  const drift=driftStatus(state.history);
  state.learning={calibration,drift};

  let eventsRaw=await api("/events",{sport:"tennis"});
  const events=(Array.isArray(eventsRaw)?eventsRaw:(eventsRaw?.data||eventsRaw?.events||[])).filter(isSinglesEvent);
  const quant=await loadQuantHistory();

  const radarEvents=events
    .filter(e=>e.status==="pending"&&hoursUntil(e.date)>0&&hoursUntil(e.date)<=RADAR_DAYS*24)
    .map(e=>({...e,_priority:eventPriority(e,quant)}))
    .sort((a,b)=>b._priority-a._priority||String(a.date).localeCompare(String(b.date)))
    .slice(0,300);

  state.radar=radarEvents.map(e=>{
    const p=buildPreview(e,quant,calibration,drift);
    return p||{event_id:String(e.id),start_at:e.date,player_a:e.home,player_b:e.away,tournament:e.league?.name||"—",priority:Math.round(e._priority),pre_status:"DATA GAP",market_priority:Math.round(e._priority),data_quality:0,confidence:0,reason_codes:[],warnings:["STORICO_NON_SUFFICIENTE"],market_checked:false,model_version:MODEL_VERSION};
  });
  const previewById=new Map(state.radar.map(x=>[x.event_id,x]));

  const candidates=events
    .filter(e=>e.status==="pending"&&hoursUntil(e.date)>=LOCK_MIN_HOURS&&hoursUntil(e.date)<=LOCK_MAX_HOURS)
    .map(e=>{const p=previewById.get(String(e.id));return{...e,_priority:eventPriority(e,quant)+(p?.pre_status==="EARLY WATCH"?35:0)+(p?.robust_prob?Math.max(0,(p.robust_prob-.5)*100):0)}})
    .sort((a,b)=>b._priority-a._priority||String(a.date).localeCompare(String(b.date)));
  const existing=new Map((state.upcoming||[]).map(x=>[x.event_id,x]));
  const unseen=candidates.filter(e=>!existing.has(String(e.id)));

  // Budget-aware rotating batch: process only a safe slice each run.
  state.cursor=state.cursor||{};
  const total=unseen.length;
  let start=total ? (state.cursor.prediction_offset||0)%total : 0;
  let batch=[];
  if(total){
    const max=Math.min(MAX_NEW_PREDICTIONS_PER_RUN,total);
    for(let i=0;i<max;i++)batch.push(unseen[(start+i)%total]);
    state.cursor.prediction_offset=(start+batch.length)%Math.max(1,total);
  }

  const hourly=Number.isFinite(state.rate_limit?.remaining)?state.rate_limit.remaining:RUN_CAP;
  const safeCalls=Math.max(0,Math.min(RUN_CAP-runCalls-5,hourly-5));
  const safeEventCount=Math.min(batch.length,safeCalls*10);
  const newEvents=batch.slice(0,safeEventCount);

  const oddsMap=newEvents.length?await multiOdds(newEvents.map(e=>String(e.id)),bookmakers):new Map();

  for(const e of newEvents){
    const raw=oddsMap.get(String(e.id)),mkt=marketFromOdds(raw);if(!mkt)continue;
    const p=buildPrediction(e,mkt,quant,calibration,drift);if(!p)continue;
    state.upcoming.push(currentMarketSnapshot(p,mkt));
  }
  const refreshedMarkets=await refreshLockedMarkets(bookmakers);
  state.upcoming=(state.upcoming||[]).filter(p=>new Date(p.start_at)>new Date(NOW.getTime()-24*3600000)).sort((a,b)=>String(a.start_at).localeCompare(String(b.start_at))).slice(0,350);
  const lockById=new Map(state.upcoming.map(x=>[x.event_id,x]));
  state.radar=state.radar.map(r=>{const x=lockById.get(r.event_id);return x?{...r,market_checked:true,market_status:x.verdict,market_checked_at:x.predicted_at}:r});
  state.stats=stats(state.history);
  state.learning.challenger=challengerEvaluation(state.history);
  const activeSignals=state.upcoming.filter(x=>x.verdict==="VALUE"||x.verdict==="STRONG VALUE").length;
  state.risk={mode:(drift.sample||0)<50?"PAPER":"RESEARCH",sport_guard:"TENNIS_SPECIFIC",surface_adaptation_guard:"ON",fatigue_guard:"ON",active_signals:activeSignals,max_concurrent_signals:4,concentration_policy:"Monitor tournament/surface clustering; no basketball-style correlation assumptions are imported."};
  const pendingBatch=Math.max(0,unseen.length-newEvents.length);
  const status=state.usage.calls>=DAILY_CAP?"DAILY HOLD":(pendingBatch>0?"READY · BATCHING":"READY");
  state.meta={
    updated_at:NOW.toISOString(),status,source:"Odds-API.io Free + Jeff Sackmann",model_version:MODEL_VERSION,
    bookmakers,locked_predictions:state.upcoming.length,radar_events:state.radar.length,pre_analyzed:state.radar.filter(x=>x.pre_status!=="DATA GAP").length,early_watch:state.radar.filter(x=>x.pre_status==="EARLY WATCH").length,data_gap:state.radar.filter(x=>x.pre_status==="DATA GAP").length,market_checked:state.radar.filter(x=>x.market_checked).length,calibration_sample:calibration.sample||0,calibration_active:!!calibration.active,
    model_health:drift.health,operating_mode:(drift.sample||0)<50?"PAPER VALIDATION":"LIVE RESEARCH",api_usage_today:state.usage.calls,api_daily_guard:DAILY_CAP,api_hourly_remaining:state.rate_limit?.remaining??null,rate_limit_reset_at:state.rate_limit?.reset_at??null,rate_limit_minutes:minutesUntil(state.rate_limit?.reset_at),run_calls:runCalls,
    pending_prediction_batch:pendingBatch,processed_this_run:newEvents.length,market_refresh_count:refreshedMarkets,quote_refresh_limit:QUOTE_REFRESH_LIMIT,quote_refresh_policy:"Hourly priority refresh of up to 30 locked matches; prediction remains immutable.",
    priority_policy:"Grand Slam > 1000/Finals > 500 > 250 > Challenger > ITF; then Top 10/25/50/100 + Elo + ranking points",benchmark:{version:"2026-08",no_vig_reference:true,automatic_settlement:true,clv_tracking:true,beginner_pro_modes:true,sharp_liquidity:false,sharp_liquidity_note:"Not available in the current zero-cost data plan; never inferred."},
    history_matches_loaded:quant.atp.rows.length+quant.wta.rows.length,
    sport_specific_guard:"Surface sample + surface-transition adaptation + recent workload/fatigue uncertainty",
    cross_app_learning:"Shared validation, audit, fail-closed and challenger discipline; sport model remains tennis-specific.",
    note:"NO BET first. Every radar match gets immediate tennis-specific pre-analysis; market calls are reserved for the highest-priority candidates. Three-engine ensemble, surface adaptation guard, workload uncertainty, segmented calibration, shadow challenger and rate-aware batching. Missing data is never invented. Locked predictions are never rewritten; current market snapshots are stored separately."
  };
  await saveState(state);
  console.log(JSON.stringify({meta:state.meta,stats:state.stats},null,2));
}

function selfTest(){
  const fake={bookmakers:{A:[{name:"ML",odds:[{home:1.80,away:2.10}],updatedAt:NOW.toISOString()}],B:[{name:"ML",odds:[{home:1.84,away:2.06}],updatedAt:NOW.toISOString()}]}};
  const m=marketFromOdds(fake);if(!m||m.count!==2||!(m.consensus>.4&&m.consensus<.7))throw new Error("SELFTEST_MARKET");
  const n=buildNameResolver(new Set(["jannik sinner","carlos alcaraz"]));if(!n.get("sinner|j")||!n.get("alcaraz|c"))throw new Error("SELFTEST_NAMES");
  const r=parseResetAt("60");if(!r||minutesUntil(r)<0)throw new Error("SELFTEST_RATE");
  const ad=adaptationContext({last_match_days:3,last_surface:"Clay",matches7:2,workload7:180},{last_match_days:12,last_surface:"Hard",matches7:1,workload7:90},"Hard");
  if(!ad.a.surfaceChange||ad.b.surfaceChange||ad.riskMax!==1)throw new Error("SELFTEST_ADAPTATION");
  const load=adaptationContext({last_match_days:2,last_surface:"Hard",matches7:5,workload7:560},{last_match_days:3,last_surface:"Hard",matches7:2,workload7:180},"Hard");
  if(!load.a.denseLoad||load.riskMax!==1)throw new Error("SELFTEST_FATIGUE");
  console.log(JSON.stringify({ok:true,model:MODEL_VERSION,tests:["market_no_vig","name_resolver","rate_limit_parser","surface_adaptation_guard","fatigue_guard"]}));
}
if(process.argv.includes("--self-test")){selfTest();process.exit(0)}
try{await main()}
catch(e){
  console.error(e);
  let status="DEGRADED";
  let note="State preserved; next scheduled run continues automatically.";

  if(e.message==="RATE_LIMIT_429"||e.message==="RATE_LIMIT_WAIT"){
    status=rateLimitLabel();
    note="Limite orario raggiunto: il motore riparte automaticamente dopo il reset.";
  }
  else if(e.message==="DAILY_BUDGET_GUARD"){
    status="DAILY HOLD";
    note="Budget giornaliero di sicurezza raggiunto: ripresa automatica domani.";
  }
  else if(e.message==="RUN_BUDGET_GUARD"){
    status="READY · NEXT BATCH";
    note="Lotto corrente completato: il prossimo ciclo continua con i match rimanenti.";
  }

  state.meta={
    ...(state.meta||{}),
    updated_at:NOW.toISOString(),
    status,
    source:"Odds-API.io Free + Jeff Sackmann",
    model_version:MODEL_VERSION,
    error:e.message,
    api_usage_today:state.usage.calls,
    api_daily_guard:DAILY_CAP,
    api_hourly_remaining:state.rate_limit?.remaining??null,
    rate_limit_reset_at:state.rate_limit?.reset_at??null,
    rate_limit_minutes:minutesUntil(state.rate_limit?.reset_at),
    run_calls:runCalls,
    note
  };
  await saveState(state);
  process.exitCode=0; // preserve last good board; do not destroy the autonomous loop
}
