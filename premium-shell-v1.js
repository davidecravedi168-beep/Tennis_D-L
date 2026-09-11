(()=>{
'use strict';
const MARK='TEP_PREMIUM_SHELL_R1';
if(window.__TEP_PREMIUM_SHELL_R1)return;
window.__TEP_PREMIUM_SHELL_R1=true;

const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const num=v=>v!==null&&v!==''&&Number.isFinite(Number(v))?Number(v):null;
const pct=v=>Number.isFinite(Number(v))?`${Math.round(Number(v)*100)}%`:'—';
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const byId=id=>document.getElementById(id);
const q=(s,r=document)=>r.querySelector(s);
const qa=(s,r=document)=>[...r.querySelectorAll(s)];
const prettyName=raw=>{
  const s=String(raw||'').trim();
  if(!s)return '—';
  if(s.includes(',')){const [last,...rest]=s.split(',');return `${rest.join(',').trim()} ${last.trim()}`.trim()}
  return s;
};
const shortTournament=s=>String(s||'Tennis').replace(/^(ATP|WTA)\s*-\s*/i,'').replace(/,\s*[^,]+$/,'').trim();
const localTime=v=>{const d=new Date(v);return Number.isFinite(+d)?d.toLocaleString('it-IT',{weekday:'short',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):'Orario da definire'};
const initials=name=>prettyName(name).split(/\s+/).filter(Boolean).slice(0,2).map(x=>x[0]?.toUpperCase()||'').join('')||'TP';

const photoStatic={
  'jannik sinner':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Jannik%20Sinner%202025%20US%20Open.jpg?width=720',
  'carlos alcaraz':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Carlos%20Alcaraz%20%282025%29.jpg?width=720',
  'novak djokovic':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Novak%20Djokovic%20at%202025%20Miami%20Open%20%28cropped%29.jpg?width=720',
  'daniil medvedev':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Daniil%20Medvedev%20%282025%20DC%20Open%29%2005%20%28cropped%29.jpg?width=720',
  'alexander zverev':'https://commons.wikimedia.org/wiki/Special:Redirect/file/BMW%20Open%202025%20Zverev%20S%C3%B6der%20%28cropped%29.jpg?width=720',
  'iga swiatek':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Iga%20Swiatek%20%28cropped%29.jpg?width=720',
  'iga %C5%9Bwi%C4%85tek':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Iga%20Swiatek%20%28cropped%29.jpg?width=720',
  'aryna sabalenka':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Aryna%20Sabalenka%20at%202025%20Miami%20Open%2005%20%28cropped%29.jpg?width=720',
  'casper ruud':'https://commons.wikimedia.org/wiki/Special:Redirect/file/Casper%20Ruud%2C%20Norwegian%20professional%20tennis%20player%2C%20ATP%20500%20Basel%202025%20%28cropped%29.jpg?width=720'
};
const photoCacheKey='tep:premium-player-photo:v1';
let photoCache={};
try{photoCache=JSON.parse(localStorage.getItem(photoCacheKey)||'{}')||{}}catch{}
function savePhotoCache(){try{localStorage.setItem(photoCacheKey,JSON.stringify(photoCache))}catch{}}
async function resolvePhoto(raw){
  const name=prettyName(raw),key=name.toLowerCase();
  if(photoStatic[key])return {src:photoStatic[key],source:`https://commons.wikimedia.org/wiki/Special:MediaSearch?type=image&search=${encodeURIComponent(name)}`};
  if(photoCache[key])return photoCache[key];
  if(!name||/^(wsf|r16p|qf|sf)\d+/i.test(name))return null;
  try{
    const title=encodeURIComponent(name.replace(/\s+/g,'_'));
    const r=await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${title}`,{cache:'force-cache',headers:{Accept:'application/json'}});
    if(!r.ok)return null;
    const j=await r.json();
    const src=j?.thumbnail?.source||j?.originalimage?.source;
    if(!src)return null;
    const out={src,source:j?.content_urls?.desktop?.page||`https://en.wikipedia.org/wiki/${title}`};
    photoCache[key]=out;savePhotoCache();return out;
  }catch{return null}
}
function avatarHtml(name,cls=''){
  return `<span class="tepAvatar ${cls}" data-player-photo="${esc(name)}"><span class="tepAvatarFallback">${esc(initials(name))}</span><img alt="${esc(prettyName(name))}" loading="lazy" decoding="async"></span>`;
}
async function hydratePhotos(root=document){
  const nodes=qa('[data-player-photo]',root).filter(x=>x.dataset.photoState!=='done'&&x.dataset.photoState!=='loading');
  for(const el of nodes){
    el.dataset.photoState='loading';
    const info=await resolvePhoto(el.dataset.playerPhoto);
    if(info?.src){
      const img=q('img',el);if(img){img.src=info.src;img.hidden=false;img.dataset.source=info.source||'';img.addEventListener('error',()=>{img.hidden=true},{once:true});}
      el.dataset.photoSource=info.source||'';
    }
    el.dataset.photoState='done';
  }
}

const CSS=`
:root{--tep-lime:#caff3d;--tep-lime2:#99ff32;--tep-cyan:#39c6ff;--tep-purple:#c57cff;--tep-amber:#ffbf21;--tep-bg:#020a12;--tep-card:#071521;--tep-card2:#0a1b2a;--tep-line:#17364c;--tep-muted:#93a9c2;--tep-soft:#d8e8f8;--tep-shadow:0 24px 70px rgba(0,0,0,.42)}
body.tepPremiumMode{background:radial-gradient(circle at 75% -10%,rgba(57,198,255,.12),transparent 28rem),radial-gradient(circle at 12% 18%,rgba(202,255,61,.055),transparent 26rem),linear-gradient(180deg,#020911,#04101a 58%,#020911);color:#f8fbff}
body.tepPremiumMode .app{max-width:980px;padding:max(13px,env(safe-area-inset-top)) 14px calc(106px + env(safe-area-inset-bottom))}
body.tepPremiumMode .topbar{position:sticky;top:0;z-index:45;margin:-13px -14px 12px;padding:calc(max(13px,env(safe-area-inset-top))) 14px 10px;background:linear-gradient(180deg,rgba(2,10,18,.98),rgba(2,10,18,.86),rgba(2,10,18,0));backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
body.tepPremiumMode .brand{min-width:0}body.tepPremiumMode .brand h1{font-size:24px;font-weight:900;letter-spacing:-.045em;text-transform:none;font-style:italic;white-space:nowrap}body.tepPremiumMode .brand h1 .tepEdgeWord{color:var(--tep-lime)}body.tepPremiumMode .brand h1 small{display:none}body.tepPremiumMode .brand p{font-size:8px;text-transform:uppercase;letter-spacing:.34em;color:#b8c7d8;margin-top:6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
body.tepPremiumMode #tep-brand-inline{width:42px!important;height:42px!important;border-radius:50%!important;box-shadow:0 0 0 1px rgba(202,255,61,.25),0 0 22px rgba(202,255,61,.2)}
body.tepPremiumMode .topActions{gap:6px}body.tepPremiumMode .statusPill{border-color:rgba(202,255,61,.24);background:rgba(6,21,32,.78)}body.tepPremiumMode .miniBtn{border-color:#21445d;background:#071724;color:#eaf4ff}body.tepPremiumMode #modeBtn{display:none}
body.tepPremiumMode .autopilotBar{border:0;background:transparent;padding:0 3px 8px;margin:0 0 6px;font-size:8px}body.tepPremiumMode .autopilotBar b{color:var(--tep-lime)}body.tepPremiumMode .autopilotBar span{color:#6f88a0}
body.tepPremiumMode #hero,body.tepPremiumMode .marketTape,body.tepPremiumMode .quickStrip{display:none!important}
#tepPremiumHero{position:relative;overflow:hidden;border:1px solid #21445c;border-radius:24px;background:radial-gradient(circle at 20% 15%,rgba(57,198,255,.12),transparent 20rem),radial-gradient(circle at 80% 25%,rgba(202,255,61,.06),transparent 18rem),linear-gradient(150deg,#081a28,#030b13 62%);box-shadow:var(--tep-shadow);margin-bottom:12px;min-height:470px}
#tepPremiumHero:before{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(1,8,13,.72) 72%,#030b13 100%);pointer-events:none}
.tepHeroTop{position:relative;z-index:4;display:flex;justify-content:center;gap:8px;flex-wrap:wrap;padding:16px 14px 0}.tepBadge{display:inline-flex;align-items:center;gap:7px;border:1px solid #275171;background:rgba(4,18,30,.82);border-radius:999px;padding:8px 12px;color:#d9e8f6;font-size:11px;font-weight:800}.tepBadge.lime{border-color:rgba(202,255,61,.42);color:var(--tep-lime)}
.tepHeroMeta{position:relative;z-index:4;text-align:center;color:#9cb3ca;font-size:11px;margin-top:9px}.tepHeroMeta b{color:#eaf4ff;font-weight:700}
.tepHeroPlayers{position:relative;z-index:2;display:grid;grid-template-columns:1fr 70px 1fr;align-items:end;min-height:235px;padding:2px 18px 0}.tepPlayer{position:relative;min-width:0;display:flex;align-items:flex-end;gap:12px}.tepPlayer.right{flex-direction:row-reverse;text-align:right}.tepPlayer .tepAvatar{width:min(31vw,195px);height:230px;flex:0 0 auto;border-radius:22px 22px 8px 8px;overflow:hidden;background:linear-gradient(160deg,#102b3d,#07131f);border:0;box-shadow:none}.tepPlayer .tepAvatar img{width:100%;height:100%;object-fit:cover;object-position:50% 18%;filter:saturate(.88) contrast(1.06);-webkit-mask-image:linear-gradient(#000 0 78%,transparent 100%);mask-image:linear-gradient(#000 0 78%,transparent 100%)}.tepPlayer .tepAvatarFallback{font-size:54px;color:#5b7890}.tepPlayerText{padding-bottom:30px;min-width:0}.tepPlayerText small{display:block;color:#8ca5bd;font-size:10px;margin-bottom:4px}.tepPlayerText strong{display:block;font-size:clamp(20px,4.8vw,34px);line-height:.98;letter-spacing:-.045em;white-space:normal}.tepPlayerText span{display:block;color:#bfd0e0;font-size:10px;margin-top:8px}.tepVs{align-self:center;text-align:center;color:#b8cae0;font-weight:900;font-size:22px;padding-bottom:36px}
.tepWinBand{position:relative;z-index:6;margin:-14px 16px 14px;border:1.5px solid var(--tep-lime);border-radius:19px;background:linear-gradient(90deg,rgba(16,48,31,.68),rgba(5,20,25,.9) 45%,rgba(8,23,34,.94));box-shadow:0 0 24px rgba(202,255,61,.12),inset 0 0 30px rgba(202,255,61,.025);display:grid;grid-template-columns:1fr 1.2fr 1fr;align-items:center;padding:13px 15px}.tepHeroPct{font-size:clamp(42px,10vw,70px);font-weight:950;letter-spacing:-.065em;line-height:.9}.tepHeroPct.a{color:var(--tep-lime);text-shadow:0 0 22px rgba(202,255,61,.24)}.tepHeroPct.b{color:#e8f5ff;text-align:right;text-shadow:0 0 18px rgba(57,198,255,.18)}.tepPctName{display:block;font-size:11px;color:#afc5db;margin-top:6px}.tepWinBand>div:last-child .tepPctName{text-align:right}.tepWinCenter{text-align:center;border-inline:1px solid #335064;padding:0 10px}.tepWinCenter small{display:block;color:#9db6cb;font-size:9px;text-transform:uppercase;letter-spacing:.08em}.tepWinCenter strong{display:block;color:var(--tep-lime);font-size:12px;margin-top:6px}.tepConfidence{display:flex;gap:4px;justify-content:center;margin-top:8px}.tepConfidence i{width:20px;height:8px;border-radius:999px;background:#24394d}.tepConfidence i.on{background:linear-gradient(90deg,var(--tep-lime2),var(--tep-lime));box-shadow:0 0 8px rgba(202,255,61,.22)}
.tepHeroInsight{position:relative;z-index:6;margin:0 16px 16px;border:1px solid #153349;border-radius:14px;background:rgba(5,19,30,.9);padding:11px 13px;color:#bcd0e3;font-size:10px;line-height:1.45}.tepHeroInsight b{color:var(--tep-cyan);margin-right:8px}
#tepPremiumDashboard{display:grid;gap:10px;margin-bottom:10px}.tepDashPair{display:grid;grid-template-columns:1fr 1fr;gap:10px}.tepDashCard,.tepUpcoming,.tepInsightStrip{border:1px solid #17364c;border-radius:18px;background:linear-gradient(145deg,rgba(8,26,40,.96),rgba(4,15,25,.97));box-shadow:0 13px 38px rgba(0,0,0,.19)}.tepDashCard{padding:15px;display:flex;gap:12px;align-items:center;min-height:105px}.tepIconBox{width:48px;height:48px;border-radius:15px;display:grid;place-items:center;font-size:24px;border:1px solid rgba(57,198,255,.32);background:rgba(57,198,255,.06)}.tepIconBox.lime{border-color:rgba(202,255,61,.35);background:rgba(202,255,61,.06);color:var(--tep-lime)}.tepDashCard strong{font-size:17px}.tepDashCard p{margin:4px 0 0;color:#8fa8bf;font-size:10px;line-height:1.4}.tepLivePill{margin-left:auto;color:var(--tep-lime);font-size:9px;font-weight:900;border:1px solid rgba(202,255,61,.35);border-radius:999px;padding:6px 8px}
.tepUpcoming{padding:14px}.tepSectionTitle{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:9px}.tepSectionTitle strong{font-size:18px}.tepSectionTitle span{font-size:10px;color:var(--tep-cyan)}.tepUpcomingRow{display:grid;grid-template-columns:58px 1fr auto;align-items:center;gap:10px;padding:9px 4px;border-top:1px solid rgba(42,74,98,.48)}.tepUpcomingRow:first-of-type{border-top:0}.tepUpcomingRow time{font-size:9px;color:#9cb3c9}.tepUpcomingNames{display:flex;align-items:center;gap:8px;min-width:0}.tepMiniAvatar{width:37px;height:37px!important;border-radius:50%!important;flex:0 0 37px!important}.tepMiniAvatar .tepAvatarFallback{font-size:12px}.tepUpcomingNames b{font-size:11px;display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tepUpcomingNames span{font-size:8px;color:#89a3ba}.tepUpcomingProb{font-size:16px;font-weight:950;color:var(--tep-lime);text-align:right}.tepUpcomingProb span{display:block;color:#cfe8ff;font-size:11px}.tepInsightStrip{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;overflow:hidden}.tepInsightCell{padding:13px;border-left:1px solid #17364c}.tepInsightCell:first-child{border-left:0}.tepInsightCell b{display:block;font-size:12px}.tepInsightCell span{display:block;margin-top:4px;color:#8ca5bd;font-size:9px;line-height:1.35}
body.tepPremiumMode .section{margin-top:12px}.tepPageLead{margin:8px 2px 13px}.tepPageLead h2{font-size:34px;line-height:1;margin:0;letter-spacing:-.05em}.tepPageLead p{font-size:11px;color:#8fa8bf;margin:7px 0 0;line-height:1.45}
body.tepPremiumMode .card{background:linear-gradient(145deg,rgba(8,25,39,.98),rgba(4,15,25,.98));border-color:#17364c;border-radius:19px;box-shadow:0 14px 34px rgba(0,0,0,.16)}body.tepPremiumMode .card h2{font-size:17px;letter-spacing:-.02em}body.tepPremiumMode .sub{color:#8fa8bf;font-size:10px}body.tepPremiumMode .pill{border-color:#21445c;background:#071926}body.tepPremiumMode .pill.good{color:var(--tep-lime);border-color:rgba(202,255,61,.34);background:rgba(202,255,61,.055)}
body.tepPremiumMode .chip{background:#071724;border-color:#21445c;color:#a7bdd2}body.tepPremiumMode .chip.active{border-color:var(--tep-lime);color:#06110a;background:linear-gradient(90deg,var(--tep-lime),#b8ff4b);box-shadow:0 0 18px rgba(202,255,61,.15)}body.tepPremiumMode .matchSearch{background:#061521;border:1px solid #21445c;color:white;border-radius:14px}
body.tepPremiumMode #matches>.card>.cardHead{display:none}.tepPremiumMatchSummary{position:relative;overflow:hidden;border-bottom:1px solid #17364c;background:linear-gradient(105deg,rgba(10,28,43,.98),rgba(5,17,28,.98));display:grid;grid-template-columns:1fr 44px 1fr 88px;align-items:center;gap:8px;padding:11px;cursor:pointer}.tepPremiumMatchSummary:hover{background:linear-gradient(105deg,rgba(13,35,53,.98),rgba(6,20,31,.98))}.tepMatchPlayer{display:flex;align-items:center;gap:8px;min-width:0}.tepMatchPlayer.right{flex-direction:row-reverse;text-align:right}.tepMatchPlayer .tepAvatar{width:48px;height:58px;border-radius:12px;flex:0 0 48px}.tepMatchPlayer .tepAvatarFallback{font-size:15px}.tepMatchPlayer b{display:block;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.tepMatchPlayer span{display:block;color:#8ba4ba;font-size:8px;margin-top:3px}.tepMatchVs{text-align:center;color:#7991a8;font-weight:900}.tepMatchProb{text-align:right}.tepMatchProb b{display:block;color:var(--tep-lime);font-size:17px}.tepMatchProb span{font-size:10px;color:#d5e9fb}.tepMatchMeta{grid-column:1/-1;display:flex;gap:7px;flex-wrap:wrap;color:#8da7be;font-size:8px;padding-top:3px}.tepMatchMeta i{font-style:normal;border:1px solid #1d4058;border-radius:999px;padding:4px 7px}.matchRow.open .tepPremiumMatchSummary{box-shadow:inset 3px 0 0 var(--tep-lime)}body.tepPremiumMode .matchSummary{display:none!important}body.tepPremiumMode .matchRow{border-color:#17364c;border-radius:17px;background:#061521}body.tepPremiumMode .matchDetail{background:#04111c;padding:12px}
body.tepPremiumMode .tepProMetrics{border-color:#21445c!important;background:linear-gradient(150deg,#071a29,#06131f)!important}
body.tepPremiumMode .recordKpi,body.tepPremiumMode .detailCell,body.tepPremiumMode .priceCell,body.tepPremiumMode .betCard,body.tepPremiumMode .liveCard,body.tepPremiumMode .riskBox{border-color:#1b3b52;background:linear-gradient(145deg,#081a28,#061521)}
body.tepPremiumMode .betCard.best{border-color:rgba(202,255,61,.46);box-shadow:0 0 0 1px rgba(202,255,61,.06),0 12px 28px rgba(0,0,0,.2)}body.tepPremiumMode .betRank,body.tepPremiumMode .edgeUp,body.tepPremiumMode .priceOk,body.tepPremiumMode .win{color:var(--tep-lime)!important}body.tepPremiumMode .progressBar{background:linear-gradient(90deg,var(--tep-cyan),var(--tep-lime))}
body.tepPremiumMode .bottomNav{display:none!important}#tepPremiumNav{position:fixed;left:50%;transform:translateX(-50%);bottom:0;z-index:80;width:min(100%,980px);display:grid;grid-template-columns:repeat(4,1fr);padding:9px 10px calc(8px + env(safe-area-inset-bottom));background:rgba(2,10,18,.94);border-top:1px solid #163248;backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}.tepNavBtn{border:0;background:transparent;color:#8fa6c1;min-height:55px;display:grid;place-items:center;gap:2px;font-size:9px}.tepNavBtn svg{width:23px;height:23px;fill:none;stroke:currentColor;stroke-width:1.8}.tepNavBtn.active{color:var(--tep-lime);text-shadow:0 0 16px rgba(202,255,61,.32)}.tepNavBtn.active svg{filter:drop-shadow(0 0 6px rgba(202,255,61,.28))}
#tepMenuToggle{width:38px;min-width:38px;padding:0!important;font-size:18px!important}#tepPremiumMenu{position:fixed;inset:0;z-index:120;display:none;background:rgba(0,6,11,.68);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}#tepPremiumMenu.open{display:block}.tepMenuSheet{position:absolute;right:12px;top:calc(max(64px,env(safe-area-inset-top) + 60px));width:min(330px,calc(100% - 24px));border:1px solid #21445c;border-radius:20px;background:linear-gradient(160deg,#081b2a,#04101a);padding:15px;box-shadow:var(--tep-shadow)}.tepMenuSheet h3{margin:0 0 3px;font-size:18px}.tepMenuSheet p{margin:0 0 12px;color:#8ca5bd;font-size:9px;line-height:1.4}.tepMenuAction{width:100%;border:1px solid #1d3c52;background:#071724;color:#eaf5ff;border-radius:13px;padding:12px;text-align:left;margin-top:7px;font-weight:800}.tepMenuAction b{color:var(--tep-lime);float:right}.tepPhotoCredit{font-size:7px;color:#587187;line-height:1.4;margin-top:12px}
.tepAvatar{position:relative;display:grid;place-items:center;overflow:hidden;background:radial-gradient(circle at 50% 25%,#183d55,#081725 70%);border:1px solid #21445c}.tepAvatar img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}.tepAvatarFallback{font-weight:950;color:#89a6be;letter-spacing:-.04em}
@media(max-width:720px){body.tepPremiumMode .app{padding-inline:10px}body.tepPremiumMode .topbar{margin-inline:-10px;padding-inline:10px}.tepDashPair{grid-template-columns:1fr 1fr}.tepHeroPlayers{grid-template-columns:1fr 38px 1fr;padding-inline:5px;min-height:205px}.tepPlayer{gap:3px}.tepPlayer.right{gap:3px}.tepPlayer .tepAvatar{width:min(30vw,145px);height:196px}.tepPlayerText{padding-bottom:20px}.tepPlayerText strong{font-size:clamp(17px,5vw,24px)}.tepPlayerText small{display:none}.tepVs{font-size:17px;padding-bottom:28px}.tepWinBand{margin-inline:8px;padding-inline:10px;grid-template-columns:.8fr 1.4fr .8fr}.tepWinCenter{padding-inline:6px}.tepHeroInsight{margin-inline:8px}.tepInsightStrip{grid-template-columns:1fr}.tepInsightCell{border-left:0;border-top:1px solid #17364c}.tepInsightCell:first-child{border-top:0}.tepPremiumMatchSummary{grid-template-columns:1fr 24px 1fr 62px}.tepMatchPlayer .tepAvatar{width:40px;height:49px;flex-basis:40px}.tepMatchProb b{font-size:15px}.tepPageLead h2{font-size:29px}}
@media(max-width:480px){body.tepPremiumMode .brand h1{font-size:19px}body.tepPremiumMode .brand p{font-size:6.8px;letter-spacing:.25em}body.tepPremiumMode #tep-brand-inline{width:36px!important;height:36px!important}.topActions .statusPill{display:none}.tepDashPair{grid-template-columns:1fr}.tepHeroTop{padding-top:12px}.tepBadge{font-size:9px;padding:6px 9px}.tepHeroPlayers{min-height:185px}.tepPlayer .tepAvatar{width:31vw;height:175px}.tepPlayerText span{display:none}.tepPlayerText strong{font-size:17px}.tepWinBand{grid-template-columns:.8fr 1.3fr .8fr}.tepHeroPct{font-size:38px}.tepWinCenter strong{font-size:10px}.tepConfidence i{width:12px;height:6px}.tepPremiumMatchSummary{grid-template-columns:1fr 20px 1fr 55px;padding:9px 7px}.tepMatchPlayer{gap:5px}.tepMatchPlayer .tepAvatar{width:34px;height:42px;flex-basis:34px}.tepMatchPlayer b{font-size:9px}.tepMatchProb b{font-size:13px}.tepMatchProb span{font-size:8px}}
`;

function installStyle(){
  if(byId('tepPremiumStyle'))return;
  const s=document.createElement('style');s.id='tepPremiumStyle';s.textContent=CSS;document.head.appendChild(s);
}
function countryLabel(name){
  const k=prettyName(name).toLowerCase();
  const m={
    'jannik sinner':'🇮🇹 ITA','lorenzo musetti':'🇮🇹 ITA','carlos alcaraz':'🇪🇸 ESP','novak djokovic':'🇷🇸 SRB','daniil medvedev':'🌐','alexander zverev':'🇩🇪 GER','casper ruud':'🇳🇴 NOR','holger rune':'🇩🇰 DEN','stefanos tsitsipas':'🇬🇷 GRE','iga swiatek':'🇵🇱 POL','iga świątek':'🇵🇱 POL','aryna sabalenka':'🌐','elena rybakina':'🇰🇿 KAZ','frances tiafoe':'🇺🇸 USA','ben shelton':'🇺🇸 USA'
  };
  return m[k]||'';
}
function probPair(ev){
  let a=num(ev?.p_a),b=num(ev?.p_b);
  if(a!==null&&b!==null&&a>=0&&b>=0&&a+b>0){const s=a+b;return [a/s,b/s]}
  const f=num(ev?.favorite_prob);if(f!==null&&f>0&&f<1){const fav=prettyName(ev?.favorite_name).toLowerCase(),pa=prettyName(ev?.player_a).toLowerCase();return fav===pa?[f,1-f]:[1-f,f]}
  return [null,null];
}
function currentEvent(){
  try{
    if(typeof activeRow==='function'&&typeof eventById==='function'&&typeof rowEventId==='function'){
      const r=activeRow();if(r){const x=eventById(rowEventId(r));if(x)return x}
    }
  }catch{}
  try{if(typeof filterUpcoming==='function'){const xs=filterUpcoming();if(xs?.length)return xs[0]}}catch{}
  try{if(typeof board!=='undefined'&&Array.isArray(board?.upcoming)&&board.upcoming.length)return board.upcoming[0]}catch{}
  return null;
}
function marketRowsFor(ev){try{return typeof rowsForEvent==='function'?rowsForEvent(ev?.event_id):[]}catch{return []}}
function rowProb(r){return num(r?.model_prob)??num(r?.forecast_prob)??num(r?.probability)??num(r?.p)}
function advancedMetrics(ev){
  const rows=marketRowsFor(ev),lab=ev?.market_lab||{};
  const total=num(lab.mean_total_games)??num(lab.median_total_games);
  const decide=rows.filter(r=>String(r?.market||'').toUpperCase()==='SET_SCORE'&&['2-1','1-2'].includes(String(r?.selection||''))).reduce((s,r)=>s+(rowProb(r)||0),0)||null;
  const tie=rows.find(r=>String(r?.market||'').toUpperCase()==='TIEBREAK_IN_MATCH'&&String(r?.selection||'').toUpperCase()==='YES');
  const tieP=tie?rowProb(tie):null;
  const pa=ev?.player_intel?.a?.service||{},pb=ev?.player_intel?.b?.service||{};
  const aceA=num(pa.aces_per_match),aceB=num(pb.aces_per_match),dfA=num(pa.double_faults_per_match),dfB=num(pb.double_faults_per_match);
  return {total,decide,tie:tieP,aceA,aceB,dfA,dfB};
}
function confidenceInfo(a,b,ev){
  const gap=a!==null&&b!==null?Math.abs(a-b):0,raw=num(ev?.confidence);const c=raw!==null?clamp(raw/100,0,1):clamp(.45+gap*.75,0,1);const bars=clamp(Math.round(c*5),1,5);return {bars,label:c>=.78?'Alta confidenza':c>=.62?'Confidenza media':'Confidenza prudente'};
}
function insightText(ev,a,b){
  try{if(typeof bestRowForEvent==='function'&&typeof rowWhy==='function'){const r=bestRowForEvent(ev.event_id),t=r?rowWhy(r):'';if(t&&t.length>8)return t}}
  catch{}
  if(a!==null&&b!==null){const fav=a>=b?prettyName(ev.player_a):prettyName(ev.player_b),p=Math.max(a,b);return `${fav} è avanti nel modello al ${pct(p)}. La percentuale è una stima, non una garanzia di risultato.`}
  return 'Il modello sta completando la lettura del match. Nessuna percentuale viene inventata quando il dato non è disponibile.';
}
function heroSignature(ev){const [a,b]=probPair(ev||{});return [ev?.event_id,ev?.player_a,ev?.player_b,a,b,ev?.confidence,ev?.start_at,ev?.surface,ev?.tournament].join('|')}
let lastHeroSig='';
function renderPremiumHero(){
  const host=byId('tepPremiumHero');if(!host)return;
  const ev=currentEvent();
  const sig=heroSignature(ev);if(sig===lastHeroSig)return;lastHeroSig=sig;
  if(!ev){host.innerHTML=`<div class="tepHeroTop"><span class="tepBadge lime">● MODELLO IN ATTESA</span></div><div style="padding:80px 20px;text-align:center;color:#8fa8bf"><b style="display:block;color:white;font-size:28px">Tennis Edge Pro</b><span style="display:block;margin-top:8px">Sto caricando i match e le probabilità validate.</span></div>`;return}
  const [a,b]=probPair(ev),ci=confidenceInfo(a,b,ev),m=advancedMetrics(ev),pa=prettyName(ev.player_a),pb=prettyName(ev.player_b),tour=String(ev.tour||'').toUpperCase()||(/WTA/i.test(ev.tournament||'')?'WTA':'ATP'),fav=a!==null&&b!==null?(a>=b?pa:pb):'—';
  const service=(m.aceA!==null||m.aceB!==null)?`${m.aceA!==null?m.aceA.toFixed(1):'—'} / ${m.aceB!==null?m.aceB.toFixed(1):'—'} ace/match`:'Storico servizio non disponibile';
  host.innerHTML=`
    <div class="tepHeroTop"><span class="tepBadge lime">🏆 ${esc(tour)}</span><span class="tepBadge">▦ ${esc(ev.surface||'Superficie N/D')}</span></div>
    <div class="tepHeroMeta"><b>${esc(shortTournament(ev.tournament))}</b> · ${esc(localTime(ev.start_at))}</div>
    <div class="tepHeroPlayers">
      <div class="tepPlayer">${avatarHtml(ev.player_a,'hero')}<div class="tepPlayerText"><small>Giocatore A</small><strong>${esc(pa)}</strong><span>${esc(countryLabel(ev.player_a))}</span></div></div>
      <div class="tepVs">VS</div>
      <div class="tepPlayer right">${avatarHtml(ev.player_b,'hero')}<div class="tepPlayerText"><small>Giocatore B</small><strong>${esc(pb)}</strong><span>${esc(countryLabel(ev.player_b))}</span></div></div>
    </div>
    <div class="tepWinBand">
      <div><div class="tepHeroPct a">${pct(a)}</div><span class="tepPctName">${esc(pa.split(' ').at(-1)||pa)}</span></div>
      <div class="tepWinCenter"><small>Probabilità di vittoria</small><strong>${esc(fav!=='—'?`${fav} in vantaggio`:'Dato in attesa')}</strong><small style="margin-top:5px">${esc(ci.label)}</small><div class="tepConfidence">${[0,1,2,3,4].map(i=>`<i class="${i<ci.bars?'on':''}"></i>`).join('')}</div></div>
      <div><div class="tepHeroPct b">${pct(b)}</div><span class="tepPctName">${esc(pb.split(' ').at(-1)||pb)}</span></div>
    </div>
    <div class="tepHeroInsight"><b>“</b>${esc(insightText(ev,a,b))}</div>
    <div class="tepInsightStrip" style="margin:0 16px 16px;position:relative;z-index:6">
      <div class="tepInsightCell"><b>${m.total!==null?m.total.toFixed(1):'—'}</b><span>Giochi attesi · modello</span></div>
      <div class="tepInsightCell"><b>${m.decide!==null?pct(m.decide):'—'}</b><span>Probabilità set decisivo</span></div>
      <div class="tepInsightCell"><b>${m.tie!==null?pct(m.tie):'—'}</b><span>Tie-break nel match · ${esc(service)}</span></div>
    </div>`;
  hydratePhotos(host);
}
function upcomingList(){
  try{if(typeof filterUpcoming==='function'){const x=filterUpcoming();if(Array.isArray(x)&&x.length)return x}}
  catch{}
  try{return Array.isArray(board?.upcoming)?board.upcoming:[]}catch{return []}
}
function renderDashboard(){
  const host=byId('tepPremiumDashboard');if(!host)return;
  const xs=upcomingList().slice(0,3);let liveCount=0;try{liveCount=Array.isArray(live?.events)?live.events.length:0}catch{}
  const sig=xs.map(heroSignature).join('::')+`|${liveCount}`;if(host.dataset.sig===sig)return;host.dataset.sig=sig;
  const rows=xs.map(ev=>{const [a,b]=probPair(ev),pa=prettyName(ev.player_a),pb=prettyName(ev.player_b);return `<div class="tepUpcomingRow" data-jump-match="${esc(ev.event_id)}"><time>${esc(localTime(ev.start_at).replace(/^\w+\s*/,'').split(',').at(-1)?.trim()||localTime(ev.start_at))}</time><div class="tepUpcomingNames">${avatarHtml(ev.player_a,'tepMiniAvatar')}<div><b>${esc(pa)} vs ${esc(pb)}</b><span>${esc(shortTournament(ev.tournament))} · ${esc(ev.surface||'—')}</span></div></div><div class="tepUpcomingProb">${pct(a)}<span>${pct(b)}</span></div></div>`}).join('')||'<div style="padding:14px;color:#8fa8bf;font-size:10px">Nessun match disponibile al momento.</div>';
  const lead=xs[0],met=lead?advancedMetrics(lead):{};
  host.innerHTML=`
    <div class="tepDashPair">
      <div class="tepDashCard" data-premium-go="matches"><div class="tepIconBox">▥</div><div><strong>Top Match</strong><p>Confronto visuale, probabilità e metriche del modello.</p></div></div>
      <div class="tepDashCard" data-premium-go="live"><div class="tepIconBox lime">⚡</div><div><strong>Live</strong><p>Match in corso e aggiornamenti disponibili.</p></div><span class="tepLivePill">${liveCount} LIVE</span></div>
    </div>
    <div class="tepUpcoming"><div class="tepSectionTitle"><strong>Partite in arrivo</strong><span data-premium-go="matches">Vedi tutte ›</span></div>${rows}</div>
    <div class="tepInsightStrip">
      <div class="tepInsightCell"><b>${lead?esc(lead.surface||'—'):'—'}</b><span>Superficie del match in evidenza</span></div>
      <div class="tepInsightCell"><b>${lead&&met.total!==null?met.total.toFixed(1):'—'}</b><span>Giochi attesi, se disponibili dal modello</span></div>
      <div class="tepInsightCell"><b>${lead&&met.tie!==null?pct(met.tie):'—'}</b><span>Probabilità tie-break, se validata</span></div>
    </div>`;
  hydratePhotos(host);wirePremiumGo(host);
}
function eventForRow(row){
  const id=String(row?.dataset?.id||'');if(!id)return null;
  try{if(typeof eventById==='function'){const x=eventById(id);if(x)return x}}catch{}
  return upcomingList().find(x=>String(x.event_id)===id)||null;
}
function renderPremiumMatches(){
  qa('#matchList .matchRow').forEach(row=>{
    const ev=eventForRow(row);if(!ev)return;
    const [a,b]=probPair(ev),open=row.classList.contains('open'),sig=[heroSignature(ev),open].join('|');
    let p=q('.tepPremiumMatchSummary',row);if(p?.dataset.sig===sig)return;
    const pa=prettyName(ev.player_a),pb=prettyName(ev.player_b);
    const html=`<div class="tepMatchPlayer">${avatarHtml(ev.player_a,'')}<div><b>${esc(pa)}</b><span>${esc(countryLabel(ev.player_a))}</span></div></div><div class="tepMatchVs">VS</div><div class="tepMatchPlayer right">${avatarHtml(ev.player_b,'')}<div><b>${esc(pb)}</b><span>${esc(countryLabel(ev.player_b))}</span></div></div><div class="tepMatchProb"><b>${pct(a)}</b><span>${pct(b)} ${open?'⌃':'›'}</span></div><div class="tepMatchMeta"><i>${esc(shortTournament(ev.tournament))}</i><i>${esc(ev.surface||'—')}</i><i>${esc(localTime(ev.start_at))}</i></div>`;
    if(!p){p=document.createElement('div');p.className='tepPremiumMatchSummary';row.insertBefore(p,row.firstChild);p.addEventListener('click',e=>{if(e.target.closest('a,button,input,select'))return;const b=q('.expandBtn',row);if(b)b.click()});}
    p.dataset.sig=sig;p.innerHTML=html;hydratePhotos(p);
  });
}
function insertPageLeads(){
  const defs={
    matches:['Esplora','Cerca i prossimi match, confronta probabilità, superficie e dettagli senza perdere il contesto.'],
    live:['Live','Punteggio, stato del match e segnali in-play con la stessa interfaccia premium.'],
    record:['Analisi','Track record, qualità del modello e performance leggibili a colpo d’occhio.'],
    bankroll:['Le mie analisi','Bankroll, smart card e registro locale delle tue decisioni.']
  };
  Object.entries(defs).forEach(([id,[title,sub]])=>{const sec=byId(id);if(!sec||q('.tepPageLead',sec))return;const lead=document.createElement('div');lead.className='tepPageLead';lead.innerHTML=`<h2>${esc(title)}</h2><p>${esc(sub)}</p>`;sec.insertBefore(lead,sec.firstChild)});
}
function installHeroAndDashboard(){
  const main=byId('mainContent');if(!main)return;
  if(!byId('tepPremiumHero')){const hero=document.createElement('section');hero.id='tepPremiumHero';hero.setAttribute('aria-label','Match in evidenza');const old=byId('hero');main.insertBefore(hero,old||main.firstChild)}
  const bets=byId('bets');if(bets&&!byId('tepPremiumDashboard')){const d=document.createElement('div');d.id='tepPremiumDashboard';bets.insertBefore(d,bets.firstChild)}
}
function installNav(){
  if(byId('tepPremiumNav'))return;
  const n=document.createElement('nav');n.id='tepPremiumNav';n.setAttribute('aria-label','Navigazione premium');
  n.innerHTML=`
    <button class="tepNavBtn" data-target="bets" type="button"><svg viewBox="0 0 24 24"><path d="M3 11.5 12 4l9 7.5V21h-6v-6H9v6H3z"/></svg><span>Home</span></button>
    <button class="tepNavBtn" data-target="matches" type="button"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6"/><path d="m16 16 4 4"/></svg><span>Esplora</span></button>
    <button class="tepNavBtn" data-target="record" type="button"><svg viewBox="0 0 24 24"><path d="M5 19V9m5 10V5m5 14v-7m5 7V8"/></svg><span>Analisi</span></button>
    <button class="tepNavBtn" data-target="bankroll" type="button"><svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/></svg><span>Le mie analisi</span></button>`;
  document.body.appendChild(n);
  qa('.tepNavBtn',n).forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.target)));
}
function navigate(target){
  const old=q(`.bottomNav .nav[data-go="${CSS.escape(target)}"]`);if(old){old.click();window.scrollTo({top:0,behavior:'smooth'})}
  syncNav();closeMenu();
}
function syncNav(){
  const active=q('.section.active')?.id||'bets';qa('.tepNavBtn').forEach(b=>b.classList.toggle('active',b.dataset.target===active));
}
function wirePremiumGo(root=document){qa('[data-premium-go]',root).forEach(x=>{if(x.dataset.goWired)return;x.dataset.goWired='1';x.style.cursor='pointer';x.addEventListener('click',()=>navigate(x.dataset.premiumGo))})}
function installMenu(){
  const top=q('.topActions');if(!top)return;
  if(!byId('tepMenuToggle')){const b=document.createElement('button');b.className='miniBtn';b.id='tepMenuToggle';b.type='button';b.setAttribute('aria-label','Apri menu');b.textContent='☰';b.addEventListener('click',toggleMenu);top.appendChild(b)}
  if(!byId('tepPremiumMenu')){const m=document.createElement('div');m.id='tepPremiumMenu';m.innerHTML=`<div class="tepMenuSheet"><h3>Tennis Edge Pro</h3><p>Accesso rapido alle funzioni che restano fuori dalla barra principale.</p><button class="tepMenuAction" data-menu-go="live">Live <b>›</b></button><button class="tepMenuAction" data-menu-go="record">Track record <b>›</b></button><button class="tepMenuAction" data-menu-go="bankroll">Bankroll & My Bets <b>›</b></button><button class="tepMenuAction" data-menu-sure="1">SureBet <b>↗</b></button><div class="tepPhotoCredit">Le foto giocatore, quando disponibili, vengono caricate da Wikipedia/Wikimedia; tocca la foto nel browser per risalire alla pagina sorgente/licenza. Se una foto non è disponibile viene mostrato un avatar neutro.</div></div>`;document.body.appendChild(m);m.addEventListener('click',e=>{if(e.target===m)closeMenu()});qa('[data-menu-go]',m).forEach(b=>b.addEventListener('click',()=>navigate(b.dataset.menuGo)));q('[data-menu-sure]',m)?.addEventListener('click',()=>{const a=q('.bottomNav .sureLink');if(a)location.href=a.href});}
}
function toggleMenu(){byId('tepPremiumMenu')?.classList.toggle('open')}function closeMenu(){byId('tepPremiumMenu')?.classList.remove('open')}
function tuneBrand(){
  const h=q('.brand h1'),p=q('.brand p');if(h&&!h.dataset.premium){h.dataset.premium='1';h.innerHTML='Tennis <span class="tepEdgeWord">Edge</span> Pro';}if(p)p.textContent='DATI · ANALISI · VANTAGGIO';
}
let busy=false,timer=null;
function refresh(){
  if(busy)return;busy=true;
  try{tuneBrand();installHeroAndDashboard();insertPageLeads();renderPremiumHero();renderDashboard();renderPremiumMatches();syncNav();wirePremiumGo();hydratePhotos();}finally{busy=false}
}
function schedule(){clearTimeout(timer);timer=setTimeout(refresh,80)}
function boot(){
  document.body.classList.add('tepPremiumMode');installStyle();tuneBrand();installHeroAndDashboard();installNav();installMenu();insertPageLeads();refresh();
  const root=byId('mainContent')||document.body;const mo=new MutationObserver(schedule);mo.observe(root,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});setInterval(refresh,5000);
  document.documentElement.dataset.tepPremiumShell=MARK;
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot();
})();
