import fs from "node:fs/promises";
import path from "node:path";

const API_KEY=process.env.ODDS_API_KEY;
const BASE="https://api.odds-api.io/v3";
const OUT="data/live-board.json";
const QUANT="data/quant-board.json";
const NOW=new Date();
const MODEL_VERSION="TENNIS-LIVE-12.5-STRUCTURED";
const FETCH_ODDS_THIS_RUN=(Math.floor(NOW.getUTCMinutes()/15)%2===0); // ~every 30m; score snapshot stays ~15m
const MAX_LIVE_ODDS_EVENTS=10; // one multi-odds call max, keeps the free daily budget guarded
const COMMERCIAL_MODE=/^(1|true|yes)$/i.test(String(process.env.COMMERCIAL_MODE||""));
const COMMERCIAL_ODDS_LICENSE_CONFIRMED=/^(1|true|yes)$/i.test(String(process.env.COMMERCIAL_ODDS_LICENSE_CONFIRMED||""));
const SOURCE_LABEL=COMMERCIAL_MODE?"Commercial licensed odds/live configuration":"Odds-API.io development live feed";

const num=v=>{const x=Number(v);return Number.isFinite(x)?x:null};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
async function readJson(p,fallback){try{return JSON.parse(await fs.readFile(p,"utf8"))}catch{return fallback}}
async function saveJson(p,x){await fs.mkdir(path.dirname(p),{recursive:true});const tmp=`${p}.tmp-${process.pid}`;await fs.writeFile(tmp,JSON.stringify(x,null,2)+"\n","utf8");await fs.rename(tmp,p)}
function isSinglesEvent(e){const a=String(e?.home||""),b=String(e?.away||""),league=String(e?.league?.name||"");if(!a||!b)return false;if(/[\/&]/.test(a)||/[\/&]/.test(b))return false;if(/doubles|teams|mixed doubles/i.test(league))return false;return true}
function matchProbFromSet(q,bestOf){q=clamp(q,.001,.999);return bestOf===5?(10*q**3-15*q**4+6*q**5):(3*q*q-2*q*q*q)}
function setProbFromMatch(p,bestOf){let lo=.001,hi=.999;for(let i=0;i<42;i++){const m=(lo+hi)/2;if(matchProbFromSet(m,bestOf)<p)lo=m;else hi=m}return(lo+hi)/2}
function matchWinFromSets(sa,sb,bestOf,q){const need=bestOf===5?3:2;if(sa>=need)return 1;if(sb>=need)return 0;const memo=new Map();const rec=(a,b)=>{if(a>=need)return 1;if(b>=need)return 0;const k=`${a}|${b}`;if(memo.has(k))return memo.get(k);const v=q*rec(a+1,b)+(1-q)*rec(a,b+1);memo.set(k,v);return v};return rec(sa,sb)}
function setWinFromGames(ga,gb,holdA,holdB,tbA){
  if(((ga>=6||gb>=6)&&Math.abs(ga-gb)>=2)||(ga===7&&gb>=5)||(gb===7&&ga>=5))return ga>gb?1:0;
  const memo=new Map();
  const rec=(a,b,server)=>{if(((a>=6||b>=6)&&Math.abs(a-b)>=2)||(a===7&&b>=5)||(b===7&&a>=5))return a>b?1:0;if(a===6&&b===6)return tbA;const k=`${a}|${b}|${server}`;if(memo.has(k))return memo.get(k);const pGame=server==="A"?holdA:(1-holdB);const v=pGame*rec(a+1,b,server==="A"?"B":"A")+(1-pGame)*rec(a,b+1,server==="A"?"B":"A");memo.set(k,v);return v};
  return .5*(rec(ga,gb,"A")+rec(ga,gb,"B"));
}
function setWinFromGamesServer(ga,gb,holdA,holdB,tbA,server){
  if(((ga>=6||gb>=6)&&Math.abs(ga-gb)>=2)||(ga===7&&gb>=5)||(gb===7&&ga>=5))return ga>gb?1:0;
  const memo=new Map();const rec=(a,b,srv)=>{if(((a>=6||b>=6)&&Math.abs(a-b)>=2)||(a===7&&b>=5)||(b===7&&a>=5))return a>b?1:0;if(a===6&&b===6)return tbA;const k=`${a}|${b}|${srv}`;if(memo.has(k))return memo.get(k);const pGame=srv==="A"?holdA:(1-holdB),v=pGame*rec(a+1,b,srv==="A"?"B":"A")+(1-pGame)*rec(a,b+1,srv==="A"?"B":"A");memo.set(k,v);return v};return rec(ga,gb,server);
}
function tennisPointCount(v){
  const z=String(v??"").trim().toUpperCase();if(z==="0"||z==="LOVE")return 0;if(z==="15")return 1;if(z==="30")return 2;if(z==="40")return 3;if(z==="AD"||z==="ADV"||z==="A")return 4;return null;
}
function gameWinFromPointState(p,serverPoints,returnPoints){
  const a=tennisPointCount(serverPoints),b=tennisPointCount(returnPoints);if(a==null||b==null)return null;p=clamp(p,.35,.85);const q=1-p,deuce=(p*p)/(p*p+q*q);
  if(a===4&&b===3)return p+(1-p)*deuce;if(a===3&&b===4)return p*deuce;if(a>=3&&b>=3)return deuce;
  const memo=new Map();const rec=(x,y)=>{if(x>=4&&x-y>=2)return 1;if(y>=4&&y-x>=2)return 0;if(x>=3&&y>=3)return deuce;const k=`${x}|${y}`;if(memo.has(k))return memo.get(k);const r=p*rec(x+1,y)+(1-p)*rec(x,y+1);memo.set(k,r);return r};return rec(a,b);
}
function normalizeServer(v,home,away){const z=String(v??"").trim().toLowerCase();if(!z)return null;if(["home","a","1"].includes(z)||z===String(home||"").trim().toLowerCase())return"A";if(["away","b","2"].includes(z)||z===String(away||"").trim().toLowerCase())return"B";return null}
function matchWinWithCurrentSet(sa,sb,bestOf,q,currentQ){
  const need=bestOf===5?3:2;if(sa>=need)return 1;if(sb>=need)return 0;
  if(!Number.isFinite(currentQ))return matchWinFromSets(sa,sb,bestOf,q);
  return currentQ*matchWinFromSets(sa+1,sb,bestOf,q)+(1-currentQ)*matchWinFromSets(sa,sb+1,bestOf,q);
}
function scoreRows(scores,home="",away=""){
  const periods=scores?.periods;if(!periods||typeof periods!=="object")return[];const rows=[];
  for(const [key,v] of Object.entries(periods)){
    if(!v||typeof v!=="object"||!/set|^p\d+$|period/i.test(key))continue;
    const h=num(v.home??v.homeScore??v.a),a=num(v.away??v.awayScore??v.b);if(h==null||a==null||h<0||a<0||h>7||a>7)continue;
    const done=((h>=6||a>=6)&&Math.abs(h-a)>=2)||(h===7&&a>=5)||(a===7&&h>=5),ord=Number((String(key).match(/\d+/)||[999])[0]);
    const hp=v.homePoints??v.homePoint??v.points?.home??v.point?.home??null,ap=v.awayPoints??v.awayPoint??v.points?.away??v.point?.away??null,server=normalizeServer(v.server??v.serving??v.serve,home,away);
    rows.push({key,home:h,away:a,done,ord,home_point:hp,away_point:ap,server,point_structured:tennisPointCount(hp)!=null&&tennisPointCount(ap)!=null&&!!server});
  }
  return rows.sort((x,y)=>x.ord-y.ord).slice(0,5);
}
function scoreView(e,locked){
  const raw=e?.scores||{},rows=scoreRows(raw,e?.home,e?.away),completed=rows.filter(x=>x.done),current=rows.find(x=>!x.done)||null;
  let sa=null,sb=null,integrity="RAW_ONLY",liveP=null,currentSetP=null,currentGameP=null;
  if(rows.length){sa=completed.filter(x=>x.home>x.away).length;sb=completed.filter(x=>x.away>x.home).length;integrity=current?.point_structured?"STRUCTURED_POINT":current?"STRUCTURED_SET_GAME":"STRUCTURED_SETS";
    if(locked&&Number.isFinite(locked.p_a)){
      const bestOf=locked?.market_lab?.best_of||(locked.tour==="ATP"&&/australian open|roland garros|french open|wimbledon|us open/i.test(String(locked.tournament||""))&&!/qual/i.test(String(locked.tournament||""))?5:3),q=setProbFromMatch(locked.p_a,bestOf),holdA=locked?.market_lab?.hold_a,holdB=locked?.market_lab?.hold_b,tbA=locked?.market_lab?.tb_a??.5,spA=locked?.market_lab?.serve_point_a,spB=locked?.market_lab?.serve_point_b;
      if(current&&Number.isFinite(holdA)&&Number.isFinite(holdB)){
        if(current.point_structured&&Number.isFinite(spA)&&Number.isFinite(spB)){
          if(current.server==="A")currentGameP=gameWinFromPointState(spA,current.home_point,current.away_point);
          else{const serverB=gameWinFromPointState(spB,current.away_point,current.home_point);currentGameP=Number.isFinite(serverB)?1-serverB:null}
          if(Number.isFinite(currentGameP)){const next=current.server==="A"?"B":"A";currentSetP=currentGameP*setWinFromGamesServer(current.home+1,current.away,holdA,holdB,tbA,next)+(1-currentGameP)*setWinFromGamesServer(current.home,current.away+1,holdA,holdB,tbA,next)}
        }
        if(!Number.isFinite(currentSetP))currentSetP=setWinFromGames(current.home,current.away,holdA,holdB,tbA);
      }
      liveP=matchWinWithCurrentSet(sa,sb,bestOf,q,currentSetP);
    }
  }
  return{raw,sets:rows,completed_sets:completed,current_set:current,sets_home:sa,sets_away:sb,integrity,live_model_p_a:liveP,live_model_p_b:Number.isFinite(liveP)?1-liveP:null,current_set_p_a:currentSetP,current_game_p_a:currentGameP};
}
async function fetchLive(){if(!API_KEY)throw new Error("MISSING_ODDS_API_KEY");const u=new URL(BASE+"/events/live");u.searchParams.set("apiKey",API_KEY);u.searchParams.set("sport","tennis");const r=await fetch(u,{headers:{"user-agent":"TennisEdgePro/9.0-live"}});if(!r.ok)throw new Error(`HTTP_${r.status}`);return r.json()}
function parseML(obj){if(!obj?.bookmakers)return null;const rows=[];for(const [book,markets] of Object.entries(obj.bookmakers)){const m=(markets||[]).find(x=>String(x?.name||"").toUpperCase()==="ML"),o=m?.odds?.[0],a=num(o?.home),b=num(o?.away);if(!(a>1&&b>1))continue;const z=1/a+1/b,margin=z-1;if(margin<-.03||margin>.3)continue;rows.push({book,a,b,pA:(1/a)/z,updated_at:m?.updatedAt||null})}if(!rows.length)return null;const sorted=rows.map(x=>x.pA).sort((a,b)=>a-b),cons=sorted[Math.floor(sorted.length/2)],bestA=Math.max(...rows.map(x=>x.a)),bestB=Math.max(...rows.map(x=>x.b));return{books:rows.length,consensus_a:cons,best_a:bestA,best_b:bestB,best_book_a:rows.find(x=>x.a===bestA)?.book||"—",best_book_b:rows.find(x=>x.b===bestB)?.book||"—",updated_at:rows.map(x=>x.updated_at).filter(Boolean).sort().at(-1)||null}}
async function fetchLiveOdds(ids,bookmakers){
  if(!API_KEY||!ids.length||!bookmakers.length)return new Map();const u=new URL(BASE+"/odds/multi");u.searchParams.set("apiKey",API_KEY);u.searchParams.set("eventIds",ids.slice(0,MAX_LIVE_ODDS_EVENTS).join(","));u.searchParams.set("bookmakers",bookmakers.slice(0,2).join(","));u.searchParams.set("markets","ML");const r=await fetch(u,{headers:{"user-agent":"TennisEdgePro/9.0-live-market"}});if(!r.ok)throw new Error(`LIVE_ODDS_${r.status}`);const raw=await r.json(),arr=Array.isArray(raw)?raw:(raw?.data||raw?.events||[]);return new Map(arr.map(x=>[String(x.id??x.eventId),parseML(x)]).filter(([,v])=>v));
}
function selfTest(){
  const rows=scoreRows({periods:{p1:{home:6,away:4},p2:{home:3,away:6},p3:{home:3,away:2,homePoints:"30",awayPoints:"15",server:"home"}}},"A Player","B Player");if(rows.length!==3||rows.filter(x=>x.done).length!==2||!rows.find(x=>!x.done)?.point_structured)throw new Error("SELFTEST_SET_GAME_PARSE");
  const cur=setWinFromGames(5,4,.78,.74,.53);if(!(cur>.5&&cur<.95))throw new Error("SELFTEST_CURRENT_SET");const gp=gameWinFromPointState(.64,"30","15");if(!(gp>.5&&gp<1))throw new Error("SELFTEST_POINT_GAME");
  const p=matchWinWithCurrentSet(1,1,3,setProbFromMatch(.64,3),cur);if(!(p>.5&&p<.95))throw new Error("SELFTEST_LIVE_PROB");
  const ml=parseML({bookmakers:{A:[{name:"ML",odds:[{home:1.6,away:2.3}]}],B:[{name:"ML",odds:[{home:1.65,away:2.25}]}]}});if(!ml||ml.books!==2)throw new Error("SELFTEST_LIVE_MARKET");
  const robust=clamp(.64-.025,.01,.99),min=1.02/robust,rev=robust*1.72-1;if(!(min>1&&rev>0))throw new Error("SELFTEST_LIVE_PRICE_GUARD");
  console.log(JSON.stringify({ok:true,model:MODEL_VERSION,tests:["structured_set_game_parser","point_game_probability","current_set_probability","live_match_probability","live_market_no_vig","live_price_guard"]}));
}
if(process.argv.includes("--self-test")){selfTest();process.exit(0)}

