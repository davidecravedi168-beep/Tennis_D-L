import fs from 'node:fs';

function patchFile(path, mutator){
  const before=fs.readFileSync(path,'utf8');
  const after=mutator(before);
  if(after===before){console.log(`unchanged: ${path}`);return}
  fs.writeFileSync(path,after);
  console.log(`patched: ${path}`);
}
function once(text,from,to,label){
  if(text.includes(to))return text;
  const count=text.split(from).length-1;
  if(count!==1)throw new Error(`${label}: expected 1 match, found ${count}`);
  return text.replace(from,to);
}

patchFile('quant-engine.mjs',src=>{
  src=once(src,
`function compactMarketLab(lab){
  if(!lab||typeof lab!=="object")return lab;
  const {scenario,best_priced,detected_market_names,note,...publicLab}=lab;
  return publicLab;
}`,
`function compactMarketLab(lab){
  if(!lab||typeof lab!=="object")return lab;
  // Keep the compact prediction-first summary public. Raw provider metadata stays private.
  const {best_priced,detected_market_names,note,...publicLab}=lab;
  return publicLab;
}`,'compact market lab');

  src=once(src,
`  const scenario=[];`,
`  // Prediction first: estimate what is most likely to happen before looking at price.
  // Price remains a second-stage gate; it can block a bet but never rewrite the sports forecast.
  const forecastSide=c.pA>=.5?"A":"B",forecastName=forecastSide==="A"?event.home:event.away,forecastProb=Math.max(c.pA,c.pB);
  const marketReliability={MATCH_WINNER:1,WIN_A_SET:.98,SET_HANDICAP:.96,GAME_HANDICAP:.94,TOTAL_GAMES:.92,FIRST_SET_WINNER:.88,TIEBREAK_IN_MATCH:.76,SET_SCORE:.68};
  const predictionCandidates=priced
    .filter(r=>Number.isFinite(r.model_prob)&&r.model_prob>=.54&&Number.isFinite(r.robust_prob)&&!(r.reasons||[]).length)
    .map(r=>({...r,prediction_score:clamp((.72*r.model_prob+.28*r.robust_prob)*(marketReliability[r.market]||.8),0,1)}))
    .sort((a,b)=>b.prediction_score-a.prediction_score||(b.model_prob||0)-(a.model_prob||0));
  // A recommended wager must also clear the price gate. High probability alone is not enough.
  const playable=predictionCandidates.filter(r=>Number.isFinite(r.robust_ev)&&r.robust_ev>0&&Number.isFinite(r.best_odds)&&r.best_odds>1);
  const bestPrediction=playable[0]||null,alternatives=playable.slice(1,4);
  const likelyScoreEntry=Object.entries(sim.score_probs).sort((a,b)=>b[1]-a[1])[0]||[null,null];
  const prediction_summary={winner_side:forecastSide,winner_name:forecastName,winner_prob:forecastProb,confidence:conf,data_quality:dq,likely_set_score:likelyScoreEntry[0],likely_set_score_prob:likelyScoreEntry[1],expected_total_games:sim.mean_total_games,best_market:bestPrediction?{market:bestPrediction.market,selection:bestPrediction.selection,model_prob:bestPrediction.model_prob,robust_prob:bestPrediction.robust_prob,best_odds:bestPrediction.best_odds,min_acceptable_odds:bestPrediction.min_acceptable_odds,robust_ev:bestPrediction.robust_ev,prediction_score:bestPrediction.prediction_score,validation_tier:bestPrediction.validation_tier}:null};
  const scenario=[];`,'prediction-first selector');

  src=once(src,
`market_uncertainty:marketUnc,priced,scenario:scenario.slice(0,14),best_priced:priced[0]||null,detected_market_names`,
`market_uncertainty:marketUnc,priced,scenario:scenario.slice(0,14),prediction_summary,best_prediction:bestPrediction,alternatives,best_priced:priced[0]||null,detected_market_names`,'prediction summary export');

  src=src.replace('multi_market_version:"MM-3.0-PRICE-GUARD"','multi_market_version:"MM-4.0-PREDICTION-FIRST"');
  return src;
});

