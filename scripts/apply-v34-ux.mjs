import fs from 'node:fs';

const file='premium-shell-v1.js';
let s=fs.readFileSync(file,'utf8');
const original=s;

const need=(ok,label)=>{if(!ok)throw new Error(`V34 patch contract changed: ${label}`)};
const replaceText=(oldText,newText,label)=>{
  if(s.includes(newText))return;
  need(s.includes(oldText),label);
  s=s.replace(oldText,newText);
};
const replaceRe=(re,newText,marker,label)=>{
  if(s.includes(marker))return;
  need(re.test(s),label);
  s=s.replace(re,newText);
};

s=s.replace("const VERSION='TEP_FULL_PREMIUM_UI_V3_1';","const VERSION='TEP_FULL_PREMIUM_UI_V3_4';")
   .replace("const VERSION='TEP_FULL_PREMIUM_UI_V3_3';","const VERSION='TEP_FULL_PREMIUM_UI_V3_4';")
   .replace('if(window.__TEP_FULL_PREMIUM_UI_V31)return;','if(window.__TEP_FULL_PREMIUM_UI_V34)return;')
   .replace('if(window.__TEP_FULL_PREMIUM_UI_V33)return;','if(window.__TEP_FULL_PREMIUM_UI_V34)return;')
   .replace('window.__TEP_FULL_PREMIUM_UI_V31=true;','window.__TEP_FULL_PREMIUM_UI_V34=true;')
   .replace('window.__TEP_FULL_PREMIUM_UI_V33=true;','window.__TEP_FULL_PREMIUM_UI_V34=true;');
need(s.includes("TEP_FULL_PREMIUM_UI_V3_4"),'version');

const stateMarker="const savePhotoCache=()=>{try{localStorage.setItem(photoKey,JSON.stringify(photoCache))}catch{}};";
if(!s.includes('const photoInflight=new Map()')){
  need(s.includes(stateMarker),'photo-state');
  s=s.replace(stateMarker,stateMarker+"\nconst photoInflight=new Map(),photoMisses=new Set();let photoObserver=null;");
}

const candidateBlock=`function catalogPhoto(raw){const key=pretty(raw).toLowerCase();return String(window.__TEP_PLAYER_PHOTOS__?.[key]||'')}\nasync function wikiCandidates(raw){\n  const name=pretty(raw),key=name.toLowerCase();\n  if(!name||/^(wsf|r16p|qf|sf)\\d+/i.test(name))return[];\n  const bundled=catalogPhoto(name);\n  if(photoCache[key])return[...new Set([photoCache[key],bundled].filter(Boolean))];\n  if(bundled)return[bundled];\n  if(photoMisses.has(key))return[];\n  if(photoInflight.has(key))return photoInflight.get(key);\n  const job=(async()=>{\n    const out=[];\n    try{const title=encodeURIComponent(name.replace(/\\s+/g,'_')),r=await fetch(\`https://en.wikipedia.org/api/rest_v1/page/summary/\${title}\`,{cache:'force-cache',headers:{Accept:'application/json'}});if(r.ok){const j=await r.json();const src=j?.thumbnail?.source||j?.originalimage?.source;if(src)out.push(src)}}catch{}\n    if(!out.length){\n      try{const q=encodeURIComponent(name),u=\`https://www.wikidata.org/w/api.php?action=wbsearchentities&search=\${q}&language=en&uselang=en&limit=8&format=json&origin=*\`,r=await fetch(u,{cache:'force-cache'});if(r.ok){const j=await r.json(),hit=(j?.search||[]).find(x=>/tennis/i.test(String(x?.description||'')));if(hit?.id){const e=await fetch(\`https://www.wikidata.org/w/api.php?action=wbgetentities&ids=\${encodeURIComponent(hit.id)}&props=claims&format=json&origin=*\`,{cache:'force-cache'});if(e.ok){const ej=await e.json(),file=ej?.entities?.[hit.id]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;if(file)out.push(\`https://commons.wikimedia.org/wiki/Special:FilePath/\${encodeURIComponent(String(file).replace(/ /g,'_'))}?width=900\`)}}}}catch{}\n    }\n    try{const q=encodeURIComponent(\`\${name} tennis\`),u=\`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=\${q}&gsrlimit=5&prop=pageimages&piprop=thumbnail&pithumbsize=900&format=json&origin=*\`,r=await fetch(u,{cache:'force-cache'});if(r.ok){const j=await r.json();for(const p of Object.values(j?.query?.pages||{})){const src=p?.thumbnail?.source;if(src&&!out.includes(src))out.push(src)}}}catch{}\n    if(!out.length)photoMisses.add(key);\n    return out;\n  })();\n  photoInflight.set(key,job);\n  try{return await job}finally{photoInflight.delete(key)}\n}\nfunction avatar`;
replaceRe(/async function wikiCandidates\(raw\)\{[\s\S]*?\n\}\nfunction avatar/,candidateBlock,'function catalogPhoto(raw)','photo-candidates');