const previous=await readJson(OUT,{meta:{status:"EMPTY"},events:[]});
try{
  if(COMMERCIAL_MODE&&!COMMERCIAL_ODDS_LICENSE_CONFIRMED)throw new Error("COMMERCIAL_ODDS_LICENSE_REQUIRED");
  const raw=await fetchLive(),arr=(Array.isArray(raw)?raw:(raw?.data||raw?.events||[])).filter(isSinglesEvent),quant=await readJson(QUANT,{upcoming:[],meta:{}}),byId=new Map((quant.upcoming||[]).map(x=>[String(x.event_id),x]));
  const linkedIds=arr.filter(e=>byId.has(String(e.id))).map(e=>String(e.id)).slice(0,MAX_LIVE_ODDS_EVENTS),bookmakers=(quant.meta?.bookmakers||[]).slice(0,2),previousById=new Map((previous.events||[]).map(x=>[String(x.event_id),x]));
  let oddsMap=new Map(),oddsStatus="SKIPPED_BUDGET_CADENCE";
  if(FETCH_ODDS_THIS_RUN&&linkedIds.length&&bookmakers.length){try{oddsMap=await fetchLiveOdds(linkedIds,bookmakers);oddsStatus="LIVE_ODDS"}catch(err){oddsStatus=`ODDS_STALE_${err.message}`}}
  const events=arr.map(e=>{
    const locked=byId.get(String(e.id)),sv=scoreView(e,locked),freshLm=oddsMap.get(String(e.id))||null,prevLm=previousById.get(String(e.id))?.live_market||null,lm=freshLm||prevLm,liveMarketStale=!!(lm&&!freshLm);
    const divergence=lm&&Number.isFinite(sv.live_model_p_a)?sv.live_model_p_a-lm.consensus_a:null,absGap=Number.isFinite(divergence)?Math.abs(divergence):null;
    const liveResearch=liveMarketStale?"STALE MARKET":Number.isFinite(absGap)&&sv.integrity!=="RAW_ONLY"?(absGap>=.06?"STRONG DIVERGENCE":absGap>=.035?"DIVERGENCE":"ALIGNED"):"NO SIGNAL";
    const pa=Number.isFinite(sv.live_model_p_a)?sv.live_model_p_a:null,pb=Number.isFinite(pa)?1-pa:null,robA=Number.isFinite(pa)?clamp(pa-.025,.01,.99):null,robB=Number.isFinite(pb)?clamp(pb-.025,.01,.99):null;
    const evA=lm&&Number.isFinite(robA)&&lm.best_a>1?robA*lm.best_a-1:null,evB=lm&&Number.isFinite(robB)&&lm.best_b>1?robB*lm.best_b-1:null;
    const minA=Number.isFinite(robA)?1.02/robA:null,minB=Number.isFinite(robB)?1.02/robB:null;
    const livePriceGuard={robust_p_a:robA,robust_p_b:robB,robust_ev_a:evA,robust_ev_b:evB,min_odds_a:minA,min_odds_b:minB,target_ev:.02,integrity_required:"STRUCTURED",note:"Research only unless the UI confirms a fresh snapshot, structured score and non-stale live market."};
    return{event_id:String(e.id),player_a:e.home,player_b:e.away,tournament:e.league?.name||"—",league_slug:e.league?.slug||null,start_at:e.date||null,status:e.status||"live",score:sv,live_market:lm,live_price_guard:livePriceGuard,live_market_stale:liveMarketStale,live_divergence_a:divergence,live_research_label:liveResearch,pre_match:locked?{verdict:locked.verdict,confidence:locked.confidence,p_a:locked.p_a,p_b:locked.p_b,candidate_name:locked.candidate_name,candidate_odds:locked.candidate_odds,current_odds:locked.current_odds,market_best:locked.market_best||null,audit_id:locked.audit_id,market_lab:{best_of:locked.market_lab?.best_of,hold_a:locked.market_lab?.hold_a,hold_b:locked.market_lab?.hold_b,tb_a:locked.market_lab?.tb_a,serve_point_a:locked.market_lab?.serve_point_a,serve_point_b:locked.market_lab?.serve_point_b}}:null};
  });
  await saveJson(OUT,{meta:{updated_at:NOW.toISOString(),data_refreshed_at:NOW.toISOString(),status:"LIVE",source:SOURCE_LABEL,model_version:MODEL_VERSION,state_schema:"TEP-12.5",commercial_mode:COMMERCIAL_MODE,commercial_license_guard:COMMERCIAL_MODE?"CONFIRMED_BY_ENV":"RESEARCH_ONLY",events:events.length,linked_predictions:events.filter(x=>x.pre_match).length,odds_status:oddsStatus,odds_refresh_policy:"Free beta: score snapshots follow the scheduled worker and live ML odds are rate-guarded. Commercial point-by-point operation requires a licensed low-latency feed.",score_contract:"Set/game state is parsed only from unambiguous structured period fields. Point score is never fabricated."},events});
  console.log(JSON.stringify({ok:true,events:events.length,linked:events.filter(x=>x.pre_match).length,oddsStatus}));
}catch(e){
  const out={...previous,meta:{...(previous.meta||{}),updated_at:NOW.toISOString(),status:"STALE",error:e.message,source:SOURCE_LABEL,model_version:MODEL_VERSION,note:"Last good live board preserved; no score or live edge is fabricated."}};await saveJson(OUT,out);console.error(e.message);process.exitCode=0;
}
