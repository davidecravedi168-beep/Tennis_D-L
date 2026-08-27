import fs from 'node:fs';

const path = 'index.html';
let html = fs.readFileSync(path, 'utf8');

function replaceExact(label, from, to) {
  const first = html.indexOf(from);
  if (first < 0) throw new Error(`[${label}] source pattern not found`);
  if (html.indexOf(from, first + from.length) >= 0) throw new Error(`[${label}] source pattern is not unique`);
  html = html.replace(from, to);
  console.log(`patched: ${label}`);
}

function replaceCount(label, from, to, expected) {
  const count = html.split(from).length - 1;
  if (count !== expected) throw new Error(`[${label}] expected ${expected} matches, found ${count}`);
  html = html.split(from).join(to);
  console.log(`patched: ${label} x${count}`);
}

replaceExact(
  'autopilot recovery helpers',
  "const schedulerSafe=()=>board?.meta?.automation?.scheduler_verified===true&&schedulerAge()<55;\nconst hoursToStart=",
  "const schedulerSafe=()=>board?.meta?.automation?.scheduler_verified===true&&schedulerAge()<55;\nconst recoverySafe=()=>{const a=board?.meta?.automation||{},event=String(a.event||'').toLowerCase();return event==='push'&&automationAge()<55};\nconst autopilotSafe=()=>schedulerSafe()||recoverySafe();\nconst hoursToStart="
);

replaceExact(
  'operational safety accepts validated recovery',
  "return !!board&&contract.ok&&boardFresh()&&schedulerSafe()&&!usingCache&&navigator.onLine&&board?.meta?.calibration_active===true",
  "return !!board&&contract.ok&&boardFresh()&&autopilotSafe()&&!usingCache&&navigator.onLine&&board?.meta?.calibration_active===true"
);

replaceExact(
  'guard recovery semantics',
  "  if(!schedulerSafe())return{title:'AUTOPILOT NON CERTIFICATO',text:'L’ultimo aggiornamento non proviene da un ciclo automatico recente. Le giocate restano bloccate finché GitHub conferma un vero evento programmato.',cls:'warn'};\n  if(!boardFresh())return{title:'AGGIORNAMENTO TROPPO VECCHIO'",
  "  if(!autopilotSafe())return{title:'AUTOPILOT NON OPERATIVO',text:'Non esiste un ciclo automatico o recovery recente. Forecast e ingressi restano bloccati finché la pipeline non torna fresca.',cls:'bad'};\n  if(!boardFresh())return{title:'AGGIORNAMENTO TROPPO VECCHIO'"
);

replaceExact(
  'guard recovery advisory',
  "  if(['DRIFT','DEGRADED','ERROR'].includes(health)||anomaly)return{title:'ANOMALIA SOTTO CONTROLLO',text:'Dati, quota o comportamento del modello sono diversi dal normale. Non significa partita truccata né previsione certa: l’ingresso resta bloccato finché non arriva conferma.',cls:health==='ERROR'?'bad':'warn'};\n  return{title:'TUTTO REGOLARE',text:'Dati, quote e modello stanno superando i controlli automatici. Restano comunque validi prezzo minimo e gestione del rischio.',cls:''};",
  "  if(['DRIFT','DEGRADED','ERROR'].includes(health)||anomaly)return{title:'ANOMALIA SOTTO CONTROLLO',text:'Dati, quota o comportamento del modello sono diversi dal normale. Non significa partita truccata né previsione certa: l’ingresso resta bloccato finché non arriva conferma.',cls:health==='ERROR'?'bad':'warn'};\n  if(!schedulerSafe()&&recoverySafe())return{title:'AUTOPILOT RECOVERY',text:'Dati freschi e validati da un ciclo automatico di recovery via push. Il cron nativo resta non certificato, ma non azzera più forecast e PAPER/TEST.',cls:'warn'};\n  return{title:'TUTTO REGOLARE',text:'Dati, quote e modello stanno superando i controlli automatici. Restano comunque validi prezzo minimo e gestione del rischio.',cls:''};"
);

replaceExact(
  'data health autopilot gate',
  "    ['AUTOPILOT',schedulerSafe(),schedulerSafe()?'SCHEDULE':'GUARD'],",
  "    ['AUTOPILOT',autopilotSafe(),schedulerSafe()?'SCHEDULE':recoverySafe()?'RECOVERY':'GUARD'],"
);

replaceExact(
  'autopilot status renderer',
  "  const bar=$('autopilotBar'),state=$('autopilotState'),detail=$('autopilotDetail'),a=board?.meta?.automation||{},cycle=automationAge(),scheduledCycle=schedulerAge(),data=boardAge(),scheduled=schedulerSafe(),dataOk=finite(data)&&data<BOARD_MAX_AGE,healthy=scheduled&&dataOk;\n  bar.className=`autopilotBar ${healthy?'ok':scheduled||finite(cycle)?'warn':'bad'}`;\n  state.textContent=healthy?'AUTOPILOT · ATTIVO':scheduled?'AUTOPILOT · DATA GUARD':a.event==='workflow_dispatch'?'AUTOPILOT · SOLO MANUALE':'AUTOPILOT · DA VERIFICARE';\n  detail.textContent=scheduled?`Ciclo automatico ${Math.round(scheduledCycle)} min fa · ${finite(data)?`dati quant ${Math.round(data)} min fa`:'dati quant non aggiornati'}`:finite(cycle)?`Ultimo controllo ${Math.round(cycle)} min fa (${a.event||'evento sconosciuto'}). Le giocate restano bloccate finché il cron non è certificato.`:'Nessun ciclo automatico certificato: fail-closed attivo.';",
  "  const bar=$('autopilotBar'),state=$('autopilotState'),detail=$('autopilotDetail'),a=board?.meta?.automation||{},cycle=automationAge(),scheduledCycle=schedulerAge(),data=boardAge(),scheduled=schedulerSafe(),recovery=recoverySafe(),active=scheduled||recovery,dataOk=finite(data)&&data<BOARD_MAX_AGE,healthy=active&&dataOk;\n  bar.className=`autopilotBar ${scheduled&&dataOk?'ok':healthy?'warn':active||finite(cycle)?'warn':'bad'}`;\n  state.textContent=scheduled&&dataOk?'AUTOPILOT · ATTIVO':recovery&&dataOk?'AUTOPILOT · RECOVERY':scheduled?'AUTOPILOT · DATA GUARD':a.event==='workflow_dispatch'?'AUTOPILOT · SOLO MANUALE':'AUTOPILOT · DA VERIFICARE';\n  detail.textContent=scheduled?`Ciclo schedule ${Math.round(scheduledCycle)} min fa · ${finite(data)?`dati quant ${Math.round(data)} min fa`:'dati quant non aggiornati'}`:recovery?`Recovery automatico ${Math.round(cycle)} min fa (push) · dati e forecast utilizzabili; cron nativo ancora da certificare.`:finite(cycle)?`Ultimo controllo ${Math.round(cycle)} min fa (${a.event||'evento sconosciuto'}). Pipeline non certificata come recovery recente.`:'Nessun ciclo automatico recente: fail-closed attivo.';"
);

replaceCount(
  'recovery labels',
  "['Autopilot',schedulerSafe()?'SCHEDULE OK':'GUARD']",
  "['Autopilot',schedulerSafe()?'SCHEDULE OK':recoverySafe()?'RECOVERY OK':'GUARD']",
  2
);

fs.writeFileSync(path, html);
console.log('TEP UI recovery patch complete');
