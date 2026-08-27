import fs from "node:fs";

const html=fs.readFileSync("index.html","utf8");
const inline=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(x=>x[1]).join("\n");
new Function(inline);
const required=["Tennis Edge Pro","TEP-12.5-AUTOPILOT","id=\"autopilotBar\"","id=\"bestBets\"","id=\"marketMatrix\"","id=\"liveGrid\"","id=\"matchList\"","id=\"recordTable\"","id=\"smartSlip\"","function validateBoard","function operationalSafe","function renderAutomation","function renderMatches","function renderRecord","function renderBankroll"];
const missing=required.filter(x=>!html.includes(x));
if(missing.length)throw new Error(`app contract missing: ${missing.join(", ")}`);
const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
const duplicates=[...new Set(ids.filter((x,i)=>ids.indexOf(x)!==i))];
if(duplicates.length)throw new Error(`duplicate ids: ${duplicates.join(", ")}`);
console.log(JSON.stringify({ok:true,version:"TEP-12.5-AUTOPILOT",ids:ids.length,inline_script_bytes:inline.length}));
