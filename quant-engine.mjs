import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const API_KEY=process.env.ODDS_API_KEY;
const BASE="https://api.odds-api.io/v3";
const OUT="data/quant-board.json";
const MODEL_VERSION="TENNIS-EDGE-QUANT-6.0";
const NOW=new Date();
const DAILY_CAP=380;          // free tier 500/day: 80 calls safety reserve
const RUN_CAP=28;             // protects accidental loops
const LOCK_MIN_HOURS=1;
const LOCK_MAX_HOURS=36;
const RADAR_DAYS=7;
const MAX_NEW_PREDICTIONS_PER_RUN=120;
const MAX_SETTLEMENTS_PER_RUN=6;
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
  const rl=state?.rate_limit||{};
  const reset=rl.reset_at;
  const remaining=Number(rl.remaining);
  // A future reset timestamp alone does NOT mean we are blocked.
  // Providers often send the next reset time on every successful response.
  // Pause only when the provider has explicitly exhausted the window.
  return !!(reset&&new Date(reset)>NOW&&Number.isFinite(remaining)&&remaining<=0);
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
const BOARD_SCHEMA="TEP_BOARD_V6";

function validateStateShape(s){
  if(!s||typeof s!=="object"||Array.isArray(s))throw new Error("STATE_INVALID");
  for(const k of["radar","upcoming","history"]){
    if(s[k]!=null&&!Array.isArray(s[k]))throw new Error(`STATE_${k.toUpperCase()}_INVALID`);
  }
  if(s.meta!=null&&(typeof s.meta!=="object"||Array.isArray(s.meta)))throw new Error("STATE_META_INVALID");
  return true;
}
function stateChecksum(s){
  return hash({
    schema:BOARD_SCHEMA,model:s?.meta?.model_version||MODEL_VERSION,updated:s?.meta?.updated_at||null,
    radar:(s?.radar||[]).map(x=>x.preview_id||x.event_id).slice(0,350),
    upcoming:(s?.upcoming||[]).map(x=>x.audit_id||x.event_id).slice(0,350),
    history:(s?.history||[]).slice(0,100).map(x=>x.audit_id||x.event_id)
  });
}
async function saveState(s){
  validateStateShape(s);
  s.schema_version=BOARD_SCHEMA;
  s.board_integrity={checksum:stateChecksum(s),generated_at:NOW.toISOString(),model_version:s?.meta?.model_version||MODEL_VERSION};
  await fs.mkdir(path.dirname(OUT),{recursive:true});
  await fs.writeFile(OUT,JSON.stringify(s,null,2)+"\\n","utf8");
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
    headers:{"user-agent":"TennisEdgePro/6.0"}
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
  const r=await fetch(url,{headers:{"user-agent":"TennisEdgePro/6.0"}});
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
function playerNameParts(value){
  let raw=String(value||"").trim();
  raw=raw.replace(/\([^)]*\)/g," ").replace(/\[[^\]]*\]/g," ");
  raw=raw.replace(/\b(?:sr|jr|ii|iii|iv)\b\.?/gi," ");
  const comma=raw.includes(",");
  const n=norm(raw);
  let tok=n.split(" ").filter(Boolean).filter(x=>!["atp","wta","q","qual","qualifying"].includes(x));
  if(!tok.length)return{norm:"",tokens:[],first:"",last:"",initial:""};
  if(comma&&tok.length>=2)tok=[...tok.slice(1),tok[0]];
  let first=tok[0],last=tok[tok.length-1];
  if(tok.length>=2&&tok[tok.length-1].length===1&&tok[0].length>1){
    first=tok[tok.length-1];
    last=tok.slice(0,-1).join(" ");
  }else if(tok.length>=3&&tok[0].length===1){
    first=tok[0];
    last=tok.slice(1).join(" ");
  }else if(tok.length>=3){
    first=tok[0];
    last=tok.slice(1).join(" ");
  }
  return{norm:n,tokens:tok,first,last,initial:(first||"")[0]||""};
}
function buildNameResolver(names){
  const exact=new Map(),bySig=new Map(),byLast=new Map(),byLoose=new Map();
  for(const n of names){
    exact.set(n,n);
    const p=playerNameParts(n);if(!p.last)continue;
    const sig=`${p.last}|${p.initial}`;
    if(!bySig.has(sig))bySig.set(sig,[]);bySig.get(sig).push(n);
    if(!byLast.has(p.last))byLast.set(p.last,[]);byLast.get(p.last).push(n);
    const loose=`${p.last.slice(0,6)}|${p.initial}`;
    if(!byLoose.has(loose))byLoose.set(loose,[]);byLoose.get(loose).push(n);
  }
  return{exact,bySig,byLast,byLoose};
}
function resolveNameKey(name,tourData){
  const n=norm(name);if(!n)return null;
  if(tourData.names.has(n))return n;
  const r=tourData.nameResolver;if(!r)return null;
  if(r.exact?.has(n))return r.exact.get(n);
  const p=playerNameParts(name);if(!p.last)return null;
  const sig=`${p.last}|${p.initial}`,sigC=r.bySig?.get(sig)||[];
  if(sigC.length===1)return sigC[0];
  const lastC=r.byLast?.get(p.last)||[];
  if(lastC.length===1)return lastC[0];
  const loose=r.byLoose?.get(`${p.last.slice(0,6)}|${p.initial}`)||[];
  const scored=loose.map(c=>{
    const q=playerNameParts(c);
    let score=0;
    if(q.last===p.last)score+=8;
    if(q.initial===p.initial&&p.initial)score+=5;
    if(q.last.startsWith(p.last)||p.last.startsWith(q.last))score+=4;
    if(q.first&&p.first&&(q.first.startsWith(p.first)||p.first.startsWith(q.first)))score+=3;
    return{c,score};
  }).sort((a,b)=>b.score-a.score);
  if(scored[0]&&scored[0].score>=9&&(!scored[1]||scored[0].score-scored[1].score>=3))return scored[0].c;
  return null;
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
    matches7:recent7.length,matches14:recent14.length,last_match_days:latest?daysAgo(latest.tourney_date):null
  };
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
async function fetchHistoricalSeason(tour,year){
  // Jeff Sackmann's original repos became unavailable in 2026.
  // Use the public archival mirror first and Hugging Face as an independent fallback.
  const file=`${tour}_matches_${year}.csv`;
  const urls=[
    `https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main/${tour}/${file}`,
    `https://huggingface.co/datasets/Aneeshers/tennis-sackmann-archive/resolve/main/${tour}/${file}?download=true`
  ];
  const errors=[];
  for(const url of urls){
    try{
      const text=await fetchText(url);
      const rows=csvParse(text);
      if(!rows.length)throw new Error("EMPTY_CSV");
      return{rows,source:url.includes("githubusercontent")?"github-archive":"huggingface-archive",url};
    }catch(e){errors.push(e.message)}
  }
  throw new Error(`HISTORY_UNAVAILABLE_${tour.toUpperCase()}_${year}: ${errors.join(" | ")}`);
}

