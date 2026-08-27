import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const API_KEY=process.env.ODDS_API_KEY;
const BASE="https://api.odds-api.io/v3";
const STATE_OUT="data/quant-state.json";
const OUT="data/quant-board.json";
const MODEL_VERSION="TENNIS-EDGE-QUANT-12.5-AUTOPILOT";
const NOW=new Date();
const DAILY_CAP=330;          // reserve ~170/day for the independent live-score worker
const RUN_CAP=10;             // keeps hourly research inside the shared free-tier budget
const LOCK_MIN_HOURS=1;
const LOCK_MAX_HOURS=36;
const RADAR_DAYS=7;
const MAX_NEW_PREDICTIONS_PER_RUN=120;
const MAX_SETTLEMENTS_PER_RUN=6;
const QUOTE_REFRESH_LIMIT=10;  // refresh relevant locked matches without changing Prediction Lock
const MARKET_QUERY=""; // request all markets exposed by selected books; parser stays fail-closed
const MARKET_SIM_N=5000;
const YEARS=Array.from({length:4},(_,i)=>NOW.getUTCFullYear()-3+i);
const COMMERCIAL_MODE=/^(1|true|yes)$/i.test(String(process.env.COMMERCIAL_MODE||""));
const COMMERCIAL_ODDS_LICENSE_CONFIRMED=/^(1|true|yes)$/i.test(String(process.env.COMMERCIAL_ODDS_LICENSE_CONFIRMED||""));
const COMMERCIAL_HISTORY_LICENSE_CONFIRMED=/^(1|true|yes)$/i.test(String(process.env.COMMERCIAL_HISTORY_LICENSE_CONFIRMED||""));
const ATP_HISTORY_TEMPLATE=process.env.ATP_HISTORY_URL_TEMPLATE||"https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main/atp/atp_matches_{year}.csv";
const WTA_HISTORY_TEMPLATE=process.env.WTA_HISTORY_URL_TEMPLATE||"https://raw.githubusercontent.com/Aneeshers/tennis-sackmann-archive/main/wta/wta_matches_{year}.csv";
const USING_CUSTOM_HISTORY=!!(process.env.ATP_HISTORY_URL_TEMPLATE&&process.env.WTA_HISTORY_URL_TEMPLATE);
const SOURCE_LABEL=COMMERCIAL_MODE?"Commercial licensed-data configuration":"Research mode · Odds-API.io development tier + Sackmann archive mirror (CC BY-NC-SA)";
function assertCommercialLicenses(){
  if(!COMMERCIAL_MODE)return;
  if(!COMMERCIAL_ODDS_LICENSE_CONFIRMED)throw new Error("COMMERCIAL_ODDS_LICENSE_REQUIRED");
  if(!COMMERCIAL_HISTORY_LICENSE_CONFIRMED||!USING_CUSTOM_HISTORY)throw new Error("COMMERCIAL_HISTORY_LICENSE_REQUIRED");
}
function historyUrl(tour,year){const tpl=tour==="atp"?ATP_HISTORY_TEMPLATE:WTA_HISTORY_TEMPLATE;return tpl.replaceAll("{year}",String(year))}

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
  const exhausted=rl.last_status===429||(Number.isFinite(remaining)&&remaining<=0);
  return !!(exhausted&&reset&&new Date(reset)>NOW);
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

async function readJson(file){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return null}}
async function atomicJson(file,value,{pretty=true}={}){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp,JSON.stringify(value,null,pretty?2:0)+"\n","utf8");
  await fs.rename(tmp,file);
}
function roundPublic(value){
  if(Array.isArray(value))return value.map(roundPublic);
  if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,roundPublic(v)]));
  return typeof value==="number"&&Number.isFinite(value)?Number(value.toFixed(6)):value;
}
function publicRadar(x){
  return{
    event_id:x.event_id,start_at:x.start_at,player_a:x.player_a,player_b:x.player_b,
    tournament:x.tournament,priority:x.priority,pre_status:x.pre_status,surface:x.surface,
    tour:x.tour,favorite_name:x.favorite_name,favorite_prob:x.favorite_prob,
    confidence:x.confidence,data_quality:x.data_quality,market_checked:x.market_checked,
    preview_id:x.preview_id
  };
}
function compactRecentMatches(rows){
  return (rows||[]).slice(0,10).map(m=>({
    date:m.date,tournament:m.tournament,surface:m.surface,round:m.round,result:m.result,
    opponent:m.opponent,score:m.score,
    service:{service_games_won:m.service?.service_games_won??null},
    return:{return_games_won:m.return?.return_games_won??null}
  }));
}
function publicPrediction(x){
  const intel=x?.player_intel;
  if(!intel?.a||!intel?.b)return x;
  return{...x,player_intel:{...intel,a:{...intel.a,recent_matches:compactRecentMatches(intel.a.recent_matches)},b:{...intel.b,recent_matches:compactRecentMatches(intel.b.recent_matches)}}};
}
function publicBoard(s){
  const learning=s.learning||{};
  return roundPublic({
    meta:s.meta||{},stats:s.stats||{},market_stats:s.market_stats||{},risk:s.risk||{},
    radar:Array.isArray(s.radar)?s.radar.map(publicRadar):[],upcoming:Array.isArray(s.upcoming)?s.upcoming.map(publicPrediction):[],
    history:Array.isArray(s.history)?s.history.slice(0,300):[],
    learning:{challenger:learning.challenger||null,drift:learning.drift||null,cold_start:learning.cold_start||null}
  });
}
async function loadState(){
  return await readJson(STATE_OUT)||await readJson(OUT)||{meta:{status:"SETUP"},radar:[],upcoming:[],history:[],observed_results:[],learning:{},usage:{day:dayKey(NOW),calls:0},cache:{}};
}
async function saveState(s){
  await atomicJson(STATE_OUT,s);
  // Keep the browser payload compact enough for mobile Safari and slow cellular links.
  await atomicJson(OUT,publicBoard(s),{pretty:false});
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
    headers:{"user-agent":"TennisEdgePro/12.5"}
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
  const r=await fetch(url,{headers:{"user-agent":"TennisEdgePro/12.5"}});
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
    updated_books:r.filter(x=>x.updatedMs!=null).length,
    secondary:secondaryMarketLines(obj)
  };
}

