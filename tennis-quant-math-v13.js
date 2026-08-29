(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;root.TennisQuantMath=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
'use strict';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,Number(x)));
const validProb=p=>Number.isFinite(Number(p))&&Number(p)>0&&Number(p)<1;
const validOdds=o=>Number.isFinite(Number(o))&&Number(o)>1;
function impliedProbability(odds){return validOdds(odds)?1/Number(odds):null}
function fairOdds(prob){return validProb(prob)?1/Number(prob):null}
function expectedValue(prob,odds){return validProb(prob)&&validOdds(odds)?Number(prob)*Number(odds)-1:null}
function probabilityEdge(prob,marketProb){return validProb(prob)&&validProb(marketProb)?Number(prob)-Number(marketProb):null}
function fullKelly(prob,odds){if(!validProb(prob)||!validOdds(odds))return null;const p=Number(prob),b=Number(odds)-1,q=1-p;return (b*p-q)/b}
function fractionalKelly(prob,odds,fraction=.25,cap=.02){const k=fullKelly(prob,odds);if(!Number.isFinite(k))return null;return clamp(Math.max(0,k)*clamp(fraction,0,1),0,Math.max(0,cap))}
function deVigTwo(oddsA,oddsB){if(!validOdds(oddsA)||!validOdds(oddsB))return null;const ia=1/Number(oddsA),ib=1/Number(oddsB),book=ia+ib;return{probA:ia/book,probB:ib/book,hold:book-1}}
function holdProbabilityFromPoint(pointWinProb){if(!validProb(pointWinProb))return null;const p=Number(pointWinProb),q=1-p;const beforeDeuce=Math.pow(p,4)*(1+4*q+10*q*q);const reachDeuce=20*Math.pow(p,3)*Math.pow(q,3);const winFromDeuce=(p*p)/(p*p+q*q);return beforeDeuce+reachDeuce*winFromDeuce}
function eloWinProbability(ratingA,ratingB,scale=400){if(!Number.isFinite(Number(ratingA))||!Number.isFinite(Number(ratingB))||!(Number(scale)>0))return null;return 1/(1+Math.pow(10,(Number(ratingB)-Number(ratingA))/Number(scale)))}
function bestOfThreeFromSetProb(setProb){if(!validProb(setProb))return null;const p=Number(setProb);return p*p*(3-2*p)}
function brier(prob,outcome){if(!validProb(prob)||![0,1,false,true].includes(outcome))return null;return Math.pow(Number(prob)-Number(outcome),2)}
function logLoss(prob,outcome){if(!validProb(prob)||![0,1,false,true].includes(outcome))return null;const p=clamp(Number(prob),1e-9,1-1e-9),y=Number(outcome);return-(y*Math.log(p)+(1-y)*Math.log(1-p))}
function intervalWidth(low,high){return validProb(low)&&validProb(high)&&Number(low)<=Number(high)?Number(high)-Number(low):null}
return{impliedProbability,fairOdds,expectedValue,probabilityEdge,fullKelly,fractionalKelly,deVigTwo,holdProbabilityFromPoint,eloWinProbability,bestOfThreeFromSetProb,brier,logLoss,intervalWidth};
});
