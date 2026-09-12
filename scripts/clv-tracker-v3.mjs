import fs from 'node:fs/promises';
import path from 'node:path';
import {num} from './clv-evidence-v4.mjs';

const BOARD='data/quant-board.json';
const LEDGER='data/forward-ledger.json';
const OUT='data/clv-tracker-v3.json';
const SCHEMA='TEP-CLV-TRACKER-V3';
const MAX_OBS=96;
const stage=r=>r?.immutable?.forecast_stage||'MARKET_LOCK';
const keyFromRecord=r=>[String(r?.immutable?.event_id||''),String(r?.immutable?.model_version||''),String(r?.immutable?.predicted_at||'')].join('|');
const keyFromBoard=p=>[String(p?.event_id||''),String(p?.model_version||''),String(p?.predicted_at||'')].join('|');
const iso=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?d.toISOString():null};
async function readJson(f){try{return JSON.parse(await fs.readFile(f,'utf8'))}catch{return null}}
async function writeJson(f,v){await fs.mkdir(path.dirname(f),{recursive:true});await fs.writeFile(f,JSON.stringify(v,null,2)+'\n','utf8')}
function append(obs,snap){const a=Array.isArray(obs)?[...obs]:[],prev=a[a.length-1],prevTime=prev?.observed_at?new Date(prev.observed_at).getTime():null,nextTime=new Date(snap.observed_at).getTime();if(!Number.isFinite(nextTime)||!(snap.odds>1))return a;if(!prev||Math.abs((num(prev.odds)??-99)-snap.odds)>.0001||(!Number.isFinite(prevTime)||nextTime-prevTime>45*60000))a.push(snap);return a.slice(-MAX_OBS)}
function snapshots(p,board){
  const rows=[];
  for(const q of Array.isArray(p?.quote_tape)?p.quote_tape:[]){
    const observed_at=q?.at,odds=num(q?.odds);
    if(observed_at&&odds>1)rows.push({observed_at,odds,book:q?.book||null,source:'QUOTE_TAPE'});
  }
  const observed_at=p?.current_odds_updated_at||board?.meta?.data_refreshed_at||null,odds=num(p?.current_odds);
  if(observed_at&&odds>1)rows.push({observed_at,odds,book:p?.current_book||null,source:'CURRENT_BOARD'});
  return rows.sort((a,b)=>new Date(a.observed_at)-new Date(b.observed_at));
}
function selfTest(){const a=append([],{observed_at:'2026-01-01T10:00:00.000Z',odds:1.9,book:'A'});const b=append(a,{observed_at:'2026-01-01T10:10:00.000Z',odds:1.9,book:'A'});const c=append(b,{observed_at:'2026-01-01T10:11:00.000Z',odds:1.91,book:'A'});const ss=snapshots({quote_tape:[{at:'2026-01-01T10:00:00Z',odds:1.9,book:'A'}],current_odds:1.91,current_odds_updated_at:'2026-01-01T11:00:00Z'},{meta:{}});if(a.length!==1||b.length!==1||c.length!==2||ss.length!==2||num(null)!==null||num('')!==null)throw new Error('CLV_TRACKER_SELF_TEST');console.log(JSON.stringify({ok:true,tests:['strict_null_safe_number','dedupe','price_change_capture','quote_tape_merge']}))}
if(process.argv.includes('--self-test')){selfTest();process.exit(0)}
const board=await readJson(BOARD);const ledger=await readJson(LEDGER);if(!board||!ledger)throw new Error('CLV_TRACKER_INPUT_MISSING');let out=await readJson(OUT);if(!out||out.schema!==SCHEMA)out={schema:SCHEMA,created_at:new Date().toISOString(),updated_at:new Date().toISOString(),policy:{forward_only:true,max_observations_per_match:MAX_OBS,source:'quant-board current_odds',note:'Stores only odds actually observed before scheduled start. No synthetic or retroactive closing prices.'},records:{}};
const upcoming=new Map((board.upcoming||[]).map(p=>[keyFromBoard(p),p]));let captured=0;for(const r of ledger.records||[]){if(stage(r)!=='MARKET_LOCK'||r?.lifecycle?.status!=='OPEN')continue;const p=upcoming.get(keyFromRecord(r));if(!p)continue;const start=iso(r?.immutable?.start_at);if(!start)continue;const k=r.ledger_id||keyFromRecord(r),prev=out.records[k]||{ledger_id:r.ledger_id||null,event_id:String(r.immutable.event_id),model_version:r.immutable.model_version||null,predicted_at:r.immutable.predicted_at||null,start_at:start,candidate_side:r.immutable.candidate_side||null,entry_odds:num(r.immutable.candidate_odds),observations:[]};const before=prev.observations.length;for(const snap of snapshots(p,board)){const observed=iso(snap.observed_at);if(!observed||new Date(observed)>=new Date(start))continue;prev.observations=append(prev.observations,{observed_at:observed,odds:snap.odds,book:snap.book,source:snap.source});}if(prev.observations.length>before)captured+=prev.observations.length-before;out.records[k]=prev}
const values=Object.values(out.records);out.updated_at=new Date().toISOString();out.stats={tracked_matches:values.length,captured_this_run:captured,total_observations:values.reduce((s,r)=>s+(r.observations?.length||0),0),matches_with_prestart_observation:values.filter(r=>(r.observations||[]).length>0).length,latest_observed_at:values.flatMap(r=>r.observations||[]).map(x=>x.observed_at).filter(Boolean).sort().at(-1)||null};await writeJson(OUT,out);console.log(JSON.stringify({ok:true,...out.stats,output:OUT}));
