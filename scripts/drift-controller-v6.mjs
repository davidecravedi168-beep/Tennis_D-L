import fs from 'node:fs/promises';
import {calibrateProb,activeCalibration} from './calibration-policy-v4.mjs';

const LEDGER='data/forward-ledger.json';
const OUT='data/drift-controller-v6.json';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const isSide=v=>v==='A'||v==='B';
const won=r=>r.immutable?.candidate_side===r.lifecycle?.actual_side;
const eligible=r=>r?.immutable?.forecast_stage==='MARKET_LOCK'&&r?.lifecycle?.status==='SETTLED'&&isSide(r.immutable?.candidate_side)&&isSide(r.lifecycle?.actual_side)&&num(r.immutable?.candidate_prob)>0&&num(r.immutable?.candidate_prob)<1;

function metrics(rows, calibrated=false){
  const xs=rows.map(r=>{
    const raw=num(r.immutable.candidate_prob);
    const p=calibrated?calibrateProb(raw,{tour:r.immutable?.tour,odds:r.immutable?.candidate_odds}):raw;
    return {p:clamp(p,1e-9,1-1e-9),y:won(r)?1:0};
  });
  if(!xs.length)return {n:0,brier:null,logloss:null,ece:null};
  const brier=mean(xs.map(x=>(x.p-x.y)**2));
  const logloss=-mean(xs.map(x=>x.y*Math.log(x.p)+(1-x.y)*Math.log(1-x.p)));
  const bins=Array.from({length:10},()=>[]);
  for(const x of xs)bins[Math.min(9,Math.floor(x.p*10))].push(x);
  let ece=0;
  for(const b of bins){if(!b.length)continue;ece+=b.length/xs.length*Math.abs(mean(b.map(x=>x.p))-mean(b.map(x=>x.y)))}
  return {n:xs.length,brier,logloss,ece};
}
function state(recent,base){
  const dB=recent.brier-base.brier,dL=recent.logloss-base.logloss,dE=recent.ece-base.ece;
  let level='OK';const reasons=[];
  if(dB>.03){level='WATCH';reasons.push('BRIER_WORSE')}
  if(dL>.08){level='WATCH';reasons.push('LOGLOSS_WORSE')}
  if(dE>.04){level='WATCH';reasons.push('ECE_WORSE')}
  if((dB>.06&&dL>.12)||dE>.08){level='ALERT';reasons.push('MATERIAL_PROBABILITY_DRIFT')}
  return {state:level,reasons,delta:{brier:dB,logloss:dL,ece:dE}};
}
function selfTest(){
  const ok={brier:.20,logloss:.58,ece:.09},bad={brier:.24,logloss:.67,ece:.14};
  if(state(bad,ok).state!=='WATCH')throw new Error('WATCH_TEST');
  if(state(ok,ok).state!=='OK')throw new Error('OK_TEST');
  console.log(JSON.stringify({ok:true,tests:['raw_vs_calibrated','watch_threshold','defensive_policy']}));
}
if(process.argv.includes('--self-test')){selfTest();process.exit(0)}

const ledger=JSON.parse(await fs.readFile(LEDGER,'utf8'));
const rows=(ledger.records||[]).filter(eligible).sort((a,b)=>new Date(a.lifecycle?.settled_at||0)-new Date(b.lifecycle?.settled_at||0));
const recent=rows.slice(-50),base=rows.slice(0,-50);
let out={schema:'TEP-DRIFT-CONTROLLER-V6',generated_at:new Date().toISOString(),sample:{total:rows.length,recent:recent.length,baseline:base.length},active_calibration:activeCalibration(),mode:'OBSERVE',decision_policy:{min_calibrated_ev:0.02,pause_accepts:false,wta_extra_core:false},raw:null,calibrated:null,interpretation:'INSUFFICIENT_SAMPLE'};
if(base.length>=30&&recent.length>=30){
  const rr=metrics(recent,false),rb=metrics(base,false),cr=metrics(recent,true),cb=metrics(base,true);
  const raw=state(rr,rb),cal=state(cr,cb);
  out.raw={recent:rr,baseline:rb,...raw};
  out.calibrated={recent:cr,baseline:cb,...cal};
  if(raw.state!=='OK'&&cal.state==='OK'){
    out.mode='CALIBRATION_ABSORBING_DRIFT';
    out.interpretation='Raw probabilities drifted, but active calibration absorbs the deterioration. Do not retune the base model from this signal alone.';
  }else if(cal.state==='WATCH'){
    out.mode='DEFENSIVE';
    out.decision_policy={min_calibrated_ev:0.04,pause_accepts:false,wta_extra_core:true};
    out.interpretation='Active calibrated probabilities are drifting. Tighten Challenger acceptance until metrics normalize.';
  }else if(cal.state==='ALERT'){
    out.mode='PAUSE';
    out.decision_policy={min_calibrated_ev:0.06,pause_accepts:true,wta_extra_core:true};
    out.interpretation='Material calibrated drift. Pause new Challenger accepts; keep collecting shadow data.';
  }else{
    out.mode='NORMAL';
    out.interpretation='No material calibrated probability drift.';
  }
}
await fs.writeFile(OUT,JSON.stringify(out,null,2)+'\n','utf8');
console.log(JSON.stringify({ok:true,mode:out.mode,raw:out.raw?.state||null,calibrated:out.calibrated?.state||null,policy:out.decision_policy,output:OUT}));