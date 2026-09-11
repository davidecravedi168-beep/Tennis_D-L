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
  return text.replace(from,to);
}

shell=replaceOnce(shell,"const VERSION='TEP_FULL_PREMIUM_UI_V3_5';","const VERSION='TEP_FULL_PREMIUM_UI_V3_6';",'V3.5 version marker');
shell=replaceOnce(shell,"if(window.__TEP_FULL_PREMIUM_UI_V35)return;\nwindow.__TEP_FULL_PREMIUM_UI_V35=true;","if(window.__TEP_FULL_PREMIUM_UI_V36)return;\nwindow.__TEP_FULL_PREMIUM_UI_V36=true;",'V3.5 runtime guard');

const oldNav='<nav class="tp-nav"><button data-route="home"><i>⌂</i><span>Home</span></button><button data-route="explore"><i>🎾</i><span>Partite</span></button><button data-route="analysis"><i>◎</i><span>Analisi</span></button><button data-route="mine"><i>★</i><span>Salvati</span></button></nav>';
const newNav='<nav class="tp-nav" aria-label="Navigazione principale"><a href="#tp-home" data-route="home"><i>⌂</i><span>Home</span></a><a href="#tp-explore" data-route="explore"><i>🎾</i><span>Partite</span></a><a href="#tp-analysis" data-route="analysis"><i>◎</i><span>Analisi</span></a><a href="#tp-mine" data-route="mine"><i>★</i><span>Salvati</span></a></nav>';
shell=replaceOnce(shell,oldNav,newNav,'bottom navigation markup');

shell=shell.replaceAll('.tp-nav button','.tp-nav [data-route]');

const oldApply="function applyView(){const view=$('#tpView');if(!view)return;view.innerHTML=screenHtml();$$('.tp-nav [data-route]').forEach(b=>b.classList.toggle('on',b.dataset.route===state.screen));const fresh=$('.tp-fresh');if(fresh)fresh.textContent=freshness();queueMicrotask(()=>hydrate(view))}";
const newApply=`const ROUTES=new Set(['home','explore','analysis','mine','live','record']);
function navRouteFromHash(){const m=String(location.hash||'').match(/^#tp-(home|explore|analysis|mine|live|record)$/);return m?m[1]:null}
function syncNav(){
  $$('.tp-nav [data-route]').forEach(el=>{const on=el.dataset.route===state.screen;el.classList.toggle('on',on);if(on)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current')});
}
function syncRouteHash(name){const next=ROUTES.has(name)?name:'home',hash='#tp-'+next;if(location.hash!==hash){try{history.replaceState(null,'',hash)}catch{location.hash=hash}}}
function applyView(){const view=$('#tpView');if(!view)return;view.innerHTML=screenHtml();syncNav();const fresh=$('.tp-fresh');if(fresh)fresh.textContent=freshness();queueMicrotask(()=>hydrate(view))}`;
if(!shell.includes('function navRouteFromHash(){')) shell=replaceOnce(shell,oldApply,newApply,'view/navigation sync');

const oldRoute="function route(name){const next=name||'home';if(next===state.screen){window.scrollTo({top:0,left:0,behavior:'auto'});return}state.scroll[state.screen]=window.scrollY;state.screen=next;closeMenu();$$('.tp-nav [data-route]').forEach(b=>b.classList.toggle('on',b.dataset.route===next));render();window.scrollTo({top:state.scroll[next]||0,left:0,behavior:'auto'})}";
const newRoute=`function route(name,{syncHash=true,restoreScroll=true}={}){const next=ROUTES.has(name)?name:'home';if(next===state.screen){if(syncHash)syncRouteHash(next);syncNav();if(restoreScroll)window.scrollTo({top:0,left:0,behavior:'auto'});return}state.scroll[state.screen]=window.scrollY;state.screen=next;closeMenu();render();if(syncHash)syncRouteHash(next);window.scrollTo({top:restoreScroll?(state.scroll[next]||0):0,left:0,behavior:'auto'})}`;
if(!shell.includes('function route(name,{syncHash=true,restoreScroll=true}={})')) shell=replaceOnce(shell,oldRoute,newRoute,'route function');

