import fs from 'node:fs/promises';
import path from 'node:path';
import {num, closingFor, summarizeCLV} from './clv-evidence-v4.mjs';

const LEDGER='data/forward-ledger.json';
const OUT='data/paper-funnel.json';
const now=new Date();
const pct=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&b>0? a/b:null;
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const stage=r=>r?.immutable?.forecast_stage||'MARKET_LOCK';
const settled=r=>r?.lifecycle?.status==='SETTLED';
const isSide=v=>v==='A'||v==='B';

function semanticKey(r){const i=r?.immutable||{};return stage(r)==='RADAR_PREVIEW'?[stage(r),i.event_id,i.model_version].join('|'):[stage(r),i.event_id,i.model_version,i.predicted_at].join('|')}
function dedupe(rows){const m=new Map();for(const r of rows){const k=semanticKey(r),p=m.get(k);if(!p||(!settled(p)&&settled(r)))m.set(k,r)}return [...m.values()]}
function reasonList(r){const i=r?.immutable||{};const raw=[...(i.no_bet_reasons||[]),...(i.reason_codes||[]),...(i.warnings||[])];return [...new Set(raw.map(x=>String(x||'').trim()).filter(Boolean))]}
function reasonCounts(rows){const m=new Map();for(const r of rows){const reasons=reasonList(r);if(!reasons.length)m.set('UNSPECIFIED',1+(m.get('UNSPECIFIED')||0));for(const x of reasons)m.set(x,1+(m.get(x)||0))}return [...m.entries()].sort((a,b)=>b[1]-a[1]).map(([reason,count])=>({reason,count,share:pct(count,rows.length)}))}
function paper(rows,tracker){const e=rows.filter(r=>settled(r)&&isSide(r.immutable?.candidate_side)&&num(r.immutable?.candidate_odds)>1&&isSide(r.lifecycle?.actual_side));let bank=0,peak=0,maxDD=0,wins=0;const ordered=[...e].sort((a,b)=>new Date(a.lifecycle?.settled_at||0)-new Date(b.lifecycle?.settled_at||0));for(const r of ordered){const won=r.immutable.candidate_side===r.lifecycle.actual_side;wins+=won?1:0;bank+=won?num(r.immutable.candidate_odds)-1:-1;peak=Math.max(peak,bank);maxDD=Math.max(maxDD,peak-bank)}const evidence=e.map(r=>closingFor(r,tracker)).filter(x=>x.status==='OBSERVED'&&Number.isFinite(x.clv));const clv=evidence.map(x=>x.clv);return {settled:e.length,wins,hit_rate:pct(wins,e.length),profit_units:bank,roi:pct(bank,e.length),max_drawdown_units:maxDD,clv_sample:clv.length,avg_clv:mean(clv),clv_provider_sample:evidence.filter(x=>x.source==='HISTORICAL_PROVIDER').length,clv_proxy_sample:evidence.filter(x=>x.source==='LAST_PRESTART_OBSERVED').length}}
function coverage(rows,key){return pct(rows.filter(r=>num(r.immutable?.[key])!==null).length,rows.length)}

