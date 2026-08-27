import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

const BOARD="data/quant-board.json";
const LEDGER="data/forward-ledger.json";
const SCHEMA="TEP-FORWARD-LEDGER-1";
const NOW=new Date();

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const hash=v=>crypto.createHash("sha256").update(JSON.stringify(v)).digest("hex");
async function readJson(file){try{return JSON.parse(await fs.readFile(file,"utf8"))}catch{return null}}
async function atomicJson(file,value){await fs.mkdir(path.dirname(file),{recursive:true});const tmp=`${file}.tmp-${process.pid}`;await fs.writeFile(tmp,JSON.stringify(value,null,2)+"\n","utf8");await fs.rename(tmp,file)}

function immutableForecast(p){
  return {
    event_id:String(p.event_id),
    model_version:p.model_version||null,
    prediction_audit_id:p.audit_id||null,
    predicted_at:p.predicted_at||null,
    start_at:p.start_at||null,
    player_a:p.player_a||null,
    player_b:p.player_b||null,
    tournament:p.tournament||null,
    surface:p.surface||null,
    tour:p.tour||null,
    verdict:p.verdict||"NO BET",
    p_a:num(p.p_a),
    p_b:num(p.p_b),
    raw_p_a:num(p.raw_p_a),
    shadow_p_a:num(p.shadow_p_a),
    confidence:num(p.confidence),
    data_quality:num(p.data_quality),
    uncertainty:num(p.uncertainty),
    candidate_side:p.candidate_side||null,
    candidate_name:p.candidate_name||null,
    candidate_prob:num(p.candidate_prob),
    candidate_odds:num(p.candidate_odds),
    candidate_book:p.candidate_book||null,
    candidate_ev:num(p.candidate_ev),
    candidate_edge:num(p.candidate_edge),
    robust_prob:num(p.robust_prob),
    robust_ev:num(p.robust_ev),
    robust_edge:num(p.robust_edge),
    market_consensus_a:num(p.market_consensus_a),
    market_depth:num(p.market_depth),
    pick_side:p.pick_side||null,
    pick_name:p.pick_name||null,
    pick_prob:num(p.pick_prob),
    pick_odds:num(p.pick_odds),
    pick_book:p.pick_book||null,
    pick_ev:num(p.pick_ev),
    pick_edge:num(p.pick_edge),
    calibration_scope:p.calibration_scope||null,
    calibration_sample:num(p.calibration_sample),
    model_health:p.model_health||null,
    reason_codes:Array.isArray(p.reason_codes)?[...p.reason_codes]:[],
    no_bet_reasons:Array.isArray(p.no_bet_reasons)?[...p.no_bet_reasons]:[],
    warnings:Array.isArray(p.warnings)?[...p.warnings]:[]
  };
}

function makeRecord(p,observedAt){
  const immutable=immutableForecast(p);
  const ledgerId=hash([immutable.event_id,immutable.model_version,immutable.predicted_at]).slice(0,20).toUpperCase();
  return {
    ledger_id:ledgerId,
    first_observed_at:observedAt,
    capture_method:"FIRST_OBSERVED_PREMATCH",
    immutable,
    immutable_sha256:hash(immutable),
    lifecycle:{status:"OPEN",actual_side:null,actual_winner:null,settled_at:null,pick_won:null,profit_units:null,brier:null,log_loss:null,shadow_brier:null,clv:null,closing_odds:null}
  };
}

function settleRecord(r,h){
  if(!h||r.lifecycle?.status==="SETTLED")return r;
  const side=h.actual_side;
  if(side!=="A"&&side!=="B")return r;
  const y=side==="A"?1:0,p=clamp(num(r.immutable.p_a)??.5,.001,.999),sp=num(r.immutable.shadow_p_a);
  const pick=r.immutable.pick_side;
  const won=pick?pick===side:null;
  const odds=num(r.immutable.pick_odds);
  const profit=pick&&odds>1?(won?odds-1:-1):0;
  return {...r,lifecycle:{
    status:"SETTLED",
    actual_side:side,
    actual_winner:h.actual_winner|| (side==="A"?r.immutable.player_a:r.immutable.player_b),
    settled_at:h.settled_at||NOW.toISOString(),
    pick_won:won,
    profit_units:profit,
    brier:(p-y)**2,
    log_loss:-(y*Math.log(p)+(1-y)*Math.log(1-p)),
    shadow_brier:Number.isFinite(sp)?(sp-y)**2:null,
    clv:num(h.clv),
    closing_odds:num(h.closing_odds)
  }};
}

function stats(records){
  const settled=records.filter(r=>r.lifecycle.status==="SETTLED");
  const picks=settled.filter(r=>r.immutable.pick_side&&["VALUE","STRONG VALUE"].includes(r.immutable.verdict));
  const wins=picks.filter(r=>r.lifecycle.pick_won===true).length;
  const profit=picks.reduce((s,r)=>s+(num(r.lifecycle.profit_units)||0),0);
  const b=settled.map(r=>num(r.lifecycle.brier)).filter(Number.isFinite);
  const ll=settled.map(r=>num(r.lifecycle.log_loss)).filter(Number.isFinite);
  const clv=picks.map(r=>num(r.lifecycle.clv)).filter(Number.isFinite);
  const n=records.length;
  const next=n<100?100:n<250?250:n<500?500:1000;
  return {
    total_forecasts:n,
    open_forecasts:records.filter(r=>r.lifecycle.status==="OPEN").length,
    settled_forecasts:settled.length,
    no_bet_forecasts:records.filter(r=>r.immutable.verdict==="NO BET").length,
    watch_forecasts:records.filter(r=>r.immutable.verdict==="WATCH").length,
    qualified_forecasts:records.filter(r=>["VALUE","STRONG VALUE"].includes(r.immutable.verdict)).length,
    settled_picks:picks.length,
    wins,
    hit_rate:picks.length?wins/picks.length:null,
    profit_units:profit,
    roi:picks.length?profit/picks.length:null,
    brier:b.length?b.reduce((a,x)=>a+x,0)/b.length:null,
    log_loss:ll.length?ll.reduce((a,x)=>a+x,0)/ll.length:null,
    avg_clv:clv.length?clv.reduce((a,x)=>a+x,0)/clv.length:null,
    clv_sample:clv.length,
    next_audit_target:next,
    forecasts_to_next_audit:Math.max(0,next-n)
  };
}

