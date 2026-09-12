import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const SOURCE='data/forward-ledger.json';
const OUT='data/statistical-learning-v7.json';
const SCHEMA='TEP-STATISTICAL-LEARNING-V7';
const FEATURE_NAMES=['model_logit','market_logit','model_market_gap','raw_calibration_gap','shadow_gap','data_quality','uncertainty','market_depth','tour_wta','surface_clay','surface_grass'];
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const num=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const sigmoid=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
const logit=p=>Math.log(clamp(p,1e-6,1-1e-6)/(1-clamp(p,1e-6,1-1e-6)));
const quantile=(xs,q)=>{if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y),i=(a.length-1)*q,l=Math.floor(i),h=Math.ceil(i);return a[l]+(a[h]-a[l])*(i-l)};
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const isSide=v=>v==='A'||v==='B';
const stage=r=>r?.immutable?.forecast_stage||'MARKET_LOCK';
const settled=r=>r?.lifecycle?.status==='SETTLED';

function semanticKey(r){const i=r?.immutable||{};return [stage(r),i.event_id,i.model_version,i.predicted_at].join('|')}
function dedupe(rows){const m=new Map();for(const r of rows){const k=semanticKey(r),p=m.get(k);if(!p||(!settled(p)&&settled(r)))m.set(k,r)}return [...m.values()]}
function sideProb(p,side){const x=num(p);return x!==null&&x>0&&x<1?(side==='A'?x:1-x):null}
function prepare(ledger){
  const rejected={not_market_lock:0,not_settled:0,invalid_side:0,invalid_probability:0,invalid_odds:0,temporal_leakage:0};
  const rows=[];
  for(const r of dedupe(ledger.records||[])){
    const i=r?.immutable||{},l=r?.lifecycle||{};
    if(stage(r)!=='MARKET_LOCK'){rejected.not_market_lock++;continue}
    if(!settled(r)){rejected.not_settled++;continue}
    if(!isSide(i.candidate_side)||!isSide(l.actual_side)){rejected.invalid_side++;continue}
    const p=num(i.candidate_prob),odds=num(i.candidate_odds);
    if(!(p>0&&p<1)){rejected.invalid_probability++;continue}
    if(!(odds>1)){rejected.invalid_odds++;continue}
    const observed=new Date(r.first_observed_at||i.predicted_at||0).getTime(),start=new Date(i.start_at||0).getTime();
    if(Number.isFinite(observed)&&Number.isFinite(start)&&observed>=start){rejected.temporal_leakage++;continue}
    const market=sideProb(i.market_consensus_a,i.candidate_side)??clamp(1/odds,.02,.98);
    const raw=sideProb(i.raw_p_a,i.candidate_side)??p;
    const shadow=sideProb(i.shadow_p_a,i.candidate_side)??p;
    const surface=String(i.surface||'').toUpperCase(),tour=String(i.tour||'').toUpperCase();
    const rawFeatures={
      model_logit:logit(p),market_logit:logit(market),model_market_gap:p-market,raw_calibration_gap:p-raw,shadow_gap:p-shadow,
      data_quality:(num(i.data_quality)??50)/100,uncertainty:num(i.uncertainty)??.12,market_depth:Math.log1p(Math.max(0,num(i.market_depth)??0)),
      tour_wta:tour==='WTA'?1:0,surface_clay:surface.includes('CLAY')?1:0,surface_grass:surface.includes('GRASS')?1:0
    };
    rows.push({id:r.ledger_id||semanticKey(r),time:new Date(l.settled_at||i.start_at||0).getTime(),p,y:i.candidate_side===l.actual_side?1:0,odds,tour:tour||'UNKNOWN',surface:surface||'UNKNOWN',raw:FEATURE_NAMES.map(k=>rawFeatures[k]),rawFeatures});
  }
  rows.sort((a,b)=>a.time-b.time||String(a.id).localeCompare(String(b.id)));
  return {rows,rejected};
}

