import fs from "node:fs";

const event=process.env.GH_EVENT_NAME||process.env.GITHUB_EVENT_NAME||"local";
const schedule=process.env.GH_EVENT_SCHEDULE||"";
const now=Date.now();

function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"))}catch{return null}}
function ageMinutes(value){const t=new Date(value||0).getTime();return Number.isFinite(t)&&t>0?(now-t)/60000:Infinity}
function dataAge(doc){return ageMinutes(doc?.meta?.data_refreshed_at||doc?.meta?.updated_at)}
function output(key,value){if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`${key}=${value}\n`)}

const quant=read("data/quant-board.json");
const live=read("data/live-board.json");
const manual=event==="workflow_dispatch";
const quantAge=dataAge(quant),liveAge=dataAge(live);
const quantVersion=String(quant?.meta?.model_version||"");
const liveVersion=String(live?.meta?.model_version||"");
const runQuant=manual||quantAge>=50||!quantVersion.includes("12.5");
const runLive=manual||liveAge>=12||!liveVersion.includes("12.5");
const quantReason=manual?"manual":!quantVersion.includes("12.5")?"upgrade":!Number.isFinite(quantAge)?"missing":`age-${quantAge.toFixed(1)}m`;
const liveReason=manual?"manual":!liveVersion.includes("12.5")?"upgrade":!Number.isFinite(liveAge)?"missing":`age-${liveAge.toFixed(1)}m`;

for(const [key,value] of Object.entries({run_quant:runQuant,run_live:runLive,quant_reason:quantReason,live_reason:liveReason}))output(key,String(value));
console.log(JSON.stringify({ok:true,event,schedule:schedule||null,run_quant:runQuant,run_live:runLive,quant_reason:quantReason,live_reason:liveReason,quant_age_min:Number.isFinite(quantAge)?+quantAge.toFixed(1):null,live_age_min:Number.isFinite(liveAge)?+liveAge.toFixed(1):null}));
