import fs from "node:fs/promises";
import path from "node:path";

const checkedAt=new Date().toISOString();
const event=process.env.GH_EVENT_NAME||process.env.GITHUB_EVENT_NAME||"local";
const runId=process.env.GH_RUN_ID||process.env.GITHUB_RUN_ID||null;
let previous={};
try{previous=JSON.parse(await fs.readFile("data/automation-health.json","utf8"))}catch{}
const isSchedule=event==="schedule";
const lastSchedulerAt=isSchedule?checkedAt:(previous.last_scheduler_at||null);
const lastSchedulerRunId=isSchedule?runId:(previous.last_scheduler_run_id||null);
const schedulerAge=lastSchedulerAt?(Date.now()-new Date(lastSchedulerAt).getTime())/60000:Infinity;
const automation={
  checked_at:checkedAt,
  timezone:"Europe/Rome",
  event,
  schedule:process.env.GH_EVENT_SCHEDULE||null,
  run_id:runId,
  run_attempt:Number(process.env.GH_RUN_ATTEMPT||process.env.GITHUB_RUN_ATTEMPT||1),
  run_quant:process.env.RUN_QUANT==="true",
  run_live:process.env.RUN_LIVE==="true",
  quant_reason:process.env.QUANT_REASON||null,
  live_reason:process.env.LIVE_REASON||null,
  workflow_version:"TEP-12.5-STABLE-AUTOPILOT",
  last_scheduler_at:lastSchedulerAt,
  last_scheduler_run_id:lastSchedulerRunId,
  scheduler_verified:Number.isFinite(schedulerAge)&&schedulerAge<55
};

async function atomicJson(file,value,{pretty=true}={}){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp,JSON.stringify(value,null,pretty?2:0)+"\n","utf8");
  await fs.rename(tmp,file);
}
for(const file of ["data/quant-state.json","data/quant-board.json"]){
  try{
    const doc=JSON.parse(await fs.readFile(file,"utf8"));
    doc.meta=doc.meta||{};
    doc.meta.automation=automation;
    await atomicJson(file,doc,{pretty:file!=="data/quant-board.json"});
  }catch(e){if(e?.code!=="ENOENT")throw e}
}
await atomicJson("data/automation-health.json",{ok:true,...automation});
console.log(JSON.stringify({ok:true,automation}));
