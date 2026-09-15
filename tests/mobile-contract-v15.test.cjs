const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const html=fs.readFileSync('index.html','utf8'), shell=fs.readFileSync('premium-shell-v1.js','utf8');
test('mobile viewport and safe areas are mandatory',()=>{assert.match(html,/viewport-fit=cover/);assert.match(html,/env\(safe-area-inset-top\)/);assert.match(html,/env\(safe-area-inset-bottom\)/)});
test('touch navigation has five large targets',()=>{assert.match(html,/grid-template-columns:repeat\(5,1fr\)/);assert.match(html,/touch-action:manipulation/);assert.match(html,/\.nav\{[^}]*min-height:55px/s);assert.match(html,/@media\(max-width:620px\)/)});
test('mobile layout prevents horizontal card overflow',()=>{assert.match(html,/minmax\(0,1fr\)/);assert.match(html,/text-overflow:ellipsis/);assert.doesNotMatch(shell,/behavior:'smooth'/)});
test('premium shell keeps five primary destinations',()=>{for(const x of ['Oggi','Partite','Edge','Storico','Altro'])assert.ok(shell.includes(x),x+' missing')});