function validate(ledger){
  if(ledger?.schema!==SCHEMA)throw new Error("LEDGER_SCHEMA");
  if(!Array.isArray(ledger.records))throw new Error("LEDGER_RECORDS");
  const ids=new Set();
  for(const r of ledger.records){
    if(!r?.ledger_id||ids.has(r.ledger_id))throw new Error("LEDGER_DUPLICATE_ID");ids.add(r.ledger_id);
    if(r.immutable_sha256!==hash(r.immutable))throw new Error(`LEDGER_IMMUTABILITY:${r.ledger_id}`);
    const p=num(r.immutable?.p_a),q=num(r.immutable?.p_b);
    if(!(p>0&&p<1&&q>0&&q<1&&Math.abs(p+q-1)<.01))throw new Error(`LEDGER_PROBABILITY:${r.ledger_id}`);
    const pred=new Date(r.immutable.predicted_at).getTime(),start=new Date(r.immutable.start_at).getTime(),seen=new Date(r.first_observed_at).getTime();
    if(!Number.isFinite(pred)||!Number.isFinite(start)||!Number.isFinite(seen)||pred>=start||seen>=start)throw new Error(`LEDGER_PREMATCH:${r.ledger_id}`);
    if(!["OPEN","SETTLED"].includes(r.lifecycle?.status))throw new Error(`LEDGER_STATUS:${r.ledger_id}`);
  }
  return true;
}

function selfTest(){
  const p={event_id:"1",model_version:"TEST",audit_id:"A",predicted_at:"2026-01-01T10:00:00Z",start_at:"2026-01-01T12:00:00Z",player_a:"A",player_b:"B",p_a:.61,p_b:.39,shadow_p_a:.59,verdict:"NO BET",candidate_side:"A",candidate_prob:.61,candidate_odds:1.7,locked:true};
  const r=makeRecord(p,"2026-01-01T10:01:00Z"),s=settleRecord(r,{actual_side:"A",actual_winner:"A",settled_at:"2026-01-01T14:00:00Z"});
  const ledger={schema:SCHEMA,records:[s]};validate(ledger);
  if(!(s.lifecycle.brier>0&&s.lifecycle.brier<.2)||s.immutable_sha256!==r.immutable_sha256)throw new Error("LEDGER_SELF_TEST");
  console.log(JSON.stringify({ok:true,schema:SCHEMA,tests:["prematch_lock","immutable_hash","settlement","no_bet_tracking"]}));
}

if(process.argv.includes("--self-test")){selfTest();process.exit(0)}

const board=await readJson(BOARD);if(!board)throw new Error("QUANT_BOARD_MISSING");
let ledger=await readJson(LEDGER)||{schema:SCHEMA,created_at:NOW.toISOString(),updated_at:NOW.toISOString(),policy:{forward_only:true,retroactive_backfill:false,prediction_fields_immutable:true,no_bet_included:true,note:"Only forecasts first observed before match start are admitted. Historical closed matches from before ledger activation are never backfilled."},stats:{},records:[]};
if(ledger.schema!==SCHEMA)throw new Error("LEDGER_SCHEMA_MISMATCH");

const existing=new Set(ledger.records.map(r=>r.ledger_id));
let added=0,settledNow=0;
for(const p of board.upcoming||[]){
  const start=new Date(p.start_at).getTime(),pred=new Date(p.predicted_at).getTime();
  if(p.locked!==true||!Number.isFinite(start)||!Number.isFinite(pred)||pred>=start||NOW.getTime()>=start||!Number.isFinite(num(p.p_a)))continue;
  const r=makeRecord(p,NOW.toISOString());
  if(existing.has(r.ledger_id))continue;
  ledger.records.push(r);existing.add(r.ledger_id);added++;
}
const historyById=new Map((board.history||[]).filter(h=>h.status==="SETTLED").map(h=>[String(h.event_id),h]));
ledger.records=ledger.records.map(r=>{if(r.lifecycle.status==="SETTLED")return r;const next=settleRecord(r,historyById.get(String(r.immutable.event_id)));if(next!==r&&next.lifecycle.status==="SETTLED")settledNow++;return next});
ledger.updated_at=NOW.toISOString();
ledger.stats=stats(ledger.records);
validate(ledger);

if(process.argv.includes("--validate")){
  console.log(JSON.stringify({ok:true,schema:ledger.schema,stats:ledger.stats}));
}else{
  await atomicJson(LEDGER,ledger);
  console.log(JSON.stringify({ok:true,schema:ledger.schema,added,settled_now:settledNow,stats:ledger.stats}));
}
