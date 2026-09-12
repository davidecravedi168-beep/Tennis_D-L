(()=>{
  'use strict';
  const VERSION='15.2';
  const n=v=>(typeof v==='number'||(typeof v==='string'&&v.trim()!==''))&&Number.isFinite(Number(v))?Number(v):null;
  const esc=s=>String(s??'—').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const num=(v,d=1)=>n(v)==null?'—':n(v).toLocaleString('it-IT',{minimumFractionDigits:d,maximumFractionDigits:d});
  const pct=v=>n(v)!=null&&n(v)>=0&&n(v)<=1?`${num(n(v)*100)}%`:'—';
  const signed=v=>n(v)==null?'—':`${n(v)>0?'+':''}${num(n(v)*100)}%`;
  const odd=v=>n(v)>1?num(v,2):'—';
  const probability=v=>n(v)!=null&&n(v)>=0&&n(v)<=1?n(v):null;
  const playerName=v=>String(v||'').split(',').reverse().join(' ').trim().replace(/\s+/g,' ');
  function probabilityPair(x={}){
    let a=probability(x.p_a),b=probability(x.p_b);
    if((n(x.p_a)!=null&&a==null)||(n(x.p_b)!=null&&b==null))return [null,null];
    if(a==null&&b==null){const p=probability(x.forecast_prob),side=String(x.forecast_side||'').toUpperCase();if(p==null||!['A','B'].includes(side))return [null,null];a=side==='A'?p:1-p;b=1-a;}
    else if(a==null)a=1-b;else if(b==null)b=1-a;
    if(Math.abs(a+b-1)>.001)return [null,null];
    return [a/(a+b),b/(a+b)];
  }
  function forecastView(x={}){
    const [a,b]=probabilityPair(x),aTenths=a==null?null:Math.round(a*1000),bTenths=a==null?null:1000-aTenths;
    const side=a==null||aTenths===bTenths?null:a>b?'A':'B';
    return {a,b,side,name:side?playerName(x[side==='A'?'player_a':'player_b']):null,labels:a==null?['—','—']:[num(aTenths/10,1)+'%',num(bTenths/10,1)+'%'],summary:a==null?'Pronostico non disponibile':side?'Favorito del modello':'Match in equilibrio'};
  }
  function winnerQuotes(x={},now=Date.now()){
    const rows=Array.isArray(x.market_live?.rows)?x.market_live.rows:[];
    const candidate=String(x.candidate_side||x.candidate||'').toUpperCase();
    return ['A','B'].map(side=>{
      const name=playerName(x[side==='A'?'player_a':'player_b']);
      const matching=rows.filter(r=>r.market==='MATCH_WINNER'&&String(r.side).toUpperCase()===side&&(!r.selection||playerName(r.selection).toLowerCase()===name.toLowerCase()));
      // A newer withdrawn price must never resurrect an older bookmaker quote.
      let row=matching.sort((a,b)=>(timestamp(b.current_updated_at||b.current_odds_updated_at)??Infinity)-(timestamp(a.current_updated_at||a.current_odds_updated_at)??Infinity))[0];
      if(!row&&!matching.length&&candidate===side&&!rows.some(r=>r.market==='MATCH_WINNER'&&String(r.side).toUpperCase()===side))row={current_odds:x.current_odds,current_book:x.current_book,current_updated_at:x.current_odds_updated_at};
      const odds=n(row?.current_odds)>1?n(row.current_odds):null,age=quoteAge(row||{},x,now),book=typeof row?.current_book==='string'&&row.current_book.trim()?row.current_book.trim():null;
      const status=odds==null?'missing':age==null||!book?'unverified':age>30?'stale':'fresh';
      return {side,name,odds,book,age,status,label:odd(odds),note:status==='missing'?'Quota non disponibile':status==='unverified'?'Quota da verificare':status==='stale'?'Quota da aggiornare':'Quota osservata'};
    });
  }
  const stat=(label,value,note='')=>`<div class="tdl15Stat"><span>${esc(label)}</span><b>${esc(value)}</b>${note?`<em>${esc(note)}</em>`:''}</div>`;
  function timestamp(v){if(v==null)return null;const s=String(v),normal=/^\d{8}$/.test(s)?`${s.slice(0,4)}-${s.slice(4,6)}-${s.slice(6,8)}`:s;const t=Date.parse(normal);return Number.isFinite(t)?t:null}
  const date=v=>timestamp(v)==null?'—':new Date(timestamp(v)).toLocaleDateString('it-IT');
  function quoteAge(r,x={},now=Date.now()){
    const stamp=timestamp(r?.current_updated_at||r?.current_odds_updated_at||(!r?x.current_odds_updated_at:null));
    return stamp==null||stamp>now?null:(now-stamp)/60000;
  }
  function marketView(x,r,now=Date.now()){
    const side=x.candidate_side||x.candidate;
    const candidate=side==='A'?x.player_a:side==='B'?x.player_b:null;
    const selection=r?.selection||candidate||'Selezione non disponibile';
    const model=r?n(r.model_prob):n(x.candidate_prob);
    let market=r?n(r.current_market_prob??r.market_prob):null;
    if(!r&&probability(x.market_consensus_a)!=null&&['A','B'].includes(side))market=side==='A'?n(x.market_consensus_a):1-n(x.market_consensus_a);
    return {selection,model,market,edge:model!=null&&market!=null?model-market:null,odds:r?n(r.current_odds):n(x.current_odds),minimum:n(r?.min_acceptable_odds??(!r?x.market_best?.min_acceptable_odds:null)),robust:n(r?.current_robust_ev??(!r?x.current_robust_ev:null)),age:quoteAge(r,x,now),book:r?.current_book||(!r?x.current_book:null),books:r?.current_books??r?.market_books??(!r?x.current_market_books:null)};
  }
  function coverage(x){
    const a=x.player_intel?.a?.sample||{},b=x.player_intel?.b?.sample||{},missing=[];
    if(!n(a.stat_matches))missing.push('statistiche giocatore A');
    if(!n(b.stat_matches))missing.push('statistiche giocatore B');
    if(!n(a.surface_matches)||!n(b.surface_matches))missing.push('campione sulla superficie per uno o entrambi');
    return missing.length?`Copertura incompleta: ${missing.join('; ')}.`:'Campioni di statistiche e superficie disponibili per entrambi i giocatori.';
  }
  function operational(x,r){
    try{if(r&&typeof currentPriceStatus==='function'){const state=currentPriceStatus(r);return {'BET ZONE':'Supera i controlli quota','WATCH PRICE':'Attendi una quota migliore','TEST VALUE':'Solo simulazione','BLOCKED':'Nessuna giocata: controlli non superati','NO PRICE':'Quota non disponibile','STALE':'Quota da aggiornare','PASS':'Nessuna giocata a questa quota'}[state]||'Nessuna giocata'}}catch{}
    return 'Solo analisi · controlli operativi non disponibili';
  }
  function player(p={},x,side){
    const s=p.service||{},r=p.return||{},sample=p.sample||{},context=p.context||{},key=side.toLowerCase();
    const dates=(p.recent_matches||[]).map(z=>timestamp(z.date)).filter(t=>t!=null),last=dates.length?new Date(Math.max(...dates)).toISOString():null;
    return `<section class="tdl15Player"><h4>${esc(p.name||x['player_'+key]||side)}</h4><p class="tdl15Foot">${n(sample.matches)??0} match in archivio · ${n(sample.stat_matches)??0} con statistiche · ${n(sample.surface_matches)??0} sulla superficie.</p><div class="tdl15Grid">${stat('Ranking',p.rank??x['rank_'+key]??'—')}${stat('Elo generale',num(x['elo_'+key],0))}${stat('Elo sulla superficie',n(sample.surface_matches)>0?num(x['surface_elo_'+key],0):'—',!n(sample.surface_matches)?'Campione assente':'')}${stat('Forma nel campione',n(sample.matches)>0?pct(context.form):'—')}${stat('Prime di servizio in campo',pct(s.first_serve_pct))}${stat('Punti vinti al servizio',pct(s.service_points_won))}${stat('Game vinti al servizio',pct(s.service_games_won))}${stat('Ace / doppi falli per match',`${num(s.aces_per_match)} / ${num(s.double_faults_per_match)}`)}${stat('Punti vinti in risposta',pct(r.return_points_won))}${stat('Game vinti in risposta',pct(r.return_games_won))}${stat('Palle break convertite',pct(r.break_points_converted))}${stat('Ultimo match in archivio',date(last),'Non indica i giorni di riposo effettivo')}</div></section>`;
  }
  function getRow(id){try{return typeof bestRowForEvent==='function'?bestRowForEvent(id):null}catch{return null}}
  function dossier(x,r=getRow(x?.event_id)){
    if(!x)return '';
    const m=marketView(x,r),lab=x.market_lab||{},scenarios=lab.scenario||[],pi=x.player_intel||{};
    const score=scenarios.filter(z=>z.market==='SET_SCORE'&&n(z.model_prob)!=null).sort((a,b)=>b.model_prob-a.model_prob)[0];
    const tb=scenarios.find(z=>z.market==='TIEBREAK_IN_MATCH'&&String(z.selection).toUpperCase()==='YES');
    const reasons=(x.no_bet_reasons||[]).map(r=>({robust_EV_nonpositivo:'Vantaggio prudente non positivo',calibration_sample_insufficient:'Campione di calibrazione insufficiente'}[r]||String(r).replaceAll('_',' ')));
    return `<section class="tdl15" aria-label="Dossier del match"><div class="tdl15Head"><h3>Dossier del match</h3><span>DATI E CONTESTO</span></div><div class="tdl15Decision"><div class="tdl15Box"><strong>${esc(operational(x,r))}</strong><p>${esc(reasons.slice(0,3).join(' · ')||'Il pronostico sportivo e la convenienza della quota sono valutazioni diverse.')}</p></div><div class="tdl15Box"><strong>Qualità dati ${num(x.data_quality,0)}/100</strong><p>${esc(coverage(x))}</p></div></div>
      <details class="tdl15Group"><summary>Quote e confronto con il modello</summary><p class="tdl15Foot"><b>Selezione analizzata: ${esc(m.selection)}</b>. I valori qui sotto si riferiscono tutti a questa selezione.</p><div class="tdl15Grid">${stat('Probabilità del modello',pct(m.model))}${stat('Consenso del mercato',pct(m.market))}${stat('Differenza modello / mercato',m.edge==null?'—':`${m.edge>0?'+':''}${num(m.edge*100)} punti %`)}${stat('Rendimento atteso prudente',signed(m.robust))}${stat('Ultima quota osservata',odd(m.odds))}${stat('Soglia quota del modello',odd(m.minimum),'Non equivale a un via libera')}${stat('Quota teorica equa',m.model>0?odd(1/m.model):'—')}${stat('Bookmaker',m.book||'—')}${stat('Bookmaker nel confronto',m.books??'—')}${stat('Età della quota',m.age==null?'Non verificabile':m.age<60?`${num(m.age,0)} min`:`${num(m.age/60)} ore`,m.age==null||m.age>30?'Freschezza da verificare':'')}${stat('Confidenza del modello',`${num(x.confidence,0)} / 100`,'Non è probabilità di vincita')}${stat('Esiti per la calibrazione',x.calibration_sample??'—')}</div><p class="tdl15Foot">Il rendimento atteso prudente considera l’incertezza del modello. Quota minima, freschezza e calibrazione restano vincolanti; una differenza positiva da sola non autorizza una giocata.</p></details>
      <details class="tdl15Group"><summary>Confronta i giocatori: servizio, risposta e forma</summary><div class="tdl15Compare">${player(pi.a,x,'A')}${player(pi.b,x,'B')}</div></details>
      <details class="tdl15Group"><summary>Scenari del match e precedenti</summary><div class="tdl15Grid">${stat('Precedenti disponibili',n(x.h2h_n)==null?'—':`${x.h2h_n} nell’archivio`)}${stat('Numero simulazioni',lab.simulations??'—')}${stat('Giochi totali attesi',num(lab.mean_total_games))}${stat('Punteggio più probabile',score?`${score.selection} · ${pct(score.model_prob)}`:'—')}${stat('Almeno un tie-break',tb?pct(tb.model_prob):'—')}${stat('Tenuta servizio A / B',`${pct(lab.hold_a)} / ${pct(lab.hold_b)}`)}${stat('Forma superficie A / B',`${n(pi.a?.sample?.surface_matches)>0?pct(x.surface_form_a):'—'} / ${n(pi.b?.sample?.surface_matches)>0?pct(x.surface_form_b):'—'}`)}${stat('Campione superficie A / B',`${pi.a?.sample?.surface_matches??'—'} / ${pi.b?.sample?.surface_matches??'—'}`)}</div><p class="tdl15Foot">Punteggio e tie-break sono output di simulazione paper, non mercati automaticamente giocabili. La tenuta del servizio è una stima. Zero precedenti indica assenza nell’archivio disponibile, non in tutta la carriera.</p></details>
      <details class="tdl15Group"><summary>Come leggere questi numeri</summary><p class="tdl15Foot">Elo: forza relativa stimata dai risultati. Forma: risultati nel campione disponibile. Quota equa: reciproco della probabilità, senza margine bookmaker. “—” indica un dato assente o non verificabile. Statistiche storiche, osservazioni di mercato e simulazioni hanno coperture diverse.</p></details></section>`;
  }
  function css(){
    if(document.getElementById('tdl15css'))return;
    const s=document.createElement('style');s.id='tdl15css';s.textContent=`
.tdl15{margin-top:18px;border:1px solid #385570;border-radius:18px;padding:18px;background:linear-gradient(145deg,#102b3b,#0b1b29);color:#e9f4fd;font-size:13px;line-height:1.55;min-width:0}.tdl15Head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.tdl15Head h3{margin:0;font-size:19px;color:#edf8ff}.tdl15Head>span{font-size:10px;letter-spacing:.06em;color:#9fc6e1}.tdl15Decision{display:grid;grid-template-columns:1fr 1fr;gap:12px}.tdl15Box{border:1px solid #385570;border-radius:12px;padding:14px;min-width:0}.tdl15Box strong{display:block;font-size:15px;color:#ddf1ff}.tdl15Box p{font-size:12px;color:#b9cedd;line-height:1.6;margin:8px 0 0}.tdl15Group{border-top:1px solid #385570;margin-top:16px}.tdl15Group>summary{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:50px;padding:6px 0;font-size:14px;font-weight:700;list-style:none;cursor:pointer}.tdl15Group>summary:after{content:'+';font-size:22px;color:#9ddcff}.tdl15Group[open]>summary:after{content:'−'}.tdl15Grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;margin:12px 0}.tdl15Stat{border:1px solid #304d64;border-radius:10px;padding:12px;min-width:0}.tdl15Stat span{display:block;font-size:12px;color:#b9cedd;line-height:1.4}.tdl15Stat b{display:block;font-size:17px;line-height:1.4;margin-top:6px;overflow-wrap:anywhere}.tdl15Stat em{display:block;font-size:11px;font-style:normal;color:#e9ce95;line-height:1.5;margin-top:6px}.tdl15Compare{display:grid;grid-template-columns:1fr 1fr;gap:14px}.tdl15Player{min-width:0}.tdl15Player h4{font-size:16px;margin:12px 0 6px;color:#edf8ff}.tdl15Player .tdl15Grid{grid-template-columns:repeat(2,minmax(0,1fr))}.tdl15Foot{font-size:12px;color:#b9cedd;line-height:1.6;margin:10px 0}.tdl15 :focus-visible{outline:2px solid #9ddcff;outline-offset:4px}@media(max-width:680px){.tdl15{padding:14px}.tdl15Decision,.tdl15Compare{grid-template-columns:1fr}.tdl15Grid{grid-template-columns:repeat(2,minmax(0,1fr))}.tdl15Stat{padding:10px}.tdl15Stat b{font-size:16px}.tdl15Head{flex-wrap:wrap}}
`;document.head.appendChild(s);
  }
  function refresh(){css()}
  const api={version:VERSION,n,timestamp,quoteAge,probabilityPair,forecastView,winnerQuotes,marketView,coverage,dossier,refresh};
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof window!=='undefined')window.TennisDataLens=api;
  if(typeof document==='undefined')return;
  document.readyState==='loading'?document.addEventListener('DOMContentLoaded',refresh,{once:true}):refresh();
})();
