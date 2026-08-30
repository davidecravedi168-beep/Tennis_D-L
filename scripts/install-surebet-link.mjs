import fs from 'node:fs';
const file='index.html';
let s=fs.readFileSync(file,'utf8');
const marker='TEP-SUREBET-NAV-1';
if(!s.includes(marker)){
  s=s.replace('</style>',`\n/* ${marker} */\n.bottomNav{grid-template-columns:repeat(6,1fr)}.nav.sureLink{text-decoration:none}.nav.sureLink span{pointer-events:none}\n</style>`);
  const nav=`\n<a class="nav sureLink" href="./surebet.html" aria-label="SureBet"><svg viewBox="0 0 24 24"><path d="M4 12h5l2-6 3 12 2-6h4"/><path d="M5 20h14"/></svg><span>SURE</span></a>`;
  s=s.replace('</nav>',`${nav}\n</nav>`);
  fs.writeFileSync(file,s);
  console.log(JSON.stringify({ok:true,changed:true,marker}));
}else console.log(JSON.stringify({ok:true,changed:false,marker}));