const ledger=JSON.parse(await fs.readFile(LEDGER,'utf8'));let tracker=null;try{tracker=JSON.parse(await fs.readFile('data/clv-tracker-v3.json','utf8'))}catch{tracker={records:{}}}
const rows=dedupe(Array.isArray(ledger.records)?ledger.records:[]);
const market=rows.filter(r=>stage(r)==='MARKET_LOCK');
const withCandidate=market.filter(r=>isSide(r.immutable?.candidate_side)&&num(r.immutable?.candidate_odds)>1);
const qualified=market.filter(r=>['VALUE','STRONG VALUE'].includes(r.immutable?.verdict));
const watch=market.filter(r=>r.immutable?.verdict==='WATCH');
const noBet=market.filter(r=>r.immutable?.verdict==='NO BET');
const missingOdds=market.filter(r=>!(num(r.immutable?.candidate_odds)>1));
const missingCandidate=market.filter(r=>!isSide(r.immutable?.candidate_side));
const dq=market.map(r=>num(r.immutable?.data_quality)).filter(Number.isFinite);
const conf=market.map(r=>num(r.immutable?.confidence)).filter(Number.isFinite);
const ledgerUpdated=new Date(ledger.updated_at||0);
const freshnessMinutes=Number.isFinite(ledgerUpdated.getTime())?(now-ledgerUpdated)/60000:null;
const paperAll=paper(market,tracker),paperWatch=paper(watch,tracker),paperNoBet=paper(noBet,tracker),official=paper(qualified.map(r=>({...r,immutable:{...r.immutable,candidate_side:r.immutable.pick_side||r.immutable.candidate_side,candidate_odds:r.immutable.pick_odds||r.immutable.candidate_odds}})),tracker);
const clv=summarizeCLV(market,tracker);
const anomalies=[];
if(market.length>=50&&qualified.length===0)anomalies.push({code:'NO_QUALIFIED_SIGNALS',severity:'attention',detail:`${market.length} market locks observed with zero VALUE/STRONG VALUE signals.`});
if(market.length&&withCandidate.length===0)anomalies.push({code:'NO_MARKET_CANDIDATES',severity:'problem',detail:'No market-lock forecast has a valid candidate side plus odds.'});
if(market.length&&missingOdds.length/market.length>.5)anomalies.push({code:'ODDS_COVERAGE_LOW',severity:'attention',detail:`Candidate odds missing/invalid on ${missingOdds.length}/${market.length} market locks.`});
if(clv.state==='BROKEN')anomalies.push({code:'CLV_NOT_POPULATING',severity:'attention',detail:`${clv.eligible_rows} settled paper candidates exist but no genuine pre-start closing reference is available.`});
if(clv.state==='PARTIAL')anomalies.push({code:'CLV_LOW_COVERAGE',severity:'attention',detail:`Genuine CLV evidence covers ${(clv.coverage*100).toFixed(1)}% of settled paper candidates (${clv.clv_sample}/${clv.eligible_rows}); missing values remain unavailable.`});
if(clv.state==='SUSPECT')anomalies.push({code:'CLV_SUSPECT',severity:'attention',detail:'The observed CLV sample is nearly always zero; inspect the quote source before using it for model selection.'});
if(freshnessMinutes!==null&&freshnessMinutes>360)anomalies.push({code:'LEDGER_STALE',severity:'problem',detail:`Forward ledger is ${Math.round(freshnessMinutes)} minutes old.`});

const out={schema:'TEP-PAPER-FUNNEL-2',generated_at:now.toISOString(),source:{ledger_schema:ledger.schema||null,ledger_updated_at:ledger.updated_at||null,freshness_minutes:freshnessMinutes,clv_tracker_updated_at:tracker?.updated_at||null},policy:{validation_only:true,thresholds_changed:false,official_pick_logic_changed:false,flat_stake_units:1,strict_nulls:true,clv_definition:'candidate entry odds / best available genuine closing reference - 1',note:'Observability only: tracks every locked market candidate and rejection reason without relaxing betting thresholds. Missing CLV evidence remains null and never becomes zero.'},funnel:{market_locks:market.length,valid_market_candidates:withCandidate.length,watch:watch.length,no_bet:noBet.length,qualified_value:qualified.length,settled_market_locks:market.filter(settled).length,settled_paper_candidates:paperAll.settled,missing_candidate_side:missingCandidate.length,missing_candidate_odds:missingOdds.length},paper:{all_candidates:paperAll,watch:paperWatch,no_bet:paperNoBet,official_qualified:official},clv,coverage:{candidate_odds:coverage(market,'candidate_odds'),candidate_ev:coverage(market,'candidate_ev'),candidate_edge:coverage(market,'candidate_edge'),market_consensus:coverage(market,'market_consensus_a'),data_quality:coverage(market,'data_quality'),confidence:coverage(market,'confidence'),avg_data_quality:mean(dq),avg_confidence:mean(conf)},rejection_reasons:reasonCounts(noBet),watch_reasons:reasonCounts(watch),anomalies,status:anomalies.some(x=>x.severity==='problem')?'PROBLEM':anomalies.length?'ATTENTION':'HEALTHY'};

await fs.mkdir(path.dirname(OUT),{recursive:true});
await fs.writeFile(OUT,JSON.stringify(out,null,2)+'\n','utf8');
if(process.argv.includes('--validate')){if(out.schema!=='TEP-PAPER-FUNNEL-2'||!out.funnel||!out.paper||!out.clv||out.policy.strict_nulls!==true||!Array.isArray(out.anomalies))throw new Error('PAPER_FUNNEL_INVALID');console.log(JSON.stringify({ok:true,status:out.status,funnel:out.funnel,clv:out.clv,anomalies:out.anomalies}))}else console.log(JSON.stringify({ok:true,status:out.status,output:OUT,funnel:out.funnel,clv:out.clv,top_rejections:out.rejection_reasons.slice(0,5),anomalies:out.anomalies}));
