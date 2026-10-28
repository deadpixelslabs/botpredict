import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createCloudApi, cloudSnapshot, type CloudApiStore } from '../server/cloudApi';
import type { CloudState } from '../server/cloudStore';
import { credentialProofId, sealCredentials, validateCredentials } from '../server/credentials';

const now = Date.UTC(2026,9,29,12);
const token = 'synthetic-operator-token-for-http-test';
const env: NodeJS.ProcessEnv = {BOT_CONTROL_TOKEN:token,BLOB_STORE_ID:'store_test',PREDICT_FUN_API_KEY:'synthetic-api-key',ENABLE_LIVE_TRADING:'false'};
function initial(): CloudState {
  return {schemaVersion:1,revision:1,updatedAt:now,config:{isPaperTrading:true,enableAutoTrade:false,maxTradeAmount:1,minConfidence:.65},ledger:[],commands:[],status:{heartbeatAt:now-1000,phase:'paused',currentPrice:90000,quoteAgeMs:200,storageHealthy:true,logs:['Synthetic log']}};
}
class FakeStore implements CloudApiStore {
  state = initial(); reads = 0; writes = 0; unavailable = false;
  async readState() { this.reads++; if(this.unavailable)throw new Error('private-url?token=do-not-echo'); return structuredClone(this.state); }
  async mutateState(mutator:(state:CloudState)=>void|Promise<void>) {
    if(this.unavailable)throw new Error('private-url?token=do-not-echo');
    const next = structuredClone(this.state); await mutator(next); this.writes++; this.state = next; return structuredClone(next);
  }
}
async function httpFixture(context:any, config:NodeJS.ProcessEnv=env) {
  const store = new FakeStore();
  const app = createCloudApi({store,env:config,now:()=>now});
  const server:Server = createServer(app);
  await new Promise<void>(resolve => server.listen(0,'127.0.0.1',resolve));
  context.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if(!address || typeof address === 'string')throw new Error('Missing address');
  const base = `http://127.0.0.1:${address.port}`;
  const request = async (path:string,options:RequestInit={},authorized=true) => {
    const result = await fetch(base+path,{...options,headers:{...(authorized?{Authorization:'Bearer '+token}:{}),...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
    return {status:result.status,body:await result.json(),headers:result.headers};
  };
  return {store,request,base};
}
test('public health discloses setup flags only; ledger endpoints require operator auth',async context => {
  const f = await httpFixture(context);
  const health = await f.request('/api/health',{},false);
  assert.equal(health.status,200); assert.equal(health.body.storageConfigured,true);
  assert.equal(health.body.operatorConfigured,true); assert.equal(health.body.predictApiConfigured,true);
  assert.ok(!JSON.stringify(health.body).includes(token)); assert.equal(f.store.reads,0);
  for(const path of ['/api/config','/api/stats','/api/history','/api/trades','/api/logs']) assert.equal((await f.request(path,{},false)).status,401);
  assert.equal(f.store.reads,0);
});
test('missing operator or private store fails closed instead of returning empty financial data',async context => {
  const missingToken = await httpFixture(context,{BLOB_STORE_ID:'store_test'});
  assert.equal((await missingToken.request('/api/stats')).status,503);
  const missingStore = await httpFixture(context,{BOT_CONTROL_TOKEN:token});
  assert.equal((await missingStore.request('/api/stats')).status,503);
  assert.equal(missingStore.store.reads,0);
});
test('config and snapshots strip secret configuration and redact known credentials from logs',async context => {
  const f = await httpFixture(context);
  f.store.state.config.walletPrivateKey = 'private-value';
  f.store.state.config.predictFunApiKey = env.PREDICT_FUN_API_KEY;
  f.store.state.status.walletPrivateKey = 'private-value';
  f.store.state.status.logs = ['should redact '+env.PREDICT_FUN_API_KEY];
  const config = await f.request('/api/config');
  assert.equal(config.status,200); assert.equal(config.body.walletPrivateKey,undefined); assert.equal(config.body.predictFunApiKey,undefined);
  const stats = await f.request('/api/stats');
  assert.equal(stats.status,200); assert.equal(stats.body.walletPrivateKey,undefined);
  assert.ok(!JSON.stringify(stats.body).includes(env.PREDICT_FUN_API_KEY!));
  assert.equal(stats.headers.get('cache-control'),'no-store');
});
test('config changes are durably queued, never reported applied or directly written into active config',async context => {
  const f = await httpFixture(context);
  const result = await f.request('/api/config',{method:'POST',body:JSON.stringify({minConfidence:.8})});
  assert.equal(result.status,202); assert.equal(result.body.queued,true);
  assert.equal(f.store.state.config.minConfidence,.65);
  assert.equal(f.store.state.commands.length,1);
  assert.equal(f.store.state.commands[0].status,'pending');
  assert.deepEqual(f.store.state.commands[0].payload,{minConfidence:.8});
  assert.equal(f.store.state.commands[0].id,result.body.commandId);
});
test('mutations reject cross origin, secrets, invalid values, and unapproved live activation',async context => {
  const f = await httpFixture(context);
  const post = (payload:any,headers:Record<string,string>={}) => f.request('/api/config',{method:'POST',headers,body:JSON.stringify(payload)});
  assert.equal((await post({enableAutoTrade:true},{Origin:'https://other.example'})).status,403);
  for(const payload of [{walletPrivateKey:'not-accepted'},{maxTradeAmount:-1},{minConfidence:'0.8'},{isPaperTrading:false},{}]) assert.equal((await post(payload)).status,400);
  assert.equal(f.store.writes,0);
  const good = await post({enableAutoTrade:true},{Origin:f.base});
  assert.equal(good.status,202);
});
test('bounded queue and storage failures cannot claim command success',async context => {
  const f = await httpFixture(context);
  f.store.state.commands = Array.from({length:20},(_,i)=>({id:String(i),type:'config',createdAt:now,status:'pending',payload:{debug:false}}));
  assert.equal((await f.request('/api/config',{method:'POST',body:JSON.stringify({enableAutoTrade:true})})).status,409);
  f.store.unavailable = true;
  const result = await f.request('/api/config',{method:'POST',body:JSON.stringify({enableAutoTrade:true})});
  assert.equal(result.status,503); assert.ok(!JSON.stringify(result.body).includes('do-not-echo'));
});
test('stale or absent daemon cannot report running quotes, current prices, or fresh logs',() => {
  const state = initial(); state.config.enableAutoTrade = true;
  state.status = {heartbeatAt:now-31000,phase:'running',currentPrice:90000,walletBalanceUsdt:100,quoteAgeMs:50,lastPredictOdds:{upOdds:2,downOdds:2,timestamp:now-31000},logs:['old']};
  const result = cloudSnapshot(state,env,now);
  assert.equal(result.workerAvailable,false); assert.equal(result.workerPhase,'offline'); assert.equal(result.tradingActive,false);
  assert.equal(result.currentPrice,null); assert.equal(result.walletBalanceUsdt,null); assert.equal(result.lastPredictOdds,null); assert.deepEqual(result.logs,[]);
});
test('performance is isolated by explicit mode and verified fill/resolution fields',() => {
  const state = initial();
  state.ledger = [
    {id:'p1',mode:'paper',timestamp:now-10000,resolvedAt:now-5000,isFilled:true,resolved:true,pnl:.25,pnlIsEstimate:true},
    {id:'live',mode:'live',timestamp:now-10000,resolvedAt:now-5000,isFilled:true,resolved:true,pnl:100},
    {id:'unknown',timestamp:now-10000,resolvedAt:now-5000,isFilled:true,resolved:true,pnl:100},
    {id:'pending',mode:'paper',timestamp:now-10000,resolved:false,isFilled:false,pnl:100},
    {id:'cancelled',mode:'paper',timestamp:now-10000,resolved:true,isFilled:false,isCancelled:true,pnl:100},
  ];
  const snapshot = cloudSnapshot(state,env,now);
  assert.equal(snapshot.totalPnl,.25); assert.equal(snapshot.dailyPnl,.25); assert.equal(snapshot.wins,1); assert.equal(snapshot.activeTrades,1);
});

const credentialEnv:NodeJS.ProcessEnv = {BOT_CONTROL_TOKEN:token,BLOB_STORE_ID:'store_test',BOT_CREDENTIALS_KEY:'ab'.repeat(32),ENABLE_LIVE_TRADING:'true'};
const credentialBody = {PREDICT_FUN_API_KEY:'synthetic-predict-live-api',WALLET_PRIVATE_KEY:'0x'+'02'.repeat(32),PREDICT_ACCOUNT_ADDRESS:''};
const credentialInput = {predictFunApiKey:credentialBody.PREDICT_FUN_API_KEY,walletPrivateKey:credentialBody.WALLET_PRIVATE_KEY,predictAccountAddress:''};
test('credential setup persists ciphertext only, pauses entry, and never returns key values',async context => {
  const f = await httpFixture(context,credentialEnv);
  f.store.state.config.enableAutoTrade = true;
  f.store.state.commands = [{id:'old-live-start',type:'config',createdAt:now-1000,status:'pending',payload:{isPaperTrading:false,enableAutoTrade:true}}];
  const saved = await f.request('/api/credentials',{method:'POST',body:JSON.stringify(credentialBody)});
  assert.equal(saved.status,200); assert.equal(saved.body.saved,true); assert.equal(saved.body.autoTradePaused,true);
  assert.equal(f.store.state.credentialRevision,1); assert.equal(f.store.state.config.enableAutoTrade,false);
  assert.equal(f.store.state.commands[0].status,'failed','older activation command must not activate a new wallet');
  assert.equal(f.store.state.sealedCredentials?.algorithm,'aes-256-gcm');
  const stored = JSON.stringify(f.store.state);
  assert.ok(!stored.includes(credentialBody.PREDICT_FUN_API_KEY)); assert.ok(!stored.includes(credentialBody.WALLET_PRIVATE_KEY));
  const status = await f.request('/api/credentials');
  assert.equal(status.status,200); assert.equal(status.body.predictFunApiKeyConfigured,true); assert.equal(status.body.walletPrivateKeyConfigured,true);
  assert.equal(status.body.predictAccountAddressConfigured,false); assert.match(status.body.walletAddress,/^0x[0-9a-fA-F]{40}$/);
  for(const result of [saved,status,await f.request('/api/config'),await f.request('/api/stats')]) {
    const text = JSON.stringify(result.body);
    assert.ok(!text.includes(credentialBody.PREDICT_FUN_API_KEY)); assert.ok(!text.includes(credentialBody.WALLET_PRIVATE_KEY));
    assert.ok(!text.includes('ciphertext')); assert.ok(!text.includes('sealedCredentials'));
  }
});
test('credential endpoint requires operator auth, same origin, exact fields and valid bounded input',async context => {
  const f = await httpFixture(context,credentialEnv);
  const post = (body:any,headers:Record<string,string>={},auth=true) => f.request('/api/credentials',{method:'POST',body:JSON.stringify(body),headers},auth);
  assert.equal((await post(credentialBody,{},false)).status,401);
  assert.equal((await post(credentialBody,{Origin:'https://other.example'})).status,403);
  for(const invalid of [{...credentialBody,extra:'value'},{...credentialBody,PREDICT_FUN_API_KEY:42},{...credentialBody,WALLET_PRIVATE_KEY:'invalid-key'},{...credentialBody,PREDICT_ACCOUNT_ADDRESS:'0x123'},{...credentialBody,PREDICT_FUN_API_KEY:'contains whitespace'},{}]) assert.equal((await post(invalid)).status,400);
  assert.equal((await post({...credentialBody,PREDICT_FUN_API_KEY:'x'.repeat(18000)})).status,413);
  assert.equal(f.store.writes,0);
});
test('credential rotation cannot orphan unresolved live orders, even cancelled orders awaiting final reconciliation',async context => {
  const f = await httpFixture(context,credentialEnv);
  f.store.state.sealedCredentials = sealCredentials(credentialInput,credentialEnv); f.store.state.credentialRevision = 1;
  const envelope = JSON.stringify(f.store.state.sealedCredentials);
  for(const extra of [{isFilled:true},{isFilled:false,submissionUncertain:true},{isCancelled:true}]) {
    f.store.state.ledger = [{id:'live-open',mode:'live',timestamp:now-1000,amount:1,resolved:false,...extra}];
    const result = await f.request('/api/credentials',{method:'POST',body:JSON.stringify({...credentialBody,PREDICT_FUN_API_KEY:'synthetic-new-api-key'})});
    assert.equal(result.status,409); assert.equal(f.store.state.credentialRevision,1);
    assert.equal(JSON.stringify(f.store.state.sealedCredentials),envelope);
  }
});
test('live activation can validate saved encrypted credentials without plaintext environment wallet keys',async context => {
  const f = await httpFixture(context,credentialEnv);
  const saved = await f.request('/api/credentials',{method:'POST',body:JSON.stringify(credentialBody)});
  assert.equal(saved.status,200);
  const queued = await f.request('/api/config',{method:'POST',body:JSON.stringify({isPaperTrading:false,enableAutoTrade:true})});
  assert.equal(queued.status,202); assert.deepEqual(f.store.state.commands.at(-1)?.payload,{isPaperTrading:false,enableAutoTrade:true});
  assert.equal(f.store.state.config.isPaperTrading,true,'queueing is not execution or daemon acknowledgment');
  const snapshot = await f.request('/api/stats'); assert.equal(snapshot.body.liveOnline,false); assert.equal(snapshot.body.predictAuthenticated,false);
});
test('saved credentials remain subject to the explicit server live opt-in',async context => {
  const f = await httpFixture(context,{...credentialEnv,ENABLE_LIVE_TRADING:'false'});
  assert.equal((await f.request('/api/credentials',{method:'POST',body:JSON.stringify(credentialBody)})).status,200);
  assert.equal((await f.request('/api/config',{method:'POST',body:JSON.stringify({isPaperTrading:false,enableAutoTrade:true})})).status,400);
  assert.equal(f.store.state.commands.length,0);
});
test('LIVE ONLINE needs current credential auth, lease, quote and verified sufficient fresh balance',() => {
  const state = initial(); state.config = {...state.config,isPaperTrading:false,enableAutoTrade:true,maxTradeAmount:1};
  state.sealedCredentials = sealCredentials(credentialInput,credentialEnv); state.credentialRevision = 1;
  state.status = {heartbeatAt:now-500,phase:'running',readiness:{engine:true,predictAuthenticated:true,lease:true},authenticatedAt:now-1000,credentialsRevisionApplied:1,liveAccountAddress:validateCredentials(credentialInput).walletAddress,authCredentialProofId:credentialProofId(validateCredentials(credentialInput),credentialEnv),quoteAgeMs:200,lastPredictOdds:{upOdds:2,downOdds:2,timestamp:now-700},walletBalanceObservedAt:now-2000,walletBalanceUsdt:5,storageHealthy:true};
  assert.equal(cloudSnapshot(state,credentialEnv,now).liveOnline,true);
  const bad = [
    {readiness:{engine:true,predictAuthenticated:false,lease:true}}, {authenticatedAt:now-300001}, {credentialsRevisionApplied:0},
    {walletBalanceObservedAt:now-45001}, {walletBalanceUsdt:.1}, {heartbeatAt:now-31000}, {quoteAgeMs:3000},
    {readiness:{engine:true,predictAuthenticated:true,lease:false}}, {storageHealthy:false}, {liveAccountAddress:'0x0000000000000000000000000000000000000001'},
  ];
  for(const patch of bad) assert.equal(cloudSnapshot({...state,status:{...state.status,...patch}},credentialEnv,now).liveOnline,false);
});
test('an encryption key change cannot silently fall back to a different environment wallet',async context => {
  const f = await httpFixture(context,{...credentialEnv,BOT_CREDENTIALS_KEY:'cd'.repeat(32),PREDICT_FUN_API_KEY:'different-environment-api',WALLET_PRIVATE_KEY:'0x'+'03'.repeat(32)});
  f.store.state.sealedCredentials = sealCredentials(credentialInput,credentialEnv); f.store.state.credentialRevision = 1;
  const status = await f.request('/api/credentials');
  assert.equal(status.body.credentialValidation,'unreadable'); assert.equal(status.body.predictApiConfigured,false); assert.equal(status.body.walletConfigured,false);
  assert.equal((await f.request('/api/config',{method:'POST',body:JSON.stringify({isPaperTrading:false,enableAutoTrade:true})})).status,400);
});

test('environment credential rotation invalidates old authentication proof even when sealed revision stays zero',() => {
  const oldEnv = {...credentialEnv,PREDICT_FUN_API_KEY:credentialBody.PREDICT_FUN_API_KEY,WALLET_PRIVATE_KEY:credentialBody.WALLET_PRIVATE_KEY};
  const state = initial(); state.config = {...state.config,isPaperTrading:false,enableAutoTrade:true,maxTradeAmount:1};
  state.status = {heartbeatAt:now-500,phase:'running',readiness:{engine:true,predictAuthenticated:true,lease:true},authenticatedAt:now-1000,credentialsRevisionApplied:0,liveAccountAddress:validateCredentials(credentialInput).walletAddress,authCredentialProofId:credentialProofId(validateCredentials(credentialInput),oldEnv),quoteAgeMs:200,lastPredictOdds:{upOdds:2,downOdds:2,timestamp:now-700},walletBalanceObservedAt:now-2000,walletBalanceUsdt:5,storageHealthy:true};
  assert.equal(cloudSnapshot(state,oldEnv,now).liveOnline,true);
  const rotatedEnv = {...oldEnv,PREDICT_FUN_API_KEY:'rotated-environment-api-key'};
  assert.equal(cloudSnapshot(state,rotatedEnv,now).liveOnline,false);
  assert.equal(cloudSnapshot(state,rotatedEnv,now).predictAuthenticated,false);
});
