import fs from "node:fs";

const event=process.env.GH_EVENT_NAME||process.env.GITHUB_EVENT_NAME||"local";
const schedule=process.env.GH_EVENT_SCHEDULE||"";
const now=Date.now();

function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return null}}
function ageMinutes(value){const t=new Date(value||0).getTime();return Number.isFinite(t)&&t>0?(now-t)/60000:Infinity}
function dataAge(doc){return ageMinutes(doc?.meta?.data_refreshed_at||doc?.meta?.updated_at)}
function output(key,value){if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`)}
function eventStartMs(x){const t=new Date(x?.start_at||x?.startAt||x?.date||0).getTime();return Number.isFinite(t)&&t>0?t:null}

const quant=read("data/quant-board.json");
const live=read("data/live-board.json");
const manual=event==="workflow_dispatch";
const pushOnly=event==="push";
const quantAge=dataAge(quant),liveAge=dataAge(live);
const quantVersion=String(quant?.meta?.model_version||"");
const liveVersion=String(live?.meta?.model_version||"");

// Provider quota guard. A green workflow is not allowed to hammer a provider
// that already told us to stop. When quant-engine exposes the reset instant,
// every API-backed branch waits for that instant before retrying.
const resetAt=new Date(quant?.meta?.rate_limit_reset_at||0).getTime();
const quant429=String(quant?.meta?.error||"").includes("429")||String(quant?.meta?.status||"").includes("API PAUSA")||String(quant?.meta?.status||"").includes("API_PAUSA");
const resetPending=Number.isFinite(resetAt)&&resetAt>now;
const apiPaused=quant429&&resetPending;

// Independent live backoff: live-engine preserves the last valid board on 429
// and stamps updated_at. Do not retry the same failing live endpoint every
// scheduled quarter-hour; allow one guarded retry after a 60 minute cooldown.
const live429=String(live?.meta?.error||"").includes("429");
const live429Backoff=live429&&ageMinutes(live?.meta?.updated_at)<60;

// Live calls are useful only around matches represented by our prediction
// universe. This prevents spending the free quota on unrelated UTR/ITF live
// events that cannot be linked to a Tennis Edge prediction.
const candidateArrays=[quant?.upcoming,quant?.locked,quant?.predictions,quant?.radar].filter(Array.isArray);
const candidates=candidateArrays.flat();
const relevantWindow=candidates.some(x=>{
  const t=eventStartMs(x);if(!t)return false;
  const delta=(t-now)/60000;
  return delta>=-300&&delta<=90;
});
const previousLinked=Number(live?.meta?.linked_predictions||0)>0&&Array.isArray(live?.events)&&live.events.some(x=>String(x?.status||"").toLowerCase()==="live");
const liveRelevant=relevantWindow||previousLinked;

const quantDue=quantAge>=50||!quantVersion.includes("12.5");
const liveDue=liveAge>=12||!liveVersion.includes("12.5");

// Code pushes are validation-only. They never spend the shared odds quota.
// Scheduled runs (or an explicit manual dispatch) remain responsible for data refreshes.
const runQuant=!pushOnly&&!apiPaused&&(manual||quantDue);
const runLive=!pushOnly&&!apiPaused&&!live429Backoff&&liveRelevant&&(manual||liveDue);

const quantReason=pushOnly
  ?"push-tests-only"
  :apiPaused
    ?`api-backoff-until-${new Date(resetAt).toISOString()}`
    :manual?"manual"
    :!quantVersion.includes("12.5")?"upgrade"
    :!Number.isFinite(quantAge)?"missing"
    :`age-${quantAge.toFixed(1)}m`;

const liveReason=pushOnly
  ?"push-tests-only"
  :apiPaused
    ?`api-backoff-until-${new Date(resetAt).toISOString()}`
    :live429Backoff?"live-429-cooldown"
    :!liveRelevant?"no-linked-live-window"
    :manual?"manual"
    :!liveVersion.includes("12.5")?"upgrade"
    :!Number.isFinite(liveAge)?"missing"
    :`age-${liveAge.toFixed(1)}m`;

for(const [key,value] of Object.entries({
  run_quant:runQuant,
  run_live:runLive,
  quant_reason:quantReason,
  live_reason:liveReason,
  api_paused:apiPaused,
  live_relevant:liveRelevant,
  push_tests_only:pushOnly
}))output(key,String(value));

console.log(JSON.stringify({
  ok:true,
  event,
  schedule:schedule||null,
  run_quant:runQuant,
  run_live:runLive,
  quant_reason:quantReason,
  live_reason:liveReason,
  api_paused:apiPaused,
  rate_limit_reset_at:resetPending?new Date(resetAt).toISOString():null,
  live_relevant:liveRelevant,
  live_429_backoff:live429Backoff,
  push_tests_only:pushOnly,
  quant_age_min:Number.isFinite(quantAge)?+quantAge.toFixed(1):null,
  live_age_min:Number.isFinite(liveAge)?+liveAge.toFixed(1):null
}));
