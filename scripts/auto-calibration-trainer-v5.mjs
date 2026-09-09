import fs from 'node:fs/promises';
import {calibrateProb as calibrateV4} from './calibration-policy-v4.mjs';

const LEDGER='data/forward-ledger.json';
const OUT='data/calibration-model-v5.json';
const REPORT='data/calibration-training-v5.json';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sigmoid=x=>1/(1+Math.exp(-x));
const logit=p=>Math.log(p/(1-p));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const isSide=v=>v==='A'||v==='B';
const won=r=>r.immutable?.candidate_side===r.lifecycle?.actual_side;
const eligible=r=>r?.immutable?.forecast_stage==='MARKET_LOCK'&&r?.lifecycle?.status==='SETTLED'&&isSide(r.immutable?.candidate_side)&&isSide(r.lifecycle?.actual_side)&&num(r.immutable?.candidate_prob)>0&&num(r.immutable?.candidate_prob)<1;

function applyModel(r,m){const p=clamp(num(r.immutable.candidate_prob),.01,.99),tour=String(r.immutable?.tour||'').toUpperCase(),odds=num(r.immutable?.candidate_odds);let z=m.a*logit(p)+m.b+(tour==='WTA'?m.wta_bias:0),q=sigmoid(z);if(Number.isFinite(odds)&&odds>=3)q=Math.min(q,1/odds);return clamp(q,.01,.99)}
function score(rows,fn){const z=rows.map(r=>({p:clamp(fn(r),1e-9,1-1e-9),y:won(r)?1:0}));if(!z.length)return {n:0,brier:null,logloss:null,ece:null};const brier=mean(z.map(x=>(x.p-x.y)**2));const logloss=-mean(z.map(x=>x.y*Math.log(x.p)+(1-x.y)*Math.log(1-x.p)));const bins=Array.from({length:10},()=>[]);for(const x of z)bins[Math.min(9,Math.floor(x.p*10))].push(x);let ece=0;for(const b of bins){if(!b.length)continue;ece+=b.length/z.length*Math.abs(mean(b.map(x=>x.p))-mean(b.map(x=>x.y)))}return {n:z.length,brier,logloss,ece}}
function objective(s){return s.logloss+.35*s.brier+.15*s.ece}
function fit(train){let best=null;for(let ai=10;ai<=30;ai++){const a=ai/20;for(let bi=-12;bi<=12;bi++){const b=bi*.05;for(let wi=-8;wi<=2;wi++){const wta_bias=wi*.05,m={a,b,wta_bias},s=score(train,r=>applyModel(r,m)),o=objective(s);if(!best||o<best.objective)best={params:m,metrics:s,objective:o}}}}return best}
function activeFn(active){if(active?.status==='ACTIVE'&&active?.params)return r=>applyModel(r,active.params);return r=>calibrateV4(num(r.immutable.candidate_prob),{tour:r.immutable?.tour,odds:r.immutable?.candidate_odds})}

const ledger=JSON.parse(await fs.readFile(LEDGER,'utf8'));const rows=(ledger.records||[]).filter(eligible).sort((a,b)=>new Date(a.lifecycle?.settled_at||0)-new Date(b.lifecycle?.settled_at||0));let active=null;try{active=JSON.parse(await fs.readFile(OUT,'utf8'))}catch{}
const HOLDOUT=40,MIN_TRAIN=120,MIN_NEW_LABELS=10;let report={schema:'TEP-CALIBRATION-TRAINING-V5',generated_at:new Date().toISOString(),settled_n:rows.length,status:'NO_ACTION'};
if(rows.length<MIN_TRAIN+HOLDOUT){report={...report,status:'INSUFFICIENT_DATA',required:MIN_TRAIN+HOLDOUT}}
else{const train=rows.slice(0,-HOLDOUT),hold=rows.slice(-HOLDOUT),newLabels=rows.length-(active?.source_settled_n||0);const incumbent=score(hold,activeFn(active));const candidate=fit(train),cand=score(hold,r=>applyModel(r,candidate.params));const improvesLog=cand.logloss<=incumbent.logloss*.995,protectBrier=cand.brier<=incumbent.brier*1.005,protectECE=cand.ece<=incumbent.ece+.01,eligiblePromotion=newLabels>=MIN_NEW_LABELS&&improvesLog&&protectBrier&&protectECE;report={...report,status:eligiblePromotion?'PROMOTED':'REJECTED',train_n:train.length,holdout_n:hold.length,new_labels_since_active:newLabels,incumbent,candidate:{params:candidate.params,metrics:cand},gates:{min_new_labels:newLabels>=MIN_NEW_LABELS,logloss_improved_0_5pct:improvesLog,brier_not_worse_0_5pct:protectBrier,ece_not_worse_0_01:protectECE}};if(eligiblePromotion){const next={schema:'TEP-CALIBRATION-MODEL-V5',status:'ACTIVE',version:`V5-${rows.length}-${Date.now()}`,promoted_at:new Date().toISOString(),source_settled_n:rows.length,train_n:train.length,validation_n:hold.length,params:candidate.params,validation:{incumbent,candidate:cand},policy:{auto_train_every_cycle:true,min_new_labels_for_promotion:MIN_NEW_LABELS,holdout_size:HOLDOUT,rollback:'fallback to previous active model or V4 if state invalid'}};await fs.writeFile(OUT,JSON.stringify(next,null,2)+'\n','utf8')}}
await fs.writeFile(REPORT,JSON.stringify(report,null,2)+'\n','utf8');console.log(JSON.stringify({ok:true,status:report.status,settled_n:rows.length,output:OUT,report:REPORT}));
