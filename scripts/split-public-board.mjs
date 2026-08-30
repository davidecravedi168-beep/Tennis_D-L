import fs from 'node:fs/promises';

const BOARD='data/quant-board.json';
const FULL='data/quant-board-full.json';
const TARGET_BYTES=575000;
const HARD_BYTES=600000;

const raw=await fs.readFile(BOARD,'utf8');
const fullBoard=JSON.parse(raw);
let board=structuredClone(fullBoard);

// Preserve the complete public payload before optimizing the mobile board.
await fs.writeFile(FULL,JSON.stringify(fullBoard)+'\n','utf8');

const originalHistory=Array.isArray(fullBoard.history)?fullBoard.history.length:0;
const originalRadar=Array.isArray(fullBoard.radar)?fullBoard.radar.length:0;
const originalUpcoming=Array.isArray(fullBoard.upcoming)?fullBoard.upcoming.length:0;

function trimUpcoming({recent=0,marketRows=2,arrayCap=6}={}){
  for(const p of board.upcoming||[]){
    for(const side of ['a','b']){
      const intel=p?.player_intel?.[side];
      if(intel&&Array.isArray(intel.recent_matches)) intel.recent_matches=intel.recent_matches.slice(0,recent);
    }
    if(Array.isArray(p?.market_live?.rows)) p.market_live.rows=p.market_live.rows.slice(0,marketRows);
    if(Array.isArray(p?.market_lab?.priced)) p.market_lab.priced=p.market_lab.priced.slice(0,marketRows);

    // Mobile payload only: cap auxiliary arrays while retaining scalar decision fields.
    const stack=[p];
    const seen=new Set();
    while(stack.length){
      const obj=stack.pop();
      if(!obj||typeof obj!=='object'||seen.has(obj)) continue;
      seen.add(obj);
      for(const [k,v] of Object.entries(obj)){
        if(Array.isArray(v)){
          if(k!=='recent_matches'&&k!=='rows'&&k!=='priced'&&v.length>arrayCap) obj[k]=v.slice(0,arrayCap);
          for(const item of obj[k]) if(item&&typeof item==='object') stack.push(item);
        }else if(v&&typeof v==='object') stack.push(v);
      }
    }
  }
}

function applyShape({history,radar,upcoming,recent,marketRows,arrayCap}){
  // Rebuild every profile from the untouched full board so adaptive passes are deterministic.
  board=structuredClone(fullBoard);
  if(Array.isArray(board.history)) board.history=board.history.slice(0,history);
  if(Array.isArray(board.radar)) board.radar=board.radar.slice(0,radar);
  if(Array.isArray(board.upcoming)) board.upcoming=board.upcoming.slice(0,upcoming);
  trimUpcoming({recent,marketRows,arrayCap});
  board.meta=board.meta||{};
  board.meta.public_payload={
    profile:'MOBILE_COMPACT_V3',
    full_payload_file:FULL,
    full_history_records:originalHistory,
    mobile_history_records:board.history?.length||0,
    full_radar_records:originalRadar,
    mobile_radar_records:board.radar?.length||0,
    full_upcoming_records:originalUpcoming,
    mobile_upcoming_records:board.upcoming?.length||0,
    mobile_recent_matches_per_player:recent,
    mobile_market_rows_per_match:marketRows,
    no_audit_data_deleted:true
  };
}

async function write(){
  const out=JSON.stringify(board)+'\n';
  await fs.writeFile(BOARD,out,'utf8');
  return Buffer.byteLength(out);
}

const profiles=[
  {history:80,radar:220,upcoming:60,recent:1,marketRows:3,arrayCap:8},
  {history:50,radar:180,upcoming:50,recent:0,marketRows:2,arrayCap:6},
  {history:30,radar:140,upcoming:40,recent:0,marketRows:1,arrayCap:4},
  {history:20,radar:100,upcoming:30,recent:0,marketRows:0,arrayCap:3},
  {history:12,radar:70,upcoming:24,recent:0,marketRows:0,arrayCap:2}
];

let bytes=Infinity,used=null;
for(const p of profiles){
  applyShape(p);
  bytes=await write();
  used=p;
  if(bytes<=TARGET_BYTES) break;
}
if(bytes>HARD_BYTES) throw new Error(`MOBILE_BOARD_STILL_TOO_LARGE:${bytes}`);

console.log(JSON.stringify({ok:true,profile:'MOBILE_COMPACT_V3',board_bytes:bytes,full_bytes:Buffer.byteLength(raw),history_full:originalHistory,history_mobile:board.history?.length||0,radar_full:originalRadar,radar_mobile:board.radar?.length||0,upcoming_full:originalUpcoming,upcoming_mobile:board.upcoming?.length||0,shape:used,full_payload:FULL}));