async function loadQuantHistory(){
  const tours={atp:[],wta:[]};
  const sourceReport={loaded:[],failed:[]};
  for(const tour of ["atp","wta"]){
    for(const y of YEARS){
      try{
        const r=await fetchHistoricalSeason(tour,y);
        tours[tour].push(...r.rows);
        sourceReport.loaded.push({tour,year:y,rows:r.rows.length,source:r.source});
      }catch(e){
        sourceReport.failed.push({tour,year:y,error:e.message});
        console.error("history",tour,y,e.message);
      }
    }
  }
  const today=+dayKey(NOW).replaceAll("-","");
  for(const k of Object.keys(tours))tours[k]=tours[k].filter(m=>dateNum(m)<=today);
  const build=rows=>{
    const names=playerNameSet(rows);
    return{rows,names,nameResolver:buildNameResolver(names),byPlayer:buildPlayerHistoryIndex(rows),h2hIndex:buildH2HIndex(rows),ratings:buildRatings(rows),ranks:latestRankIndex(rows),surfaceIndex:tournamentSurfaceIndex(rows)};
  };
  return{atp:build(tours.atp),wta:build(tours.wta),sourceReport};
}
function resolveTour(event,hist){
  const l=norm(event.league?.name||"");
  const hinted=l.includes("wta")?"wta":l.includes("atp")?"atp":null;
  if(hinted){
    const d=hist[hinted];
    return resolveNameKey(event.home,d)&&resolveNameKey(event.away,d)?hinted:null;
  }
  const atpA=resolveNameKey(event.home,hist.atp),atpB=resolveNameKey(event.away,hist.atp);
  const wtaA=resolveNameKey(event.home,hist.wta),wtaB=resolveNameKey(event.away,hist.wta);
  const inATP=!!(atpA&&atpB),inWTA=!!(wtaA&&wtaB);
  if(inATP&&!inWTA)return"atp";
  if(inWTA&&!inATP)return"wta";
  return null;
}
function eventResolution(event,h){
  const tour=resolveTour(event,h);
  if(!tour){
    const d=resolutionDiagnostic(event,h);
    return{ok:false,tour:null,a:null,b:null,reason:d.reason||"TOUR_AMBIGUOUS"};
  }
  const td=h[tour];
  const a=resolveNameKey(event.home,td),b=resolveNameKey(event.away,td);
  if(!a||!b)return{ok:false,tour,a,b,reason:!a?"PLAYER_A_UNRESOLVED":"PLAYER_B_UNRESOLVED"};
  return{ok:true,tour,a,b,reason:null};
}
function premiumEvent(event){
  const p=circuitPriority(event);
  const l=norm(event.league?.name||"");
  return p>=60||/\b(atp|wta)\b/.test(l);
}
function resolutionDiagnostic(event,h){
  const l=norm(event.league?.name||"");
  const atpA=resolveNameKey(event.home,h.atp),atpB=resolveNameKey(event.away,h.atp);
  const wtaA=resolveNameKey(event.home,h.wta),wtaB=resolveNameKey(event.away,h.wta);
  const hinted=l.includes("wta")?"wta":l.includes("atp")?"atp":null;
  return{
    hinted_tour:hinted,
    atp_a:!!atpA,atp_b:!!atpB,wta_a:!!wtaA,wta_b:!!wtaB,
    resolved_a:atpA||wtaA||null,resolved_b:atpB||wtaB||null,
    reason:hinted
      ?(!(hinted==="atp"?atpA:wtaA)?"PLAYER_A_UNRESOLVED":!(hinted==="atp"?atpB:wtaB)?"PLAYER_B_UNRESOLVED":"UNKNOWN")
      :(!atpA&&!wtaA?"PLAYER_A_UNRESOLVED":!atpB&&!wtaB?"PLAYER_B_UNRESOLVED":"TOUR_AMBIGUOUS")
  };
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

  let dq=40+(A.rank&&B.rank?10:0)+Math.min(15,(A.n+B.n)/7)+Math.min(12,Math.min(A.surfaceN,B.surfaceN)/2.2)+(A.statN&&B.statN?8:0)+Math.min(5,HH.n);
  dq=clamp(dq,30,96);
  let sportsConf=clamp(38+dq*.5-(dis*100)*.75-(unanimous?0:10)-drift.penalty,24,94);sportsConf=Math.min(sportsConf,dq+2);
  const uncertainty=clamp(.025+(100-dq)*.00115+dis*.28+(drift.health==="DRIFT"?.035:drift.health==="WATCH"?.018:0),.035,.16);

  return{tour,d,surface,keyA,keyB,A,B,HH,eloA,eloB,sEloA,sEloB,srA,srB,fatigueEdge,modelA,modelB,modelC,rawP,shadowRaw,cal,pA,pB,votesA,votesB,majority,unanimous,dis,dq,sportsConf,uncertainty};
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

function dynamicPolicy(health,calibrationSample){
  const h=String(health||"COLD").toUpperCase(),n=Number(calibrationSample)||0;
  if(h==="COLD"||n<25)return{minConfidence:74,minDQ:72,minEV:.075,minEdge:.035,minRobustEV:.025,minRobustEdge:.018,strong:false};
  if(h==="LEARNING"||h==="WATCH"||n<60)return{minConfidence:70,minDQ:68,minEV:.06,minEdge:.03,minRobustEV:.02,minRobustEdge:.015,strong:false};
  return{minConfidence:66,minDQ:64,minEV:.05,minEdge:.025,minRobustEV:.015,minRobustEdge:.012,strong:true};
}
function referenceConfidence(mkt,candidateAge){
  let score=100;
  const depth=Number(mkt?.count),sd=Number(mkt?.sd),margin=Number(mkt?.margin),age=Number(candidateAge);
  if(!Number.isFinite(depth)||depth<1)score-=55;else if(depth===1)score-=28;else if(depth===2)score-=10;
  if(Number.isFinite(sd))score-=clamp(sd/.08,0,1)*28;
  if(Number.isFinite(margin))score-=clamp(Math.max(0,margin-.04)/.14,0,1)*18;
  if(Number.isFinite(age))score-=age>90?30:age>60?18:age>30?7:0;else score-=8;
  return Math.round(clamp(score,0,100));
}
function anomalyQuarantine({candidateEV,robustEV,candidateOdds,candidateProb,modelProb,marketProb,confidence,dataQuality,disagreement}){
  const reasons=[];
  if(Number.isFinite(candidateEV)&&candidateEV>1.25)reasons.push("EV_FUORI_SCALA");
  if(Number.isFinite(robustEV)&&robustEV>.85)reasons.push("ROBUST_EV_FUORI_SCALA");
  if(Number.isFinite(candidateOdds)&&candidateOdds>=6&&Number.isFinite(candidateProb)&&candidateProb>.38)reasons.push("QUOTA_PROBABILITA_INCOERENTI");
  if(Number.isFinite(modelProb)&&Number.isFinite(marketProb)&&Math.abs(modelProb-marketProb)>.28)reasons.push("SCOSTAMENTO_ESTREMO");
  if(Number.isFinite(candidateEV)&&candidateEV>.25&&Number.isFinite(confidence)&&confidence<62)reasons.push("EV_ALTO_CONFIDENCE_BASSA");
  if(Number.isFinite(candidateEV)&&candidateEV>.20&&Number.isFinite(dataQuality)&&dataQuality<60)reasons.push("EV_ALTO_DATI_DEBOLI");
  if(Number.isFinite(candidateEV)&&candidateEV>.15&&Number.isFinite(disagreement)&&disagreement>.16)reasons.push("EV_ALTO_MODELLI_DISCORDI");
  return{quarantine:reasons.length>0,reasons:[...new Set(reasons)]};
}
function marketIntegrity(mkt,candidateAge){
  const reasons=[],flags=[];
  const depth=Number(mkt?.count),sd=Number(mkt?.sd),margin=Number(mkt?.margin);
  if(!Number.isFinite(depth)||depth<1)reasons.push("MERCATO_NON_DISPONIBILE");else if(depth===1)flags.push("MERCATO_SOTTILE");
  if(Number.isFinite(sd)&&sd>.085)reasons.push("MERCATO_DISPERSO");else if(Number.isFinite(sd)&&sd>.055)flags.push("DISPERSIONE_ALTA");
  if(Number.isFinite(margin)&&(margin>.18||margin<-.02))reasons.push("MARGINE_ANOMALO");else if(Number.isFinite(margin)&&margin>.11)flags.push("MARGINE_ALTO");
  if(Number.isFinite(candidateAge)&&candidateAge>90)reasons.push("QUOTA_STALE");else if(Number.isFinite(candidateAge)&&candidateAge>60)flags.push("QUOTA_AGING");
  return{ok:reasons.length===0,score:referenceConfidence(mkt,candidateAge),reasons:[...new Set(reasons)],flags:[...new Set(flags)]};
}
function evaluateDecision(c,mkt,candidate,drift){
  let dq=clamp(c.dq+(mkt.updated_books?4:0)+(mkt.count>=2?3:0),30,98);
  let conf=clamp(c.sportsConf-clamp(mkt.sd/.06,0,1)*8+(mkt.count>=2?2:0),22,95);conf=Math.min(conf,dq+2);
  const marketProb=candidate.side==="A"?mkt.consensus:(1-mkt.consensus);
  const robustProb=Math.max(.01,candidate.prob-c.uncertainty),robustEdge=robustProb-marketProb,robustEV=robustProb*candidate.odds-1;
  const policy=dynamicPolicy(drift.health,c.cal.sample),integrity=marketIntegrity(mkt,candidate.age);
  const quarantine=anomalyQuarantine({candidateEV:candidate.ev,robustEV,candidateOdds:candidate.odds,candidateProb:candidate.prob,modelProb:candidate.prob,marketProb,confidence:conf,dataQuality:dq,disagreement:c.dis});
  const hard=[];
  if(candidate.ev<=0)hard.push("EV_NON_POSITIVO");
  if(robustEV<=0)hard.push("ROBUST_EV_NON_POSITIVO");
  if(candidate.edge<policy.minEdge)hard.push("EDGE_TROPPO_BASSO");
  if(robustEdge<policy.minRobustEdge)hard.push("EDGE_NON_ROBUSTO");
  if(candidate.ev<policy.minEV)hard.push("EV_SOTTO_SOGLIA");
  if(robustEV<policy.minRobustEV)hard.push("ROBUST_EV_SOTTO_SOGLIA");
  if(dq<policy.minDQ)hard.push("DATA_QUALITY_SOTTO_SOGLIA");
  if(conf<policy.minConfidence)hard.push("CONFIDENCE_SOTTO_SOGLIA");
  if(c.dis>.13)hard.push("MODELLI_IN_DISACCORDO");
  if(c.majority!==candidate.side)hard.push("CONSENSUS_NON_SUL_CANDIDATO");
  if(drift.health==="DRIFT")hard.push("MODEL_DRIFT");
  if((drift.sample||0)<20)hard.push("MODELLO_COLD");
  hard.push(...integrity.reasons);
  let verdict="NO BET";
  if(quarantine.quarantine)verdict="QUARANTINE";
  else if(!hard.length){
    verdict="WATCH";
    if(c.unanimous&&c.cal.active&&drift.health==="HEALTHY"&&candidate.ev>=.065&&candidate.edge>=.032&&robustEV>=.022&&robustEdge>=.012&&c.dis<.095)verdict="VALUE";
    if(policy.strong&&c.unanimous&&c.cal.active&&(drift.sample||0)>=120&&drift.health==="HEALTHY"&&conf>=84&&dq>=84&&candidate.ev>=.10&&candidate.edge>=.05&&robustEV>=.04&&robustEdge>=.02&&c.dis<.065&&Number.isFinite(candidate.age)&&candidate.age<=30)verdict="STRONG VALUE";
  }
  return{dq,conf,marketProb,robustProb,robustEdge,robustEV,policy,integrity,quarantine,hard:[...new Set(hard)],verdict,reference_confidence:integrity.score};
}
function predictionIdentity(x){return[norm(x?.player_a||""),norm(x?.player_b||""),norm(x?.tournament||""),String(x?.start_at||"").slice(0,16)].join("|")}
function dedupeLocked(rows){
  const seen=new Set(),out=[];for(const x of rows||[]){const key=x.prediction_identity||predictionIdentity(x);if(seen.has(key))continue;seen.add(key);out.push(x)}return out;
}
function walkForwardHealth(history){
  const closed=(history||[]).filter(x=>x.status==="SETTLED"&&Number.isFinite(Number(x.p_a))&&x.actual_side).sort((a,b)=>String(a.settled_at||a.start_at).localeCompare(String(b.settled_at||b.start_at)));
  if(closed.length<30)return{sample:closed.length,status:"COLD",prior_brier:null,recent_brier:null,delta:null};
  const cut=Math.max(15,Math.floor(closed.length*.7));
  const calc=rows=>rows.reduce((sum,x)=>{const y=x.actual_side==="A"?1:0;return sum+(Number(x.p_a)-y)**2},0)/Math.max(1,rows.length);
  const prior=calc(closed.slice(0,cut)),recent=calc(closed.slice(cut)),delta=recent-prior;
  return{sample:closed.length,status:delta>.045?"DRIFT":delta>.02?"WATCH":"STABLE",prior_brier:prior,recent_brier:recent,delta};
}
function modelCard(state,quant,drift,calibration){
  return{model_version:MODEL_VERSION,schema_version:BOARD_SCHEMA,operating_mode:(drift.sample||0)<50?"PAPER VALIDATION":"VALIDATION",model_health:drift.health,calibration_active:!!calibration.active,calibration_sample:calibration.sample||0,historical_matches:(quant?.atp?.rows?.length||0)+(quant?.wta?.rows?.length||0),engines:["Strength","Surface","Form/Matchup"],market_reference:"No-vig consensus of selected recreational books",prediction_lock:"Immutable after first creation",learning:"Champion vs Challenger shadow evaluation",no_bet_policy:"Fail closed on missing, stale, anomalous or weak evidence"};
}
function dataProvenance(quant,bookmakers){
  return{market:{provider:"Odds-API.io",bookmakers:[...(bookmakers||[])],mode:"selected free bookmakers",timestamp:NOW.toISOString()},historical:{provider:"Sackmann archival mirror",atp_sources:quant?.sourceReport?.loaded?.filter(x=>x.tour==="atp").length||0,wta_sources:quant?.sourceReport?.loaded?.filter(x=>x.tour==="wta").length||0,failures:quant?.sourceReport?.failed||[]},settlement:{provider:"Odds-API.io event result endpoint"},generated_at:NOW.toISOString()};
}
function buildPrediction(event,mkt,h,calSet,drift){
  const c=sportsCore(event,h,calSet,drift);if(!c)return null;
  const edgeA=c.pA-mkt.consensus,edgeB=c.pB-(1-mkt.consensus),evA=c.pA*mkt.bestA-1,evB=c.pB*mkt.bestB-1;
  const candidate=evA>=evB
    ?{side:"A",name:event.home,odds:mkt.bestA,book:mkt.bestBookA,ev:evA,edge:edgeA,prob:c.pA,age:mkt.bestAgeA,updated:mkt.bestUpdatedA}
    :{side:"B",name:event.away,odds:mkt.bestB,book:mkt.bestBookB,ev:evB,edge:edgeB,prob:c.pB,age:mkt.bestAgeB,updated:mkt.bestUpdatedB};
  const d=evaluateDecision(c,mkt,candidate,drift);
  const official=d.verdict==="VALUE"||d.verdict==="STRONG VALUE",watch=d.verdict==="WATCH";
  const reasons=sportsReasons(c,candidate.side);if(candidate.ev>0)reasons.push(candidate.ev>=.08?"EV ++":"EV +");
  const warnings=[...d.hard,...d.integrity.flags];if(!c.unanimous)warnings.push("CONSENSUS_2_SU_3");if(!Number.isFinite(candidate.age))warnings.push("FRESHNESS_NON_VERIFICABILE");if(!c.cal.active)warnings.push("CALIBRAZIONE_NON_ATTIVA");
  const payload={
    event_id:String(event.id),start_at:event.date,player_a:event.home,player_b:event.away,tournament:event.league?.name||"—",league_slug:event.league?.slug||null,priority:Math.round(event._priority??eventPriority(event,h)),
    surface:c.surface,tour:c.tour,raw_p_a:c.rawP,shadow_p_a:c.shadowRaw,p_a:c.pA,p_b:c.pB,uncertainty:c.uncertainty,probability_low:Math.max(.01,candidate.prob-c.uncertainty),probability_high:Math.min(.99,candidate.prob+c.uncertainty),
    model_a_p:c.modelA,model_b_p:c.modelB,model_c_p:c.modelC,model_a_name:"Strength",model_b_name:"Surface",model_c_name:"Form/Matchup",model_disagreement:c.dis,engine_votes:`${Math.max(c.votesA,c.votesB)}/3`,engine_majority:c.majority,engine_unanimous:c.unanimous,
    fair_a:1/c.pA,fair_b:1/c.pB,candidate_side:candidate.side,candidate_name:candidate.name,candidate_prob:candidate.prob,candidate_odds:candidate.odds,candidate_book:candidate.book,candidate_ev:candidate.ev,candidate_edge:candidate.edge,robust_prob:d.robustProb,robust_ev:d.robustEV,robust_edge:d.robustEdge,
    pick_side:official?candidate.side:null,pick_name:official?candidate.name:null,pick_prob:official?candidate.prob:null,pick_odds:official?candidate.odds:null,pick_book:official?candidate.book:null,pick_ev:official?candidate.ev:null,pick_edge:official?candidate.edge:null,
    watch_side:watch?candidate.side:null,watch_name:watch?candidate.name:null,verdict:d.verdict,confidence:d.conf,sports_confidence:c.sportsConf,data_quality:d.dq,reference_confidence:d.reference_confidence,
    market_depth:mkt.count,market_consensus_a:mkt.consensus,market_sd:mkt.sd,market_margin:mkt.margin,market_updated_at:candidate.updated,market_age_minutes:Number.isFinite(candidate.age)?candidate.age:null,market_integrity_score:d.integrity.score,market_integrity_flags:d.integrity.flags,market_integrity_reasons:d.integrity.reasons,
    quarantine:d.quarantine.quarantine,quarantine_reasons:d.quarantine.reasons,
    rank_a:c.A.rank,rank_b:c.B.rank,elo_a:c.eloA,elo_b:c.eloB,surface_elo_a:c.sEloA,surface_elo_b:c.sEloB,form_a:c.A.form,form_b:c.B.form,surface_form_a:c.A.surface,surface_form_b:c.B.surface,h2h_n:c.HH.n,h2h_edge:c.HH.edge,serve_return_delta:c.srA-c.srB,workload7_a:c.A.workload7,workload7_b:c.B.workload7,rest_days_a:c.A.last_match_days,rest_days_b:c.B.last_match_days,
    reason_codes:reasons.slice(0,7),no_bet_reasons:[...new Set([...d.hard,...d.quarantine.reasons])],warnings:[...new Set(warnings)],risk_policy:d.policy,
    calibration_sample:c.cal.sample,calibration_scope:c.cal.scope,calibration_active:!!c.cal.active,model_health:drift.health,model_version:MODEL_VERSION,
    predicted_at:NOW.toISOString(),prediction_identity:predictionIdentity({player_a:event.home,player_b:event.away,tournament:event.league?.name||"—",start_at:event.date}),locked:true,status:"LOCKED"
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

function rejectionSummary(upcoming){
  const counts={};
  for(const x of upcoming||[]){
    for(const r of x.no_bet_reasons||[]){
      counts[r]=(counts[r]||0)+1;
    }
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a,b)=>b[1]-a[1])
  );
}

function researchReadiness(x){
  let score=0;
  const ev=Number(x.candidate_ev), rev=Number(x.robust_ev);
  const edge=Number(x.candidate_edge), redge=Number(x.robust_edge);
  const conf=Number(x.confidence), dq=Number(x.data_quality);
  const age=Number(x.market_age_minutes), dis=Number(x.model_disagreement);

  if(Number.isFinite(ev))score+=clamp(ev*230, -20, 28);
  if(Number.isFinite(rev))score+=clamp(rev*250, -20, 28);
  if(Number.isFinite(edge))score+=clamp(edge*160, -10, 12);
  if(Number.isFinite(redge))score+=clamp(redge*180, -10, 12);
  if(Number.isFinite(conf))score+=(conf-50)*.45;
  if(Number.isFinite(dq))score+=(dq-50)*.35;
  if(x.engine_unanimous)score+=8;
  else if(x.engine_votes==="2/3")score+=3;
  if(Number.isFinite(dis))score-=clamp(dis*65,0,12);
  if(Number.isFinite(age))score-=age>75?8:age<=30?2:0;

  // Structural blockers do not erase useful research information,
  // but they prevent the candidate from ever becoming an official pick.
  if((x.no_bet_reasons||[]).includes("MODEL_DRIFT"))score-=18;
  if((x.no_bet_reasons||[]).includes("DATI_INSUFFICIENTI"))score-=12;
  if((x.no_bet_reasons||[]).includes("MERCATO_DISPERSO"))score-=8;

  return Math.round(clamp(score,0,100));
}

function decisionFunnel(radar,upcoming){
  const r=radar||[],u=upcoming||[];
  const positiveEV=u.filter(x=>Number(x.candidate_ev)>0).length;
  const robustPositive=u.filter(x=>Number(x.robust_ev)>0).length;
  const confidenceOK=u.filter(x=>Number(x.confidence)>=66).length;
  const qualityOK=u.filter(x=>Number(x.data_quality)>=66).length;
  const consensusOK=u.filter(x=>x.engine_unanimous||x.engine_votes==="2/3").length;
  const freshOK=u.filter(x=>!Number.isFinite(Number(x.market_age_minutes))||Number(x.market_age_minutes)<=75).length;
  const watch=u.filter(x=>x.verdict==="WATCH").length;
  const quarantine=u.filter(x=>x.verdict==="QUARANTINE").length;
  const value=u.filter(x=>x.verdict==="VALUE"||x.verdict==="STRONG VALUE").length;

  return{
    radar:r.length,
    analyzable:r.filter(x=>x.pre_status!=="UNRESOLVED").length,
    unresolved:r.filter(x=>x.pre_status==="UNRESOLVED").length,
    market_checked:u.length,
    positive_ev:positiveEV,
    robust_positive_ev:robustPositive,
    confidence_ok:confidenceOK,
    quality_ok:qualityOK,
    consensus_ok:consensusOK,
    freshness_ok:freshOK,
    watch,
    quarantine,
    value
  };
}

function nearValueCandidates(upcoming){
  return [...(upcoming||[])]
    .filter(x=>(x.verdict==="NO BET"||x.verdict==="WATCH")&&!x.quarantine)
    .map(x=>({
      event_id:x.event_id,
      player_a:x.player_a,
      player_b:x.player_b,
      tournament:x.tournament,
      start_at:x.start_at,
      candidate_name:x.candidate_name,
      candidate_odds:x.candidate_odds,
      candidate_book:x.candidate_book,
      candidate_prob:x.candidate_prob,
      candidate_ev:x.candidate_ev,
      candidate_edge:x.candidate_edge,
      robust_ev:x.robust_ev,
      robust_edge:x.robust_edge,
      confidence:x.confidence,
      data_quality:x.data_quality,
      engine_votes:x.engine_votes,
      engine_unanimous:x.engine_unanimous,
      market_age_minutes:x.market_age_minutes,reference_confidence:x.reference_confidence,market_integrity_score:x.market_integrity_score,
      no_bet_reasons:x.no_bet_reasons||[],
      reason_codes:x.reason_codes||[],
      research_score:researchReadiness(x),
      model_health:x.model_health,
      verdict:x.verdict
    }))
    .sort((a,b)=>b.research_score-a.research_score)
    .slice(0,12);
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
      source:"Odds-API.io Free + Sackmann archival mirror",
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
    state.meta={...(state.meta||{}),updated_at:NOW.toISOString(),status:"SETUP",source:"Odds-API.io Free + Sackmann archival mirror",model_version:MODEL_VERSION,note:"Create free ODDS_API_KEY secret. No paid service required."};
    await saveState(state);return;
  }
  let bookmakers=[];
  try{
    bookmakers=selectedNames(await api("/bookmakers/selected"));
    if(bookmakers.length<1)throw new Error("NO_SELECTED_BOOKMAKERS");
  }catch(e){
    state.meta={...(state.meta||{}),updated_at:NOW.toISOString(),status:"SETUP",source:"Odds-API.io Free + Sackmann archival mirror",model_version:MODEL_VERSION,error:e.message,api_usage_today:state.usage.calls};
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
    .map(e=>{
      const res=eventResolution(e,quant);
      return{...e,_priority:eventPriority(e,quant),_resolution:res,_premium:premiumEvent(e)};
    })
    .sort((a,b)=>
      Number(b._resolution.ok)-Number(a._resolution.ok)||
      Number(b._premium)-Number(a._premium)||
      b._priority-a._priority||
      String(a.date).localeCompare(String(b.date))
    )
    .slice(0,300);

  state.radar=radarEvents.map(e=>{
    if(!e._resolution.ok){
      return{
        event_id:String(e.id),start_at:e.date,player_a:e.home,player_b:e.away,
        tournament:e.league?.name||"—",priority:Math.round(e._priority),premium:e._premium,
        pre_status:"UNRESOLVED",market_priority:Math.round(e._priority),
        data_quality:0,confidence:0,reason_codes:[],
        warnings:[e._resolution.reason||"STORICO_NON_SUFFICIENTE"],
        resolution:e._resolution,market_checked:false,model_version:MODEL_VERSION
      };
    }
    const p=buildPreview(e,quant,calibration,drift);
    if(p)return{...p,premium:e._premium,resolution:e._resolution};
    return{
      event_id:String(e.id),start_at:e.date,player_a:e.home,player_b:e.away,
      tournament:e.league?.name||"—",priority:Math.round(e._priority),premium:e._premium,
      pre_status:"DATA CAUTION",market_priority:Math.round(e._priority),
      data_quality:25,confidence:25,reason_codes:[],warnings:["DATI_PARZIALI"],
      resolution:e._resolution,market_checked:false,model_version:MODEL_VERSION
    };
  });
  const previewById=new Map(state.radar.map(x=>[x.event_id,x]));

  const candidates=events
    .filter(e=>e.status==="pending"&&hoursUntil(e.date)>=LOCK_MIN_HOURS&&hoursUntil(e.date)<=LOCK_MAX_HOURS)
    .map(e=>{
      const p=previewById.get(String(e.id));
      if(!p||p.pre_status==="UNRESOLVED")return null;
      return{...e,_priority:eventPriority(e,quant)+(p?.pre_status==="EARLY WATCH"?35:0)+(p?.robust_prob?Math.max(0,(p.robust_prob-.5)*100):0),_premium:!!p.premium};
    })
    .filter(Boolean)
    .sort((a,b)=>Number(b._premium)-Number(a._premium)||b._priority-a._priority||String(a.date).localeCompare(String(b.date)));
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
    state.upcoming.push(p);
  }
  state.upcoming=dedupeLocked((state.upcoming||[]).filter(p=>new Date(p.start_at)>new Date(NOW.getTime()-24*3600000)).sort((a,b)=>String(a.start_at).localeCompare(String(b.start_at)))).slice(0,350);
  const lockById=new Map(state.upcoming.map(x=>[x.event_id,x]));
  state.radar=state.radar.map(r=>{const x=lockById.get(r.event_id);return x?{...r,market_checked:true,market_status:x.verdict,market_checked_at:x.predicted_at}:r});
  state.stats=stats(state.history);
  state.learning.challenger=challengerEvaluation(state.history);
  state.learning.walk_forward=walkForwardHealth(state.history);
  state.decision_funnel=decisionFunnel(state.radar,state.upcoming);
  state.quarantine=(state.upcoming||[]).filter(x=>x.verdict==="QUARANTINE").slice(0,50);
  state.model_card=modelCard(state,quant,drift,calibration);
  state.data_provenance=dataProvenance(quant,bookmakers);
  state.rejection_summary=rejectionSummary(state.upcoming);
  state.near_value=nearValueCandidates(state.upcoming);
  const pendingBatch=Math.max(0,unseen.length-newEvents.length);
  const status=state.usage.calls>=DAILY_CAP?"DAILY HOLD":(pendingBatch>0?"READY · BATCHING":"READY");
  state.meta={
    updated_at:NOW.toISOString(),status,source:"Odds-API.io Free + Sackmann archival mirror",model_version:MODEL_VERSION,
    bookmakers,locked_predictions:state.upcoming.length,radar_events:state.radar.length,pre_analyzed:state.radar.filter(x=>x.pre_status!=="UNRESOLVED").length,early_watch:state.radar.filter(x=>x.pre_status==="EARLY WATCH").length,unresolved:state.radar.filter(x=>x.pre_status==="UNRESOLVED").length,data_gap:state.radar.filter(x=>x.pre_status==="UNRESOLVED").length,analyzable_radar:state.radar.filter(x=>x.pre_status!=="UNRESOLVED").length,market_checked:state.radar.filter(x=>x.market_checked).length,calibration_sample:calibration.sample||0,calibration_active:!!calibration.active,
    model_health:drift.health,operating_mode:(drift.sample||0)<50?"PAPER VALIDATION":"LIVE RESEARCH",api_usage_today:state.usage.calls,api_daily_guard:DAILY_CAP,api_hourly_remaining:state.rate_limit?.remaining??null,rate_limit_reset_at:state.rate_limit?.reset_at??null,rate_limit_minutes:minutesUntil(state.rate_limit?.reset_at),run_calls:runCalls,
    pending_prediction_batch:pendingBatch,processed_this_run:newEvents.length,
    positive_ev:state.decision_funnel.positive_ev,
    robust_positive_ev:state.decision_funnel.robust_positive_ev,
    confidence_ok:state.decision_funnel.confidence_ok,
    quality_ok:state.decision_funnel.quality_ok,
    watch_count:state.decision_funnel.watch,
    quarantine_count:state.decision_funnel.quarantine,
    value_count:state.decision_funnel.value,
    walk_forward_status:state.learning.walk_forward?.status||"COLD",
    walk_forward_sample:state.learning.walk_forward?.sample||0,
    board_schema:BOARD_SCHEMA,
    reference_policy:"No-vig consensus + dispersion + freshness + anomaly quarantine",
    top_rejection_reasons:Object.entries(state.rejection_summary).slice(0,6),
    priority_policy:"Resolvable ATP/WTA first; Grand Slam > 1000/Finals > 500 > 250 > Challenger > ITF; then Top 10/25/50/100 + Elo + ranking points",benchmark:{version:"2026-08",no_vig_reference:true,automatic_settlement:true,clv_tracking:true,beginner_pro_modes:true,sharp_liquidity:false,sharp_liquidity_note:"Not available in the current zero-cost data plan; never inferred."},
    history_matches_loaded:quant.atp.rows.length+quant.wta.rows.length,
    history_sources_loaded:quant.sourceReport?.loaded||[],
    history_sources_failed:quant.sourceReport?.failed||[],
    resolution_diagnostics:{
      player_a_unresolved:state.radar.filter(x=>x.pre_status==="UNRESOLVED"&&x.resolution?.reason==="PLAYER_A_UNRESOLVED").length,
      player_b_unresolved:state.radar.filter(x=>x.pre_status==="UNRESOLVED"&&x.resolution?.reason==="PLAYER_B_UNRESOLVED").length,
      tour_ambiguous:state.radar.filter(x=>x.pre_status==="UNRESOLVED"&&x.resolution?.reason==="TOUR_AMBIGUOUS").length,
      unresolved_examples:state.radar.filter(x=>x.pre_status==="UNRESOLVED").slice(0,8).map(x=>({a:x.player_a,b:x.player_b,t:x.tournament,reason:x.resolution?.reason||"UNKNOWN"}))
    },
    note:"NO BET first. Elite Terminal: anomaly quarantine, dynamic thresholds, no-vig reference confidence, immutable locks, schema validation, provenance, walk-forward health and explainable rejection reasons."
  };
  await saveState(state);
  console.log(JSON.stringify({meta:state.meta,stats:state.stats},null,2));
}

