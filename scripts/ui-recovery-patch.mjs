import fs from 'node:fs';

const path = 'index.html';
let html = fs.readFileSync(path, 'utf8');
const from = "return event==='push'&&automationAge()<55};";
const to = "return event==='push'&&automationAge()<80};";
const count = html.split(from).length - 1;
if (count !== 1) throw new Error(`recovery TTL patch expected 1 match, found ${count}`);
html = html.replace(from, to);
fs.writeFileSync(path, html);
console.log('patched: recovery heartbeat TTL 55m -> 80m');
