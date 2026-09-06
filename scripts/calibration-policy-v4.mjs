export const CALIBRATION_POLICY='TEP_CALIBRATION_V4_2026-09-06';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function calibrateProb(raw,{tour='UNKNOWN',odds=null}={}){
  const p=Number(raw),o=Number(odds),t=String(tour||'UNKNOWN').toUpperCase();
  if(!(p>0&&p<1)) return null;
  // Frozen shrinkage derived from the 210-case development sample. Conservative by design.
  // Never trained on future outcomes; future evaluation must remain forward-only.
  let q=p;
  if(p<.55) q=0.75*p+0.25*0.24324;
  else if(p<.60) q=0.65*p+0.35*0.42105;
  else if(p<.70) q=p;
  else if(p<.75) q=0.75*p+0.25*0.63636;
  else q=0.80*p+0.20*0.92857;
  // WTA showed material overconfidence in development; apply mild extra shrinkage.
  if(t==='WTA') q=0.85*q+0.15*0.33333;
  // Longshots remain excluded by challenger; this prevents accidental optimistic EV if reused.
  if(Number.isFinite(o)&&o>=3) q=Math.min(q,1/o);
  return clamp(q,.01,.99);
}
export function calibratedEV(raw,odds,ctx={}){const p=calibrateProb(raw,{...ctx,odds});const o=Number(odds);return p!==null&&o>1?p*o-1:null;}
