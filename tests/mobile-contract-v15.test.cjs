const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8'), shell=fs.readFileSync('premium-shell-v1.js','utf8');
test('mobile viewport and safe areas are mandatory',()=>{assert.match(html,/viewport-fit=cover/);assert.match(html,/env\(safe-area-inset-top\)/);assert.match(html,/env\(safe-area-inset-bottom\)/)});
test('touch navigation has five large targets',()=>{assert.match(html,/grid-template-columns:repeat\(5,1fr\)/);assert.match(html,/touch-action:manipulation/);assert.match(html,/\.nav\{[^}]*min-height:55px/s);assert.match(html,/@media\(max-width:620px\)/)});
test('mobile layout prevents horizontal card overflow',()=>{assert.match(html,/minmax\(0,1fr\)/);assert.match(html,/text-overflow:ellipsis/);assert.doesNotMatch(shell,/behavior:'smooth'/)});
test('production bottom nav exposes five primary touch destinations',()=>{
 const nav=(html.match(/<nav class="bottomNav"[\\s\\S]*?<\\/nav>/)||[''])[0];
 for(const go of ['bets','live','matches','record','bankroll']) assert.match(nav,new RegExp('data-go="'+go+'"'),go+' missing');
 assert.equal((nav.match(/<button class="nav/g)||[]).length,5,'primary nav must have exactly five buttons');
});
test('premium shell supports the same routed destinations',()=>{for(const go of ['bets','live','matches','record','bankroll'])assert.ok(shell.includes(go),go+' route missing')});
