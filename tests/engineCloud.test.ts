import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PredictFunArbitrageEngine, DEFAULT_ARB_CONFIG } from '../server/arbitrage-engine';

const dirs: string[] = [];
const originalNow = Date.now;
const originalApiKey = process.env.PREDICT_FUN_API_KEY;
afterEach(() => { Date.now = originalNow; if(originalApiKey === undefined)delete process.env.PREDICT_FUN_API_KEY;else process.env.PREDICT_FUN_API_KEY=originalApiKey; dirs.splice(0).forEach(dir => rmSync(dir,{recursive:true,force:true})); });
function ledgerPath() { const dir=mkdtempSync(join(tmpdir(),'predict-cloud-hooks-'));dirs.push(dir);return join(dir,'ledger.json'); }
const trade = {id:'Paper_cloud',mode:'paper',timestamp:Date.now(),amount:1,resolved:false} as any;
function setup(value: any) {
  const epoch=Math.floor(originalNow()/300000)*300;
  const now=epoch*1000+60000; Date.now=()=>now;
  value.isRunning=true;value.cfg.enableAutoTrade=true;value.cfg.maxTradeAmount=.25;
  value.currentStartPrice=100000;value.currentPrice=100020;
  value.lastPredictOdds={upOdds:2.5,downOdds:1/.61,timestamp:now-10};
  value.predictMarketDetails={epoch,market:{id:1,tradingStatus:'OPEN',feeRateBps:200,decimalPrecision:3},upOutcome:{name:'Up',onChainId:'1',bestAsk:{price:.4}},downOutcome:{name:'Down',onChainId:'2',bestAsk:{price:.61}},book:{asks:[[.4,100]],bids:[[.39,100]]}};
}
const signal={direction:'UP',edge:.3,confidence:.9,fairOdds:1.2,marketOdds:2.5,momentum:1,volumeSpike:true,orderBookImbalance:.8,latencyMs:10,reason:'synthetic'};

