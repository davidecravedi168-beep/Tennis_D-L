import fs from 'node:fs/promises';

const BOARD='data/quant-board.json';
const FULL='data/quant-board-full.json';
const MAX_BYTES=575000;

const raw=await fs.readFile(BOARD,'utf8');
const board=JSON.parse(raw);

// Preserve the complete public payload before optimizing the mobile board.
await fs.writeFile(FULL,JSON.stringify(board)+'\n','utf8');

const originalHistory=Array.isArray(board.history)?board.history.length:0;
const originalUpcoming=Array.isArray(board.upcoming)?board.upcoming.length:0;

function trimRecentMatches(limit){
  for(const p of board.upcoming||[]){
    for(const side of ['a','b']){
      const intel=p?.player_intel?.[side];
      if(intel&&Array.isArray(intel.recent_matches)) intel.recent_matches=intel.recent_matches.slice(0,limit);
    }
  }
}

function writeMeta(historyLimit,recentLimit){
  board.meta=board.meta||{};
  board.meta.public_payload={
    profile:'MOBILE_COMPACT_V1',
    full_payload_file:FULL,
    full_history_records:originalHistory,
    mobile_history_records:Math.min(originalHistory,historyLimit),
    full_upcoming_records:originalUpcoming,
    mobile_recent_matches_per_player:recentLimit,
    no_audit_data_deleted:true
  };
}

async function compact(historyLimit,recentLimit){
  if(Array.isArray(board.history)) board.history=board.history.slice(0,historyLimit);
  trimRecentMatches(recentLimit);
  writeMeta(historyLimit,recentLimit);
  const out=JSON.stringify(board)+'\n';
  await fs.writeFile(BOARD,out,'utf8');
  return Buffer.byteLength(out);
}

let bytes=await compact(120,2);
if(bytes>MAX_BYTES) bytes=await compact(80,1);
if(bytes>MAX_BYTES) bytes=await compact(40,1);
if(bytes>600000) throw new Error(`MOBILE_BOARD_STILL_TOO_LARGE:${bytes}`);

console.log(JSON.stringify({ok:true,board_bytes:bytes,full_bytes:Buffer.byteLength(raw),history_full:originalHistory,history_mobile:board.history?.length||0,full_payload:FULL}));
