import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url)),tmp=await fs.mkdtemp(path.join(os.tmpdir(),'tep-surebet-'));
const now=Date.now(),iso=n=>new Date(now+n).toISOString();
const events=Array.from({length:25},(_,i)=>({id:String(i+1),home:'Player '+i,away:'Opponent '+i,date:iso(3600000+i*60000),league:{name:'ATP Test'},status:'pending',sport:{slug:'tennis'}}));
const payload=e=>({...e,bookmakers:{Alpha:[{name:'ML',updatedAt:iso(0),odds:[{home:2.2,away:1.72}]}],Beta:[{name:'ML',updatedAt:iso(0),odds:[{home:1.8,away:2.05}]}]}});
const put=(f,x)=>fs.writeFile(path.join(tmp,f),JSON.stringify(x));
const read=async f=>JSON.parse(await fs.readFile(path.join(tmp,f),'utf8'));
const run=(args=[],key='test')=>execFileSync(process.execPath,['--import',path.join(tmp,'mock.mjs'),path.join(tmp,'surebet-engine.mjs'),...args],{cwd:tmp,env:{...process.env,ODDS_API_KEY:key},encoding:'utf8'});
try{
 await fs.mkdir(path.join(tmp,'scripts'));await fs.mkdir(path.join(tmp,'data'));
 for(const f of ['surebet-engine.mjs','scripts/surebet-core.mjs','scripts/surebet-cache.mjs','scripts/odds-budget.mjs','scripts/validate-surebet.mjs'])await fs.copyFile(path.join(root,f),path.join(tmp,f));
 await put('fixtures.json',{events,payloads:events.map(payload)});
 await fs.writeFile(path.join(tmp,'mock.mjs'),`import fs from 'node:fs'; const x=JSON.parse(fs.readFileSync('fixtures.json')); globalThis.fetch=async u=>{u=new URL(u);fs.appendFileSync('calls.txt',u.pathname+'\\n');if(u.pathname.endsWith('/bookmakers/selected'))return new Response(JSON.stringify(['Alpha','Beta']));if(u.pathname.endsWith('/events'))return new Response(JSON.stringify(x.events));if(u.pathname.endsWith('/odds/multi'))return new Response(JSON.stringify(x.payloads.filter(e=>u.searchParams.get('eventIds').split(',').includes(e.id))));throw new Error('UNEXPECTED_FETCH')};`);
 // Books + event discovery leaves only one multi page in the three-call run budget.
 run();let b=await read('data/surebet-board.json');assert.equal(b.meta.api_calls,3);assert.equal(b.meta.events_scanned,10);assert.equal(b.opportunities.length,10);
 execFileSync(process.execPath,[path.join(tmp,'scripts/validate-surebet.mjs')],{cwd:tmp});console.log('PASS discovery respects 3-call budget and validates board');
 const before=await fs.readFile(path.join(tmp,'calls.txt'),'utf8');run(['--reuse-only'],'');b=await read('data/surebet-board.json');assert.equal(b.meta.api_calls,0);assert.equal(b.opportunities.length,10);assert.equal(await fs.readFile(path.join(tmp,'calls.txt'),'utf8'),before);console.log('PASS cached quotes create board with zero calls and no key');
 await put('data/odds-budget.json',{requests:Array.from({length:60},()=>({at:now,source:'surebet'}))});run();b=await read('data/surebet-board.json');assert.equal(b.meta.status,'API_PAUSA');assert.equal(b.opportunities.length,0);assert.equal(await fs.readFile(path.join(tmp,'calls.txt'),'utf8'),before);console.log('PASS scanner sub-budget pauses without outbound request');
 await put('data/odds-budget.json',{requests:Array.from({length:480},()=>({at:now,source:'quant'}))});run();b=await read('data/surebet-board.json');assert.equal(b.meta.status,'API_PAUSA');assert.equal(b.opportunities.length,0);console.log('PASS shared daily cap');
 await put('data/odds-budget.json',{requests:Array.from({length:90},()=>({at:now,source:'live'}))});run();assert.equal((await read('data/surebet-board.json')).meta.status,'API_PAUSA');console.log('PASS shared rolling hourly cap');
 await put('data/odds-budget.json',{requests:[],blocked_until:now+600000});run();assert.equal((await read('data/surebet-board.json')).meta.status,'API_PAUSA');console.log('PASS shared provider cooldown');
 await put('data/odds-budget.json',{requests:[]});
 await fs.writeFile(path.join(tmp,'mock.mjs'),`globalThis.fetch=async()=>new Response('{}',{status:429,headers:{'retry-after':'600'}});`);run();assert.equal((await read('data/surebet-board.json')).meta.status,'API_PAUSA');assert((await read('data/odds-budget.json')).blocked_until>=now+600000);console.log('PASS HTTP 429 persists shared cooldown');
 // A withdrawal replaces all old lines, including extra markets.
 await fs.writeFile(path.join(tmp,'withdraw.mjs'),`import {rememberOdds} from './scripts/surebet-cache.mjs';await rememberOdds(${JSON.stringify([{...events[0],bookmakers:{}}])},'quant');`);execFileSync(process.execPath,[path.join(tmp,'withdraw.mjs')],{cwd:tmp});run(['--reuse-only']);b=await read('data/surebet-board.json');assert(!b.checked.some(r=>r.event_id==='1'));console.log('PASS withdrawn event cannot revive stale quotes');
 // Missing key must remain visibly distinct from an empty successful scan.
 run([],'');b=await read('data/surebet-board.json');assert.equal(b.meta.status,'SETUP');assert.equal(b.opportunities.length,0);console.log('PASS missing key fails closed');
 console.log(JSON.stringify({ok:true,integration_tests:9}));
}finally{await fs.rm(tmp,{recursive:true,force:true})}
