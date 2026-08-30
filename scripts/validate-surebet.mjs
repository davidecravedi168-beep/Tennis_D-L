import fs from 'node:fs';
const file=process.argv[2]||'data/surebet-board.json';
const x=JSON.parse(fs.readFileSync(file,'utf8'));
const errors=[];
if(!x||typeof x!=='object')errors.push('BOARD_MISSING');
if(!x.meta||typeof x.meta!=='object')errors.push('META_MISSING');
if(!Array.isArray(x.opportunities))errors.push('OPPORTUNITIES_INVALID');
for(const r of x.opportunities||[]){
  if(r.status!=='SUREBET')errors.push(`STATUS:${r.event_id}`);
  if(!(Number(r.odds_a)>1&&Number(r.odds_b)>1))errors.push(`ODDS:${r.event_id}`);
  if(!r.book_a||!r.book_b||r.book_a===r.book_b)errors.push(`BOOKS:${r.event_id}`);
  const s=1/Number(r.odds_a)+1/Number(r.odds_b);
  if(!(s<1))errors.push(`NOT_ARB:${r.event_id}`);
  if(!(Number(r.raw_roi)>0))errors.push(`ROI:${r.event_id}`);
  if(!r.stake_100||Math.abs(Number(r.stake_100.stake_a)+Number(r.stake_100.stake_b)-100)>.02)errors.push(`STAKE:${r.event_id}`);
  const worst=Math.min(Number(r.stake_100.stake_a)*Number(r.odds_a),Number(r.stake_100.stake_b)*Number(r.odds_b));
  if(worst<100)errors.push(`ROUNDING:${r.event_id}`);
}
if(errors.length){console.error(JSON.stringify({ok:false,errors},null,2));process.exit(1)}
console.log(JSON.stringify({ok:true,opportunities:x.opportunities.length,status:x.meta?.status||null}));
