import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';

const html = await readFile(new URL('../public/dashboard.html',import.meta.url),'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match=>match[1]).find(source=>source.includes('function toggleMode()'))!;
function dashboard() {
  const elements = new Map<string,any>();
  const calls:{path:string,options:any}[]=[];
  const element = (id:string) => {
    if(!elements.has(id)) elements.set(id,{value:id==='credentialPurpose'?'paper':'',disabled:false,hidden:false,required:false,textContent:'',innerHTML:'',style:{},classList:{toggle(){},add(){},remove(){}},listeners:new Map(),addEventListener(event:string,handler:unknown){this.listeners.set(event,handler);}});
    return elements.get(id);
  };
  const context=createContext({document:{getElementById:element},AbortSignal,setInterval(){},fetch:async (path:string,options:any)=>{
    calls.push({path,options});
    return {ok:true,status:200,headers:{get(){return null;}},text:async()=>JSON.stringify({operatorConfigured:true,storageConfigured:true,credentialsStatusAvailable:false})};
  }});
  // Exercise the real functions/event handlers without starting network polling.
  runInContext(script.replace('initCharts(); lockDashboard(); health();','initCharts(); lockDashboard();'),context);
  return {elements,element,context,calls,run:(source:string)=>runInContext(source,context)};
}

test('dashboard PAPER option saves API-only data, clears secrets, and distinguishes TERSIMPAN from empty inputs',async () => {
  const ui=dashboard();
  ui.run("controlToken='synthetic-operator'; refresh=async()=>{};");
  ui.element('credentialPurpose').value='paper'; ui.element('predictApiKey').value='synthetic-paper-key';
  ui.element('walletPrivateKey').value='must-not-send-wallet-in-paper';
  const saved={saved:true,credentialsStored:true,credentialRevision:1,credentialValidation:'paper_ready',predictApiConfigured:true,walletConfigured:false,enableAutoTrade:false,commands:[]};
  ui.context.fetch=async (path:string,options:any)=>{
    ui.calls.push({path,options});
    return {ok:true,status:200,headers:{get(){return null;}},text:async()=>JSON.stringify(saved)};
  };
  await ui.element('credentialsForm').listeners.get('submit')({preventDefault(){}});
  assert.equal(ui.calls.length,1); assert.equal(ui.calls[0].path,'/api/credentials');
  assert.deepEqual(JSON.parse(ui.calls[0].options.body),{PREDICT_FUN_API_KEY:'synthetic-paper-key',WALLET_PRIVATE_KEY:'',PREDICT_ACCOUNT_ADDRESS:''});
  assert.equal(ui.element('predictApiKey').value,''); assert.equal(ui.element('walletPrivateKey').value,'');
  assert.match(ui.element('credentialStatus').textContent,/TERSIMPAN.*API key untuk PAPER/);
  assert.match(ui.element('commandMessage').textContent,/Data baru muncul setelah daemon aktif/);
  assert.equal(ui.element('walletPrivateKey').disabled,true);
  ui.run('lockDashboard()'); assert.equal(ui.element('credentialPurpose').disabled,true);
});

test('mode click and live activation explain the missing wallet without queueing a request',async () => {
  const ui=dashboard();
  ui.context.config={isPaperTrading:true,enableAutoTrade:false,predictApiConfigured:true,walletConfigured:false,credentialValidation:'paper_ready',liveTradingEnabled:true};
  ui.run("controlToken='synthetic-operator'; latestConfig=config; latestStats={workerAvailable:false};");
  await ui.run('toggleMode()');
  assert.equal(ui.calls.length,0); assert.match(ui.element('commandMessage').textContent,/API key saja cukup untuk PAPER.*WALLET_PRIVATE_KEY/);
  await ui.run('startLive()'); assert.equal(ui.calls.length,0);
  ui.context.config={...ui.context.config,walletConfigured:true,credentialValidation:'format_valid'};
  ui.run('latestConfig=config'); await ui.run('toggleMode()');
  assert.equal(ui.calls.length,0); assert.match(ui.element('commandMessage').textContent,/daemon offline/);
});

test('switching setup back to PAPER clears wallet fields and makes the signing key optional',() => {
  const ui=dashboard(); ui.run("controlToken='synthetic-operator'");
  ui.element('credentialPurpose').value='live'; ui.element('credentialPurpose').listeners.get('change')();
  assert.equal(ui.element('walletPrivateKey').required,true); assert.equal(ui.element('walletPrivateKey').disabled,false);
  ui.element('walletPrivateKey').value='synthetic-secret'; ui.element('predictAccountAddress').value='0x123';
  ui.element('credentialPurpose').value='paper'; ui.element('credentialPurpose').listeners.get('change')();
  assert.equal(ui.element('walletPrivateKey').required,false); assert.equal(ui.element('walletPrivateKey').disabled,true);
  assert.equal(ui.element('walletPrivateKey').value,''); assert.equal(ui.element('predictAccountAddress').value,'');
  assert.ok(!/\b(?:localStorage|sessionStorage)\b/.test(script));
});

test('offline diagnostic distinguishes recorded failure codes from unknown causes',() => {
  const ui=dashboard();
  ui.context.stats={credentialsStored:true,credentialRevision:3,workerLastPhase:'failed',workerFailureCode:'READ_FAILED'};
  assert.match(ui.run('offlineWorkerMessage(stats)'),/TERSIMPAN.*READ_FAILED.*private Blob/);
  ui.context.stats.workerFailureCode='LEASE_LOST';
  assert.match(ui.run('offlineWorkerMessage(stats)'),/LEASE_LOST.*lease/);
  ui.context.stats.workerFailureCode=null;
  const unknown=ui.run('offlineWorkerMessage(stats)');
  assert.match(unknown,/Penyebab belum tersedia/); assert.ok(!unknown.includes('private Blob'));
  ui.context.stats={workerLastPhase:'offline'};
  assert.match(ui.run('offlineWorkerMessage(stats)'),/penyebab offline belum diketahui/);
});
