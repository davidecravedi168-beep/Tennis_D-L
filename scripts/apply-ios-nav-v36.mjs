import fs from 'node:fs';

const shellPath='premium-shell-v1.js';
const indexPath='index.html';
const manifestPath='manifest.webmanifest';

let shell=fs.readFileSync(shellPath,'utf8');
let index=fs.readFileSync(indexPath,'utf8');
let manifest=fs.readFileSync(manifestPath,'utf8');

function replaceOnce(text,from,to,label){
  if(text.includes(to)) return text;
  if(!text.includes(from)) throw new Error(`Missing ${label}`);
  // A string replacement treats `$$` as an escape for a single dollar sign.
  // Several generated snippets intentionally call the `$$` query-all helper,
  // so return the replacement from a function to preserve it byte-for-byte.
  return text.replace(from,()=>to);
}

shell=replaceOnce(shell,"const VERSION='TEP_FULL_PREMIUM_UI_V3_5';","const VERSION='TEP_FULL_PREMIUM_UI_V3_8';",'V3.5 version marker');
shell=replaceOnce(shell,"if(window.__TEP_FULL_PREMIUM_UI_V35)return;\nwindow.__TEP_FULL_PREMIUM_UI_V35=true;","if(window.__TEP_FULL_PREMIUM_UI_V38)return;\nwindow.__TEP_FULL_PREMIUM_UI_V38=true;",'V3.5 runtime guard');

const oldNav='<nav class="tp-nav"><button data-route="home"><i>⌂</i><span>Home</span></button><button data-route="explore"><i>🎾</i><span>Partite</span></button><button data-route="analysis"><i>◎</i><span>Analisi</span></button><button data-route="mine"><i>★</i><span>Salvati</span></button></nav>';
const newNav='<nav class="tp-nav" aria-label="Navigazione principale"><a href="#tp-home" data-route="home"><i>⌂</i><span>Home</span></a><a href="#tp-explore" data-route="explore"><i>🎾</i><span>Partite</span></a><a href="#tp-analysis" data-route="analysis"><i>◎</i><span>Analisi</span></a><a href="#tp-mine" data-route="mine"><i>★</i><span>Salvati</span></a></nav>';
shell=replaceOnce(shell,oldNav,newNav,'bottom navigation markup');
shell=shell.replaceAll('.tp-nav button','.tp-nav [data-route]');

const oldInstall="function install(){\n  document.body.classList.add('tp-v3');let style=$('#tpV3Style');if(!style){style=document.createElement('style');style.id='tpV3Style';document.head.appendChild(style)}style.textContent=CSS;\n  let root=$('#tpRoot');if(!root){root=document.createElement('div');root.id='tpRoot';document.body.appendChild(root)}root.innerHTML=shell();render(false);bindRoot();document.documentElement.dataset.tepFullUi=VERSION;\n}";
const newInstall=`function reportUiError(err,stage){const msg=String(err?.message||err||'errore sconosciuto').slice(0,180);document.documentElement.dataset.tepUiError=stage+': '+msg;console.error('[TEP UI]',stage,err)}
function safeRender(stage='render'){try{render(false);delete document.documentElement.dataset.tepUiError;return true}catch(err){reportUiError(err,stage);return false}}
function install(){
  document.body.classList.add('tp-v3');let style=$('#tpV3Style');if(!style){style=document.createElement('style');style.id='tpV3Style';document.head.appendChild(style)}style.textContent=CSS;
  let root=$('#tpRoot');if(!root){root=document.createElement('div');root.id='tpRoot';document.body.appendChild(root)}root.innerHTML=shell();bindRoot();safeRender('install');document.documentElement.dataset.tepFullUi=VERSION;
}`;
shell=replaceOnce(shell,oldInstall,newInstall,'install binding order');