test('cloud ledger is authoritative and never falls back to a local file', async () => {
  const path=ledgerPath();writeFileSync(path,JSON.stringify([{...trade,id:'Paper_local'}]));
  const saved:any[]=[];
  const value=new PredictFunArbitrageEngine({memoryFilePath:path},{loadTrades:async()=>[trade],saveTrades:async snapshot=>{saved.push(snapshot);}}) as any;
  await value.historyLoad;
  assert.deepEqual(value.trades.map((t:any)=>t.id),['Paper_cloud']);
  await value.saveTrades();
  assert.equal(saved.length,1);
  assert.equal(JSON.parse(readFileSync(path,'utf8'))[0].id,'Paper_local');
});
test('credential rotation prefers the current API key and never revives an import-time key', async () => {
  const captured=DEFAULT_ARB_CONFIG.predictFunApiKey;
  try {
    DEFAULT_ARB_CONFIG.predictFunApiKey='synthetic-import-time-key';
    process.env.PREDICT_FUN_API_KEY='synthetic-current-key';
    const value=new PredictFunArbitrageEngine({memoryFilePath:ledgerPath(),predictFunApiKey:'synthetic-stale-instance-key'},{loadTrades:async()=>[],saveTrades:async()=>{}});
    await value.ready();assert.equal(value.cfg.predictFunApiKey,'synthetic-current-key');
    delete process.env.PREDICT_FUN_API_KEY;
    const cleared=new PredictFunArbitrageEngine({memoryFilePath:ledgerPath()},{loadTrades:async()=>[],saveTrades:async()=>{}});
    await cleared.ready();assert.equal(cleared.cfg.predictFunApiKey,'');
  } finally {DEFAULT_ARB_CONFIG.predictFunApiKey=captured;}
});
test('cloud persistence requires both hooks and failures pause execution without file fallback', async () => {
  assert.throws(()=>new PredictFunArbitrageEngine({}, {loadTrades:async()=>[]}),/both/);
  const path=ledgerPath();
  const value=new PredictFunArbitrageEngine({memoryFilePath:path},{loadTrades:async()=>[],saveTrades:async()=>{throw new Error('synthetic store outage');}}) as any;
  await value.historyLoad;
  await assert.rejects(value.saveTrades(),/synthetic store outage/);
  assert.equal(value.getStats().storageHealthy,false);
  assert.equal(value.cfg.enableAutoTrade,false);
  assert.equal(existsSync(path),false);
});
test('remote snapshots are detached and writes preserve invocation order', async () => {
  let release!:()=>void;
  const first=new Promise<void>(r=>release=r);
  const observed:string[]=[];let calls=0;
  const value=new PredictFunArbitrageEngine({memoryFilePath:ledgerPath()},{loadTrades:async()=>[],saveTrades:async snapshot=>{calls++;if(calls===1)await first;observed.push(snapshot[0].id);}}) as any;
  await value.historyLoad;value.trades=[{...trade,id:'Paper_first'}];
  const one=value.saveTrades();value.trades[0].id='Paper_second';const two=value.saveTrades();
  await Promise.resolve();assert.equal(calls,1);release();await Promise.all([one,two]);
  assert.deepEqual(observed,['Paper_first','Paper_second']);
});
test('unreadable cloud state cannot import a local ledger or overwrite remote state', async () => {
  const path=ledgerPath();writeFileSync(path,JSON.stringify([trade]));let writes=0;
  const value=new PredictFunArbitrageEngine({memoryFilePath:path},{loadTrades:async()=>{throw new Error('synthetic corrupt state');},saveTrades:async()=>{writes++;}}) as any;
  await value.historyLoad;assert.equal(value.trades.length,0);assert.equal(value.getStats().storageHealthy,false);
  await assert.rejects(value.ready(),/healthy/);
  await assert.rejects(value.saveTrades(),/recovery/);assert.equal(writes,0);
});
test('a missing execution lease blocks paper entry and sale as well as live submission', async () => {
  let allowed=false;let fences=0;
  const value=new PredictFunArbitrageEngine({memoryFilePath:ledgerPath()},{loadTrades:async()=>[],saveTrades:async()=>{},canExecute:()=>allowed,beforeSubmit:async()=>{fences++;}}) as any;
  await value.historyLoad;setup(value);
  await value.executeTrade(signal);assert.equal(value.trades.length,0);
  value.trades=[{...trade,targetLockTime:value.predictMarketDetails.epoch,isFilled:true,sharesQuantity:1,amount:.1,fillTimestamp:Date.now()-10000}];
  await value.checkInstantSellOpportunities(.39,.6);assert.equal(value.trades[0].resolved,false);
  await assert.rejects(value.beforeLiveSubmit(),/lease/);assert.equal(fences,0);
  allowed=true;await value.beforeLiveSubmit();assert.equal(fences,1);
});
test('pause fences only new BUY orders while allowing SELL exits', async () => {
  const actions:string[]=[];
  const value=new PredictFunArbitrageEngine({memoryFilePath:ledgerPath()},{loadTrades:async()=>[],saveTrades:async()=>{},canExecute:()=>true,beforeSubmit:async action=>{actions.push(action || 'BUY');}}) as any;
  await value.ready();setup(value);value.cfg.enableAutoTrade=false;
  await assert.rejects(value.beforeLiveSubmit('BUY'),/paused/);
  await value.beforeLiveSubmit('SELL');assert.deepEqual(actions,['SELL']);
  value.isRunning=false;await assert.rejects(value.beforeLiveSubmit('SELL'),/stopped/);
});
test('stop waits for pending callbacks and ordered cloud writes before allowing engine replacement', async () => {
  let finishWrite!:()=>void;const pending=new Promise<void>(r=>finishWrite=r);let writes=0;
  const value=new PredictFunArbitrageEngine({memoryFilePath:ledgerPath()},{loadTrades:async()=>[],saveTrades:async()=>{writes++;if(writes===1)await pending;}}) as any;
  await value.ready();value.isRunning=true;value.isExecutingTrade=true;
  const saving=value.saveTrades();let stopped=false;
  const stopping=value.stop().then(()=>{stopped=true;});
  assert.equal(value.isRunning,false);assert.equal(value.stop(),value.stop());
  await new Promise(r=>setTimeout(r,30));assert.equal(stopped,false);
  value.isExecutingTrade=false;finishWrite();await Promise.all([saving,stopping]);
  assert.equal(stopped,true);assert.equal(writes,2);
});
