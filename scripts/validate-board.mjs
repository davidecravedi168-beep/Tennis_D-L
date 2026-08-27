import fs from "node:fs";

const mode=process.argv[2]||"all";
const finite=v=>v!==null&&v!==""&&Number.isFinite(Number(v));
const validDate=v=>Number.isFinite(new Date(v||0).getTime());
const fail=message=>{throw new Error(message)};

function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch(e){fail(`${file}: ${e.message}`)}}
function validatePercent(v,label){if(v!=null&&(!finite(v)||Number(v)<0||Number(v)>1))fail(`${label}: invalid percentage`)}

function validateQuant(){
  const q=read("data/quant-board.json");
  if(!q.meta||!String(q.meta.model_version||"").includes("12.5"))fail("quant: V12.5 model not active");
  if(!validDate(q.meta.updated_at))fail("quant: updated_at invalid");
  for(const key of ["upcoming","radar","history"])if(!Array.isArray(q[key]))fail(`quant: ${key} invalid`);
  const ids=new Set();
  for(const p of q.upcoming){
    const id=String(p?.event_id||"");
    if(!id||ids.has(id))fail(`quant: event id missing/duplicate ${id}`);
    ids.add(id);
    if(!p.player_a||!p.player_b||!validDate(p.start_at))fail(`quant: match contract invalid ${id}`);
    if(p.locked&&!p.audit_id)fail(`quant: audit id missing ${id}`);
    const intel=p.player_intel;
    if(String(p.model_version||"").includes("12.5")&&(!intel?.a||!intel?.b))fail(`quant: V12.5 player intel missing ${id}`);
    for(const side of [intel?.a,intel?.b].filter(Boolean)){
      if(!side.service||!side.return||!Array.isArray(side.recent_matches))fail(`quant: player intel contract invalid ${id}`);
      for(const [k,v] of Object.entries({...side.service,...side.return}))if(k.includes("pct")||k.includes("won")||k.includes("saved")||k.includes("converted"))validatePercent(v,`quant:${id}:${k}`);
    }
    const rows=p.market_live?.rows?.length?p.market_live.rows:(p.market_lab?.priced||[]);
    for(const row of rows){
      const prob=Number(row.robust_prob??row.model_prob??row.pick_prob),odds=Number(row.current_odds??row.best_odds??row.pick_odds),ev=Number(row.current_robust_ev??row.robust_ev??row.current_ev??row.pick_ev);
      const value=["VALUE","STRONG VALUE"].includes(String(row.verdict||"").toUpperCase());
      if(value&&(!(prob>0&&prob<1)||!(odds>1)||!Number.isFinite(ev)))fail(`quant: VALUE contract invalid ${id}`);
    }
  }
  console.log(JSON.stringify({ok:true,type:"quant",model:q.meta.model_version,status:q.meta.status,upcoming:q.upcoming.length,radar:q.radar.length,history:q.history.length,data_refreshed_at:q.meta.data_refreshed_at||null}));
}

function validateLive(){
  const q=read("data/live-board.json");
  if(!q.meta||!String(q.meta.model_version||"").includes("12.5")||!validDate(q.meta.updated_at)||!Array.isArray(q.events))fail("live: board contract invalid");
  for(const e of q.events){if(!e.event_id||!e.player_a||!e.player_b)fail(`live: event invalid ${e.event_id||"?"}`)}
  console.log(JSON.stringify({ok:true,type:"live",model:q.meta.model_version,status:q.meta.status,events:q.events.length,data_refreshed_at:q.meta.data_refreshed_at||null}));
}

if(mode==="quant"||mode==="all")validateQuant();
if(mode==="live"||mode==="all")validateLive();
