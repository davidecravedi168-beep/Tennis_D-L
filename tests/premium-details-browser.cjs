// Browser regressions run in GitHub Actions against the complete application.
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs');
const base=process.env.TEP_TEST_URL||'http://127.0.0.1:8765/';
const board=JSON.parse(fs.readFileSync('data/quant-board.json','utf8'));
const seed=board.upcoming[0],stamp=new Date().toISOString();
function match(id,a,b,p,qa,qb){return {...structuredClone(seed),event_id:id,player_a:a,player_b:b,p_a:p,p_b:1-p,forecast_side:p>.5?'A':'B',forecast_prob:Math.max(p,1-p),priority:0,candidate_side:'A',current_odds:qa,current_book:'Alpha',current_odds_updated_at:stamp,market_live:{rows:[{market:'MATCH_WINNER',side:'B',selection:b,current_odds:qb,current_book:'Beta',current_updated_at:stamp},{market:'MATCH_WINNER',side:'A',selection:a,current_odds:qa,current_book:'Alpha',current_updated_at:stamp}]}}}
const fixture={...board,meta:{...board.meta,data_refreshed_at:stamp},upcoming:[match('qa-long','Noha Akugue, Noma','Maristany Zuleta de Reales, Guiomar',.444916,2.2,1.61),match('qa-a','Droguet, Titouan','Budkov Kjaer, Nicolai',.552737,1.57,2.25),match('qa-tie','Giocatore senza foto A','Giocatore senza foto B',.5,null,null)],history:board.history.slice(0,5)};
fixture.upcoming[0].tournament='WTA 125K - Montreux, Switzerland';fixture.upcoming[0].tour='wta';
fixture.upcoming[1].tournament='Challenger - Cassis, France';fixture.upcoming[1].tour='atp';
fixture.upcoming[2].tournament='ATP - Test';fixture.upcoming[2].tour='atp';
fs.mkdirSync('test-results',{recursive:true});
async function geometry(page){
 const errors=await page.evaluate(()=>{
  const out=[],rect=e=>e.getBoundingClientRect();
  if(document.documentElement.scrollWidth>innerWidth+1)out.push('document overflows horizontally');
  for(const row of document.querySelectorAll('.tp-match-row')){
   const name=row.querySelector('.tp-match-player-copy'),prob=row.querySelector('.tp-row-prob');
   if(rect(name).right>rect(prob).left-1)out.push('player name overlaps probability');
   for(const el of [name,name.querySelector('strong'),prob])if(el.scrollWidth>el.clientWidth+1)out.push('player row clips content: '+el.textContent);
  }
  for(const el of document.querySelectorAll('.tp-player-copy,.tp-probability,.tp-confidence,.tdl15Box,.tdl15Stat,.tp-live-card,.tp-record-list>div'))if(el.scrollWidth>el.clientWidth+1)out.push('content clips: '+el.className);
  return out;
 });assert.deepEqual(errors,[]);
}
async function run(engine,width,round){
 const browser=await ({chromium,webkit}[engine]).launch({headless:true});
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<700,isMobile:width<700,locale:'it-IT',reducedMotion:'reduce'});
 const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/data/quant-board.json*',r=>r.fulfill({json:fixture}));
 await page.route('https://**/*',r=>r.abort()); // Deterministic initials also exercise failed-photo fallback.
 const prefix=`test-results/${engine}-${width}-round${round}`;
 try{
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await page.locator('.tp-probability').first().waitFor();
  await page.getByRole('button',{name:'MATCH',exact:true}).click();
  await page.getByRole('heading',{name:'Partite',exact:true}).waitFor();
  const card=page.locator('.tp-match-card[data-open-event="qa-long"]');
  await card.waitFor();await geometry(page);
  assert.equal(await card.locator('.is-predicted').getAttribute('data-player-side'),'B');
  assert.equal(await card.locator('[data-player-side="A"] .tp-row-prob strong').innerText(),'44,5%');
  assert.equal(await card.locator('[data-player-side="B"] .tp-row-prob strong').innerText(),'55,5%');
  assert.equal(await card.locator('[data-player-side="A"] .tp-player-quote b').innerText(),'2,20');
  assert.equal(await card.locator('[data-player-side="B"] .tp-player-quote b').innerText(),'1,61');
  assert.equal(await page.locator('[data-open-event="qa-tie"] .is-predicted').count(),0);
  const colors=await card.locator('.tp-row-prob>strong').evaluateAll(es=>es.map(e=>getComputedStyle(e).color));assert.notEqual(colors[0],colors[1]);assert.equal(colors[1],'rgb(202, 255, 61)');
  await page.screenshot({path:prefix+'-matches.png',fullPage:true});
  await page.getByRole('button',{name:'Challenger',exact:true}).click();assert.equal(await page.locator('.tp-match-card').count(),1);
  await page.getByRole('button',{name:'Tutti',exact:true}).click();
  await page.getByRole('searchbox').fill('Maristany');await page.waitForFunction(()=>document.querySelectorAll('.tp-match-card').length===1);
  await card.click();await page.getByRole('heading',{name:'Analisi match',exact:true}).waitFor();await geometry(page);
  assert.equal(await page.locator('.tp-probability.is-predicted').getAttribute('data-player-side'),'B');
  await page.getByText('Quote e confronto con il modello',{exact:true}).click();
  await page.getByRole('button',{name:'Salva match',exact:true}).click();
  assert.ok(await page.locator('.tdl15Group').first().getAttribute('open')!==null,'dossier stays open after saving');
  await page.getByText('Confronta i giocatori: servizio, risposta e forma',{exact:true}).click();await geometry(page);
  await page.screenshot({path:prefix+'-analysis.png',fullPage:true});
  for(const [button,title] of [['LIVE','Live'],['RECORD','Track Record'],['BANKROLL','Bankroll'],['MATCH','Partite']]){
   await page.getByRole('button',{name:button,exact:true}).click();await page.getByRole('heading',{name:title,exact:true}).waitFor();
   assert.equal(await page.getByRole('button',{name:button,exact:true}).getAttribute('aria-current'),'page');await geometry(page);
  }
  await page.getByRole('button',{name:'Apri menu',exact:true}).click();
  await page.locator('#tpMenu').getByRole('button',{name:'Salvati'}).click();await page.getByRole('heading',{name:'Salvati e seguiti',exact:true}).waitFor();assert.equal(await page.locator('.tp-match-card[data-open-event="qa-long"]').count(),1);
  await page.getByRole('button',{name:'EDGE',exact:true}).click();await page.locator('.tp-kicker').waitFor();await geometry(page);
  await page.getByRole('button',{name:'Apri menu',exact:true}).click();await page.getByRole('button',{name:'Chiudi menu',exact:true}).press('Escape');assert.equal(await page.locator('#tpMenuBtn').getAttribute('aria-expanded'),'false');
  assert.deepEqual(errors,[]);console.log(`PASS ${engine} ${width}px round ${round}`);
 }catch(e){await page.screenshot({path:prefix+'-failure.png',fullPage:true}).catch(()=>{});throw e;}finally{await browser.close();}
}
(async()=>{for(const round of [1,2])for(const engine of ['chromium','webkit'])for(const width of [320,390,430,1024])await run(engine,width,round)})().catch(e=>{console.error(e);process.exitCode=1});
