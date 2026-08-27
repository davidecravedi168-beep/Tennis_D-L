import fs from "node:fs/promises";
import crypto from "node:crypto";
import {execFileSync} from "node:child_process";

const BOARD_PATH="data/quant-board.json";
const FORWARD_PATH="data/forward-ledger.json";
const OUT_PATH="data/legacy-forward-audit.json";
const SCHEMA="TEP-LEGACY-VERIFIED-1";
const MAX_COMMITS=400;
const NOW=new Date();
const REPO=process.env.GITHUB_REPOSITORY||"davidecravedi168-beep/Tennis_D-L";

const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const hash=v=>crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function readJson(file){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return null}}
async function atomicJson(file,value){const tmp=`${file}.tmp-${process.pid}`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+"\n","utf8");await fs.rename(tmp,file)}
function git(args,{allowFail=false}={}){try{return execFileSync("git",args,{encoding:"utf8",maxBuffer:64*1024*1024}).trim()}catch(e){if(allowFail)return"";throw e}}
function validProb(p){return Number.isFinite(p)&&p>0&&p<1}
function isoMs(v){const t=new Date(v||0).getTime();return Number.isFinite(t)?t:null}
function normalizeProbabilities(x,type){
  let pA=num(x?.p_a),pB=num(x?.p_b);
  if(validProb(pA)&&validProb(pB)&&Math.abs(pA+pB-1)<.02)return{p_a:pA,p_b:pB};
  pA=num(x?.model_p_a);pB=num(x?.model_p_b);
  if(validProb(pA)&&validProb(pB)&&Math.abs(pA+pB-1)<.02)return{p_a:pA,p_b:pB};
  const fav=num(x?.favorite_prob),side=x?.favorite_side;
  if(type==="RADAR"&&validProb(fav)&&(side==="A"||side==="B"))return side==="A"?{p_a:fav,p_b:1-fav}:{p_a:1-fav,p_b:fav};
  return null;
}
function immutableForecast(x,type){
  const probs=normalizeProbabilities(x,type);if(!probs)return null;
  const predictedSide=probs.p_a>=.5?"A":"B";
  const candidateSide=x?.candidate_side||x?.favorite_side||predictedSide;
  const verdict=type==="MARKET_LOCK"?(x?.verdict||"NO BET"):(x?.pre_status||"RADAR");
  return{
    event_id:String(x.event_id),capture_type:type,model_version:x.model_version||null,prediction_audit_id:x.audit_id||x.preview_id||null,
    predicted_at:x.predicted_at||null,start_at:x.start_at||null,player_a:x.player_a||null,player_b:x.player_b||null,tournament:x.tournament||null,surface:x.surface||null,tour:x.tour||null,
    verdict,p_a:probs.p_a,p_b:probs.p_b,predicted_side:predictedSide,predicted_name:predictedSide==="A"?x.player_a:x.player_b,
    confidence:num(x.confidence),data_quality:num(x.data_quality),uncertainty:num(x.uncertainty),raw_p_a:num(x.raw_p_a),shadow_p_a:num(x.shadow_p_a),
    candidate_side:candidateSide,candidate_name:x.candidate_name||x.favorite_name||null,candidate_prob:num(x.candidate_prob??x.favorite_prob),candidate_odds:num(x.candidate_odds),candidate_book:x.candidate_book||null,candidate_ev:num(x.candidate_ev),candidate_edge:num(x.candidate_edge),
    robust_prob:num(x.robust_prob),robust_ev:num(x.robust_ev),robust_edge:num(x.robust_edge),market_consensus_a:num(x.market_consensus_a),market_depth:num(x.market_depth),
    pick_side:x.pick_side||null,pick_name:x.pick_name||null,pick_prob:num(x.pick_prob),pick_odds:num(x.pick_odds),pick_book:x.pick_book||null,pick_ev:num(x.pick_ev),pick_edge:num(x.pick_edge),
    reason_codes:Array.isArray(x.reason_codes)?x.reason_codes.slice(0,8):[],no_bet_reasons:Array.isArray(x.no_bet_reasons)?x.no_bet_reasons.slice(0,12):[],warnings:Array.isArray(x.warnings)?x.warnings.slice(0,12):[]
  };
}
function candidateRecord(x,type,commitSha,committedAt){
  const immutable=immutableForecast(x,type);if(!immutable)return null;
  const start=isoMs(immutable.start_at),proof=isoMs(committedAt);if(start==null||proof==null||proof>=start)return null;
  const id=hash([immutable.event_id,type,commitSha]).slice(0,20).toUpperCase();
  return{legacy_id:id,evidence:{prediction_commit:commitSha,prediction_committed_at:committedAt,prediction_path:BOARD_PATH,prediction_url:`https://github.com/${REPO}/blob/${commitSha}/${BOARD_PATH}`},immutable,immutable_sha256:hash(immutable),result:null};
}
function resultFromHistory(h,commitSha,committedAt){
  const side=h?.actual_side;if(side!=="A"&&side!=="B")return null;
  return{actual_side:side,actual_winner:h.actual_winner||null,settled_at:h.settled_at||committedAt,result_commit:commitSha,result_committed_at:committedAt,result_url:`https://github.com/${REPO}/blob/${commitSha}/${BOARD_PATH}`,closing_odds:num(h.closing_odds),clv:num(h.clv)};
}
function metrics(records){
  const settled=records.filter(r=>r.result?.actual_side==="A"||r.result?.actual_side==="B");
  const wins=settled.filter(r=>r.immutable.predicted_side===r.result.actual_side).length;
  const brier=settled.map(r=>{const y=r.result.actual_side==="A"?1:0;return(r.immutable.p_a-y)**2});
  const logloss=settled.map(r=>{const y=r.result.actual_side==="A"?1:0,p=clamp(r.immutable.p_a,.001,.999);return-(y*Math.log(p)+(1-y)*Math.log(1-p))});
  const market=records.filter(r=>r.immutable.capture_type==="MARKET_LOCK");
  const settledMarket=market.filter(r=>r.result?.actual_side==="A"||r.result?.actual_side==="B");
  const picks=settledMarket.filter(r=>r.immutable.pick_side&&["VALUE","STRONG VALUE"].includes(r.immutable.verdict)&&num(r.immutable.pick_odds)>1);
  const pickWins=picks.filter(r=>r.immutable.pick_side===r.result.actual_side).length;
  const profit=picks.reduce((s,r)=>s+(r.immutable.pick_side===r.result.actual_side?r.immutable.pick_odds-1:-1),0);
  const clv=picks.map(r=>num(r.result.clv)).filter(Number.isFinite);
  const byModel={};for(const r of settled){const k=r.immutable.model_version||"UNKNOWN",z=byModel[k]||(byModel[k]={settled:0,wins:0,brier_sum:0});const y=r.result.actual_side==="A"?1:0;z.settled++;if(r.immutable.predicted_side===r.result.actual_side)z.wins++;z.brier_sum+=(r.immutable.p_a-y)**2}
  for(const z of Object.values(byModel)){z.accuracy=z.settled?z.wins/z.settled:null;z.brier=z.settled?z.brier_sum/z.settled:null;delete z.brier_sum}
  return{verified_forecasts:records.length,settled_verified:settled.length,unresolved_verified:records.length-settled.length,accuracy:settled.length?wins/settled.length:null,brier:brier.length?brier.reduce((a,b)=>a+b,0)/brier.length:null,log_loss:logloss.length?logloss.reduce((a,b)=>a+b,0)/logloss.length:null,verified_market_locks:market.length,settled_market_locks:settledMarket.length,qualified_picks:picks.length,pick_wins:pickWins,pick_hit_rate:picks.length?pickWins/picks.length:null,profit_units:profit,roi:picks.length?profit/picks.length:null,avg_clv:clv.length?clv.reduce((a,b)=>a+b,0)/clv.length:null,clv_sample:clv.length,by_model:byModel};
}
function validate(doc){
  if(doc?.schema!==SCHEMA||!Array.isArray(doc.records))throw new Error("LEGACY_SCHEMA");
  const ids=new Set(),events=new Set();
  for(const r of doc.records){if(!r.legacy_id||ids.has(r.legacy_id))throw new Error("LEGACY_DUPLICATE_ID");ids.add(r.legacy_id);if(events.has(r.immutable.event_id))throw new Error(`LEGACY_DUPLICATE_EVENT:${r.immutable.event_id}`);events.add(r.immutable.event_id);if(r.immutable_sha256!==hash(r.immutable))throw new Error(`LEGACY_IMMUTABILITY:${r.legacy_id}`);const proof=isoMs(r.evidence.prediction_committed_at),start=isoMs(r.immutable.start_at);if(proof==null||start==null||proof>=start)throw new Error(`LEGACY_NOT_PREMATCH:${r.legacy_id}`);if(!validProb(r.immutable.p_a)||!validProb(r.immutable.p_b)||Math.abs(r.immutable.p_a+r.immutable.p_b-1)>.02)throw new Error(`LEGACY_PROBABILITY:${r.legacy_id}`);if(r.result){const rt=isoMs(r.result.result_committed_at);if(rt==null||rt<start)throw new Error(`LEGACY_RESULT_TIME:${r.legacy_id}`)}}
  return true;
}
function selfTest(){
  const row={event_id:"1",start_at:"2026-01-01T12:00:00Z",player_a:"A",player_b:"B",model_version:"TEST",p_a:.61,p_b:.39,verdict:"NO BET"};
  const r=candidateRecord(row,"MARKET_LOCK","abc","2026-01-01T10:00:00Z");if(!r||r.immutable.predicted_side!=="A")throw new Error("LEGACY_SELFTEST_CAPTURE");r.result={actual_side:"A",actual_winner:"A",settled_at:"2026-01-01T14:00:00Z",result_commit:"def",result_committed_at:"2026-01-01T14:01:00Z",result_url:"x",closing_odds:null,clv:null};const doc={schema:SCHEMA,records:[r]};validate(doc);const s=metrics(doc.records);if(s.settled_verified!==1||s.accuracy!==1)throw new Error("LEGACY_SELFTEST_METRICS");console.log(JSON.stringify({ok:true,schema:SCHEMA,tests:["git_prematch_proof","immutable_hash","result_proof","metrics"]}));
}
if(process.argv.includes("--self-test")){selfTest();process.exit(0)}