patchFile('index.html',html=>{
  html=html.replace("return event==='push'&&automationAge()<55};","return event==='push'&&automationAge()<80};");

  const iconLinks=`<link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">\n<link rel="apple-touch-icon" sizes="180x180" href="./icons/apple-touch-icon.png">\n<link rel="manifest" href="./manifest.webmanifest">\n<meta name="apple-mobile-web-app-title" content="Tennis Edge Pro">`;
  if(!html.includes('apple-touch-icon'))html=html.replace('<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',`<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n${iconLinks}`);

  html=once(html,
`for(const r of rows)out.push({...r,event_id:String(x.event_id),player_a:x.player_a,player_b:x.player_b,tournament:x.tournament,surface:x.surface,start_at:x.start_at,confidence:r.confidence??x.confidence,data_quality:r.data_quality??x.data_quality,reason_codes:r.reason_codes||x.reason_codes||[],no_bet_reasons:r.no_bet_reasons||x.no_bet_reasons||[],audit_id:r.audit_id||x.audit_id,quote_tape:r.quote_tape||x.quote_tape||[],model_health:r.model_health||x.model_health,pre_verdict:x.verdict});`,
`for(const r of rows)out.push({...r,event_id:String(x.event_id),player_a:x.player_a,player_b:x.player_b,tournament:x.tournament,surface:x.surface,start_at:x.start_at,forecast_side:x.forecast_side,forecast_name:x.forecast_name,forecast_prob:x.forecast_prob,sports_confidence:x.sports_confidence,prediction_summary:x.market_lab?.prediction_summary||null,best_prediction:x.market_lab?.best_prediction||null,confidence:r.confidence??x.confidence,data_quality:r.data_quality??x.data_quality,reason_codes:r.reason_codes||x.reason_codes||[],no_bet_reasons:r.no_bet_reasons||x.no_bet_reasons||[],audit_id:r.audit_id||x.audit_id,quote_tape:r.quote_tape||x.quote_tape||[],model_health:r.model_health||x.model_health,pre_verdict:x.verdict});`,'market rows prediction fields');

  html=once(html,
`const h=$('hero'),ver=$('heroVerdict'),rows=bestRows(true,12),r=rows.find(x=>['BET ZONE','TEST VALUE'].includes(currentPriceStatus(x)))||rows[0];`,
`const h=$('hero'),ver=$('heroVerdict'),rows=bestRows(true,24),ranked=[...rows].sort((a,b)=>(n(b.forecast_prob)||0)-(n(a.forecast_prob)||0)||(b.sports_confidence||b.confidence||0)-(a.sports_confidence||a.confidence||0)),lead=ranked[0],eventRows=lead?rows.filter(x=>x.event_id===lead.event_id):rows,r=eventRows.find(x=>['BET ZONE','TEST VALUE'].includes(currentPriceStatus(x)))||[...eventRows].sort((a,b)=>(n(b.model_prob)||0)-(n(a.model_prob)||0))[0]||rows[0];`,'hero prediction-first ranking');

  html=html.replace("if(!operationalSafe()||!r){","if(!r){");

  html=once(html,
`ver.className=\`heroVerdict \${cls}\`;ver.textContent=st==='BET ZONE'?'BET NOW':st==='TEST VALUE'?'PAPER EDGE':st==='WATCH PRICE'?'WAIT PRICE':'NO BET';$('heroMatch').innerHTML=\`\${esc(r.selection)} <span style="color:var(--muted)">· \${esc(r.player_a)} vs \${esc(r.player_b)}</span>\`;$('heroSub').textContent=\`\${marketLabel(r.market)} · \${offer?.book||'book non indicato'} · \${official?'track record validato':'mercato in validazione'}\`;`,
`ver.className=\`heroVerdict \${cls}\`;ver.textContent='PRONOSTICO';const forecastName=r.forecast_name||r.prediction_summary?.winner_name||'—',forecastProb=n(r.forecast_prob)??n(r.prediction_summary?.winner_prob);$('heroMatch').innerHTML=\`\${esc(forecastName)} \${finite(forecastProb)?pct(forecastProb):'—'} <span style="color:var(--muted)">· \${esc(r.player_a)} vs \${esc(r.player_b)}</span>\`;$('heroSub').textContent=\`Giocata migliore: \${r.selection} · \${marketLabel(r.market)} · \${st==='BET ZONE'?'PREZZO OK':st==='TEST VALUE'?'PAPER ONLY':st==='WATCH PRICE'?'ATTENDI QUOTA':st==='BLOCKED'?'BLOCCATA':'NESSUN INGRESSO'}\`;`,'hero verdict semantics');

  html=html.replaceAll('<span>ENTRA DA</span>','<span>QUOTA MINIMA ≥</span>');
  html=html.replaceAll('<span class="maturity">${esc(marketFamily(r.market))} · ${esc(mat.label)}</span>','<span class="maturity">MERCATO ${esc(marketFamily(r.market))} · DATI ${esc(mat.label)}</span>');
  html=html.replaceAll("${official?'VALIDATO':'PAPER'}","${official?'MERCATO VALIDATO':'PAPER'}");
  return html;
});

console.log('prediction-first + app icon upgrade complete');
