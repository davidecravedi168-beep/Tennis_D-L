import fs from 'node:fs';

export const ADAPTIVE_CALIBRATION_POLICY='TEP_ADAPTIVE_CALIBRATION_V5';
const MODEL_PATH='data/calibration-model-v5.json';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const sigmoid=x=>1/(1+Math.exp(-x));
const logit=p=>Math.log(p/(1-p));

function frozenV4(raw,{tour='UNKNOWN',odds=null}={}){
  const p=Number(raw),o=Number(odds),t=String(tour||'UNKNOWN').toUpperCase();
  if(!(p>0&&p<1)) return null;
  let q=p;
  if(p<.55) q=0.75*p+0.25*0.24324;
  else if(p<.60) q=0.65*p+0.35*0.42105;
  else if(p<.70) q=p;
  else if(p<.75) q=0.75*p+0.25*0.63636;
  else q=0.80*p+0.20*0.92857;
  if(t==='WTA') q=0.85*q+0.15*0.33333;
  if(Number.isFinite(o)&&o>=3) q=Math.min(q,1/o);
  return clamp(q,.01,.99);
}

function loadModel(){
  try{
    const x=JSON.parse(fs.readFileSync(MODEL_PATH,'utf8'));
    if(x?.schema==='TEP-CALIBRATION-MODEL-V5'&&x?.status==='ACTIVE'&&Number.isFinite(x?.params?.a)&&Number.isFinite(x?.params?.b)) return x;
  }catch{}
  return null;
}

export function activeCalibration(){const m=loadModel();return m?{policy:ADAPTIVE_CALIBRATION_POLICY,version:m.version,source:'AUTO_ML',model:m}:{policy:'TEP_CALIBRATION_V4_2026-09-06',version:'V4_FALLBACK',source:'FALLBACK',model:null}}

export function calibrateProb(raw,{tour='UNKNOWN',odds=null}={}){
  const p=Number(raw),o=Number(odds),t=String(tour||'UNKNOWN').toUpperCase();
  if(!(p>0&&p<1)) return null;
  const m=loadModel();
  if(!m) return frozenV4(p,{tour:t,odds:o});
  let z=m.params.a*logit(clamp(p,.01,.99))+m.params.b;
  if(t==='WTA') z+=Number(m.params.wta_bias||0);
  let q=sigmoid(z);
  if(Number.isFinite(o)&&o>=3) q=Math.min(q,1/o);
  return clamp(q,.01,.99);
}

export function calibratedEV(raw,odds,ctx={}){const p=calibrateProb(raw,{...ctx,odds});const o=Number(odds);return p!==null&&o>1?p*o-1:null;}
