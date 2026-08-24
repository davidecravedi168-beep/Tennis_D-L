import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const API_KEY=process.env.ODDS_API_KEY;
const BASE="https://api.odds-api.io/v3";
const OUT="data/quant-board.json";
const MODEL_VERSION="ZERO-COST-QUANT-3.0";
const NOW=new Date();
const DAILY_CAP=420;          // free tier 500/day: 80 calls safety reserve
const RUN_CAP=38;             // protects accidental loops
const LOCK_MIN_HOURS=1;
const LOCK_MAX_HOURS=36;
const RADAR_DAYS=7;
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
  if(state.usage.calls>=DAILY_CAP)throw new Error("DAILY_BUDGET_GUARD");
  if(runCalls>=RUN_CAP)throw new Error("RUN_BUDGET_GUARD");
  const u=new URL(BASE+endpoint);
  u.searchParams.set("apiKey",API_KEY);
  Object.entries(params).forEach(([k,v])=>v!==undefined&&v!==null&&v!==""&&u.searchParams.set(k,String(v)));
  const r=await fetch(u,{headers:{"user-agent":"TennisEdgeZeroCost/3.0"}});
  state.usage.calls++;runCalls++;
  if(r.status===429)throw new Error("RATE_LIMIT_429");
  if(!r.ok)throw new Error(`${endpoint} HTTP ${r.status}`);
  return r.json();
}
async function fetchText(url){
  const r=await fetch(url,{headers:{"user-agent":"TennisEdgeZeroCost/3.0"}});
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
  for(const [book,markets] of Object.entries(obj.bookmakers)){
    const ml=(markets||[]).find(m=>String(m.name).toUpperCase()==="ML");
    const o=ml?.odds?.[0];const a=num(o?.home),b=num(o?.away);
    if(!(a>1&&b>1))continue;
    const s=1/a+1/b,margin=s-1;if(margin<-.03||margin>.25)continue;
    rows.push({book,a,b,pA:(1/a)/s,margin,updatedAt:ml.updatedAt||null});
  }
  if(!rows.length)return null;
  const med=median(rows.map(r=>r.pA)),mad=median(rows.map(r=>Math.abs(r.pA-med)))||0;
  const use=rows.filter(r=>Math.abs(r.pA-med)<=Math.max(.06,mad*4));
  const r=use.length?use:rows,consensus=median(r.map(x=>x.pA));
  return{
    count:r.length,consensus,
    bestA:Math.max(...r.map(x=>x.a)),bestB:Math.max(...r.map(x=>x.b)),
    bestBookA:r.find(x=>x.a===Math.max(...r.map(y=>y.a)))?.book||"—",
    bestBookB:r.find(x=>x.b===Math.max(...r.map(y=>y.b)))?.book||"—",
    sd:Math.sqrt(r.reduce((s,x)=>s+(x.pA-consensus)**2,0)/r.length),
    margin:r.reduce((s,x)=>s+x.margin,0)/r.length
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
  const n=norm(name),all=playerHistory(rows,name),r10=all.slice(0,10),r20=all.slice(0,20),surf=all.filter(m=>m.surface===surface).slice(0,40),latest=all[0];
  const wins=x=>x.filter(m=>norm(m.winner_name)===n).length;
  let ownWon=0,ownPts=0,retWon=0,retPts=0,statN=0;
  r20.forEach(m=>{
    const w=norm(m.winner_name)===n,sv=num(w?m.w_svpt:m.l_svpt),fw=num(w?m.w_1stWon:m.l_1stWon),sw=num(w?m.w_2ndWon:m.l_2ndWon);
    const osv=num(w?m.l_svpt:m.w_svpt),ofw=num(w?m.l_1stWon:m.w_1stWon),osw=num(w?m.l_2ndWon:m.w_2ndWon);
    if(sv&&fw!=null&&sw!=null){ownPts+=sv;ownWon+=fw+sw;statN++}
    if(osv&&ofw!=null&&osw!=null){retPts+=osv;retWon+=osv-ofw-osw}
  });
  const isW=latest&&norm(latest.winner_name)===n;
  return{
    n:all.length,rank:latest?num(isW?latest.winner_rank:latest.loser_rank):null,
    form10:bayesRate(wins(r10),r10.length,4),form20:bayesRate(wins(r20),r20.length,6),
    surfaceN:surf.length,surface:bayesRate(wins(surf),surf.length,8),
    serve:ownPts?ownWon/ownPts:null,ret:retPts?retWon/retPts:null,
    statN,workload3:all.slice(0,3).reduce((s,m)=>s+(num(m.minutes)||0),0)
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
    atp:{rows:tours.atp,names:playerNameSet(tours.atp),ratings:buildRatings(tours.atp),surfaceIndex:tournamentSurfaceIndex(tours.atp)},
    wta:{rows:tours.wta,names:playerNameSet(tours.wta),ratings:buildRatings(tours.wta),surfaceIndex:tournamentSurfaceIndex(tours.wta)}
  };
}
function resolveTour(event,hist){
  const a=norm(event.home),b=norm(event.away),inATP=hist.atp.names.has(a)&&hist.atp.names.has(b),inWTA=hist.wta.names.has(a)&&hist.wta.names.has(b);
  if(inATP&&!inWTA)return"atp";if(inWTA&&!inATP)return"wta";
  const l=norm(event.league?.name);if(l.includes("wta"))return inWTA?"wta":null;if(l.includes("atp"))return inATP?"atp":null;
  return null;
}
function applyCalibration(p,cal){return cal?.active?clamp(sigmoid(cal.intercept+cal.slope*logit(p)),.08,.92):p}
function fitCalibration(history,prev){
  const r=(history||[]).filter(x=>x.status==="SETTLED"&&Number.isFinite(x.raw_p_a)).map(x=>({x:logit(x.raw_p_a),y:x.actual_side==="A"?1:0}));
  if(r.length<40)return{active:false,sample:r.length,intercept:prev?.intercept??0,slope:prev?.slope??1};
  let a=prev?.active?prev.intercept:0,b=prev?.active?prev.slope:1,lr=.025;
  for(let step=0;step<260;step++){
    let ga=0,gb=0;for(const z of r){const pr=sigmoid(a+b*z.x),er=pr-z.y;ga+=er;gb+=er*z.x}
    a=clamp(a-lr*(ga/r.length+.035*a),-.55,.55);b=clamp(b-lr*(gb/r.length+.035*(b-1)),.58,1.42);
  }
  return{active:true,sample:r.length,intercept:a,slope:b,updated_at:NOW.toISOString()};
}
function driftStatus(history){
  const settled=(history||[]).filter(x=>x.status==="SETTLED"&&Number.isFinite(x.brier));
  if(settled.length<25)return{health:"COLD",penalty:6,recentBrier:null,allBrier:settled.length?settled.reduce((s,x)=>s+x.brier,0)/settled.length:null};
  const all=settled.reduce((s,x)=>s+x.brier,0)/settled.length,recent=settled.slice(0,Math.min(40,settled.length)).reduce((s,x)=>s+x.brier,0)/Math.min(40,settled.length);
  if(recent>all+.035||recent>.27)return{health:"DRIFT",penalty:14,recentBrier:recent,allBrier:all};
  if(recent>all+.018)return{health:"WATCH",penalty:8,recentBrier:recent,allBrier:all};
  return{health:"HEALTHY",penalty:0,recentBrier:recent,allBrier:all};
}
function buildPrediction(event,mkt,h,cal,drift){
  const tour=resolveTour(event,h);if(!tour)return null;
  const d=h[tour],surface=fuzzySurface(event,d.surfaceIndex),A=metrics(d.rows,event.home,surface),B=metrics(d.rows,event.away,surface);
  if(A.n<5||B.n<5)return null;
  const HH=h2h(d.rows,event.home,event.away,surface);
  const keyA=norm(event.home),keyB=norm(event.away),eloA=d.ratings.global.get(keyA)??1500,eloB=d.ratings.global.get(keyB)??1500;
  const se=d.ratings.surfaces.get(surface)||new Map(),sEloA=se.get(keyA)??1500,sEloB=se.get(keyB)??1500;
  const rankTerm=A.rank&&B.rank?clamp(Math.log(B.rank/A.rank),-2,2):0;
  const srA=(A.serve??.61)+(A.ret??.39),srB=(B.serve??.61)+(B.ret??.39);
  const eloRaw=((eloA-eloB)/400)*1.12+((sEloA-sEloB)/400)*.92+rankTerm*.26+(srA-srB)*2.2;
  const modelA=sigmoid(eloRaw);
  const formRaw=(A.form10-B.form10)*2.35+(A.form20-B.form20)*.8+(A.surface-B.surface)*2.1+HH.edge*.5+(srA-srB)*1.6+clamp((B.workload3-A.workload3)/600,-.4,.4);
  const modelB=sigmoid(formRaw);
  const rawP=(modelA+modelB)/2,pA=applyCalibration(rawP,cal),pB=1-pA,dis=Math.abs(modelA-modelB);
  const agree=(modelA>=.5)===(modelB>=.5);
  const edgeA=pA-mkt.consensus,edgeB=pB-(1-mkt.consensus),evA=pA*mkt.bestA-1,evB=pB*mkt.bestB-1;
  let pickSide,pickName,pickOdds,pickBook,pickEV,pickEdge,pickProb;
  if(evA>=evB){pickSide="A";pickName=event.home;pickOdds=mkt.bestA;pickBook=mkt.bestBookA;pickEV=evA;pickEdge=edgeA;pickProb=pA}
  else{pickSide="B";pickName=event.away;pickOdds=mkt.bestB;pickBook=mkt.bestBookB;pickEV=evB;pickEdge=edgeB;pickProb=pB}
  let dq=48+(A.rank&&B.rank?10:0)+Math.min(12,(A.n+B.n)/8)+Math.min(8,Math.min(A.surfaceN,B.surfaceN)/3)+(A.statN&&B.statN?6:0)+Math.min(5,HH.n);
  dq=clamp(dq,40,94);
  let conf=clamp(50+dq*.32-(dis*100)*.85-(agree?0:14)-clamp(mkt.sd/.06,0,1)*6-drift.penalty,32,94);
  const ep=pickEdge*100,evp=pickEV*100;
  let verdict="NO BET";
  if(agree&&dq>=58&&conf>=65&&evp>=3&&ep>=1.5)verdict="WATCH / VALUE";
  if(agree&&dq>=67&&conf>=72&&evp>=6&&ep>=2.8&&dis<.10)verdict="VALUE";
  if(agree&&dq>=78&&conf>=82&&evp>=12&&ep>=5&&dis<.065&&cal.sample>=50&&drift.health==="HEALTHY")verdict="VALUE FORTE";
  if(!agree||mkt.sd>.07||pickEV<=0||Math.abs(pA-mkt.consensus)>.18){verdict="NO BET";pickSide=null;pickName=null}
  const payload={
    event_id:String(event.id),start_at:event.date,player_a:event.home,player_b:event.away,tournament:event.league?.name||"—",league_slug:event.league?.slug||null,
    surface,tour,raw_p_a:rawP,p_a:pA,p_b:pB,model_a_p:modelA,model_b_p:modelB,model_disagreement:dis,engine_agreement:agree,
    fair_a:1/pA,fair_b:1/pB,pick_side:pickSide,pick_name:pickName,pick_prob:pickProb,pick_odds:pickOdds,pick_book:pickBook,pick_ev:pickEV,pick_edge:pickEdge,
    verdict,confidence:conf,data_quality:dq,market_depth:mkt.count,market_consensus_a:mkt.consensus,market_sd:mkt.sd,
    rank_a:A.rank,rank_b:B.rank,elo_a:eloA,elo_b:eloB,surface_elo_a:sEloA,surface_elo_b:sEloB,form_a:A.form10,form_b:B.form10,
    surface_form_a:A.surface,surface_form_b:B.surface,h2h_n:HH.n,h2h_edge:HH.edge,serve_return_delta:srA-srB,
    calibration_sample:cal.sample,model_health:drift.health,model_version:MODEL_VERSION,predicted_at:NOW.toISOString(),locked:true,status:"LOCKED"
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
  const due=(state.upcoming||[]).filter(p=>new Date(p.start_at)<NOW).slice(0,20);
  const dueIds=new Set(due.map(p=>p.event_id));
  for(const p of state.upcoming||[]){
    if(!dueIds.has(p.event_id)){remaining.push(p);continue}
    try{
      const e=await api("/events/"+p.event_id);
      const actual=winnerSide(e);
      if(!actual){remaining.push(p);continue}
      const won=p.pick_side?p.pick_side===actual:null,profit=p.pick_side?(won?(p.pick_odds-1):-1):0,y=actual==="A"?1:0;
      let clv=null,closingOdds=null;
      if(p.pick_side&&bookmakers.length&&runCalls<RUN_CAP-1&&state.usage.calls<DAILY_CAP-1){
        const cm=await closingMarket(p.event_id,bookmakers);
        if(cm){closingOdds=p.pick_side==="A"?cm.bestA:cm.bestB;if(closingOdds>1)clv=p.pick_odds/closingOdds-1}
      }
      hist.unshift({...p,status:"SETTLED",settled_at:NOW.toISOString(),actual_side:actual,actual_winner:actual==="A"?p.player_a:p.player_b,pick_won:won,profit_units:profit,brier:(p.p_a-y)**2,log_loss:-(y*Math.log(clamp(p.p_a,.001,.999))+(1-y)*Math.log(clamp(1-p.p_a,.001,.999))),closing_odds:closingOdds,clv});
    }catch(e){console.error("settle",p.event_id,e.message);remaining.push(p)}
  }
  state.history=hist.slice(0,4000);state.upcoming=remaining;
}
function stats(history){
  const closed=(history||[]).filter(x=>x.status==="SETTLED"),picks=closed.filter(x=>x.pick_side&&x.verdict!=="NO BET"),wins=picks.filter(x=>x.pick_won).length;
  const profit=picks.reduce((s,x)=>s+(num(x.profit_units)||0),0),clvs=picks.map(x=>num(x.clv)).filter(Number.isFinite);
  return{
    closed_matches:closed.length,closed_picks:picks.length,wins,hit_rate:picks.length?wins/picks.length:null,profit_units:profit,roi:picks.length?profit/picks.length:null,
    brier:closed.length?closed.reduce((s,x)=>s+(num(x.brier)||0),0)/closed.length:null,
    log_loss:closed.length?closed.reduce((s,x)=>s+(num(x.log_loss)||0),0)/closed.length:null,
    avg_clv:clvs.length?clvs.reduce((a,b)=>a+b,0)/clvs.length:null,clv_sample:clvs.length
  };
}

async function main(){
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

  const calibration=fitCalibration(state.history,state.learning?.calibration);
  const drift=driftStatus(state.history);
  state.learning={calibration,drift};

  let eventsRaw=await api("/events",{sport:"tennis"});
  const events=(Array.isArray(eventsRaw)?eventsRaw:(eventsRaw?.data||eventsRaw?.events||[])).filter(isSinglesEvent);
  state.radar=events.filter(e=>e.status==="pending"&&hoursUntil(e.date)>0&&hoursUntil(e.date)<=RADAR_DAYS*24).slice(0,300).map(e=>({event_id:String(e.id),start_at:e.date,player_a:e.home,player_b:e.away,tournament:e.league?.name||"—"}));

  const candidates=events.filter(e=>e.status==="pending"&&hoursUntil(e.date)>=LOCK_MIN_HOURS&&hoursUntil(e.date)<=LOCK_MAX_HOURS);
  const existing=new Map((state.upcoming||[]).map(x=>[x.event_id,x]));
  const newEvents=candidates.filter(e=>!existing.has(String(e.id)));
  const oddsMap=await multiOdds(newEvents.map(e=>String(e.id)),bookmakers);
  const quant=await loadQuantHistory();

  for(const e of newEvents){
    const raw=oddsMap.get(String(e.id)),mkt=marketFromOdds(raw);if(!mkt)continue;
    const p=buildPrediction(e,mkt,quant,calibration,drift);if(!p)continue;
    state.upcoming.push(p);
  }
  state.upcoming=(state.upcoming||[]).filter(p=>new Date(p.start_at)>new Date(NOW.getTime()-24*3600000)).sort((a,b)=>String(a.start_at).localeCompare(String(b.start_at))).slice(0,350);
  state.stats=stats(state.history);
  state.meta={
    updated_at:NOW.toISOString(),status:state.usage.calls>=DAILY_CAP?"BUDGET HOLD":"READY",source:"Odds-API.io Free + Jeff Sackmann",model_version:MODEL_VERSION,
    bookmakers,locked_predictions:state.upcoming.length,radar_events:state.radar.length,calibration_sample:calibration.sample||0,calibration_active:!!calibration.active,
    model_health:drift.health,api_usage_today:state.usage.calls,api_daily_guard:DAILY_CAP,run_calls:runCalls,
    history_matches_loaded:quant.atp.rows.length+quant.wta.rows.length,
    note:"Zero-cost mode. API guard stops before free-tier daily limit. Predictions are immutable after first lock."
  };
  await saveState(state);
  console.log(JSON.stringify({meta:state.meta,stats:state.stats},null,2));
}

try{await main()}
catch(e){
  console.error(e);
  state.meta={...(state.meta||{}),updated_at:NOW.toISOString(),status:/BUDGET|RATE_LIMIT/.test(e.message)?"BUDGET HOLD":"DEGRADED",source:"Odds-API.io Free + Jeff Sackmann",model_version:MODEL_VERSION,error:e.message,api_usage_today:state.usage.calls,api_daily_guard:DAILY_CAP,run_calls:runCalls};
  await saveState(state);
  process.exitCode=0; // preserve last good board; do not destroy the autonomous loop
}