const hydrationBlock=`function avatar(name,cls=''){const eager=String(cls).includes('hero')?'eager':'lazy',src=catalogPhoto(name),ready=!!src;return\`<span class="tp-avatar \${cls}\${ready?' has-photo':''}" data-photo="\${esc(name)}"><span>\${esc(initials(name))}</span><img alt="\${esc(pretty(name))}" loading="\${eager}" decoding="async" fetchpriority="\${eager==='eager'?'high':'low'}"\${src?\` src="\${esc(src)}"\`:''}></span>\`}\nasync function tryImage(el,img,src){return new Promise(resolve=>{let done=false;const finish=ok=>{if(done)return;done=true;img.onload=null;img.onerror=null;if(ok)el.classList.add('has-photo');else el.classList.remove('has-photo');resolve(ok)};img.onload=()=>finish(img.naturalWidth>40&&img.naturalHeight>40);img.onerror=()=>finish(false);if(img.getAttribute('src')!==src)img.src=src;if(img.complete&&img.naturalWidth>40&&img.naturalHeight>40)finish(true);setTimeout(()=>finish(img.complete&&img.naturalWidth>40&&img.naturalHeight>40),6500)})}\nasync function loadAvatar(el){\n  if(!el||el.dataset.photoState==='loading'||el.dataset.photoState==='done')return;\n  el.dataset.photoState='loading';const img=$('img',el);if(!img){el.dataset.photoState='done';return}\n  const name=el.dataset.photo,key=pretty(name).toLowerCase(),seed=img.getAttribute('src')||'';let ok=false;\n  if(seed)ok=await tryImage(el,img,seed);\n  if(!ok){\n    if(seed){img.removeAttribute('src');el.classList.remove('has-photo')}\n    const candidates=(await wikiCandidates(name)).filter(src=>src&&src!==seed);\n    for(const src of candidates){if(await tryImage(el,img,src)){photoCache[key]=src;savePhotoCache();ok=true;break}}\n  }\n  if(!ok){el.classList.remove('has-photo');img.removeAttribute('src');delete photoCache[key];photoMisses.add(key);savePhotoCache()}\n  el.dataset.photoState='done';\n}\nfunction hydrate(root=document){\n  photoObserver?.disconnect();photoObserver=null;\n  const nodes=$$('[data-photo]',root).filter(x=>x.dataset.photoState!=='loading'&&x.dataset.photoState!=='done'),immediate=[],deferred=[];\n  for(const el of nodes){const key=pretty(el.dataset.photo).toLowerCase(),r=el.getBoundingClientRect();(catalogPhoto(key)||photoCache[key]||el.classList.contains('hero')||r.top<window.innerHeight+320?immediate:deferred).push(el)}\n  void Promise.allSettled(immediate.map(loadAvatar));\n  if(!deferred.length)return;\n  if('IntersectionObserver'in window){photoObserver=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){photoObserver?.unobserve(entry.target);void loadAvatar(entry.target)}}},{rootMargin:'420px 0px'});deferred.forEach(el=>photoObserver.observe(el))}\n  else setTimeout(()=>deferred.forEach(el=>void loadAvatar(el)),0);\n}\n\nfunction liveScore`;
replaceRe(/function avatar\(name,cls=''\)\{[\s\S]*?\n\}\n\nfunction liveScore/,hydrationBlock,'fetchpriority="${eager', 'photo-hydration');

const simpleRepls=[
  ['<strong>Top Match</strong><span>Probabilità e contesto.</span>','<strong>Partite</strong><span>Cerca, filtra e confronta.</span>'],
  ['<strong>Tutte le partite</strong><span>Cerca, filtra e confronta.</span>','<strong>Partite</strong><span>Cerca, filtra e confronta.</span>'],
  ['<div class="tp-page-title"><h1>Esplora</h1><p>Cerca e confronta i prossimi match.</p></div>','<div class="tp-page-title"><h1>Partite</h1><p>Tutti i prossimi match, con filtri chiari.</p></div>'],
  ['<div class="tp-page-title"><h1>Le Mie Analisi</h1><p>Preferiti, giocatori seguiti e performance.</p></div>','<div class="tp-page-title"><h1>Salvati e seguiti</h1><p>Preferiti, giocatori seguiti e risultati.</p></div>'],
  ['<button data-route="explore"><i>⌕</i><span>Esplora</span></button>','<button data-route="explore"><i>🎾</i><span>Partite</span></button>'],
  ['<button data-route="analysis"><i>☆</i><span>Analisi</span></button>','<button data-route="analysis"><i>◎</i><span>Analisi</span></button>'],
  ['<button data-route="mine"><i>▥</i><span>Le Mie Analisi</span></button>','<button data-route="mine"><i>★</i><span>Salvati</span></button>']
];
for(const [a,b] of simpleRepls)if(s.includes(a))s=s.replace(a,b);