function selfTest(){
  const fake={bookmakers:{A:[{name:"ML",odds:[{home:1.80,away:2.10}],updatedAt:NOW.toISOString()}],B:[{name:"ML",odds:[{home:1.84,away:2.06}],updatedAt:NOW.toISOString()}]}};
  const m=marketFromOdds(fake);if(!m||m.count!==2||!(m.consensus>.4&&m.consensus<.7))throw new Error("SELFTEST_MARKET");
  const core={dq:82,sportsConf:80,uncertainty:.04,dis:.04,majority:"A",unanimous:true,cal:{active:true,sample:120,scope:"global"},pA:.62,pB:.38};
  const normal=evaluateDecision(core,{...m,consensus:.56,sd:.01,margin:.05,count:2,updated_books:2},{side:"A",prob:.62,odds:1.90,ev:.178,edge:.06,age:15},{health:"HEALTHY",sample:120});
  if(normal.verdict!=="VALUE")throw new Error("SELFTEST_NORMAL_VALUE:"+normal.verdict);
  const q=evaluateDecision({...core,pA:.72,pB:.28},{...m,consensus:.14,sd:.02,margin:.05,count:2,updated_books:2},{side:"A",prob:.72,odds:7.5,ev:4.4,edge:.58,age:10},{health:"HEALTHY",sample:150});
  if(q.verdict!=="QUARANTINE")throw new Error("SELFTEST_QUARANTINE");
  const cold=evaluateDecision(core,{...m,consensus:.56,sd:.01,margin:.05,count:2,updated_books:2},{side:"A",prob:.62,odds:1.75,ev:.085,edge:.06,age:15},{health:"COLD",sample:0});
  if(cold.verdict==="VALUE"||cold.verdict==="STRONG VALUE")throw new Error("SELFTEST_COLD");
  const stale=evaluateDecision(core,{...m,consensus:.56,sd:.01,margin:.05,count:2,updated_books:2},{side:"A",prob:.62,odds:1.75,ev:.085,edge:.06,age:120},{health:"HEALTHY",sample:120});
  if(!stale.hard.includes("QUOTA_STALE"))throw new Error("SELFTEST_STALE");
  const dd=dedupeLocked([{player_a:"J. Sinner",player_b:"C. Alcaraz",tournament:"US Open",start_at:"2026-08-25T18:00:00Z"},{player_a:"J. Sinner",player_b:"C. Alcaraz",tournament:"US Open",start_at:"2026-08-25T18:00:30Z"}]);
  if(dd.length!==1)throw new Error("SELFTEST_DEDUPE");
  const td={names:new Set(["jannik sinner","carlos alcaraz","alex de minaur"]),nameResolver:buildNameResolver(new Set(["jannik sinner","carlos alcaraz","alex de minaur"]))};
  for(const [x,want] of [["J. Sinner","jannik sinner"],["Sinner J.","jannik sinner"],["Sinner, Jannik","jannik sinner"],["C. Alcaraz","carlos alcaraz"],["De Minaur A.","alex de minaur"]])if(resolveNameKey(x,td)!==want)throw new Error("SELFTEST_NAMES:"+x);
  validateStateShape({meta:{},radar:[],upcoming:[],history:[]});
  if(walkForwardHealth([]).status!=="COLD")throw new Error("SELFTEST_WF");
  const r=parseResetAt("60");if(!r||minutesUntil(r)<0)throw new Error("SELFTEST_RATE");
  const prevRL=state.rate_limit;
  state.rate_limit={remaining:42,reset_at:new Date(Date.now()+3600000).toISOString(),last_status:200};if(rateLimitActive())throw new Error("SELFTEST_RATE_FALSE");
  state.rate_limit={remaining:0,reset_at:new Date(Date.now()+3600000).toISOString(),last_status:429};if(!rateLimitActive())throw new Error("SELFTEST_RATE_TRUE");
  state.rate_limit=prevRL;
  console.log(JSON.stringify({ok:true,model:MODEL_VERSION,schema:BOARD_SCHEMA,tests:["market_no_vig","normal_decision","anomaly_quarantine","cold_fail_closed","stale_quote","dedupe","name_resolver","state_schema","walk_forward","rate_limit"]}));
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
    source:"Odds-API.io Free + Sackmann archival mirror",
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
