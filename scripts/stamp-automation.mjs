import fs from "node:fs/promises";
import path from "node:path";

const checkedAt=new Date().toISOString();
const automation={
  checked_at:checkedAt,
  timezone:"Europe/Rome",
  event:process.env.GH_EVENT_NAME||process.env.GITHUB_EVENT_NAME||"local",
  schedule:process.env.GH_EVENT_SCHEDULE||null,
  run_id:process.env.GH_RUN_ID||process.env.GITHUB_RUN_ID||null,
  run_attempt:Number(process.env.GH_RUN_ATTEMPT||process.env.GITHUB_RUN_ATTEMPT||1),
  run_quant:process.env.RUN_QUANT==="true",
  run_live:process.env.RUN_LIVE==="true",
  quant_reason:process.env.QUANT_REASON||null,
  live_reason:process.env.LIVE_REASON||null,
  workflow_version:"TEP-12.5-STABLE-AUTOPILOT",
  scheduler_verified:(process.env.GH_EVENT_NAME||process.env.GITHUB_EVENT_NAME)==="schedule"
};

async function atomicJson(file,value){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp,JSON.stringify(value,null,2)+"\n","utf8");
  await fs.rename(tmp,file);
}
for(const file of ["data/quant-state.json","data/quant-board.json"]){
  try{
    const doc=JSON.parse(await fs.readFile(file,"utf8"));
    doc.meta=doc.meta||{};
    doc.meta.automation=automation;
    await atomicJson(file,doc);
  }catch(e){if(e?.code!=="ENOENT")throw e}
}
await atomicJson("data/automation-health.json",{ok:true,...automation});
console.log(JSON.stringify({ok:true,automation}));