const bindStart=shell.indexOf('let searchTimer=null,navPointerAt=-1e9;');
const bindEnd=shell.indexOf("\nlet lastSig='';",bindStart);
if(bindStart<0 || bindEnd<0){
  if(!shell.includes('TEP_IOS_NAV_BIND_V36')) throw new Error('Missing old bindRoot block');
}else{
  const newBind=`// TEP_IOS_NAV_BIND_V36\nlet searchTimer=null;\nfunction bindRoot(){\n  const root=$('#tpRoot');if(!root)return;\n  root.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null;if(!target)return;const r=target.closest('[data-route]');if(r&&root.contains(r)){route(r.dataset.route);return}const o=target.closest('[data-open-event]');if(o){openEvent(o.dataset.openEvent);syncRouteHash('analysis');return}const f=target.closest('[data-favorite]');if(f){e.stopPropagation();toggleFav(f.dataset.favorite);return}const p=target.closest('[data-follow]');if(p){e.stopPropagation();toggleFollow(p.dataset.follow);return}if(target.closest('#tpMenuBtn')){$('#tpMenu')?.classList.add('open');return}if(target.closest('#tpMenuClose')||target===$('#tpMenu')){closeMenu();return}if(target.closest('[data-menu-sure]')){const a=document.querySelector('.bottomNav .sureLink');if(a?.href)location.href=a.href}});\n  root.addEventListener('input',e=>{if(e.target.id!=='tpSearch')return;state.query=e.target.value;clearTimeout(searchTimer);const pos=e.target.selectionStart;searchTimer=setTimeout(()=>{render(false);const n=$('#tpSearch');if(n){n.focus();try{n.setSelectionRange(pos,pos)}catch{}}},120)});\n  root.addEventListener('click',e=>{const target=e.target instanceof Element?e.target:null;if(!target)return;const t=target.closest('[data-tour]');if(t){state.tour=t.dataset.tour;render(false)}const s=target.closest('[data-surface]');if(s){state.surface=s.dataset.surface;render(false)}});\n  window.addEventListener('hashchange',()=>{const next=navRouteFromHash();if(next&&next!==state.screen)route(next,{syncHash:false,restoreScroll:false})});\n  window.__TEP_PREMIUM_NAV__={route,get screen(){return state.screen},version:VERSION};\n}\n`;
  shell=shell.slice(0,bindStart)+newBind+shell.slice(bindEnd);
}

const oldBoot="function boot(){install();lastSig=sig();setInterval(refresh,3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastSig='';refresh()}})}";
const newBoot="function boot(){const initial=navRouteFromHash();if(initial)state.screen=initial;install();syncRouteHash(state.screen);lastSig=sig();setInterval(refresh,3000);document.addEventListener('visibilitychange',()=>{if(!document.hidden){lastSig='';refresh()}})}";
if(!shell.includes('function boot(){const initial=navRouteFromHash();')) shell=replaceOnce(shell,oldBoot,newBoot,'boot route restore');

index=replaceOnce(index,'<link rel="manifest" href="./manifest.webmanifest">','<link rel="manifest" href="./manifest.webmanifest?v=20260911-v36-ios-nav">','manifest cache bust');
index=replaceOnce(index,'premium-shell-v1.js?v=20260911-v35-runtime-fix','premium-shell-v1.js?v=20260911-v36-ios-nav','premium shell cache bust');
manifest=replaceOnce(manifest,'"start_url": "./?v=20260911-v35-runtime-fix"','"start_url": "./?v=20260911-v36-ios-nav"','manifest start_url cache bust');

if(!shell.includes('TEP_FULL_PREMIUM_UI_V3_6')) throw new Error('V3.6 marker missing after patch');
if(!shell.includes('href="#tp-explore" data-route="explore"')) throw new Error('Native navigation anchors missing');
if(shell.includes('navPointerAt')) throw new Error('Legacy pointer suppression still present');

fs.writeFileSync(shellPath,shell);
fs.writeFileSync(indexPath,index);
fs.writeFileSync(manifestPath,manifest);
console.log('IOS_NAV_V36_PATCH=PASS');