function marketNameKey(v){return String(v||"").toUpperCase().replace(/[._-]+/g," ").replace(/\s+/g," ").trim()}
function validTwoWay(a,b,maxMargin=.32){
  if(!(a>1&&b>1))return null;const z=1/a+1/b,margin=z-1;if(margin<-.03||margin>maxMargin)return null;
  return{p1:(1/a)/z,margin};
}
function scoreEntries(o){
  const out=[];
  for(const [k,v] of Object.entries(o||{}))if(/^\d\s*[-:]\s*\d$/.test(k)&&num(v)>1)out.push([k.replace(/\s|:/g,"-"),num(v)]);
  const label=String(o?.score??o?.selection??o?.name??"").trim(),price=num(o?.price??o?.value??o?.decimal);
  if(/^\d\s*[-:]\s*\d$/.test(label)&&price>1)out.push([label.replace(/\s|:/g,"-"),price]);
  return out;
}
function secondaryMarketLines(obj){
  if(!obj?.bookmakers)return[];
  const groups=new Map(), rawNames=new Set();
  const put=(key,row)=>{if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)};
  const home=String(obj.home||""),away=String(obj.away||""),nh=norm(home),na=norm(away);
  for(const [book,markets] of Object.entries(obj.bookmakers)){
    for(const m of markets||[]){
      const name=marketNameKey(m?.name),updatedAt=m?.updatedAt||null;rawNames.add(name);
      const odds=Array.isArray(m?.odds)?m.odds:[];
      if(/SET BETTING|CORRECT SET SCORE|SET SCORE/.test(name)){
        const merged=[];for(const o of odds)merged.push(...scoreEntries(o));
        const uniq=new Map();for(const [score,price] of merged)if(price>1)uniq.set(score,Math.max(price,uniq.get(score)||0));
        const entries=[...uniq.entries()];if(entries.length>=2){const z=entries.reduce((a,[,v])=>a+1/v,0),margin=z-1;if(z>0&&margin>=-.03&&margin<=.45)for(const [score,price] of entries)put(`SET_SCORE|${score}`,{type:"SET_SCORE",score,book,price,p1:(1/price)/z,margin,updatedAt})}
        continue;
      }
      for(const o of odds){
        const line=num(o?.hdp??o?.max??o?.line);
        if(name==="TOTALS"||name==="OVER/UNDER"||/TOTAL (GAMES|GAME)/.test(name)){
          const over=num(o?.over),under=num(o?.under),tw=validTwoWay(over,under);if(!Number.isFinite(line)||!tw)continue;
          put(`TOTAL_GAMES|${line}`,{type:"TOTAL_GAMES",line,book,over,under,p1:tw.p1,margin:tw.margin,updatedAt});
        }else if(name==="SPREAD"||/GAME HANDICAP|GAME SPREAD/.test(name)){
          const a=num(o?.home),b=num(o?.away),tw=validTwoWay(a,b);if(!Number.isFinite(line)||!tw)continue;
          put(`GAME_HANDICAP|${line}`,{type:"GAME_HANDICAP",line,book,home:a,away:b,p1:tw.p1,margin:tw.margin,updatedAt});
        }else if(/SET HANDICAP|SET SPREAD/.test(name)){
          const a=num(o?.home),b=num(o?.away),tw=validTwoWay(a,b);if(!Number.isFinite(line)||!tw)continue;
          put(`SET_HANDICAP|${line}`,{type:"SET_HANDICAP",line,book,home:a,away:b,p1:tw.p1,margin:tw.margin,updatedAt});
        }else if(/FIRST SET WINNER|1ST SET WINNER|FIRST SET ML|1ST SET ML/.test(name)){
          const a=num(o?.home),b=num(o?.away),tw=validTwoWay(a,b);if(!tw)continue;
          put(`FIRST_SET_WINNER`,{type:"FIRST_SET_WINNER",book,home:a,away:b,p1:tw.p1,margin:tw.margin,updatedAt});
        }else if(/TIE ?BREAK/.test(name)){
          const yes=num(o?.yes??o?.over??o?.home),no=num(o?.no??o?.under??o?.away),tw=validTwoWay(yes,no,.4);if(!tw)continue;
          put(`TIEBREAK_IN_MATCH`,{type:"TIEBREAK_IN_MATCH",book,yes,no,p1:tw.p1,margin:tw.margin,updatedAt});
        }else if(/TO WIN A SET|WIN A SET/.test(name)){
          const label=norm(o?.player??o?.participant??o?.name??o?.selection??"");
          let side=label&&nh&&(label.includes(nh)||nh.includes(label))?"A":label&&na&&(label.includes(na)||na.includes(label))?"B":null;
          if(!side){const nn=norm(name);side=nh&&nn.includes(nh)?"A":na&&nn.includes(na)?"B":null}
          const yes=num(o?.yes),no=num(o?.no),tw=validTwoWay(yes,no,.4);if(!side||!tw)continue;
          put(`WIN_A_SET|${side}`,{type:"WIN_A_SET",side,book,yes,no,p1:tw.p1,margin:tw.margin,updatedAt});
        }
      }
    }
  }
  const out=[];
  for(const rows of groups.values()){
    if(!rows.length)continue;const r0=rows[0],type=r0.type,line=r0.line,consensus=median(rows.map(x=>x.p1));
    if(type==="TOTAL_GAMES"){
      const bo=Math.max(...rows.map(x=>x.over)),bu=Math.max(...rows.map(x=>x.under)),ro=rows.find(x=>x.over===bo),ru=rows.find(x=>x.under===bu);
      out.push({type,line,books:rows.length,consensus_over:consensus,best_over:bo,best_under:bu,best_book_over:ro?.book||"—",best_book_under:ru?.book||"—",updated_at:ro?.updatedAt||ru?.updatedAt||null,margin:rows.reduce((a,x)=>a+x.margin,0)/rows.length});
    }else if(type==="GAME_HANDICAP"||type==="SET_HANDICAP"||type==="FIRST_SET_WINNER"){
      const bh=Math.max(...rows.map(x=>x.home)),ba=Math.max(...rows.map(x=>x.away)),rh=rows.find(x=>x.home===bh),ra=rows.find(x=>x.away===ba);
      out.push({type,line:Number.isFinite(line)?line:null,books:rows.length,consensus_home:consensus,best_home:bh,best_away:ba,best_book_home:rh?.book||"—",best_book_away:ra?.book||"—",updated_at:rh?.updatedAt||ra?.updatedAt||null,margin:rows.reduce((a,x)=>a+x.margin,0)/rows.length});
    }else if(type==="TIEBREAK_IN_MATCH"||type==="WIN_A_SET"){
      const by=Math.max(...rows.map(x=>x.yes)),bn=Math.max(...rows.map(x=>x.no)),ry=rows.find(x=>x.yes===by),rn=rows.find(x=>x.no===bn);
      out.push({type,side:r0.side||null,books:rows.length,consensus_yes:consensus,best_yes:by,best_no:bn,best_book_yes:ry?.book||"—",best_book_no:rn?.book||"—",updated_at:ry?.updatedAt||rn?.updatedAt||null,margin:rows.reduce((a,x)=>a+x.margin,0)/rows.length});
    }else if(type==="SET_SCORE"){
      const bp=Math.max(...rows.map(x=>x.price)),rr=rows.find(x=>x.price===bp);
      out.push({type,score:r0.score,books:rows.length,consensus_score:consensus,best_price:bp,best_book:rr?.book||"—",updated_at:rr?.updatedAt||null,margin:rows.reduce((a,x)=>a+x.margin,0)/rows.length});
    }
  }
  out.detected_market_names=[...rawNames];
  return out.sort((a,b)=>a.type.localeCompare(b.type)||(a.line??0)-(b.line??0)||String(a.score||"").localeCompare(String(b.score||"")));
}
function matchProbFromSet(q,bestOf){
  q=clamp(q,.001,.999);
  return bestOf===5 ? (10*q**3-15*q**4+6*q**5) : (3*q*q-2*q*q*q);
}
function setProbFromMatch(p,bestOf){
  let lo=.001,hi=.999;
  for(let i=0;i<42;i++){const m=(lo+hi)/2;if(matchProbFromSet(m,bestOf)<p)lo=m;else hi=m}
  return (lo+hi)/2;
}
function holdFromServePoint(p){
  p=clamp(p,.42,.82);const q=1-p;
  const before=p**4*(1+4*q+10*q*q);
  const deuce=20*p**3*q**3;
  const fromDeuce=(p*p)/(p*p+q*q);
  return clamp(before+deuce*fromDeuce,.05,.98);
}
function tbProbFromServePoints(a,b){return clamp(.5+(a-b)*1.65,.18,.82)}
function setWinProbFromHolds(holdA,holdB,tbA){
  const memo=new Map();
  const rec=(ga,gb,server)=>{
    if((ga>=6||gb>=6)&&Math.abs(ga-gb)>=2)return ga>gb?1:0;
    if(ga===6&&gb===6)return tbA;
    const k=`${ga}|${gb}|${server}`;if(memo.has(k))return memo.get(k);
    const pGame=server==="A"?holdA:(1-holdB);
    const v=pGame*rec(ga+1,gb,server==="A"?"B":"A")+(1-pGame)*rec(ga,gb+1,server==="A"?"B":"A");
    memo.set(k,v);return v;
  };
  return .5*(rec(0,0,"A")+rec(0,0,"B"));
}
function seededRng(seedText){
  let h=2166136261>>>0;
  for(const ch of String(seedText)){h^=ch.charCodeAt(0);h=Math.imul(h,16777619)}
  return ()=>{h+=0x6D2B79F5;let t=h;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296};
}
function calibratedServeModel(c,event){
  const bestOf=(c.tour==="ATP"&&/australian open|roland garros|french open|wimbledon|us open/i.test(String(event.league?.name||""))&&!/qual/i.test(String(event.league?.name||"")))?5:3;
  const targetSet=setProbFromMatch(c.pA,bestOf);
  const serveA=clamp(Number.isFinite(c.A.serve)&&Number.isFinite(c.B.ret)?(.55*c.A.serve+.45*(1-c.B.ret)):(Number.isFinite(c.A.serve)?c.A.serve:.625),.50,.76);
  const serveB=clamp(Number.isFinite(c.B.serve)&&Number.isFinite(c.A.ret)?(.55*c.B.serve+.45*(1-c.A.ret)):(Number.isFinite(c.B.serve)?c.B.serve:.625),.50,.76);
  let lo=-.09,hi=.09;
  for(let i=0;i<30;i++){
    const d=(lo+hi)/2,pa=clamp(serveA+d,.48,.80),pb=clamp(serveB-d,.48,.80);
    const q=setWinProbFromHolds(holdFromServePoint(pa),holdFromServePoint(pb),tbProbFromServePoints(pa,pb));
    if(q<targetSet)lo=d;else hi=d;
  }
  const d=(lo+hi)/2,pointA=clamp(serveA+d,.48,.80),pointB=clamp(serveB-d,.48,.80);
  return{best_of:bestOf,set_win_a:targetSet,serve_point_a:pointA,serve_point_b:pointB,hold_a:holdFromServePoint(pointA),hold_b:holdFromServePoint(pointB),tb_a:tbProbFromServePoints(pointA,pointB)};
}
function simulateMatchMarkets(c,event,n=MARKET_SIM_N){
  const sm=calibratedServeModel(c,event),rng=seededRng(`${event.id}|${MODEL_VERSION}|${c.pA.toFixed(5)}`);
  const need=sm.best_of===5?3:2;
  let winsA=0,totalGamesSum=0,tbAny=0,aWinsSet=0,bWinsSet=0,firstSetA=0;
  const totals=[],margins=[],setMargins=[],scoreCounts={};
  for(let k=0;k<n;k++){
    let sa=0,sb=0,gaAll=0,gbAll=0,tb=0,server=rng()<.5?"A":"B",setIndex=0;
    while(sa<need&&sb<need){
      let ga=0,gb=0;
      while(true){
        if((ga>=6||gb>=6)&&Math.abs(ga-gb)>=2)break;
        if(ga===6&&gb===6){if(rng()<sm.tb_a)ga++;else gb++;tb++;server=server==="A"?"B":"A";break}
        const aWinsGame=server==="A" ? rng()<sm.hold_a : rng()>sm.hold_b;
        if(aWinsGame)ga++;else gb++;server=server==="A"?"B":"A";
      }
      gaAll+=ga;gbAll+=gb;if(ga>gb){sa++;if(setIndex===0)firstSetA++}else sb++;setIndex++;
    }
    if(sa>sb)winsA++;if(sa>0)aWinsSet++;if(sb>0)bWinsSet++;if(tb>0)tbAny++;
    const total=gaAll+gbAll,margin=gaAll-gbAll;totals.push(total);margins.push(margin);setMargins.push(sa-sb);totalGamesSum+=total;
    const key=`${sa}-${sb}`;scoreCounts[key]=(scoreCounts[key]||0)+1;
  }
  totals.sort((a,b)=>a-b);margins.sort((a,b)=>a-b);setMargins.sort((a,b)=>a-b);
  const prob=(arr,fn)=>arr.reduce((a,x)=>a+(fn(x)?1:0),0)/arr.length;
  const score_probs={};for(const [k,v] of Object.entries(scoreCounts))score_probs[k]=v/n;
  const gameFactor=clamp((totalGamesSum/n)/24,.65,1.75);
  const aceA=Number.isFinite(c.A.aces_pg)&&Number.isFinite(c.B.aces_allowed_pg)?(.65*c.A.aces_pg+.35*c.B.aces_allowed_pg)*gameFactor:null;
  const aceB=Number.isFinite(c.B.aces_pg)&&Number.isFinite(c.A.aces_allowed_pg)?(.65*c.B.aces_pg+.35*c.A.aces_allowed_pg)*gameFactor:null;
  const brA=Number.isFinite(c.A.breaks_pg)&&Number.isFinite(c.B.breaks_conceded_pg)?(.65*c.A.breaks_pg+.35*c.B.breaks_conceded_pg)*gameFactor:null;
  const brB=Number.isFinite(c.B.breaks_pg)&&Number.isFinite(c.A.breaks_conceded_pg)?(.65*c.B.breaks_pg+.35*c.A.breaks_conceded_pg)*gameFactor:null;
  return{
    simulations:n,best_of:sm.best_of,model_match_a:winsA/n,set_win_a:sm.set_win_a,first_set_a:firstSetA/n,
    serve_point_a:sm.serve_point_a,serve_point_b:sm.serve_point_b,hold_a:sm.hold_a,hold_b:sm.hold_b,tb_a:sm.tb_a,
    mean_total_games:totalGamesSum/n,median_total_games:totals[Math.floor(n/2)],
    a_wins_set:aWinsSet/n,b_wins_set:bWinsSet/n,tiebreak_yes:tbAny/n,score_probs,
    expected_aces_a:Number.isFinite(aceA)?aceA:null,expected_aces_b:Number.isFinite(aceB)?aceB:null,expected_breaks_a:Number.isFinite(brA)?brA:null,expected_breaks_b:Number.isFinite(brB)?brB:null,
    prob_total_over:line=>prob(totals,x=>x>line),prob_home_spread:line=>prob(margins,x=>x+line>0),prob_set_spread:line=>prob(setMargins,x=>x+line>0)
  };
}
function priceTargetFor(row){return row?.validation_tier==="OFFICIAL_ML"?(row?.verdict==="STRONG VALUE"?.04:row?.verdict==="VALUE"?.022:.01):(row?.verdict==="VALUE"?.015:0)}
function withPriceGuard(row){const target=priceTargetFor(row),p=row?.robust_prob,min=Number.isFinite(p)&&p>0?(1+target)/p:null;return{...row,target_robust_ev:target,min_acceptable_odds:min,price_rule:"BET only when current odds stay at/above min_acceptable_odds; secondary markets remain paper until reviewed."}}
function priceZoneFor(row,odds,robustEv){const min=Number.isFinite(row?.min_acceptable_odds)?row.min_acceptable_odds:(Number.isFinite(row?.robust_prob)&&row.robust_prob>0?(1+priceTargetFor(row))/row.robust_prob:null);if(Number.isFinite(odds)&&Number.isFinite(min)&&odds>=min&&Number.isFinite(robustEv)&&robustEv>0)return row?.validation_tier==="OFFICIAL_ML"?"BET_ZONE":"PAPER_VALUE";return Number.isFinite(robustEv)&&robustEv>0?"WATCH_PRICE":"PASS"}
function marketLabFor(event,c,mkt,conf,dq,drift,officialVerdict="NO BET",candidateSide=null){
  const sim=simulateMatchMarkets(c,event),priced=[];
  const marketUnc=clamp(c.uncertainty*.72+.025,.045,.18);
  const classify=(p,cons,odds,books,tier="PAPER_MULTI_MARKET")=>{
    if(!(Number.isFinite(p)&&Number.isFinite(cons)&&odds>1))return{model_prob:p,market_prob:cons,best_odds:odds,edge:null,ev:null,robust_prob:null,robust_edge:null,robust_ev:null,verdict:"NO BET",reasons:["MERCATO_NON_PREZZABILE"],validation_tier:tier};
    const edge=p-cons,ev=p*odds-1,robust=Math.max(.01,p-marketUnc),redge=robust-cons,rev=robust*odds-1;
    const hard=[];if(dq<68)hard.push("DATI_INSUFFICIENTI");if(c.dis>.13)hard.push("MODELLI_IN_DISACCORDO");if(drift.health==="DRIFT")hard.push("MODEL_DRIFT");if((drift.sample||0)<20&&!c.cal.cold_start)hard.push("MODELLO_COLD");if(books<1)hard.push("MERCATO_ASSENTE");
    let verdict="NO BET";
    if(!hard.length&&ev>=.035&&edge>=.018&&rev>0&&redge>=.004&&conf>=66)verdict="WATCH";
    if(!hard.length&&c.cal.active&&(drift.health==="HEALTHY"||c.cal.cold_start)&&ev>=(c.cal.cold_start?.075:.06)&&edge>=(c.cal.cold_start?.035:.028)&&rev>=(c.cal.cold_start?.025:.015)&&redge>=(c.cal.cold_start?.012:.009)&&conf>=(c.cal.cold_start?77:74)&&dq>=(c.cal.cold_start?75:72))verdict="VALUE";
    return{model_prob:p,market_prob:cons,best_odds:odds,edge,ev,robust_prob:robust,robust_edge:redge,robust_ev:rev,verdict,reasons:hard,validation_tier:tier};
  };
  const add=(row)=>{row.offer_key=row.offer_key||`${row.market}|${row.selection}`;priced.push(withPriceGuard(row))};
  // Official match-winner is part of the matrix, but retains the stricter official verdict.
  const mla=classify(c.pA,mkt.consensus,mkt.bestA,mkt.count,"OFFICIAL_ML"),mlb=classify(c.pB,1-mkt.consensus,mkt.bestB,mkt.count,"OFFICIAL_ML");
  mla.verdict=candidateSide==="A"?officialVerdict:"NO BET";mlb.verdict=candidateSide==="B"?officialVerdict:"NO BET";
  add({market:"MATCH_WINNER",selection:event.home,side:"A",book:mkt.bestBookA,offer_key:"MATCH_WINNER|A",...mla});
  add({market:"MATCH_WINNER",selection:event.away,side:"B",book:mkt.bestBookB,offer_key:"MATCH_WINNER|B",...mlb});
  for(const line of mkt.secondary||[]){
    if(line.type==="TOTAL_GAMES"){
      const po=sim.prob_total_over(line.line),pu=1-po;
      add({market:"TOTAL_GAMES",selection:`OVER ${line.line}`,line:line.line,book:line.best_book_over,offer_key:`TOTAL_GAMES|OVER|${line.line}`,...classify(po,line.consensus_over,line.best_over,line.books)});
      add({market:"TOTAL_GAMES",selection:`UNDER ${line.line}`,line:line.line,book:line.best_book_under,offer_key:`TOTAL_GAMES|UNDER|${line.line}`,...classify(pu,1-line.consensus_over,line.best_under,line.books)});
    }else if(line.type==="GAME_HANDICAP"){
      const ph=sim.prob_home_spread(line.line),pa=1-ph;
      add({market:"GAME_HANDICAP",selection:`${event.home} ${line.line>=0?"+":""}${line.line}`,line:line.line,side:"A",book:line.best_book_home,offer_key:`GAME_HANDICAP|A|${line.line}`,...classify(ph,line.consensus_home,line.best_home,line.books)});
      add({market:"GAME_HANDICAP",selection:`${event.away} ${-line.line>=0?"+":""}${-line.line}`,line:-line.line,side:"B",book:line.best_book_away,offer_key:`GAME_HANDICAP|B|${-line.line}`,...classify(pa,1-line.consensus_home,line.best_away,line.books)});
    }else if(line.type==="SET_HANDICAP"){
      const ph=sim.prob_set_spread(line.line),pa=1-ph;
      add({market:"SET_HANDICAP",selection:`${event.home} ${line.line>=0?"+":""}${line.line} set`,line:line.line,side:"A",book:line.best_book_home,offer_key:`SET_HANDICAP|A|${line.line}`,...classify(ph,line.consensus_home,line.best_home,line.books)});
      add({market:"SET_HANDICAP",selection:`${event.away} ${-line.line>=0?"+":""}${-line.line} set`,line:-line.line,side:"B",book:line.best_book_away,offer_key:`SET_HANDICAP|B|${-line.line}`,...classify(pa,1-line.consensus_home,line.best_away,line.books)});
    }else if(line.type==="FIRST_SET_WINNER"){
      add({market:"FIRST_SET_WINNER",selection:event.home,side:"A",book:line.best_book_home,offer_key:"FIRST_SET_WINNER|A",...classify(sim.first_set_a,line.consensus_home,line.best_home,line.books)});
      add({market:"FIRST_SET_WINNER",selection:event.away,side:"B",book:line.best_book_away,offer_key:"FIRST_SET_WINNER|B",...classify(1-sim.first_set_a,1-line.consensus_home,line.best_away,line.books)});
    }else if(line.type==="TIEBREAK_IN_MATCH"){
      add({market:"TIEBREAK_IN_MATCH",selection:"YES",book:line.best_book_yes,offer_key:"TIEBREAK_IN_MATCH|YES",...classify(sim.tiebreak_yes,line.consensus_yes,line.best_yes,line.books)});
      add({market:"TIEBREAK_IN_MATCH",selection:"NO",book:line.best_book_no,offer_key:"TIEBREAK_IN_MATCH|NO",...classify(1-sim.tiebreak_yes,1-line.consensus_yes,line.best_no,line.books)});
    }else if(line.type==="SET_SCORE"){
      const p=sim.score_probs[line.score]||0;add({market:"SET_SCORE",selection:line.score,book:line.best_book,offer_key:`SET_SCORE|${line.score}`,...classify(p,line.consensus_score,line.best_price,line.books)});
    }else if(line.type==="WIN_A_SET"){
      const p=line.side==="A"?sim.a_wins_set:sim.b_wins_set,who=line.side==="A"?event.home:event.away;
      add({market:"WIN_A_SET",selection:`${who} YES`,side:line.side,yes:true,book:line.best_book_yes,offer_key:`WIN_A_SET|${line.side}|YES`,...classify(p,line.consensus_yes,line.best_yes,line.books)});
      add({market:"WIN_A_SET",selection:`${who} NO`,side:line.side,yes:false,book:line.best_book_no,offer_key:`WIN_A_SET|${line.side}|NO`,...classify(1-p,1-line.consensus_yes,line.best_no,line.books)});
    }
  }
  const tierRank=x=>x.validation_tier==="OFFICIAL_ML"?3:1,verdictRank=x=>({"STRONG VALUE":4,VALUE:3,WATCH:2,"NO BET":1}[x.verdict]||0);
  priced.sort((a,b)=>verdictRank(b)-verdictRank(a)||tierRank(b)-tierRank(a)||(b.robust_ev||-9)-(a.robust_ev||-9));
  const scenario=[];
  for(const [score,p] of Object.entries(sim.score_probs).sort((a,b)=>b[1]-a[1]))scenario.push({market:"SET_SCORE",selection:score,model_prob:p,fair_odds:p>0?1/p:null,price_status:"MODEL_ONLY"});
  scenario.push({market:"FIRST_SET_WINNER",selection:event.home,model_prob:sim.first_set_a,fair_odds:sim.first_set_a>0?1/sim.first_set_a:null,price_status:"MODEL_ONLY"});
  scenario.push({market:"PLAYER_TO_WIN_A_SET",selection:event.home,model_prob:sim.a_wins_set,fair_odds:sim.a_wins_set>0?1/sim.a_wins_set:null,price_status:"MODEL_ONLY"});
  scenario.push({market:"PLAYER_TO_WIN_A_SET",selection:event.away,model_prob:sim.b_wins_set,fair_odds:sim.b_wins_set>0?1/sim.b_wins_set:null,price_status:"MODEL_ONLY"});
  scenario.push({market:"TIEBREAK_IN_MATCH",selection:"YES",model_prob:sim.tiebreak_yes,fair_odds:sim.tiebreak_yes>0?1/sim.tiebreak_yes:null,price_status:"MODEL_ONLY"});
  if(Number.isFinite(sim.expected_aces_a))scenario.push({market:"EXPECTED_ACES",selection:event.home,model_mean:sim.expected_aces_a,price_status:"MODEL_EXPERIMENTAL"});
  if(Number.isFinite(sim.expected_aces_b))scenario.push({market:"EXPECTED_ACES",selection:event.away,model_mean:sim.expected_aces_b,price_status:"MODEL_EXPERIMENTAL"});
  if(Number.isFinite(sim.expected_breaks_a))scenario.push({market:"EXPECTED_BREAKS",selection:event.home,model_mean:sim.expected_breaks_a,price_status:"MODEL_EXPERIMENTAL"});
  if(Number.isFinite(sim.expected_breaks_b))scenario.push({market:"EXPECTED_BREAKS",selection:event.away,model_mean:sim.expected_breaks_b,price_status:"MODEL_EXPERIMENTAL"});
  return{status:"PAPER_VALIDATION",simulations:sim.simulations,best_of:sim.best_of,mean_total_games:sim.mean_total_games,median_total_games:sim.median_total_games,serve_point_a:sim.serve_point_a,serve_point_b:sim.serve_point_b,hold_a:sim.hold_a,hold_b:sim.hold_b,tb_a:sim.tb_a,market_uncertainty:marketUnc,priced,scenario:scenario.slice(0,14),best_priced:priced[0]||null,detected_market_names:mkt.secondary?.detected_market_names||[],note:"Official ML keeps its mature gate. Price Guard adds a minimum acceptable price without rewriting the locked prediction. Secondary markets remain paper-only until each market family has enough settled evidence."};
}
function mapMultiOdds(raw){
  const arr=Array.isArray(raw)?raw:(raw?.data||raw?.events||[]);
  return new Map(arr.map(x=>[String(x.id??x.eventId),x]));
}
async function multiOdds(ids,bookmakers){
  const out=new Map();
  for(let i=0;i<ids.length;i+=10){
    const batch=ids.slice(i,i+10);
    const params={eventIds:batch.join(","),bookmakers:bookmakers.join(",")};if(MARKET_QUERY)params.markets=MARKET_QUERY;
    try{
      const raw=await api("/odds/multi",params);
      for(const [k,v] of mapMultiOdds(raw))out.set(k,v);
    }catch(e){
      if(["RATE_LIMIT_WAIT","RATE_LIMIT_429","RUN_BUDGET_GUARD","DAILY_BUDGET_GUARD"].includes(e.message)){
        console.warn("multiOdds pause",e.message,"events",out.size);
        break;
      }
      throw e;
    }
  }
  return out;
}
function freshOffers(event,p,mkt){
  const out=[];const add=x=>out.push(x);
  add({offer_key:"MATCH_WINNER|A",current_odds:mkt.bestA,current_market_prob:mkt.consensus,current_book:mkt.bestBookA,current_books:mkt.count,current_updated_at:mkt.bestUpdatedA});
  add({offer_key:"MATCH_WINNER|B",current_odds:mkt.bestB,current_market_prob:1-mkt.consensus,current_book:mkt.bestBookB,current_books:mkt.count,current_updated_at:mkt.bestUpdatedB});
  for(const line of mkt.secondary||[]){
    if(line.type==="TOTAL_GAMES"){
      add({offer_key:`TOTAL_GAMES|OVER|${line.line}`,current_odds:line.best_over,current_market_prob:line.consensus_over,current_book:line.best_book_over,current_books:line.books,current_updated_at:line.updated_at});
      add({offer_key:`TOTAL_GAMES|UNDER|${line.line}`,current_odds:line.best_under,current_market_prob:1-line.consensus_over,current_book:line.best_book_under,current_books:line.books,current_updated_at:line.updated_at});
    }else if(line.type==="GAME_HANDICAP"){
      add({offer_key:`GAME_HANDICAP|A|${line.line}`,current_odds:line.best_home,current_market_prob:line.consensus_home,current_book:line.best_book_home,current_books:line.books,current_updated_at:line.updated_at});
      add({offer_key:`GAME_HANDICAP|B|${-line.line}`,current_odds:line.best_away,current_market_prob:1-line.consensus_home,current_book:line.best_book_away,current_books:line.books,current_updated_at:line.updated_at});
    }else if(line.type==="SET_HANDICAP"){
      add({offer_key:`SET_HANDICAP|A|${line.line}`,current_odds:line.best_home,current_market_prob:line.consensus_home,current_book:line.best_book_home,current_books:line.books,current_updated_at:line.updated_at});
      add({offer_key:`SET_HANDICAP|B|${-line.line}`,current_odds:line.best_away,current_market_prob:1-line.consensus_home,current_book:line.best_book_away,current_books:line.books,current_updated_at:line.updated_at});
    }else if(line.type==="FIRST_SET_WINNER"){
      add({offer_key:"FIRST_SET_WINNER|A",current_odds:line.best_home,current_market_prob:line.consensus_home,current_book:line.best_book_home,current_books:line.books,current_updated_at:line.updated_at});
      add({offer_key:"FIRST_SET_WINNER|B",current_odds:line.best_away,current_market_prob:1-line.consensus_home,current_book:line.best_book_away,current_books:line.books,current_updated_at:line.updated_at});
    }else if(line.type==="TIEBREAK_IN_MATCH"){
      add({offer_key:"TIEBREAK_IN_MATCH|YES",current_odds:line.best_yes,current_market_prob:line.consensus_yes,current_book:line.best_book_yes,current_books:line.books,current_updated_at:line.updated_at});
      add({offer_key:"TIEBREAK_IN_MATCH|NO",current_odds:line.best_no,current_market_prob:1-line.consensus_yes,current_book:line.best_book_no,current_books:line.books,current_updated_at:line.updated_at});
    }else if(line.type==="SET_SCORE")add({offer_key:`SET_SCORE|${line.score}`,current_odds:line.best_price,current_market_prob:line.consensus_score,current_book:line.best_book,current_books:line.books,current_updated_at:line.updated_at});
    else if(line.type==="WIN_A_SET"){
      add({offer_key:`WIN_A_SET|${line.side}|YES`,current_odds:line.best_yes,current_market_prob:line.consensus_yes,current_book:line.best_book_yes,current_books:line.books,current_updated_at:line.updated_at});
      add({offer_key:`WIN_A_SET|${line.side}|NO`,current_odds:line.best_no,current_market_prob:1-line.consensus_yes,current_book:line.best_book_no,current_books:line.books,current_updated_at:line.updated_at});
    }
  }
  return out;
}
function repriceLockedMarketLab(p,mkt){
  const offers=new Map(freshOffers(null,p,mkt).map(x=>[x.offer_key,x]));
  const rows=(p.market_lab?.priced||[]).map(r=>{
    const f=offers.get(r.offer_key);if(!f)return{...r,current_status:"NOT_QUOTED"};
    const cp=f.current_market_prob,co=f.current_odds,me=Number.isFinite(r.model_prob)&&Number.isFinite(co)?r.model_prob*co-1:null,re=Number.isFinite(r.robust_prob)&&Number.isFinite(co)?r.robust_prob*co-1:null;
    const target=Number.isFinite(r.target_robust_ev)?r.target_robust_ev:priceTargetFor(r);
    const min=Number.isFinite(r.robust_prob)&&r.robust_prob>0?(1+target)/r.robust_prob:null;
    const zone=priceZoneFor({...r,target_robust_ev:target,min_acceptable_odds:min},co,re);
    return{...r,...f,current_ev:me,current_robust_ev:re,target_robust_ev:target,min_acceptable_odds:min,current_price_status:zone,price_cushion:Number.isFinite(co)&&Number.isFinite(min)?co/min-1:null,odds_move_pct:Number.isFinite(r.best_odds)&&Number.isFinite(co)?co/r.best_odds-1:null,market_prob_move_pp:Number.isFinite(r.market_prob)&&Number.isFinite(cp)?cp-r.market_prob:null,current_status:"OBSERVED"};
  });
  rows.sort((a,b)=>(b.current_robust_ev??b.robust_ev??-9)-(a.current_robust_ev??a.robust_ev??-9));
  return{status:"MARKET_OBSERVED",updated_at:NOW.toISOString(),rows,best_current:rows.find(x=>x.current_status==="OBSERVED")||null};
}
function appendQuoteTape(p,snap){
  const tape=Array.isArray(p.quote_tape)?[...p.quote_tape]:[];const prev=tape[tape.length-1];
  const changed=!prev||Math.abs((prev.odds||0)-(snap.odds||0))>.0001||Math.abs((prev.consensus_a||0)-(snap.consensus_a||0))>.0005||new Date(snap.at)-new Date(prev.at)>45*60000;
  if(changed)tape.push(snap);return tape.slice(-24);
}
function currentMarketSnapshot(p,mkt){
  if(!p||!mkt)return p;
  const side=p.pick_side||p.candidate_side,prob=Number.isFinite(p.pick_prob)?p.pick_prob:(Number.isFinite(p.candidate_prob)?p.candidate_prob:null);
  const odds=side==="A"?mkt.bestA:side==="B"?mkt.bestB:null,book=side==="A"?mkt.bestBookA:side==="B"?mkt.bestBookB:null,updated=side==="A"?mkt.bestUpdatedA:side==="B"?mkt.bestUpdatedB:null,age=side==="A"?mkt.bestAgeA:side==="B"?mkt.bestAgeB:null;
  const ev=Number.isFinite(prob)&&Number.isFinite(odds)?prob*odds-1:null;
  const snap={at:NOW.toISOString(),odds:Number.isFinite(odds)?odds:null,consensus_a:Number.isFinite(mkt.consensus)?mkt.consensus:null,book:book||null};
  return{...p,current_odds:Number.isFinite(odds)?odds:null,current_book:book||null,current_ev:Number.isFinite(ev)?ev:null,current_market_consensus_a:Number.isFinite(mkt.consensus)?mkt.consensus:null,current_market_books:mkt.count||0,current_odds_updated_at:updated||NOW.toISOString(),current_odds_age_min:Number.isFinite(age)?age:null,market_watch_status:"OBSERVED",prediction_lock_preserved:true,quote_tape:appendQuoteTape(p,snap),market_live:repriceLockedMarketLab(p,mkt)};
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
function addNameResolver(map,key,name){
  if(!key)return;
  if(!map.has(key))map.set(key,[]);
  const a=map.get(key);
  if(!a.includes(name))a.push(name);
}
function buildNameResolver(names){
  const bySig=new Map();
  bySig.byTokens=new Map();
  bySig.bySuffixToken=new Map();
  for(const n of names){
    const p=n.split(" ").filter(Boolean);if(p.length<2)continue;
    addNameResolver(bySig,p[p.length-1]+"|"+(p[0][0]||""),n);
    addNameResolver(bySig.byTokens,[...p].sort().join("|"),n);
    for(let len=1;len<=Math.min(4,p.length-1);len++){
      const surname=p.slice(-len).join(" "),given=p.slice(0,-len);
      for(const g of given)addNameResolver(bySig.bySuffixToken,surname+"|"+g,n);
    }
  }
  return bySig;
}
function uniqueName(xs){return Array.isArray(xs)&&xs.length===1?xs[0]:null}
function resolveNameKey(name,tourData){
  const raw=String(name||"").trim(),n=norm(raw);
  if(tourData.names.has(n))return n;
  const p=n.split(" ").filter(Boolean);if(p.length<2)return null;
  const r=tourData.nameResolver;
  let hit=uniqueName(r?.byTokens?.get([...p].sort().join("|")));
  if(hit)return hit;
  if(raw.includes(",")){
    const parts=raw.split(","),surname=norm(parts.shift()),given=norm(parts.join(" "));
    if(surname&&given){
      const reversed=norm(given+" "+surname);
      if(tourData.names.has(reversed))return reversed;
      const rp=reversed.split(" ").filter(Boolean);
      hit=uniqueName(r?.byTokens?.get([...rp].sort().join("|")));
      if(hit)return hit;
      const candidates=new Set();
      for(const g of given.split(" ").filter(Boolean)){
        for(const x of r?.bySuffixToken?.get(surname+"|"+g)||[])candidates.add(x);
      }
      if(candidates.size===1)return [...candidates][0];
    }
  }
  const sig=p[p.length-1]+"|"+(p[0][0]||"");
  return uniqueName(r?.get(sig));
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

function safeRate(n,d){return Number.isFinite(n)&&Number.isFinite(d)&&d>0?clamp(n/d,0,1):null}
function historicalMatchIntel(m,key){
  const w=norm(m.winner_name)===key;
  const own={
    sv:num(w?m.w_svpt:m.l_svpt),firstIn:num(w?m.w_1stIn:m.l_1stIn),firstWon:num(w?m.w_1stWon:m.l_1stWon),secondWon:num(w?m.w_2ndWon:m.l_2ndWon),
    games:num(w?m.w_SvGms:m.l_SvGms),bpFaced:num(w?m.w_bpFaced:m.l_bpFaced),bpSaved:num(w?m.w_bpSaved:m.l_bpSaved),ace:num(w?m.w_ace:m.l_ace),df:num(w?m.w_df:m.l_df)
  };
  const opp={
    sv:num(w?m.l_svpt:m.w_svpt),firstIn:num(w?m.l_1stIn:m.w_1stIn),firstWon:num(w?m.l_1stWon:m.w_1stWon),secondWon:num(w?m.l_2ndWon:m.w_2ndWon),
    games:num(w?m.l_SvGms:m.w_SvGms),bpFaced:num(w?m.l_bpFaced:m.w_bpFaced),bpSaved:num(w?m.l_bpSaved:m.w_bpSaved),ace:num(w?m.l_ace:m.w_ace),df:num(w?m.l_df:m.w_df)
  };
  const ownBreaks=Number.isFinite(own.bpFaced)&&Number.isFinite(own.bpSaved)?Math.max(0,own.bpFaced-own.bpSaved):null;
  const breaksMade=Number.isFinite(opp.bpFaced)&&Number.isFinite(opp.bpSaved)?Math.max(0,opp.bpFaced-opp.bpSaved):null;
  const oppSecond=Number.isFinite(opp.sv)&&Number.isFinite(opp.firstIn)?Math.max(0,opp.sv-opp.firstIn):null;
  return{
    date:String(m.tourney_date||''),tournament:m.tourney_name||null,surface:m.surface||null,round:m.round||null,result:w?'W':'L',
    opponent:w?m.loser_name:m.winner_name,score:m.score||null,minutes:num(m.minutes),own_rank:num(w?m.winner_rank:m.loser_rank),opponent_rank:num(w?m.loser_rank:m.winner_rank),
    service:{first_serve_pct:safeRate(own.firstIn,own.sv),first_serve_points_won:safeRate(own.firstWon,own.firstIn),second_serve_points_won:safeRate(own.secondWon,Number.isFinite(own.sv)&&Number.isFinite(own.firstIn)?own.sv-own.firstIn:null),service_points_won:safeRate((own.firstWon??0)+(own.secondWon??0),own.sv),service_games_won:safeRate(Number.isFinite(own.games)&&Number.isFinite(ownBreaks)?own.games-ownBreaks:null,own.games),break_points_saved:safeRate(own.bpSaved,own.bpFaced),aces:own.ace,double_faults:own.df},
    return:{first_return_points_won:safeRate(Number.isFinite(opp.firstIn)&&Number.isFinite(opp.firstWon)?opp.firstIn-opp.firstWon:null,opp.firstIn),second_return_points_won:safeRate(Number.isFinite(oppSecond)&&Number.isFinite(opp.secondWon)?oppSecond-opp.secondWon:null,oppSecond),return_points_won:safeRate(Number.isFinite(opp.sv)&&Number.isFinite(opp.firstWon)&&Number.isFinite(opp.secondWon)?opp.sv-opp.firstWon-opp.secondWon:null,opp.sv),return_games_won:safeRate(breaksMade,opp.games),break_points_converted:safeRate(breaksMade,opp.bpFaced)}
  };
}
function metricsFast(tourData,key,surface){
  const all=tourData.byPlayer?.get(key)||[],r20=all.slice(0,20),surf=all.filter(m=>m.surface===surface).slice(0,40),latest=all[0];
  let ownPts=0,ownWon=0,firstIn=0,firstWon=0,secondAtt=0,secondWon=0,serviceGames=0,serviceGamesWon=0,bpFaced=0,bpSaved=0;
  let retPts=0,retWon=0,firstRetAtt=0,firstRetWon=0,secondRetAtt=0,secondRetWon=0,returnGames=0,returnGamesWon=0,bpOpp=0,bpConverted=0;
  let statN=0,aces=0,dfs=0,acesAllowed=0,breaks=0,breaksConceded=0,propN=0;
  for(const m of r20){
    const w=norm(m.winner_name)===key;
    const sv=num(w?m.w_svpt:m.l_svpt),fi=num(w?m.w_1stIn:m.l_1stIn),fw=num(w?m.w_1stWon:m.l_1stWon),sw=num(w?m.w_2ndWon:m.l_2ndWon),sg=num(w?m.w_SvGms:m.l_SvGms);
    const osv=num(w?m.l_svpt:m.w_svpt),ofi=num(w?m.l_1stIn:m.w_1stIn),ofw=num(w?m.l_1stWon:m.w_1stWon),osw=num(w?m.l_2ndWon:m.w_2ndWon),osg=num(w?m.l_SvGms:m.w_SvGms);
    const bpf=num(w?m.w_bpFaced:m.l_bpFaced),bps=num(w?m.w_bpSaved:m.l_bpSaved),obpf=num(w?m.l_bpFaced:m.w_bpFaced),obps=num(w?m.l_bpSaved:m.w_bpSaved);
    const oa=num(w?m.w_ace:m.l_ace),df=num(w?m.w_df:m.l_df),aa=num(w?m.l_ace:m.w_ace);
    if(sv&&fi!=null&&fw!=null&&sw!=null){
      const sa=Math.max(0,sv-fi);ownPts+=sv;ownWon+=fw+sw;firstIn+=fi;firstWon+=fw;secondAtt+=sa;secondWon+=sw;statN++;
    }
    if(osv&&ofi!=null&&ofw!=null&&osw!=null){
      const osa=Math.max(0,osv-ofi);retPts+=osv;retWon+=osv-ofw-osw;firstRetAtt+=ofi;firstRetWon+=Math.max(0,ofi-ofw);secondRetAtt+=osa;secondRetWon+=Math.max(0,osa-osw);
    }
    if(sg!=null&&bpf!=null&&bps!=null){const bc=Math.max(0,bpf-bps);serviceGames+=sg;serviceGamesWon+=Math.max(0,sg-bc);bpFaced+=bpf;bpSaved+=bps;breaksConceded+=bc}
    if(osg!=null&&obpf!=null&&obps!=null){const bm=Math.max(0,obpf-obps);returnGames+=osg;returnGamesWon+=bm;bpOpp+=obpf;bpConverted+=bm;breaks+=bm}
    if(oa!=null||df!=null||aa!=null){aces+=oa||0;dfs+=df||0;acesAllowed+=aa||0;propN++}
  }
  const isW=latest&&norm(latest.winner_name)===key,recent7=all.filter(m=>daysAgo(m.tourney_date)<=7),recent14=all.filter(m=>daysAgo(m.tourney_date)<=14);
  return{
    n:all.length,rank:latest?num(isW?latest.winner_rank:latest.loser_rank):null,
    form:weightedWinRate(r20,key,75,4),form_long:weightedWinRate(all.slice(0,35),key,150,7),surfaceN:surf.length,surface:weightedWinRate(surf,key,210,8),
    serve:safeRate(ownWon,ownPts),ret:safeRate(retWon,retPts),statN,
    first_serve_pct:safeRate(firstIn,ownPts),first_serve_points_won:safeRate(firstWon,firstIn),second_serve_points_won:safeRate(secondWon,secondAtt),service_points_won:safeRate(ownWon,ownPts),service_games_won:safeRate(serviceGamesWon,serviceGames),break_points_saved:safeRate(bpSaved,bpFaced),
    first_return_points_won:safeRate(firstRetWon,firstRetAtt),second_return_points_won:safeRate(secondRetWon,secondRetAtt),return_points_won:safeRate(retWon,retPts),return_games_won:safeRate(returnGamesWon,returnGames),break_points_converted:safeRate(bpConverted,bpOpp),
    aces_pg:propN?aces/propN:null,double_faults_pg:propN?dfs/propN:null,aces_allowed_pg:propN?acesAllowed/propN:null,breaks_pg:propN?breaks/propN:null,breaks_conceded_pg:propN?breaksConceded/propN:null,propN,
    workload7:recent7.reduce((s,m)=>s+(num(m.minutes)||90),0),workload14:recent14.reduce((s,m)=>s+(num(m.minutes)||90),0),matches7:recent7.length,matches14:recent14.length,last_match_days:latest?daysAgo(latest.tourney_date):null,last_surface:latest?.surface||null,
    recent_matches:all.slice(0,12).map(m=>historicalMatchIntel(m,key))
  };
}
function verificationLinks(tour){
  return tour==='atp'?{
    official_stats:'https://www.atptour.com/en/stats',
    official_match_stats:'https://www.atptour.com/en/stats/individual-game-stats',
    sofascore:'https://www.sofascore.com/it/tennis'
  }:{
    official_stats:'https://www.wtatennis.com/stats',
    official_match_stats:'https://www.wtatennis.com/stats',
    sofascore:'https://www.sofascore.com/it/tennis'
  };
}
function publicPlayerIntel(p,name,tour,surface){
  const recentMatches=compactRecentMatches(p.recent_matches);
  return{
    name,tour:String(tour||'').toUpperCase(),target_surface:surface||null,rank:p.rank??null,
    sample:{matches:p.n??0,stat_matches:p.statN??0,surface_matches:p.surfaceN??0,prop_matches:p.propN??0},
    context:{form:p.form??null,form_long:p.form_long??null,surface_form:p.surface??null,last_surface:p.last_surface??null,rest_days:p.last_match_days??null,matches_7d:p.matches7??0,matches_14d:p.matches14??0,workload_7d_minutes:p.workload7??0,workload_14d_minutes:p.workload14??0},
    service:{first_serve_pct:p.first_serve_pct??null,first_serve_points_won:p.first_serve_points_won??null,second_serve_points_won:p.second_serve_points_won??null,service_points_won:p.service_points_won??null,service_games_won:p.service_games_won??null,break_points_saved:p.break_points_saved??null,aces_per_match:p.aces_pg??null,double_faults_per_match:p.double_faults_pg??null},
    return:{first_return_points_won:p.first_return_points_won??null,second_return_points_won:p.second_return_points_won??null,return_points_won:p.return_points_won??null,return_games_won:p.return_games_won??null,break_points_converted:p.break_points_converted??null,breaks_per_match:p.breaks_pg??null,aces_allowed_per_match:p.aces_allowed_pg??null},
    recent_matches:recentMatches,verification:verificationLinks(tour),
    history_source:USING_CUSTOM_HISTORY?'CUSTOM_LICENSED_HISTORY':'TENNIS_HISTORY_ARCHIVE_RESEARCH',
    verification_note:'Statistiche calcolate dallo storico match del motore; link ufficiali ATP/WTA e SofaScore per controllo esterno. Nessun dato viene inventato se il campione non e disponibile.'
  };
}
function refreshPlayerIntel(locked,event,h,calibration,drift){
  const e=event||{
    id:locked.event_id,date:locked.start_at,home:locked.player_a,away:locked.player_b,
    league:{name:locked.tournament||"",slug:locked.league_slug||null}
  };
  const c=sportsCore(e,h,calibration,drift);
  if(!c)return{...locked,player_intel_status:"DATA_GAP"};
  return{
    ...locked,
    player_intel:{
      candidate_side:locked.candidate_side||locked.pick_side||null,
      candidate_name:locked.candidate_name||locked.pick_name||null,
      calculated_at:NOW.toISOString(),
      a:publicPlayerIntel(c.A,e.home,c.tour,c.surface),
      b:publicPlayerIntel(c.B,e.away,c.tour,c.surface)
    },
    player_intel_status:"READY",
    player_intel_refreshed_at:NOW.toISOString(),
    prediction_lock_preserved:true
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
    for(const y of YEARS){
      const url=historyUrl(tour,y);
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

function historicalColdStartRecords(rows,tour){
  const ordered=(rows||[]).filter(m=>tennisDate(m?.tourney_date)&&norm(m?.winner_name)&&norm(m?.loser_name)&&["Hard","Clay","Grass"].includes(String(m?.surface||""))).sort((a,b)=>dateNum(a)-dateNum(b));
  const global=new Map(),surfaces=new Map(),recent=new Map(),pairs=new Map(),records=[];
  const rating=(map,key)=>map.get(key)??1500;
  const pushRecent=(key,z)=>{const a=recent.get(key)||[];a.push(z);if(a.length>55)a.splice(0,a.length-55);recent.set(key,a)};
  const ageDays=(now,then)=>Math.max(0,(now-then)/86400000);
  const player=(key,surface,now,rank)=>{
    const all=recent.get(key)||[],r20=all.slice(-20),r35=all.slice(-35),surf=all.filter(x=>x.surface===surface).slice(-40);
    const wr=(arr,half,prior)=>{let w=.5*prior,t=prior;for(const x of arr){const wt=Math.exp(-ageDays(now,x.date)*Math.LN2/half);t+=wt;if(x.won)w+=wt}return t?w/t:.5};
    let ownWon=0,ownPts=0,retWon=0,retPts=0,statN=0;
    for(const x of r20){if(Number.isFinite(x.serve_pts)&&Number.isFinite(x.serve_won)&&x.serve_pts>0){ownPts+=x.serve_pts;ownWon+=x.serve_won;statN++}if(Number.isFinite(x.return_pts)&&Number.isFinite(x.return_won)&&x.return_pts>0){retPts+=x.return_pts;retWon+=x.return_won}}
    const r7=all.filter(x=>ageDays(now,x.date)<=7),r14=all.filter(x=>ageDays(now,x.date)<=14),last=all.at(-1);
    return{n:all.length,rank:Number.isFinite(rank)?rank:null,form:wr(r20,75,4),form_long:wr(r35,150,7),surfaceN:surf.length,surface:wr(surf,210,8),serve:ownPts?ownWon/ownPts:null,ret:retPts?retWon/retPts:null,statN,workload7:r7.reduce((s,x)=>s+(x.minutes||90),0),workload14:r14.reduce((s,x)=>s+(x.minutes||90),0),matches7:r7.length,matches14:r14.length,last_match_days:last?ageDays(now,last.date):null,last_surface:last?.surface||null};
  };
  const hh=(a,b,surface,now)=>{
    const arr=(pairs.get(pairKey(a,b))||[]).slice(-12);let wa=0,wb=0,total=0;
    for(const x of arr){const years=ageDays(now,x.date)/365.25,wt=Math.exp(-years/2.8)*(x.surface===surface?1.45:1);if(x.winner===a)wa+=wt;else wb+=wt;total+=wt}
    return{n:arr.length,edge:total?(wa-wb)/total:0};
  };
  for(const m of ordered){
    const now=tennisDate(m.tourney_date),surface=String(m.surface),w=norm(m.winner_name),l=norm(m.loser_name);if(!now||!w||!l||w===l)continue;
    const A=w<l?w:l,B=A===w?l:w,actual=A===w?"A":"B";
    const rankA=num(A===w?m.winner_rank:m.loser_rank),rankB=num(B===w?m.winner_rank:m.loser_rank);
    const PA=player(A,surface,now,rankA),PB=player(B,surface,now,rankB);
    if(PA.n>=6&&PB.n>=6){
      const eloA=rating(global,A),eloB=rating(global,B),sm=surfaces.get(surface)||new Map(),sEloA=rating(sm,A),sEloB=rating(sm,B);
      const rankTerm=PA.rank&&PB.rank?clamp(Math.log(PB.rank/PA.rank),-2,2):0,srA=(PA.serve??.61)+(PA.ret??.39),srB=(PB.serve??.61)+(PB.ret??.39),HH=hh(A,B,surface,now);
      const restA=PA.last_match_days==null?3:clamp(PA.last_match_days,0,10),restB=PB.last_match_days==null?3:clamp(PB.last_match_days,0,10),fatigue=clamp((PB.workload7-PA.workload7)/500,-.45,.45)+clamp((restA-restB)/14,-.25,.25);
      const modelA=sigmoid(((eloA-eloB)/400)*1.18+rankTerm*.34),modelB=sigmoid(((sEloA-sEloB)/400)*1.22+(PA.surface-PB.surface)*1.55),modelC=sigmoid((PA.form-PB.form)*2.25+(PA.form_long-PB.form_long)*.7+(srA-srB)*2.0+HH.edge*.46+fatigue*.72);
      const relA=1+(PA.rank&&PB.rank?.15:0)+Math.min(.35,(PA.n+PB.n)/120),relB=.7+Math.min(.5,Math.min(PA.surfaceN,PB.surfaceN)/30),relC=.75+Math.min(.35,Math.min(PA.statN,PB.statN)/15)+Math.min(.15,(PA.n+PB.n)/160);
      const raw=(modelA*relA+modelB*relB+modelC*relC)/(relA+relB+relC);
      if(Number.isFinite(raw))records.push({status:"SETTLED",raw_p_a:clamp(raw,.02,.98),actual_side:actual,tour,surface,historical_at:now.toISOString()});
    }
    const rw=rating(global,w),rl=rating(global,l),ew=expected(rw,rl),k=24;global.set(w,rw+k*(1-ew));global.set(l,rl-k*(1-ew));
    const sm=surfaces.get(surface)||new Map(),sw=rating(sm,w),sl=rating(sm,l),es=expected(sw,sl),ks=28;sm.set(w,sw+ks*(1-es));sm.set(l,sl-ks*(1-es));surfaces.set(surface,sm);
    const pk=pairKey(w,l),pa=pairs.get(pk)||[];pa.push({winner:w,surface,date:now});if(pa.length>14)pa.splice(0,pa.length-14);pairs.set(pk,pa);
    const rowFor=(key,won)=>{
      const own=won?"w":"l",opp=won?"l":"w",sv=num(m[`${own}_svpt`]),fw=num(m[`${own}_1stWon`]),sw2=num(m[`${own}_2ndWon`]),osv=num(m[`${opp}_svpt`]),ofw=num(m[`${opp}_1stWon`]),osw=num(m[`${opp}_2ndWon`]);
      return{won,surface,date:now,minutes:num(m.minutes)||90,serve_pts:sv,serve_won:sv&&fw!=null&&sw2!=null?fw+sw2:null,return_pts:osv,return_won:osv&&ofw!=null&&osw!=null?osv-ofw-osw:null};
    };
    pushRecent(w,rowFor(w,true));pushRecent(l,rowFor(l,false));
  }
  return records.slice(-3200);
}
function historicalColdStartSeed(hist,prev={}){
  let records=[...historicalColdStartRecords(hist?.atp?.rows,"atp"),...historicalColdStartRecords(hist?.wta?.rows,"wta")].sort((a,b)=>String(a.historical_at).localeCompare(String(b.historical_at)));
  if(records.length>5200)records=records.slice(-5200);
  if(records.length<240)return{approved:false,calibration:null,records:records.length,holdout_n:0,holdout_brier:null,raw_brier:null,log_loss:null};
  const cut=Math.max(180,Math.floor(records.length*.72)),train=records.slice(0,cut),holdout=records.slice(cut),cal=fitCalibrationSet(train,prev);
  let b=0,rb=0,ll=0,n=0;
  for(const r of holdout){
    const c=selectCalibration(cal,r.tour,r.surface),p=applyCalibration(r.raw_p_a,c),y=r.actual_side==="A"?1:0;if(!(p>0&&p<1))continue;
    b+=(p-y)**2;rb+=(r.raw_p_a-y)**2;ll+=-(y*Math.log(p)+(1-y)*Math.log(1-p));n++;
  }
  const brier=n?b/n:null,rawBrier=n?rb/n:null,logLoss=n?ll/n:null,approved=!!(cal.active&&n>=180&&Number.isFinite(brier)&&brier<=.255&&Number.isFinite(logLoss)&&logLoss<=.72&&brier<=(rawBrier??1)+.012);
  const calibration=approved?{...cal,active:true,origin:"HISTORICAL_WALK_FORWARD",cold_start:true,seed_records:records.length,holdout_n:n,holdout_brier:brier,holdout_raw_brier:rawBrier,holdout_log_loss:logLoss}:{...cal,active:false,origin:"HISTORICAL_SEED_REJECTED",cold_start:false,seed_records:records.length,holdout_n:n,holdout_brier:brier,holdout_raw_brier:rawBrier,holdout_log_loss:logLoss};
  return{approved,calibration,records:records.length,holdout_n:n,holdout_brier:brier,raw_brier:rawBrier,log_loss:logLoss};
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
  const meta={origin:set?.origin||"FORWARD_TRACK_RECORD",cold_start:!!set?.cold_start,seed_holdout_brier:set?.holdout_brier??null};
  const g=set?.surface?.[`${tour}:${surface}`];if(g?.active&&g.sample>=35)return{...g,scope:`${tour}:${surface}`,...meta};
  const t=set?.tour?.[tour];if(t?.active&&t.sample>=45)return{...t,scope:tour,...meta};
  const a=set?.global;if(a?.active&&a.sample>=60)return{...a,scope:"global",...meta};
  return{active:false,sample:set?.sample||0,intercept:0,slope:1,scope:"none",...meta};
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
  if((drift.sample||0)<20&&!c.cal.cold_start)hard.push("MODELLO_COLD");

  let verdict="NO BET";
  if(!hard.length&&c.majority===candidateSide&&conf>=66&&dq>=66&&evp>=4&&ep>=2&&revp>=1&&rep>=.8)verdict="WATCH";
  if(!hard.length&&c.unanimous&&c.cal.active&&drift.health==="HEALTHY"&&conf>=75&&dq>=72&&evp>=6.5&&ep>=3.2&&revp>=2.2&&rep>=1.2&&c.dis<.095)verdict="VALUE";
  if(!hard.length&&c.unanimous&&c.cal.active&&(drift.sample||0)>=120&&drift.health==="HEALTHY"&&conf>=84&&dq>=84&&evp>=10&&ep>=5&&revp>=4&&rep>=2&&c.dis<.065&&Number.isFinite(candidateAge)&&candidateAge<=30)verdict="STRONG VALUE";
  if(drift.health==="LEARNING"&&verdict==="VALUE")verdict="WATCH";

  const marketLab=marketLabFor(event,c,mkt,conf,dq,drift,verdict,candidateSide);
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
    player_intel:{candidate_side:candidateSide,candidate_name:candidateName,a:publicPlayerIntel(c.A,event.home,c.tour,c.surface),b:publicPlayerIntel(c.B,event.away,c.tour,c.surface)},
    market_lab:marketLab,market_best:marketLab.best_priced,multi_market_version:"MM-3.0-PRICE-GUARD",
    reason_codes:reasons.slice(0,7),no_bet_reasons:hard,warnings:[...new Set(warnings)],calibration_sample:c.cal.sample,calibration_scope:c.cal.scope,calibration_active:!!c.cal.active,model_health:drift.health,model_version:MODEL_VERSION,predicted_at:NOW.toISOString(),locked:true,status:"LOCKED"
  };
  payload.audit_id=hash(payload);return payload;
}

function completedSetRows(scores){
  const periods=scores?.periods;if(!periods||typeof periods!=="object")return[];const rows=[];
  for(const [key,v] of Object.entries(periods)){if(!v||typeof v!=="object"||!/set|^p\d+$|period/i.test(key))continue;const a=num(v.home??v.homeScore??v.a),b=num(v.away??v.awayScore??v.b);if(a==null||b==null||a<0||b<0||a>7||b>7)continue;const done=((a>=6||b>=6)&&Math.abs(a-b)>=2)||(a===7&&b>=5)||(b===7&&a>=5);if(done)rows.push({key,home:a,away:b})}
  return rows.slice(0,5);
}
function settleSecondaryMarkets(e,p){
  const sets=completedSetRows(e?.scores);if(!sets.length)return[];const sa=sets.filter(x=>x.home>x.away).length,sb=sets.filter(x=>x.away>x.home).length,total=sets.reduce((z,x)=>z+x.home+x.away,0),gm=sets.reduce((z,x)=>z+x.home-x.away,0),sm=sa-sb,score=`${sa}-${sb}`,first=sets[0].home>sets[0].away?"A":"B",tb=sets.some(x=>Math.max(x.home,x.away)===7&&Math.min(x.home,x.away)===6);
  const rows=[];for(const r of p?.market_lab?.priced||[]){if(r.validation_tier==="OFFICIAL_ML"||!(r.best_odds>1)||!Number.isFinite(r.model_prob))continue;let won=null,push=false;
    if(r.market==="TOTAL_GAMES"){const z=total-r.line;if(z===0)push=true;else won=/^OVER/.test(r.selection)?z>0:z<0}
    else if(r.market==="GAME_HANDICAP"){const z=(r.side==="A"?gm:-gm)+Number(r.line||0);if(z===0)push=true;else won=z>0}
    else if(r.market==="SET_HANDICAP"){const z=(r.side==="A"?sm:-sm)+Number(r.line||0);if(z===0)push=true;else won=z>0}
    else if(r.market==="FIRST_SET_WINNER")won=r.side===first;
    else if(r.market==="TIEBREAK_IN_MATCH")won=(r.selection==="YES")===tb;
    else if(r.market==="SET_SCORE")won=r.selection===score;
    else if(r.market==="WIN_A_SET"){const yes=r.side==="A"?sa>0:sb>0;won=!!r.yes===yes}
    else continue;
    const outcome=push?null:(won?1:0),profit=push?0:(won?r.best_odds-1:-1);rows.push({market:r.market,selection:r.selection,offer_key:r.offer_key,model_prob:r.model_prob,odds:r.best_odds,verdict:r.verdict,won:push?null:won,push,profit_units:profit,brier:outcome==null?null:(r.model_prob-outcome)**2,settled_at:NOW.toISOString()});
  }return rows;
}
function multiMarketStats(history){
  const rows=(history||[]).flatMap(x=>x.secondary_settled||[]).filter(x=>x&&!x.push),qualified=rows.filter(x=>x.verdict==="VALUE"||x.verdict==="WATCH"),wins=qualified.filter(x=>x.won).length,pl=qualified.reduce((a,x)=>a+(x.profit_units||0),0),b=rows.filter(x=>Number.isFinite(x.brier));
  const by={};for(const r of rows){const z=by[r.market]||(by[r.market]={settled:0,qualified:0,wins:0,pl:0,brier:0,brier_n:0});z.settled++;if(r.verdict==="VALUE"||r.verdict==="WATCH"){z.qualified++;if(r.won)z.wins++;z.pl+=r.profit_units||0}if(Number.isFinite(r.brier)){z.brier+=r.brier;z.brier_n++}}
  for(const z of Object.values(by)){z.hit_rate=z.qualified?z.wins/z.qualified:null;z.roi=z.qualified?z.pl/z.qualified:null;z.brier=z.brier_n?z.brier/z.brier_n:null;delete z.brier_n;delete z.wins;delete z.pl}
  return{settled:rows.length,qualified:qualified.length,hit_rate:qualified.length?wins/qualified.length:null,roi:qualified.length?pl/qualified.length:null,brier:b.length?b.reduce((a,x)=>a+x.brier,0)/b.length:null,by_market:by};
}
async function closingMarket(eventId,bookmakers){
  try{
    const raw=await api("/historical/odds",{eventId,bookmakers:bookmakers.join(","),markets:"ML"});
    return marketFromOdds(raw);
  }catch(e){console.error("closing",eventId,e.message);return null}
}
async function settlePredictions(bookmakers,events=[]){
  const hist=[...(state.history||[])],remaining=[];
  const due=(state.upcoming||[]).filter(p=>new Date(p.start_at)<NOW).slice(0,MAX_SETTLEMENTS_PER_RUN);
  const dueIds=new Set(due.map(p=>String(p.event_id)));
  const byId=new Map((events||[]).map(e=>[String(e.id),e]));
  let closingCalls=0;
  for(const p of state.upcoming||[]){
    const id=String(p.event_id);
    if(!dueIds.has(id)){remaining.push(p);continue}
    const e=byId.get(id),actual=e?winnerSide(e):null;
    if(!e||!actual){remaining.push(p);continue}
    const won=p.pick_side?p.pick_side===actual:null,profit=p.pick_side?(won?(p.pick_odds-1):-1):0,y=actual==="A"?1:0;
    let clv=null,closingOdds=null;
    const hourly=Number.isFinite(state.rate_limit?.remaining)?state.rate_limit.remaining:RUN_CAP;
    if(p.pick_side&&bookmakers.length&&closingCalls<1&&!rateLimitActive()&&hourly>6&&runCalls<RUN_CAP-5&&state.usage.calls<DAILY_CAP-5){
      closingCalls++;
      const cm=await closingMarket(p.event_id,bookmakers);
      if(cm){closingOdds=p.pick_side==="A"?cm.bestA:cm.bestB;if(closingOdds>1)clv=p.pick_odds/closingOdds-1}
    }
    const secondary_settled=settleSecondaryMarkets(e,p);
    // Keep the immutable audit facts, but drop bulky live/player payloads once a match is settled.
    const {player_intel,market_live,market_lab,quote_tape,...locked}=p;
    hist.unshift({...locked,status:"SETTLED",settled_at:NOW.toISOString(),actual_side:actual,actual_winner:actual==="A"?p.player_a:p.player_b,pick_won:won,profit_units:profit,brier:(p.p_a-y)**2,log_loss:-(y*Math.log(clamp(p.p_a,.001,.999))+(1-y)*Math.log(clamp(1-p.p_a,.001,.999))),shadow_brier:Number.isFinite(p.shadow_p_a)?(p.shadow_p_a-y)**2:null,shadow_log_loss:Number.isFinite(p.shadow_p_a)?-(y*Math.log(clamp(p.shadow_p_a,.001,.999))+(1-y)*Math.log(clamp(1-p.shadow_p_a,.001,.999))):null,closing_odds:closingOdds,clv,secondary_settled,archive_compacted:true});
  }
  state.history=hist.slice(0,2000);state.upcoming=remaining;
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
  assertCommercialLicenses();
  if(rateLimitActive()){
    const mins=minutesUntil(state.rate_limit.reset_at);
    state.meta={
      ...(state.meta||{}),
      updated_at:NOW.toISOString(),
      status:rateLimitLabel(),
      source:SOURCE_LABEL,
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
    state.meta={...(state.meta||{}),updated_at:NOW.toISOString(),status:"SETUP",source:SOURCE_LABEL,model_version:MODEL_VERSION,note:COMMERCIAL_MODE?"Commercial mode requires licensed providers and an API key.":"Research mode: create ODDS_API_KEY secret. Free/development data must not be used for a paid production launch."};
    await saveState(state);return;
  }
  let bookmakers=[];
  try{
    state.cache=state.cache||{};
    const cachedNames=selectedNames(state.cache?.bookmakers?.names||state.meta?.bookmakers||[]);
    const fetchedMs=new Date(state.cache?.bookmakers?.fetched_at||0).getTime();
    const cacheFresh=cachedNames.length&&Number.isFinite(fetchedMs)&&(NOW.getTime()-fetchedMs<24*3600000);
    if(cacheFresh){
      bookmakers=cachedNames;
    }else if(cachedNames.length&&!state.cache?.bookmakers?.fetched_at){
      bookmakers=cachedNames;
      state.cache.bookmakers={names:bookmakers,fetched_at:NOW.toISOString()};
    }else{
      bookmakers=selectedNames(await api("/bookmakers/selected"));
      if(bookmakers.length<1)throw new Error("NO_SELECTED_BOOKMAKERS");
      state.cache.bookmakers={names:bookmakers,fetched_at:NOW.toISOString()};
    }
  }catch(e){
    state.meta={...(state.meta||{}),updated_at:NOW.toISOString(),status:"SETUP",source:SOURCE_LABEL,model_version:MODEL_VERSION,error:e.message,api_usage_today:state.usage.calls};
    await saveState(state);return;
  }
  let eventsRaw=await api("/events",{sport:"tennis"});
  const events=(Array.isArray(eventsRaw)?eventsRaw:(eventsRaw?.data||eventsRaw?.events||[])).filter(isSinglesEvent);
  await settlePredictions(bookmakers,events);

  const quant=await loadQuantHistory();
  const forwardCalibration=fitCalibrationSet(state.history,state.learning?.calibration_forward||state.learning?.calibration);
  const coldStart=historicalColdStartSeed(quant,state.learning?.calibration_seed);
  const useForward=forwardCalibration.active&&(forwardCalibration.sample||0)>=60;
  const calibration=useForward?{...forwardCalibration,origin:"FORWARD_TRACK_RECORD",cold_start:false}:coldStart.approved?coldStart.calibration:{...forwardCalibration,origin:"FORWARD_COLD",cold_start:false};
  const drift=driftStatus(state.history);
  state.learning={calibration,calibration_forward:forwardCalibration,calibration_seed:coldStart.calibration,drift,cold_start:{approved:coldStart.approved,records:coldStart.records,holdout_n:coldStart.holdout_n,holdout_brier:coldStart.holdout_brier,raw_brier:coldStart.raw_brier,log_loss:coldStart.log_loss}};
  const eventById=new Map(events.map(e=>[String(e.id),e]));
  state.upcoming=(state.upcoming||[]).map(p=>refreshPlayerIntel(p,eventById.get(String(p.event_id)),quant,calibration,drift));

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
  state.market_stats=multiMarketStats(state.history);
  state.learning.challenger=challengerEvaluation(state.history);
  const activeSignals=state.upcoming.filter(x=>x.verdict==="VALUE"||x.verdict==="STRONG VALUE").length;
  state.risk={mode:(drift.sample||0)<50?"PAPER":"RESEARCH",sport_guard:"TENNIS_SPECIFIC",surface_adaptation_guard:"ON",fatigue_guard:"ON",active_signals:activeSignals,max_concurrent_signals:4,concentration_policy:"Monitor tournament/surface clustering; no basketball-style correlation assumptions are imported."};
  const pendingBatch=Math.max(0,unseen.length-newEvents.length);
  const status=state.usage.calls>=DAILY_CAP?"DAILY HOLD":(pendingBatch>0?"READY · BATCHING":"READY");
  state.meta={
    updated_at:NOW.toISOString(),data_refreshed_at:NOW.toISOString(),status,source:SOURCE_LABEL,model_version:MODEL_VERSION,state_schema:"TEP-12.5",
    commercial_mode:COMMERCIAL_MODE,commercial_license_guard:COMMERCIAL_MODE?"CONFIRMED_BY_ENV":"RESEARCH_ONLY",history_source:USING_CUSTOM_HISTORY?"CUSTOM_LICENSED_TEMPLATE":"SACKMANN_ARCHIVE_MIRROR_CC_BY_NC_SA_RESEARCH_ONLY",
    bookmakers,locked_predictions:state.upcoming.length,radar_events:state.radar.length,pre_analyzed:state.radar.filter(x=>x.pre_status!=="DATA GAP").length,early_watch:state.radar.filter(x=>x.pre_status==="EARLY WATCH").length,data_gap:state.radar.filter(x=>x.pre_status==="DATA GAP").length,market_checked:state.radar.filter(x=>x.market_checked).length,calibration_sample:calibration.sample||0,calibration_active:!!calibration.active,calibration_origin:calibration.origin||"FORWARD_COLD",forward_calibration_sample:forwardCalibration.sample||0,historical_seed_records:coldStart.records||0,historical_seed_holdout_n:coldStart.holdout_n||0,historical_seed_holdout_brier:coldStart.holdout_brier??null,cold_start_paper_mode:!!calibration.cold_start,
    model_health:drift.health,operating_mode:(drift.sample||0)<50?"PAPER VALIDATION":"LIVE RESEARCH",api_usage_today:state.usage.calls,api_daily_guard:DAILY_CAP,api_hourly_remaining:state.rate_limit?.remaining??null,rate_limit_reset_at:state.rate_limit?.reset_at??null,rate_limit_minutes:minutesUntil(state.rate_limit?.reset_at),run_calls:runCalls,
    pending_prediction_batch:pendingBatch,processed_this_run:newEvents.length,market_refresh_count:refreshedMarkets,quote_refresh_limit:QUOTE_REFRESH_LIMIT,quote_refresh_policy:"Hourly priority refresh of locked matches; Prediction Lock remains immutable. All bookmaker market names are parsed defensively; unsupported schemas are ignored.",
    priority_policy:"Grand Slam > 1000/Finals > 500 > 250 > Challenger > ITF; then Top 10/25/50/100 + Elo + ranking points",benchmark:{version:"2026-08",no_vig_reference:true,automatic_settlement:true,clv_tracking:true,beginner_pro_modes:true,multi_market_paper:true,multi_market_settlement:true,quote_tape:true,live_score_worker:true,sharp_liquidity:false,sharp_liquidity_note:"Not available in the current zero-cost data plan; never inferred."},
    history_matches_loaded:quant.atp.rows.length+quant.wta.rows.length,
    sport_specific_guard:"Surface sample + surface-transition adaptation + recent workload/fatigue uncertainty",
    cross_app_learning:"Shared validation, audit, fail-closed and challenger discipline; sport model remains tennis-specific.",
    note:"NO BET first. Historical walk-forward calibration may unlock PAPER/TEST edges during cold start, but official ML remains blocked from VALUE until forward track-record health is mature. Multi-market simulation remains paper-only until family-level validation matures. Quote tape never rewrites a Prediction Lock."
  };
  await saveState(state);
  console.log(JSON.stringify({meta:state.meta,stats:state.stats},null,2));
}

function selfTest(){
  const fake={home:"A Player",away:"B Player",bookmakers:{A:[{name:"ML",odds:[{home:1.80,away:2.10}],updatedAt:NOW.toISOString()},{name:"Totals",odds:[{hdp:22.5,over:1.91,under:1.91}]},{name:"First Set Winner",odds:[{home:1.75,away:2.05}]},{name:"Tiebreak in Match",odds:[{yes:2.20,no:1.65}]},{name:"Set Handicap",odds:[{hdp:-1.5,home:2.10,away:1.70}]}],B:[{name:"ML",odds:[{home:1.84,away:2.06}],updatedAt:NOW.toISOString()},{name:"Totals",odds:[{hdp:22.5,over:1.95,under:1.88}]},{name:"First Set Winner",odds:[{home:1.78,away:2.02}]},{name:"Tiebreak in Match",odds:[{yes:2.25,no:1.62}]},{name:"Set Handicap",odds:[{hdp:-1.5,home:2.12,away:1.68}]}]}};
  const m=marketFromOdds(fake);if(!m||m.count!==2||!(m.consensus>.4&&m.consensus<.7))throw new Error("SELFTEST_MARKET");if(!m.secondary.some(x=>x.type==="TOTAL_GAMES")||!m.secondary.some(x=>x.type==="FIRST_SET_WINNER")||!m.secondary.some(x=>x.type==="TIEBREAK_IN_MATCH")||!m.secondary.some(x=>x.type==="SET_HANDICAP"))throw new Error("SELFTEST_SECONDARY_PARSE");
  const fakeC={pA:.64,uncertainty:.06,tour:"ATP",A:{serve:.64,ret:.37},B:{serve:.61,ret:.34}};
  const sim=simulateMatchMarkets(fakeC,{id:"SELF",league:{name:"ATP Test"}},1200);
  if(!(sim.model_match_a>.54&&sim.model_match_a<.74)||!(sim.mean_total_games>15&&sim.mean_total_games<40))throw new Error("SELFTEST_MULTI_MARKET");
  const pg=withPriceGuard({validation_tier:"OFFICIAL_ML",verdict:"VALUE",robust_prob:.55});if(!(pg.min_acceptable_odds>1/.55&&pg.target_robust_ev===.022)||priceZoneFor(pg,pg.min_acceptable_odds+.01,.03)!=="BET_ZONE")throw new Error("SELFTEST_PRICE_GUARD");
  const ps=withPriceGuard({validation_tier:"PAPER_MULTI_MARKET",verdict:"VALUE",robust_prob:.55});if(priceZoneFor(ps,ps.min_acceptable_odds+.01,.03)!=="PAPER_VALUE")throw new Error("SELFTEST_PAPER_GUARD");
  const ns=new Set(["jannik sinner","carlos alcaraz","qinwen zheng","vilius gaubas","tomas barrios vera","christopher o connell"]),n=buildNameResolver(ns),nt={names:ns,nameResolver:n};if(!n.get("sinner|j")||!n.get("alcaraz|c")||resolveNameKey("Zheng, Qinwen",nt)!=="qinwen zheng"||resolveNameKey("Gaubas, Vilius",nt)!=="vilius gaubas"||resolveNameKey("Barrios Vera, Marcelo Tomas",nt)!=="tomas barrios vera"||resolveNameKey("O\'Connell, Christopher",nt)!=="christopher o connell")throw new Error("SELFTEST_NAMES");
  const r=parseResetAt("60");if(!r||minutesUntil(r)<0)throw new Error("SELFTEST_RATE");
  const ad=adaptationContext({last_match_days:3,last_surface:"Clay",matches7:2,workload7:180},{last_match_days:12,last_surface:"Hard",matches7:1,workload7:90},"Hard");
  if(!ad.a.surfaceChange||ad.b.surfaceChange||ad.riskMax!==1)throw new Error("SELFTEST_ADAPTATION");
  const load=adaptationContext({last_match_days:2,last_surface:"Hard",matches7:5,workload7:560},{last_match_days:3,last_surface:"Hard",matches7:2,workload7:180},"Hard");
  if(!load.a.denseLoad||load.riskMax!==1)throw new Error("SELFTEST_FATIGUE");
  const syn=[];for(let i=0;i<20;i++){const d=String(20240101+i),aw=i%2===0;const w=aw?"Alpha One":"Beta Two",l=aw?"Beta Two":"Alpha One";syn.push({tourney_date:d,surface:"Hard",winner_name:w,loser_name:l,winner_rank:20,loser_rank:40,minutes:90,w_svpt:60,w_1stWon:28,w_2ndWon:12,l_svpt:62,l_1stWon:25,l_2ndWon:10})}
  if(historicalColdStartRecords(syn,"atp").length<6)throw new Error("SELFTEST_COLD_START_WALK_FORWARD");
  console.log(JSON.stringify({ok:true,model:MODEL_VERSION,tests:["market_no_vig","secondary_market_parser","multi_market_sim","price_guard","paper_guard","name_resolver","rate_limit_parser","surface_adaptation_guard","fatigue_guard","cold_start_walk_forward"]}));
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
  else if(e.message==="COMMERCIAL_ODDS_LICENSE_REQUIRED"||e.message==="COMMERCIAL_HISTORY_LICENSE_REQUIRED"){
    status="LICENSE HOLD";
    note="Commercial mode fail-closed: configure and explicitly confirm commercially licensed odds + historical data before production.";
  }

  state.meta={
    ...(state.meta||{}),
    updated_at:NOW.toISOString(),
    status,
    source:SOURCE_LABEL,
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