const oldApply="function applyView(){const view=$('#tpView');if(!view)return;view.innerHTML=screenHtml();$$('.tp-nav [data-route]').forEach(b=>b.classList.toggle('on',b.dataset.route===state.screen));const fresh=$('.tp-fresh');if(fresh)fresh.textContent=freshness();queueMicrotask(()=>hydrate(view))}";
const newApply=`const ROUTES=new Set(['home','explore','analysis','mine','live','record']);
function navRouteFromHash(){const m=String(location.hash||'').match(/^#tp-(home|explore|analysis|mine|live|record)$/);return m?m[1]:null}
function syncNav(){
  $$('.tp-nav [data-route]').forEach(el=>{const on=el.dataset.route===state.screen;el.classList.toggle('on',on);if(on)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current')});
}
function syncRouteHash(name){const next=ROUTES.has(name)?name:'home',hash='#tp-'+next;if(location.hash!==hash){try{history.replaceState(null,'',hash)}catch{location.hash=hash}}}
function applyView(){const view=$('#tpView');if(!view)return;view.innerHTML=screenHtml();syncNav();const fresh=$('.tp-fresh');if(fresh)fresh.textContent=freshness();queueMicrotask(()=>hydrate(view))}`;
shell=replaceOnce(shell,oldApply,newApply,'view/navigation sync');

const oldRoute="function route(name){const next=name||'home';if(next===state.screen){window.scrollTo({top:0,left:0,behavior:'auto'});return}state.scroll[state.screen]=window.scrollY;state.screen=next;closeMenu();$$('.tp-nav [data-route]').forEach(b=>b.classList.toggle('on',b.dataset.route===next));render();window.scrollTo({top:state.scroll[next]||0,left:0,behavior:'auto'})}";
const newRoute=`function route(name,{syncHash=true,restoreScroll=true}={}){const next=ROUTES.has(name)?name:'home';if(next!==state.screen){state.scroll[state.screen]=window.scrollY;state.screen=next}closeMenu();syncNav();if(syncHash)syncRouteHash(next);safeRender('route:'+next);window.scrollTo({top:restoreScroll?(state.scroll[next]||0):0,left:0,behavior:'auto'})}`;
shell=replaceOnce(shell,oldRoute,newRoute,'route function');

const oldOpen="function openEvent(id){if(!id)return;state.scroll[state.screen]=window.scrollY;state.selectedId=String(id);state.screen='analysis';render();window.scrollTo({top:0,left:0,behavior:'auto'})}";
const newOpen="function openEvent(id){if(!id)return;state.scroll[state.screen]=window.scrollY;state.selectedId=String(id);state.screen='analysis';syncNav();syncRouteHash('analysis');safeRender('openEvent');window.scrollTo({top:0,left:0,behavior:'auto'})}";
shell=replaceOnce(shell,oldOpen,newOpen,'open event navigation');

