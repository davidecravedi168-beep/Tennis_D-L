// Shared by the scanner and browser. No network calls and no model probabilities.
export const POLICY = Object.freeze({maxAge:10,maxSpread:5,ttl:4,minWindow:90,minRoi:.005,buffer:.0025});
export const number = v => {
  if (typeof v !== 'number' && typeof v !== 'string') return null;
  if (typeof v === 'string' && !/^\s*-?\d+(?:[.,]\d+)?\s*$/.test(v)) return null;
  const n=Number(String(v).replace(',','.')); return Number.isFinite(n)?n:null;
};
export const timestamp = v => typeof v==='string' && v.trim() ? Date.parse(v) : NaN;
export const age = (v,now=Date.now()) => {const t=timestamp(v);return Number.isFinite(t)&&t<=now+30000?Math.max(0,(now-t)/60000):Infinity};
export const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const halfLine=n=>Number.isFinite(n)&&Math.abs(n*2-Math.round(n*2))<1e-8&&Math.abs(Math.round(n*2)%2)===1;
export function allocate(total,qa,qb,cost=0){
  [total,qa,qb,cost]=[total,qa,qb,cost].map(number);
  if(total===null||qa===null||qb===null||cost===null||total<2||total>1000000||qa<=1||qb<=1||qa>1000||qb>1000||cost<0||cost>total)return null;
  const cents=Math.round(total*100),fees=Math.ceil(cost*100-1e-8),base=Math.floor(cents*qb/(qa+qb));let best=null;
  for(let ca=Math.max(1,base-2);ca<=Math.min(cents-1,base+2);ca++){
    const cb=cents-ca,ra=Math.floor(ca*qa+1e-8),rb=Math.floor(cb*qb+1e-8),worst=Math.min(ra,rb);
    if(!best||worst>best.worst)best={ca,cb,ra,rb,worst};
  }
  if(!best)return null;
  const spent=cents/100,profit=(best.worst-cents-fees)/100;
  return {sa:best.ca/100,sb:best.cb/100,ra:best.ra/100,rb:best.rb/100,worst:best.worst/100,spent,cost:fees/100,profit,profitA:(best.ra-cents-fees)/100,profitB:(best.rb-cents-fees)/100,roi:profit/spent};
}
export function marketGroups(obj,now=Date.now()){
  const groups=new Map();
  for(const [book,markets] of Object.entries(obj?.bookmakers||{})){
    if(!book.trim()||!Array.isArray(markets))continue;
    const offers=new Map(),duplicates=new Set();
    for(const m of markets){
      const label=String(m?.name||'').trim().toLowerCase();
      if(!['ml','totals (games)','spread (games)'].includes(label))continue;
      for(const o of Array.isArray(m.odds)?m.odds:[]){
        let market,line=null,a,b;
        if(label==='ml'){if(number(o.draw)>1)continue;market='MATCH_WINNER_2WAY';a=number(o.home);b=number(o.away)}
        else if(label==='totals (games)'){market='TOTAL_GAMES_2WAY';line=number(o.hdp??o.max);if(!halfLine(line)||line<=0)continue;a=number(o.over);b=number(o.under)}
        else {market='GAME_HANDICAP_2WAY';line=number(o.hdp);if(!halfLine(line))continue;a=number(o.home);b=number(o.away)}
        if(!(a>1&&b>1&&a<=1000&&b<=1000))continue;
        const sum=1/a+1/b;if(sum<.97||sum>1.25)continue;
        const updated=m.updatedAt||o.updatedAt||null,key=`${market}|${line??''}`;
        if(offers.has(key))duplicates.add(key);
        offers.set(key,{book,a,b,updated_at:updated,age_min:age(updated,now),p:(1/a)/sum,market,line});
      }
    }
    for(const [key,row] of offers){if(duplicates.has(key))continue;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(row)}
  }
  return groups;
}
export function analyzeMarkets(event,obj,now=Date.now()){
  if(!obj||norm(event.home)!==norm(obj.home)||norm(event.away)!==norm(obj.away))return [];
  if(obj.id!=null&&String(event.id)!==String(obj.id))return [];
  if(obj.sport&& !norm(obj.sport.slug||obj.sport.name).includes('tennis'))return [];
  const result=[];
  for(const [key,rows] of marketGroups(obj,now)){
    const median=[...rows].sort((a,b)=>a.p-b.p)[Math.floor(rows.length/2)].p;
    const pairs=[];
    for(const a of rows)for(const b of rows){
      if(norm(a.book)===norm(b.book))continue;
      const alloc=allocate(100,a.a,b.b);if(!alloc)continue;
      const raw=1/(1/a.a+1/b.b)-1,spread=Math.abs(timestamp(a.updated_at)-timestamp(b.updated_at))/60000;
      const expiry=Math.min(timestamp(a.updated_at)+POLICY.maxAge*60000,timestamp(b.updated_at)+POLICY.maxAge*60000,now+POLICY.ttl*60000,timestamp(event.date));
      const reasons=[];
      if(raw<POLICY.minRoi)reasons.push('MARGINE_TROPPO_BASSO');
      if(a.age_min>POLICY.maxAge||b.age_min>POLICY.maxAge)reasons.push('QUOTA_NON_FRESCA');
      if(!Number.isFinite(spread)||spread>POLICY.maxSpread)reasons.push('QUOTE_NON_SINCRONE');
      if(Math.max(Math.abs(a.p-median),Math.abs(b.p-median))>.15)reasons.push('QUOTA_OUTLIER');
      if(alloc.roi<=POLICY.buffer)reasons.push('BUFFER_NON_SUPERATO');
      if(!Number.isFinite(expiry)||(expiry-now)/1000<POLICY.minWindow)reasons.push('FINESTRA_ESECUZIONE_TROPPO_CORTA');
      if(obj.status&&obj.status!=='pending')reasons.push('EVENTO_NON_PREMATCH');
      pairs.push({a,b,alloc,raw,spread,expiry,reasons});
    }
    pairs.sort((a,b)=>Number(a.reasons.length>0)-Number(b.reasons.length>0)||b.raw-a.raw);
    const best=pairs[0],first=rows[0];
    const selection_a=first.market==='TOTAL_GAMES_2WAY'?`Over ${first.line}`:first.market==='GAME_HANDICAP_2WAY'?`${event.home} ${first.line>0?'+':''}${first.line}`:event.home;
    const selection_b=first.market==='TOTAL_GAMES_2WAY'?`Under ${first.line}`:first.market==='GAME_HANDICAP_2WAY'?`${event.away} ${-first.line>0?'+':''}${-first.line}`:event.away;
    const row={event_id:String(event.id),start_at:event.date,player_a:event.home,player_b:event.away,tournament:event.league?.name||'Tennis',market:first.market,line:first.line,market_key:key,selection_a,selection_b,market_depth:rows.length,
      quotes:rows.map(({book,a,b,updated_at,age_min})=>({book,a,b,updated_at,age_min:Number.isFinite(age_min)?age_min:null})),status:'NON_CERTIFICATA',reasons:['COPERTURA_INSUFFICIENTE'],raw_roi:null};
    if(best){const {a,b,alloc,raw,spread,expiry,reasons}=best;Object.assign(row,{status:reasons.length?'NON_CERTIFICATA':'SUREBET',reasons,book_a:a.book,book_b:b.book,odds_a:a.a,odds_b:b.b,updated_a:a.updated_at,updated_b:b.updated_at,raw_roi:raw,buffered_roi:alloc.roi-POLICY.buffer,safety_buffer:POLICY.buffer,timestamp_spread_min:Number.isFinite(spread)?spread:null,expires_at:Number.isFinite(expiry)?new Date(expiry).toISOString():null,execution_window_sec:Number.isFinite(expiry)?Math.max(0,Math.floor((expiry-now)/1000)):0,same_market_verified:true,settlement_rules_verified:false,certainty_scope:'MATHEMATICAL_ODDS_ONLY',detected_at:new Date(now).toISOString(),stake_100:{stake_a:alloc.sa,stake_b:alloc.sb,return_if_a:alloc.ra,return_if_b:alloc.rb,worst_return:alloc.worst,profit:alloc.profit,roi:alloc.roi}})}
    result.push(row);
  }
  return result;
}
export function activeOpportunities(board,now=Date.now()){
  if(board?.meta?.status!=='READY'||age(board.meta.updated_at,now)>POLICY.maxAge)return [];
  return (Array.isArray(board.opportunities)?board.opportunities:[]).filter(r=>r.status==='SUREBET'&&Array.isArray(r.reasons)&&!r.reasons.length&&['MATCH_WINNER_2WAY','TOTAL_GAMES_2WAY','GAME_HANDICAP_2WAY'].includes(r.market)&&(r.market==='MATCH_WINNER_2WAY'||halfLine(r.line))&&r.raw_roi>=POLICY.minRoi&&r.same_market_verified===true&&norm(r.book_a)!==norm(r.book_b)&&r.book_a&&r.book_b&&timestamp(r.start_at)>now&&timestamp(r.expires_at)>now&&age(r.updated_a,now)<=POLICY.maxAge&&age(r.updated_b,now)<=POLICY.maxAge&&Math.abs(timestamp(r.updated_a)-timestamp(r.updated_b))<=POLICY.maxSpread*60000&&allocate(100,r.odds_a,r.odds_b)?.roi>POLICY.buffer);
}
export function prioritize(events,cache,cursor=0,limit=20,now=Date.now()){
  const ranked=events.map(e=>{const groups=marketGroups(cache?.[e.id]?.odds,now);const covered=[...groups.values()].some(r=>r.filter(q=>q.age_min<=POLICY.maxAge).length>=2);const known=[...groups.values()].some(r=>r.length>=2);return {e,rank:(covered?100:known?50:0)+(timestamp(e.date)-now<8*3600000?20:0)}}).sort((a,b)=>b.rank-a.rank||timestamp(a.e.date)-timestamp(b.e.date));
  const n=Math.max(0,limit),priority=ranked.slice(0,Math.max(0,n-5)).map(x=>x.e),rest=ranked.filter(x=>!priority.some(p=>p.id===x.e.id));
  for(let i=0;i<Math.min(5,rest.length);i++)priority.push(rest[(Math.max(0,cursor)+i)%rest.length].e);
  return priority.slice(0,n);
}