function scaler(rows){const means=[],scales=[];for(let j=0;j<FEATURE_NAMES.length;j++){const xs=rows.map(r=>r.raw[j]);const m=mean(xs),sd=Math.sqrt(mean(xs.map(x=>(x-m)**2)))||1;means.push(m);scales.push(sd<1e-8?1:sd)}return {means,scales}}
function vector(r,s){return [1,...r.raw.map((x,j)=>(x-s.means[j])/s.scales[j])]}
function fit(rows,{lambda=.04,iterations=2600,rate=.08}={}){
  const scale=scaler(rows),xs=rows.map(r=>vector(r,scale)),ys=rows.map(r=>r.y),w=Array(FEATURE_NAMES.length+1).fill(0);
  w[0]=logit(clamp(mean(ys),.05,.95));
  for(let it=0;it<iterations;it++){
    const g=Array(w.length).fill(0);
    for(let i=0;i<xs.length;i++){let z=0;for(let j=0;j<w.length;j++)z+=w[j]*xs[i][j];const e=sigmoid(z)-ys[i];for(let j=0;j<w.length;j++)g[j]+=e*xs[i][j]}
    const lr=rate/(1+it/900);
    for(let j=0;j<w.length;j++){g[j]/=xs.length;if(j)g[j]+=lambda*w[j];w[j]-=lr*g[j]}
  }
  return {weights:w,scale,lambda,iterations,predict:r=>clamp(sigmoid(vector(r,scale).reduce((z,x,j)=>z+x*w[j],0)),.01,.99)};
}