const bindStart=shell.indexOf('let searchTimer=null,navPointerAt=-1e9;');
const bindEnd=shell.indexOf("\nlet lastSig='';",bindStart);
if(bindStart<0 || bindEnd<0) throw new Error('Missing old bindRoot block');
const newBind=`// TEP_IOS_NAV_BIND_V38\nlet searchTimer=null,lastNavTouch=-1e9;\nfunction activateBottomNav(el,e){\n  const name=el?.dataset?.route;if(!ROUTES.has(name))return;\n  if(e?.type==='click'&&performance.now()-lastNavTouch<650){e.preventDefault();return}\n  if(e?.type==='touchend')lastNavTouch=performance.now();\n  e?.preventDefault?.();route(name);\n}\nfunction bindBottomNav(root){\n  $$('.tp-nav [data-route]',root).forEach(el=>{\n    el.addEventListener('touchend',e=>activateBottomNav(el,e),{passive:false});\n    el.addEventListener('click',e=>activateBottomNav(el,e));\n  });\n}\nfunction handleRouteHash(){const next=navRouteFromHash();if(next&&next!==state.screen)route(next,{syncHash:false,restoreScroll:false})}\nfunction bindRoot(){\n  const root=$('#tpRoot');if(!root)return;bindBottomNav(root);\n  root.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null;if(!target)return;const r=target.closest('[data-route]');if(r&&root.contains(r)){if(r.closest('.tp-nav'))return;route(r.dataset.route);return}const o=target.closest('[data-open-event]');if(o){openEvent(o.dataset.openEvent);return}const f=target.closest('[data-favorite]');if(f){e.stopPropagation();toggleFav(f.dataset.favorite);return}const p=target.closest('[data-follow]');if(p){e.stopPropagation();toggleFollow(p.dataset.follow);return}if(target.closest('#tpMenuBtn')){$('#tpMenu')?.classList.add('open');return}if(target.closest('#tpMenuClose')||target===$('#tpMenu')){closeMenu();return}if(target.closest('[data-menu-sure]')){const a=document.querySelector('.bottomNav .sureLink');if(a?.href)location.href=a.href}});\n  root.addEventListener('input',e=>{if(e.target.id!=='tpSearch')return;state.query=e.target.value;clearTimeout(searchTimer);const pos=e.target.selectionStart;searchTimer=setTimeout(()=>{safeRender('search');const n=$('#tpSearch');if(n){n.focus();try{n.setSelectionRange(pos,pos)}catch{}}},120)});\n  root.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null;if(!target)return;const t=target.closest('[data-tour]');if(t){state.tour=t.dataset.tour;safeRender('tour')}const s=target.closest('[data-surface]');if(s){state.surface=s.dataset.surface;safeRender('surface')}});\n  window.addEventListener('hashchange',handleRouteHash);\n  window.__TEP_PREMIUM_NAV__={route,handleRouteHash,get screen(){return state.screen},version:VERSION};\n}\n`;
if(bindStart<0 || bindEnd<0){
  if(!shell.includes('TEP_IOS_NAV_BIND_V38')) throw new Error('Missing old bindRoot block');
}else{
  shell=shell.slice(0,bindStart)+newBind+shell.slice(bindEnd);
}

const oldBoot="function boot(){install();lastSig=sig();setInterval(refresh,3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastSig='';refresh()}})}";
const newBoot="function boot(){const initial=navRouteFromHash();if(initial)state.screen=initial;install();syncRouteHash(state.screen);lastSig=sig();setInterval(refresh,3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastSig='';refresh()}})}";
shell=replaceOnce(shell,oldBoot,newBoot,'boot route restore');

index=replaceOnce(index,'<link rel="manifest" href="./manifest.webmanifest">','<link rel="manifest" href="./manifest.webmanifest?v=20260912-v41-player-details">','manifest cache bust');
index=replaceOnce(index,'premium-shell-v1.js?v=20260911-v35-runtime-fix','premium-shell-v1.js?v=20260912-v41-player-details','premium shell cache bust');
manifest=replaceOnce(manifest,'"start_url": "./?v=20260911-v35-runtime-fix"','"start_url": "./?v=20260912-v41-player-details"','manifest start_url cache bust');

if(!shell.includes('TEP_FULL_PREMIUM_UI_V3_8')) throw new Error('V3.8 marker missing after patch');
if(!shell.includes('TEP_IOS_NAV_BIND_V38')) throw new Error('V3.8 direct nav binder missing');
if(!shell.includes("root.innerHTML=shell();bindRoot();safeRender('install')")) throw new Error('Bind-before-render invariant missing');
if(!shell.includes('href="#tp-explore" data-route="explore"')) throw new Error('Native navigation anchors missing');
if(shell.includes('navPointerAt')) throw new Error('Legacy pointer suppression still present');

fs.writeFileSync(shellPath,shell);
fs.writeFileSync(indexPath,index);
fs.writeFileSync(manifestPath,manifest);
console.log('IOS_NAV_V38_PATCH=PASS');
