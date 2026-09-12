import fs from 'node:fs/promises';
// All producer workflows share one concurrency group and commit this ledger.
const FILE='data/odds-budget.json';
export const LIMITS={daily:480,hourly:90,surebet:60};
export async function budgetState(now=Date.now()){
  let s;try{s=JSON.parse(await fs.readFile(FILE,'utf8'))}catch(e){if(e.code!=='ENOENT')throw new Error('SHARED_BUDGET_INVALID');s={requests:[]}}
  s.requests=(s.requests||[]).filter(r=>r.at>now-86400000&&r.at<=now);
  return s;
}
async function save(s){await fs.mkdir('data',{recursive:true});await fs.writeFile(FILE+'.tmp',JSON.stringify(s)+'\n');await fs.rename(FILE+'.tmp',FILE)}
export async function budgetFetch(url,options={},source='quant'){
  const now=Date.now(),s=await budgetState(now);
  if(s.blocked_until>now)throw new Error('RATE_LIMIT_WAIT');
  if(s.requests.length>=LIMITS.daily||s.requests.filter(r=>r.at>now-3600000).length>=LIMITS.hourly||source==='surebet'&&s.requests.filter(r=>r.source==='surebet').length>=LIMITS.surebet)throw new Error('DAILY_BUDGET_GUARD');
  // Charge before sending: failed/timeout requests may also count at the provider.
  s.requests.push({at:now,source});await save(s);
  const response=await fetch(url,{...options,signal:options.signal||AbortSignal.timeout(20000)});
  if(response.status===429){
    const retry=response.headers.get('retry-after'),seconds=Number(retry);
    const retryAt=retry?(Number.isFinite(seconds)?now+seconds*1000:Date.parse(retry)):NaN;
    s.blocked_until=Number.isFinite(retryAt)&&retryAt>now?retryAt:now+3600000;
    await save(s);
  }
  return response;
}