const navBlock=`function applyView(){const view=$('#tpView');if(!view)return;view.innerHTML=screenHtml();$$('.tp-nav button').forEach(b=>b.classList.toggle('on',b.dataset.route===state.screen));const fresh=$('.tp-fresh');if(fresh)fresh.textContent=freshness();queueMicrotask(()=>hydrate(view))}\nfunction render(){applyView()}\nfunction route(name){const next=name||'home';if(next===state.screen){window.scrollTo({top:0,left:0,behavior:'auto'});return}state.scroll[state.screen]=window.scrollY;state.screen=next;closeMenu();$$('.tp-nav button').forEach(b=>b.classList.toggle('on',b.dataset.route===next));render();window.scrollTo({top:state.scroll[next]||0,left:0,behavior:'auto'})}\nfunction openEvent(id){if(!id)return;state.scroll[state.screen]=window.scrollY;state.selectedId=String(id);state.screen='analysis';render();window.scrollTo({top:0,left:0,behavior:'auto'})}\nfunction toggleFav`;
replaceRe(/function applyView\(\)\{[\s\S]*?function toggleFav/,navBlock,'function render(){applyView()}', 'instant-navigation');

if(!s.includes('let searchTimer=null,navPointerAt='))s=s.replace('let searchTimer=null;','let searchTimer=null,navPointerAt=-1e9;');
if(!s.includes("root.addEventListener('pointerdown'")){
  const click="root.addEventListener('click',e=>{const r=e.target.closest('[data-route]');if(r){route(r.dataset.route);return}";
  need(s.includes(click),'pointer-binding');
  s=s.replace(click,"root.addEventListener('pointerdown',e=>{const r=e.target.closest('.tp-nav [data-route]');if(!r)return;navPointerAt=performance.now();e.preventDefault();route(r.dataset.route)});\n  root.addEventListener('click',e=>{const r=e.target.closest('[data-route]');if(r){if(r.closest('.tp-nav')&&performance.now()-navPointerAt<700)return;route(r.dataset.route);return}");
}

s=s.replace(/#tpView\.tp-enter\{animation:tpEnter [^}]+\}@keyframes tpEnter\{[^}]+\}\}/g,'#tpView.tp-enter{animation:none}');
s=s.replace(".tp-nav button{border:0;background:none;color:#9caec2;display:grid;place-items:center;gap:2px;min-height:54px;transition:color .12s ease,transform .12s ease}.tp-nav i{font-size:22px;font-style:normal}.tp-nav span{font-size:8px}.tp-nav button.on{color:var(--tp-lime)}",".tp-nav button{border:0;background:transparent;color:#9caec2;display:grid;place-items:center;gap:2px;min-height:54px;border-radius:14px;touch-action:manipulation;-webkit-tap-highlight-color:transparent;transition:color .06s ease,background .06s ease}.tp-nav i{font-size:21px;font-style:normal}.tp-nav span{font-size:9px;font-weight:800;letter-spacing:.01em}.tp-nav button.on{color:var(--tp-lime);background:rgba(202,255,61,.1)}");
if(!s.includes('content-visibility:auto')){
  const marker='@media(min-width:720px){';need(s.includes(marker),'media-marker');s=s.replace(marker,'@supports (content-visibility:auto){.tp-match-card,.tp-live-card,.tp-record-list>div{content-visibility:auto;contain-intrinsic-size:92px}}\n'+marker);
}

for(const marker of ["TEP_FULL_PREMIUM_UI_V3_4",'function catalogPhoto(raw)',"root.addEventListener('pointerdown'",'<span>Partite</span>','<span>Salvati</span>','function render(){applyView()}'])need(s.includes(marker),marker);
if(s.includes('document.startViewTransition'))throw new Error('V34 still contains startViewTransition');
if(s!==original){fs.writeFileSync(file,s);console.log('V34_FAST_UX_PATCH=APPLIED')}else console.log('V34_FAST_UX_PATCH=ALREADY_APPLIED');
