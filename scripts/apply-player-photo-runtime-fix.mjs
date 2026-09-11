import fs from 'node:fs';

const file='premium-shell-v1.js';
let s=fs.readFileSync(file,'utf8');
const original=s;

const oldAvatar=`function avatar(name,cls=''){return\`<span class="tp-avatar \${cls}" data-photo="\${esc(name)}"><span>\${esc(initials(name))}</span><img alt="\${esc(pretty(name))}" loading="lazy" decoding="async" hidden></span>\`}`;
const newAvatar=`function avatar(name,cls=''){const eager=String(cls).includes('hero')?'eager':'lazy';return\`<span class="tp-avatar \${cls}" data-photo="\${esc(name)}"><span>\${esc(initials(name))}</span><img alt="\${esc(pretty(name))}" loading="\${eager}" decoding="async"></span>\`}`;
if(s.includes(oldAvatar)) s=s.replace(oldAvatar,newAvatar);
else if(!s.includes("const eager=String(cls).includes('hero')?'eager':'lazy'")) throw new Error('avatar contract changed; refusing blind patch');

const oldTry=`async function tryImage(img,src){return new Promise(resolve=>{let done=false;const finish=ok=>{if(done)return;done=true;img.onload=null;img.onerror=null;resolve(ok)};img.onload=()=>finish(img.naturalWidth>80);img.onerror=()=>finish(false);img.src=src;if(img.complete&&img.naturalWidth>80)finish(true);setTimeout(()=>finish(img.complete&&img.naturalWidth>80),4500)})}`;
const newTry=`async function tryImage(el,img,src){return new Promise(resolve=>{let done=false;const finish=ok=>{if(done)return;done=true;img.onload=null;img.onerror=null;if(ok)el.classList.add('has-photo');else el.classList.remove('has-photo');resolve(ok)};img.onload=()=>finish(img.naturalWidth>80&&img.naturalHeight>80);img.onerror=()=>finish(false);img.src=src;if(img.complete&&img.naturalWidth>80&&img.naturalHeight>80)finish(true);setTimeout(()=>finish(img.complete&&img.naturalWidth>80&&img.naturalHeight>80),5000)})}`;
if(s.includes(oldTry)) s=s.replace(oldTry,newTry);
else if(!s.includes('async function tryImage(el,img,src)')) throw new Error('tryImage contract changed; refusing blind patch');

const oldHydrate=`async function hydrate(root=document){\n  for(const el of $$('[data-photo]',root).filter(x=>x.dataset.photoState!=='loading'&&x.dataset.photoState!=='done')){\n    el.dataset.photoState='loading';const img=$('img',el);if(!img){el.dataset.photoState='done';continue}\n    const name=el.dataset.photo,key=pretty(name).toLowerCase(),candidates=await wikiCandidates(name);let ok=false;\n    for(const src of candidates){if(await tryImage(img,src)){img.hidden=false;photoCache[key]=src;savePhotoCache();ok=true;break}}\n    if(!ok){img.hidden=true;delete photoCache[key];savePhotoCache()}\n    el.dataset.photoState='done';\n  }\n}`;
const newHydrate=`async function hydrate(root=document){\n  const nodes=$$('[data-photo]',root).filter(x=>x.dataset.photoState!=='loading'&&x.dataset.photoState!=='done');\n  await Promise.all(nodes.map(async el=>{\n    el.dataset.photoState='loading';const img=$('img',el);if(!img){el.dataset.photoState='done';return}\n    const name=el.dataset.photo,key=pretty(name).toLowerCase(),candidates=await wikiCandidates(name);let ok=false;\n    for(const src of candidates){if(await tryImage(el,img,src)){photoCache[key]=src;savePhotoCache();ok=true;break}}\n    if(!ok){el.classList.remove('has-photo');img.removeAttribute('src');delete photoCache[key];savePhotoCache()}\n    el.dataset.photoState='done';\n  }));\n}`;
if(s.includes(oldHydrate)) s=s.replace(oldHydrate,()=>newHydrate);
else if(!s.includes("await Promise.all(nodes.map(async el=>")&&!s.includes('void Promise.allSettled(immediate.map(loadAvatar))')) throw new Error('hydrate contract changed; refusing blind patch');

// Repair an early V3.1 migration typo that accidentally collapsed $$() to $().
const brokenNodes="const nodes=$('[data-photo]',root).filter(x=>x.dataset.photoState!=='loading'&&x.dataset.photoState!=='done');";
const fixedNodes="const nodes=$$('[data-photo]',root).filter(x=>x.dataset.photoState!=='loading'&&x.dataset.photoState!=='done');";
if(s.includes(brokenNodes)) s=s.replace(brokenNodes,()=>fixedNodes);

const oldCss='.tp-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}';
const newCss='.tp-avatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:0;transition:opacity .16s ease}.tp-avatar.has-photo img{opacity:1}';
if(s.includes(oldCss)) s=s.replace(oldCss,newCss);
else if(!s.includes('.tp-avatar.has-photo img{opacity:1}')) throw new Error('avatar CSS contract changed; refusing blind patch');

for(const required of [
  "loading=\"${eager}\"",
  'async function tryImage(el,img,src)',
  "const nodes=$$('[data-photo]',root).filter(",
  ".tp-avatar.has-photo img{opacity:1}"
]) if(!s.includes(required)) throw new Error('photo runtime fix missing: '+required);
if(!s.includes("await Promise.all(nodes.map(async el=>")&&!s.includes('void Promise.allSettled(immediate.map(loadAvatar))')) throw new Error('photo hydration strategy missing');

if(s!==original){fs.writeFileSync(file,s);console.log('PLAYER_PHOTO_RUNTIME_FIX=APPLIED')}else console.log('PLAYER_PHOTO_RUNTIME_FIX=ALREADY_APPLIED');