const forward=await readJson(FORWARD_PATH);const cutoff=forward?.created_at;if(!cutoff)throw new Error("FORWARD_LEDGER_CUTOFF_MISSING");const cutoffMs=isoMs(cutoff);if(cutoffMs==null)throw new Error("FORWARD_LEDGER_CUTOFF_INVALID");
const log=git(["log","--reverse",`--max-count=${MAX_COMMITS}`,"--format=%H\t%cI","--",BOARD_PATH],{allowFail:true});
const commits=log?log.split("\n").map(line=>{const [sha,at]=line.split("\t");return{sha,at}}).filter(x=>x.sha&&x.at):[];
const forecasts=new Map(),results=new Map();let snapshots=0,parseErrors=0;
for(const c of commits){
  const committedMs=isoMs(c.at);if(committedMs==null)continue;
  const raw=git(["show",`${c.sha}:${BOARD_PATH}`],{allowFail:true});if(!raw)continue;
  let board;try{board=JSON.parse(raw)}catch{parseErrors++;continue}snapshots++;
  for(const h of board.history||[]){if(h?.status!=="SETTLED")continue;const id=String(h.event_id||"");if(!id||results.has(id))continue;const r=resultFromHistory(h,c.sha,c.at);if(r)results.set(id,r)}
  if(committedMs>=cutoffMs)continue;
  const marketById=new Map((board.upcoming||[]).map(x=>[String(x.event_id),x]));
  const radarById=new Map((board.radar||[]).map(x=>[String(x.event_id),x]));
  const ids=new Set([...marketById.keys(),...radarById.keys()]);
  for(const id of ids){if(forecasts.has(id))continue;const market=marketById.get(id),radar=radarById.get(id);let rec=null;if(market)rec=candidateRecord(market,"MARKET_LOCK",c.sha,c.at);if(!rec&&radar)rec=candidateRecord(radar,"RADAR",c.sha,c.at);if(rec)forecasts.set(id,rec)}
}
// Current board may contain settlement evidence created after the scanned history window.
const current=await readJson(BOARD_PATH);if(current){const head=git(["rev-parse","HEAD"],{allowFail:true})||"HEAD",headAt=git(["show","-s","--format=%cI",head],{allowFail:true})||NOW.toISOString();for(const h of current.history||[]){const id=String(h.event_id||"");if(!id||results.has(id)||h?.status!=="SETTLED")continue;const r=resultFromHistory(h,head,headAt);if(r)results.set(id,r)}}
let records=[...forecasts.values()].map(r=>({...r,result:results.get(r.immutable.event_id)||null}));
// Legacy means strictly before the new forward ledger activation; current forward matches are excluded by proof cutoff.
records.sort((a,b)=>String(a.immutable.start_at).localeCompare(String(b.immutable.start_at))||a.immutable.event_id.localeCompare(b.immutable.event_id));
const stats=metrics(records);
const doc={schema:SCHEMA,generated_at:NOW.toISOString(),legacy_cutoff:cutoff,policy:{git_commit_proof_required:true,prediction_must_precede_match:true,strictly_pre_forward_ledger:true,retroactive_model_backfill:false,one_canonical_forecast_per_match:true,canonical_preference:"earliest verified snapshot; market lock preferred when present in that snapshot",roi_only_with_original_locked_pick_and_odds:true,note:"This dataset is reconstructed only from repository states that demonstrably existed before each match. It is reported separately from the live forward ledger and from historical backtests."},scan:{max_commits:MAX_COMMITS,commits_found:commits.length,snapshots_parsed:snapshots,parse_errors:parseErrors},stats,records};
validate(doc);
if(process.argv.includes("--validate")){console.log(JSON.stringify({ok:true,schema:SCHEMA,legacy_cutoff:cutoff,scan:doc.scan,stats:doc.stats}));}else{await atomicJson(OUT_PATH,doc);console.log(JSON.stringify({ok:true,schema:SCHEMA,legacy_cutoff:cutoff,scan:doc.scan,stats:doc.stats}));}
