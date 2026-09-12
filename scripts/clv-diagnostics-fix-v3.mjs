import fs from 'node:fs/promises';
import {num, closingFor, summarizeCLV, CLV_MAX_PROXY_AGE_MIN} from './clv-evidence-v4.mjs';

const LEDGER='data/forward-ledger.json';
const TRACKER='data/clv-tracker-v3.json';
const DIAG='data/tennis-model-diagnostics-v2.json';
const stage=r=>r?.immutable?.forecast_stage||'MARKET_LOCK';
const settled=r=>r?.lifecycle?.status==='SETTLED';
const isSide=v=>v==='A'||v==='B';
const key=r=>[stage(r),r?.immutable?.event_id,r?.immutable?.model_version,r?.immutable?.predicted_at].join('|');
function dedupe(rows){const m=new Map();for(const r of rows){const k=key(r),p=m.get(k);if(!p||(!settled(p)&&settled(r)))m.set(k,r)}return [...m.values()]}
function eligible(rows){return rows.filter(r=>stage(r)==='MARKET_LOCK'&&settled(r)&&isSide(r.immutable?.candidate_side)&&num(r.immutable?.candidate_odds)>1&&isSide(r.lifecycle?.actual_side))}
function selfTest(){const base={immutable:{forecast_stage:'MARKET_LOCK',event_id:'1',model_version:'T',predicted_at:'2026-01-01T09:00:00Z',start_at:'2026-01-01T12:00:00Z',candidate_side:'A',candidate_odds:2},lifecycle:{status:'SETTLED',actual_side:'A',closing_odds:null,clv:null},ledger_id:'L1'};const t={records:{L1:{observations:[{observed_at:'2026-01-01T11:30:00Z',odds:1.8}]}}};const c=closingFor(base,t);const s=summarizeCLV([base],t,{minSamples:1});if(num(null)!==null||num('')!==null||!c||Math.abs(c.clv-(2/1.8-1))>1e-12||c.source!=='LAST_PRESTART_OBSERVED'||s.clv_sample!==1)throw new Error('CLV_DIAGNOSTICS_SELF_TEST');console.log(JSON.stringify({ok:true,tests:['strict_null_is_missing','candidate_clv','prestart_proxy','coverage','source_tagging']}))}
if(process.argv.includes('--self-test')){selfTest();process.exit(0)}
const ledger=JSON.parse(await fs.readFile(LEDGER,'utf8'));let tracker=null;try{tracker=JSON.parse(await fs.readFile(TRACKER,'utf8'))}catch{tracker={records:{}}}const diag=JSON.parse(await fs.readFile(DIAG,'utf8'));const rows=eligible(dedupe(ledger.records||[]));diag.clv=summarizeCLV(rows,tracker,{maxProxyAgeMin:CLV_MAX_PROXY_AGE_MIN});diag.clv_integrity={version:'V4',updated_at:new Date().toISOString(),definition:'candidate entry odds / best available genuine closing reference - 1',provider_preferred:true,proxy_fallback:'last actually observed pre-start odds within 180 minutes',retroactive_synthesis:false,strict_nulls:true};await fs.writeFile(DIAG,JSON.stringify(diag,null,2)+'\n','utf8');console.log(JSON.stringify({ok:true,n:rows.length,clv:diag.clv,output:DIAG}));