function auc(rows,key='q'){const z=rows.filter(r=>Number.isFinite(r[key])).sort((a,b)=>a[key]-b[key]);let pos=0,neg=0,rankSum=0,i=0;while(i<z.length){let j=i+1;while(j<z.length&&z[j][key]===z[i][key])j++;const avgRank=(i+1+j)/2;for(let k=i;k<j;k++){if(z[k].y){pos++;rankSum+=avgRank}else neg++}i=j}return pos&&neg?(rankSum-pos*(pos+1)/2)/(pos*neg):null}
function calibrationFit(rows,key='q'){
  if(rows.length<20)return {intercept:null,slope:null};let a=0,b=1;
  for(let it=0;it<1400;it++){let ga=0,gb=0;for(const r of rows){const x=logit(r[key]),e=sigmoid(a+b*x)-r.y;ga+=e;gb+=e*x}a-=.035*ga/rows.length;b-=.035*gb/rows.length}
  return {intercept:a,slope:b};
}
function reliability(rows,key='q'){
  const bins=Array.from({length:10},(_,i)=>({low:i/10,high:(i+1)/10,rows:[]}));for(const r of rows)bins[Math.min(9,Math.floor(clamp(r[key],0,.999999)*10))].rows.push(r);
  return bins.filter(b=>b.rows.length).map(b=>{const n=b.rows.length,w=b.rows.reduce((s,r)=>s+r.y,0),phat=w/n,z=1.96,den=1+z*z/n,center=(phat+z*z/(2*n))/den,half=z*Math.sqrt((phat*(1-phat)+z*z/(4*n))/n)/den;return {band:`${Math.round(b.low*100)}-${Math.round(b.high*100)}%`,n,avg_probability:mean(b.rows.map(r=>r[key])),observed_rate:phat,wilson_95:[clamp(center-half,0,1),clamp(center+half,0,1)]}})
}
function metrics(rows,key='q'){
  if(!rows.length)return {n:0,brier:null,logloss:null,ece:null,auc:null,calibration_intercept:null,calibration_slope:null};
  const brier=mean(rows.map(r=>(r[key]-r.y)**2)),logloss=-mean(rows.map(r=>r.y*Math.log(clamp(r[key],1e-9,1-1e-9))+(1-r.y)*Math.log(clamp(1-r[key],1e-9,1-1e-9))));
  const rel=reliability(rows,key),ece=rel.reduce((s,b)=>s+b.n/rows.length*Math.abs(b.avg_probability-b.observed_rate),0),cal=calibrationFit(rows,key);
  return {n:rows.length,brier,logloss,ece,auc:auc(rows,key),calibration_intercept:cal.intercept,calibration_slope:cal.slope};
}
function rollingOos(rows){const minTrain=Math.max(100,Math.min(140,Math.floor(rows.length*.5))),block=30,out=[],folds=[];for(let start=minTrain;start<rows.length;start+=block){const train=rows.slice(0,start),test=rows.slice(start,Math.min(rows.length,start+block)),m=fit(train);for(const r of test)out.push({...r,q:m.predict(r)});folds.push({train_n:train.length,test_n:test.length,train_through:new Date(train.at(-1).time).toISOString(),test_through:new Date(test.at(-1).time).toISOString()})}return {rows:out,folds,minTrain,block}}
function rng(seed){let x=seed>>>0||0x9e3779b9;return()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296}}
function bootstrap(rows){
  if(rows.length<30)return {iterations:0,block_size:0,brier_delta_95:[null,null],logloss_delta_95:[null,null]};const rand=rng(parseInt(sha(rows.map(r=>r.id)).slice(0,8),16)),n=rows.length,block=Math.max(5,Math.round(Math.sqrt(n))),bd=[],ld=[];
  for(let z=0;z<800;z++){const sample=[];while(sample.length<n){const start=Math.floor(rand()*n);for(let j=0;j<block&&sample.length<n;j++)sample.push(rows[(start+j)%n])}let brierDelta=0,logDelta=0;for(const r of sample){brierDelta+=(r.q-r.y)**2-(r.p-r.y)**2;logDelta+=-(r.y*Math.log(clamp(r.q,1e-9,1-1e-9))+(1-r.y)*Math.log(clamp(1-r.q,1e-9,1-1e-9)))+(r.y*Math.log(clamp(r.p,1e-9,1-1e-9))+(1-r.y)*Math.log(clamp(1-r.p,1e-9,1-1e-9)))}bd.push(brierDelta/n);ld.push(logDelta/n)}
  return {iterations:800,block_size:block,brier_delta_95:[quantile(bd,.025),quantile(bd,.975)],logloss_delta_95:[quantile(ld,.025),quantile(ld,.975)]};
}
function psi(base,recent,key='q'){const cuts=[0,.45,.5,.55,.6,.65,.7,1],bucket=(xs,i)=>xs.filter(r=>r[key]>=cuts[i]&&(i===cuts.length-2?r[key]<=cuts[i+1]:r[key]<cuts[i+1])).length;let v=0;for(let i=0;i<cuts.length-1;i++){const a=(bucket(base,i)+.5)/(base.length+.5*(cuts.length-1)),b=(bucket(recent,i)+.5)/(recent.length+.5*(cuts.length-1));v+=(b-a)*Math.log(b/a)}return v}
function drift(rows){if(rows.length<100)return {state:'INSUFFICIENT',psi:null,baseline_n:0,recent_n:rows.length};const recent=rows.slice(-50),base=rows.slice(0,-50),v=psi(base,recent),bm=metrics(base),rm=metrics(recent);return {state:v>=.25||rm.logloss-bm.logloss>.12?'ALERT':v>=.10||rm.logloss-bm.logloss>.06?'WATCH':'OK',psi:v,baseline_n:base.length,recent_n:recent.length,delta_brier:rm.brier-bm.brier,delta_logloss:rm.logloss-bm.logloss}}
function segment(rows,name,fn){const m=new Map();for(const r of rows){const k=fn(r);if(!m.has(k))m.set(k,[]);m.get(k).push(r)}const globalRate=mean(rows.map(r=>r.y))??.5,prior=20;return [...m.entries()].map(([key,x])=>{const raw=mean(x.map(r=>r.y)),shrunk=(x.reduce((s,r)=>s+r.y,0)+prior*globalRate)/(x.length+prior);return {segment:name,key,n:x.length,observed_rate:raw,shrunken_rate:shrunk,baseline:metrics(x,'p'),candidate:metrics(x,'q')}}).sort((a,b)=>b.n-a.n)}
function build(ledger){
  const prepared=prepare(ledger),rows=prepared.rows,oos=rollingOos(rows),base=metrics(oos.rows,'p'),candidate=metrics(oos.rows,'q'),boot=bootstrap(oos.rows),d=drift(oos.rows),final=rows.length>=40?fit(rows):null;
  const segments=[...segment(oos.rows,'tour',r=>r.tour),...segment(oos.rows,'surface',r=>r.surface),...segment(oos.rows,'odds',r=>r.odds>=3?'3.00+':r.odds>=2.2?'2.20-2.99':r.odds>=1.8?'1.80-2.19':r.odds>=1.5?'1.50-1.79':'<1.50')];
  const segmentGuard=segments.filter(s=>s.n>=30).every(s=>s.candidate.logloss<=s.baseline.logloss+.02),gates={minimum_oos:oos.rows.length>=150,brier_delta_ci_below_zero:boot.brier_delta_95[1]!==null&&boot.brier_delta_95[1]<0,logloss_delta_ci_below_zero:boot.logloss_delta_95[1]!==null&&boot.logloss_delta_95[1]<0,ece_not_worse:candidate.ece!==null&&candidate.ece<=base.ece+.005,calibration_slope_sane:candidate.calibration_slope!==null&&candidate.calibration_slope>=.75&&candidate.calibration_slope<=1.25,segment_stability:segmentGuard,drift_not_alert:d.state!=='ALERT',no_temporal_leakage:prepared.rejected.temporal_leakage===0};
  const review=Object.values(gates).every(Boolean);
  const selection={champion:'CHAMPION_V12_5',challenger:'STATISTICAL_LEARNING_V7',selected_model:'CHAMPION_V12_5',status:review?'REVIEW_REQUIRED':'CHAMPION_LOCKED',review_eligible:review,auto_promote:false,reason:review?'Challenger passes the pre-defined out-of-sample gates and requires human review before any release.':'Evidence is not yet strong enough to replace the production champion.',decision_quality_policy:{no_bet_below:58,watch_only_below:68,value_review_from:76,strong_value_from:86}};
  return {schema:SCHEMA,generated_at:new Date().toISOString(),source:{ledger_schema:ledger.schema||null,ledger_updated_at:ledger.updated_at||null,eligible_rows:rows.length,rejected:prepared.rejected},policy:{shadow_only:true,production_logic_changed:false,auto_promote:false,time_ordered_walk_forward:true,holdout_reuse:false,regularization:'L2',uncertainty:'deterministic moving-block bootstrap 95%',small_sample_control:'Beta-binomial shrinkage, prior strength 20',note:'The learned model is an auditable challenger. It cannot change picks, thresholds, stake or bankroll without a separately reviewed release.'},features:FEATURE_NAMES,oos:{n:oos.rows.length,folds:oos.folds,baseline:base,candidate,delta:{brier:candidate.brier-base.brier,logloss:candidate.logloss-base.logloss,ece:candidate.ece-base.ece},confidence_intervals:boot,reliability:reliability(oos.rows)},segments,drift:d,promotion:{state:review?'REVIEW_ELIGIBLE':'HOLD',review_eligible:review,gates},selection,model:final?{status:'SHADOW',trained_n:rows.length,training_through:new Date(rows.at(-1).time).toISOString(),intercept:final.weights[0],coefficients:Object.fromEntries(FEATURE_NAMES.map((k,i)=>[k,final.weights[i+1]])),scaler:Object.fromEntries(FEATURE_NAMES.map((k,i)=>[k,{mean:final.scale.means[i],scale:final.scale.scales[i]}])),lambda:final.lambda,iterations:final.iterations,training_fingerprint:sha(rows.map(r=>r.id))}:null};
}
function selfTest(){
  const records=[];for(let i=0;i<260;i++){const market=.42+(i%17)/100,p=clamp(market+(i%3===0?.10:.03),.05,.95),quality=55+(i%45),unc=.04+(i%8)/100,truth=sigmoid(-.3+1.15*logit(p)+.9*(p-market)+.5*(quality/100-.7)-.8*(unc-.08)),y=((i*7919)%10000)/10000<truth?1:0,side=i%2?'A':'B',pa=side==='A'?p:1-p,ma=side==='A'?market:1-market;records.push({ledger_id:String(i),first_observed_at:new Date(Date.UTC(2025,0,1+i,8)).toISOString(),immutable:{forecast_stage:'MARKET_LOCK',event_id:String(i),model_version:'SYN',predicted_at:new Date(Date.UTC(2025,0,1+i,8)).toISOString(),start_at:new Date(Date.UTC(2025,0,1+i,12)).toISOString(),candidate_side:side,candidate_prob:p,candidate_odds:1/market,market_consensus_a:ma,raw_p_a:pa,shadow_p_a:pa,data_quality:quality,uncertainty:unc,market_depth:3,tour:i%4?'atp':'wta',surface:i%5?'Hard':'Clay'},lifecycle:{status:'SETTLED',actual_side:y?side:(side==='A'?'B':'A'),settled_at:new Date(Date.UTC(2025,0,1+i,18)).toISOString()}})}const out=build({schema:'TEST',records});if(out.oos.n<100||!Number.isFinite(out.oos.candidate.brier)||!Number.isFinite(out.oos.candidate.logloss)||out.policy.auto_promote!==false||!out.model||out.source.rejected.temporal_leakage!==0)throw new Error('STATISTICAL_LEARNING_V7_SELF_TEST');console.log(JSON.stringify({ok:true,tests:['time_ordered_walk_forward','regularized_logistic_ml','proper_scoring','auc','calibration','block_bootstrap','hierarchical_shrinkage','psi_drift','promotion_fail_closed'],oos_n:out.oos.n}))
}

if(process.argv.includes('--self-test')){selfTest();process.exit(0)}
const ledger=JSON.parse(await fs.readFile(SOURCE,'utf8')),out=build(ledger);
await fs.mkdir(path.dirname(OUT),{recursive:true});await fs.writeFile(OUT,JSON.stringify(out,null,2)+'\n','utf8');
if(process.argv.includes('--validate')){if(out.schema!==SCHEMA||out.policy.shadow_only!==true||out.policy.production_logic_changed!==false||out.policy.auto_promote!==false||!Array.isArray(out.oos.folds)||out.source.rejected.temporal_leakage!==0)throw new Error('STATISTICAL_LEARNING_V7_INVALID')}
console.log(JSON.stringify({ok:true,eligible:out.source.eligible_rows,oos_n:out.oos.n,baseline:out.oos.baseline,candidate:out.oos.candidate,promotion:out.promotion.state,drift:out.drift.state,output:OUT}));
