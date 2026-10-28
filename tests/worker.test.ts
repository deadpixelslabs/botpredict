import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudStore, type BlobJsonAdapter, type CloudState } from '../server/cloudStore';
import { WorkerRuntime, type WorkerEngine, type WorkerOptions } from '../worker/runtime';
import { sealCredentials, credentialsFromEnvironment, credentialProofId } from '../server/credentials';
import type { ArbitrageConfig, ArbitrageTrade, EngineRuntimeOptions } from '../server/arbitrage-engine';

class MemoryBlob implements BlobJsonAdapter {
  record: {value: unknown; etag: string} | null = null;
  writes = 0;
  failWrites = false;
  async read() { return this.record ? structuredClone(this.record) : null; }
  async write(_path: string, value: unknown, options: {ifMatch?: string; createOnly?: boolean}) {
    if (this.failWrites) throw new Error('synthetic write failure with credentials that must not be logged');
    if (options.createOnly && this.record || options.ifMatch && options.ifMatch !== this.record?.etag) {
      throw Object.assign(new Error('conflict'),{status:412});
    }
    this.record = {value:structuredClone(value),etag:String(++this.writes)};
    return {etag:this.record.etag};
  }
}

class FakeEngine implements WorkerEngine {
  cfg: ArbitrageConfig;
  runtime: EngineRuntimeOptions;
  trades: ArbitrageTrade[] = [];
  starts = 0; stops = 0; clears = 0; changes: Partial<ArbitrageConfig>[] = [];
  private loading: Promise<void>;
  constructor(config: Partial<ArbitrageConfig>, runtime: EngineRuntimeOptions) {
    this.cfg = {isPaperTrading:true,enableAutoTrade:false,minConfidence:.65,minEdge:.03,maxTradeAmount:1,maxDailyLoss:5,...config} as ArbitrageConfig;
    this.runtime = runtime;
    this.loading = runtime.loadTrades!().then(trades => {this.trades=trades;});
  }
  async ready() { await this.loading; }
  async start() {this.starts++;}
  async stop() {this.stops++;await this.runtime.saveTrades!(this.trades);}
  setConfig(config: Partial<ArbitrageConfig>) {this.changes.push({...config});this.cfg={...this.cfg,...config};}
  clearLogs() {this.clears++;}
  getStats() {return {isPaperTrading:this.cfg.isPaperTrading,totalTrades:this.trades.length,logs:[]};}
}

function fixture(env: NodeJS.ProcessEnv = {PREDICT_FUN_API_KEY:'synthetic-api-key'}, options: Partial<WorkerOptions> = {}) {
  let clock = 100_000;
  const blob = new MemoryBlob();
  const store = new CloudStore(blob,{now:()=>clock,prefix:'worker-test'});
  const engines: FakeEngine[] = [];
  const messages: string[] = [];
  const createEngine = (config: Partial<ArbitrageConfig>, runtime: EngineRuntimeOptions) => {
    const engine = new FakeEngine(config,runtime);engines.push(engine);return engine;
  };
  const worker = new WorkerRuntime({store,env,owner:'owner-a',now:()=>clock,createEngine,log:message=>messages.push(message),...options});
  return {worker,store,blob,engines,messages,createEngine,now:()=>clock,advance:(ms:number)=>{clock+=ms;}};
}

test('missing storage waits without constructing or starting a trading engine', async () => {
  let created = 0;
  const worker = new WorkerRuntime({store:null,createEngine:()=>{created++;throw new Error('not expected');},log:()=>{}});
  await worker.step();
  assert.equal(worker.phase,'waiting_for_storage');assert.equal(created,0);assert.equal(worker.canExecute(),false);
  await worker.stop();
});

test('missing Predict key never starts feeds but authenticated queued controls are applied durably once', async () => {
  const f=fixture({});
  await f.store.mutateState(state=>{state.commands.push({id:'config-one',type:'config',payload:{minConfidence:.72},createdAt:f.now(),status:'pending'},{id:'clear-one',type:'clearLogs',createdAt:f.now(),status:'pending'});});
  await f.worker.step();await f.worker.step();
  const state=await f.store.readState();
  assert.equal(f.worker.phase,'waiting_for_api_key');assert.equal(f.engines[0].starts,0);
  assert.equal(state.config.minConfidence,.72);assert.equal(state.commands[0].status,'applied');
  assert.equal(f.engines[0].changes.length,1);assert.equal(f.engines[0].clears,1);
  assert.equal(state.status.phase,'waiting_for_api_key');assert.equal(state.status.heartbeatAt,f.now());
  assert.equal(f.worker.canExecute(),false);await f.worker.stop();
});

test('only one lease owner constructs an engine and lease renews before its local safety deadline', async () => {
  const f=fixture();await f.worker.step();
  assert.equal(f.worker.phase,'paused');assert.equal(f.worker.canExecute(),true);assert.equal(f.engines[0].starts,1);
  let competingCreated=0;
  const second=new WorkerRuntime({store:f.store,env:{PREDICT_FUN_API_KEY:'key'},owner:'owner-b',now:f.now,log:()=>{},createEngine:()=>{competingCreated++;throw new Error('not expected');}});
  await second.step();assert.equal(second.phase,'standby');assert.equal(competingCreated,0);
  f.advance(11_000);await f.worker.step();
  f.advance(26_000);assert.equal(f.worker.canExecute(),true,'successful renewal extends the local execution lease');
  await f.worker.stop();assert.equal(await f.store.acquireLease('owner-b'),true);await second.stop();
});

test('configuration enqueued between ticks fences submission until applied, with no duplicate command effects', async () => {
  const f=fixture();await f.worker.step();
  await f.store.mutateState(state=>{state.commands.push({id:'pause',type:'config',payload:{enableAutoTrade:false},createdAt:f.now(),status:'pending'});});
  await assert.rejects(f.engines[0].runtime.beforeSubmit!(),/configuration/);
  assert.equal(f.worker.canExecute(),false);
  await f.worker.step();assert.equal(f.worker.canExecute(),true);
  await f.engines[0].runtime.beforeSubmit!('SELL');
  await f.worker.step();assert.equal(f.engines[0].changes.length,1);
  await f.worker.stop();
});

test('ledger saves preserve API commands/settings and a failed durable commit immediately closes the order gate', async () => {
  const f=fixture();await f.worker.step();
  await f.store.mutateState(state=>{state.commands.push({id:'clear',type:'clearLogs',createdAt:f.now(),status:'pending'});});
  const trade={id:'intent',timestamp:f.now(),amount:1,mode:'paper',direction:'UP',entryOdds:2,fairOdds:1.5,edge:.05,signal:{}} as ArbitrageTrade;
  await f.engines[0].runtime.saveTrades!([trade]);
  let state=await f.store.readState();assert.equal(state.ledger[0].id,'intent');assert.equal(state.commands.length,1);assert.equal(state.config.enableAutoTrade,false);
  f.blob.failWrites=true;
  await assert.rejects(f.engines[0].runtime.saveTrades!([]),/Durable order ledger/);
  assert.equal(f.worker.canExecute(),false);assert.equal(f.worker.faulted,true);
  assert.ok(!f.messages.join(' ').includes('credentials'));
  f.blob.failWrites=false;await f.worker.stop();
});

test('stolen or expired leases cannot sign; persisted ledger remains untouched by a stale owner', async () => {
  const f=fixture();await f.worker.step();
  f.advance(46_000);assert.equal(f.worker.canExecute(),false);
  assert.equal(await f.store.acquireLease('new-owner'),true);
  await assert.rejects(f.engines[0].runtime.beforeSubmit!(),/not ready/);
  await assert.rejects(f.engines[0].runtime.saveTrades!([]),/Durable order ledger/);
  await f.worker.stop();
  await f.store.assertLease('new-owner');
});

test('invalid commands fail generically; terminal command history is bounded without dropping pending commands', async () => {
  const f=fixture();
  await f.store.mutateState(state=>{
    for(let i=0;i<60;i++)state.commands.push({id:`done-${i}`,type:'clearLogs',createdAt:f.now(),status:'applied'});
    state.commands.push({id:'bad',type:'config',payload:{maxTradeAmount:-1},createdAt:f.now(),status:'pending'});
    state.commands.push({id:'good',type:'config',payload:{maxTradeAmount:.5},createdAt:f.now(),status:'pending'});
  });
  await f.worker.step();const state=await f.store.readState();
  assert.equal(state.commands.find(c=>c.id==='bad')?.status,'failed');
  assert.match(state.commands.find(c=>c.id==='bad')?.error || '',/Command could not be applied/);
  assert.equal(state.commands.find(c=>c.id==='good')?.status,'applied');
  assert.equal(state.config.maxTradeAmount,.5);assert.ok(state.commands.length<=50);
  await f.worker.stop();
});

test('explicit offline mode remains available without opening market feeds', async () => {
  const f=fixture({BOOT_OFFLINE:'true',PREDICT_FUN_API_KEY:'synthetic'});await f.worker.step();
  assert.equal(f.worker.phase,'offline');assert.equal(f.engines[0].starts,0);assert.equal(f.worker.canExecute(),false);
  await f.worker.stop();await f.worker.stop();assert.equal(f.engines[0].stops,1);
});

test('fresh dashboard snapshots publish every two seconds independently from ten-second lease renewal', async () => {
  const f=fixture();await f.worker.step();
  const first=(await f.store.readState()).status.heartbeatAt;
  f.advance(1_000);await f.worker.step();assert.equal((await f.store.readState()).status.heartbeatAt,first);
  f.advance(1_000);await f.worker.step();assert.equal((await f.store.readState()).status.heartbeatAt,f.now());
  assert.equal(f.engines[0].starts,1,'snapshot updates do not restart the market engine');
  await f.worker.stop();
});

function liveEnv(): NodeJS.ProcessEnv {
  return {PREDICT_FUN_API_KEY:'synthetic-live-api',WALLET_PRIVATE_KEY:`0x${'01'.repeat(32)}`,
    ENABLE_LIVE_TRADING:'true',BOT_CONTROL_TOKEN:'synthetic-control-token-32-characters',BOT_CREDENTIALS_KEY:'ab'.repeat(32)};
}
function nextCredentials() { return {predictFunApiKey:'synthetic-rotated-api',walletPrivateKey:`0x${'02'.repeat(32)}`,predictAccountAddress:''}; }

test('live readiness requires successful strict authentication, not merely formatted keys', async () => {
  let allowAuth=false, checks=0;
  const f=fixture(liveEnv(),{verifyCredentials:async()=>{checks++;if(!allowAuth)throw new Error('private provider error must not be displayed');}});
  await f.store.mutateState(state=>{state.config.isPaperTrading=false;state.config.enableAutoTrade=true;});
  await f.worker.step();
  let state=await f.store.readState();
  assert.equal(f.worker.phase,'waiting_for_auth');assert.equal(f.engines[0].starts,0);assert.equal(f.worker.canExecute(),false);
  assert.equal(state.status.readiness.predictAuthenticated,false);assert.equal(state.status.readiness.walletCryptoValid,true);
  allowAuth=true;f.advance(10_000);await f.worker.step();state=await f.store.readState();
  assert.equal(checks,2);assert.equal(f.worker.phase,'running');assert.equal(f.worker.canExecute(),true);
  assert.equal(state.status.readiness.predictAuthenticated,true);assert.equal(state.status.authenticatedAt,f.now());
  assert.equal(state.status.credentialsRevisionApplied,0);
  assert.equal(state.status.authCredentialProofId,credentialProofId(credentialsFromEnvironment(liveEnv())!,liveEnv()));
  assert.ok(!JSON.stringify(state.status).includes(liveEnv().WALLET_PRIVATE_KEY!));
  await f.worker.stop();
});

test('encrypted credentials replace environment credentials only after old engine drains; old closures remain fenced', async () => {
  const applied: string[]=[];
  const env=liveEnv();const f=fixture(env,{applyCredentials:value=>{applied.push(value.walletPrivateKey);},verifyCredentials:async()=>{}});
  await f.worker.step();const old=f.engines[0];
  await f.store.mutateState(state=>{state.sealedCredentials=sealCredentials(nextCredentials(),env);state.credentialRevision=1;state.config.enableAutoTrade=false;});
  await f.worker.step();
  assert.equal(old.stops,1);assert.equal(f.engines.length,2);assert.equal(applied[1],nextCredentials().walletPrivateKey);
  assert.equal(f.engines[1].cfg.predictFunApiKey,nextCredentials().predictFunApiKey);
  assert.equal(env.WALLET_PRIVATE_KEY,liveEnv().WALLET_PRIVATE_KEY,'injected credential application never mutates process environment in tests');
  await assert.rejects(old.runtime.beforeSubmit!('SELL'),/previous engine/);
  assert.equal(old.runtime.canExecute!(),false);
  await f.worker.stop();
});

test('unresolved live positions defer signer rotation while existing read-only recovery can finish', async () => {
  const env=liveEnv();const f=fixture(env,{verifyCredentials:async()=>{}});await f.worker.step();
  const trade={id:'pending-live',timestamp:f.now(),amount:1,mode:'live',direction:'UP',entryOdds:2,fairOdds:1.5,edge:.1,signal:{},resolved:false} as ArbitrageTrade;
  f.engines[0].trades=[trade];await f.engines[0].runtime.saveTrades!([trade]);
  await f.store.mutateState(state=>{state.sealedCredentials=sealCredentials(nextCredentials(),env);state.credentialRevision=1;state.config.enableAutoTrade=false;});
  await f.worker.step();
  assert.equal(f.worker.phase,'waiting_for_open_positions');assert.equal(f.engines.length,1);assert.equal(f.engines[0].stops,0);assert.equal(f.worker.canExecute(),false);
  trade.resolved=true;trade.pnl=0;trade.resolvedAt=f.now();await f.engines[0].runtime.saveTrades!([trade]);await f.worker.step();
  assert.equal(f.engines[0].stops,1);assert.equal(f.engines.length,2);
  await f.worker.stop();
});

test('undecryptable stored credentials never fall back to a valid environment wallet', async () => {
  const env=liveEnv();const f=fixture(env,{verifyCredentials:async()=>{throw new Error('must not authenticate');}});
  await f.store.mutateState(state=>{state.sealedCredentials=sealCredentials(nextCredentials(),{BOT_CREDENTIALS_KEY:'ff'.repeat(32)});state.credentialRevision=1;});
  await f.worker.step();const state=await f.store.readState();
  assert.equal(f.worker.phase,'waiting_for_auth');assert.equal(f.engines.length,0);assert.equal(f.worker.canExecute(),false);
  assert.equal(state.status.readiness.predictAuthenticated,false);assert.equal(state.status.readiness.engine,false);
  await f.worker.stop();
});

test('credential rotation racing an old live-command acknowledgement cannot reactivate it', async () => {
  const env=liveEnv();const f=fixture(env,{verifyCredentials:async()=>{}});
  await f.store.mutateState(state=>{state.commands.push({id:'old-live',type:'config',payload:{isPaperTrading:false,enableAutoTrade:true},createdAt:f.now(),status:'pending'});});
  const write=f.blob.write.bind(f.blob);let inject=true;
  f.blob.write=async(path,value,options)=>{
    const draft=value as CloudState;
    if(inject&&draft.commands.find(command=>command.id==='old-live')?.status==='applied') {
      inject=false;
      await f.store.mutateState(current=>{
        current.sealedCredentials=sealCredentials(nextCredentials(),env);current.credentialRevision=1;current.config.enableAutoTrade=false;
        current.commands.forEach(command=>{if(command.status==='pending')command.status='failed';});
      });
    }
    return write(path,value,options);
  };
  await f.worker.step();const state=await f.store.readState();
  assert.equal(state.credentialRevision,1);assert.equal(state.config.enableAutoTrade,false);assert.equal(state.config.isPaperTrading,true);
  assert.equal(state.commands.find(command=>command.id==='old-live')?.status,'failed');assert.equal(f.worker.canExecute(),false);
  assert.equal(f.engines[0].starts,0);
  await f.worker.stop();
});

test('authoritative paused state blocks BUY while still allowing an authenticated risk-reducing SELL', async () => {
  const f=fixture(liveEnv(),{verifyCredentials:async()=>{}});
  await f.store.mutateState(state=>{state.config.isPaperTrading=false;state.config.enableAutoTrade=true;});
  await f.worker.step();await f.store.mutateState(state=>{state.config.enableAutoTrade=false;});
  await assert.rejects(f.engines[0].runtime.beforeSubmit!('BUY'),/paused/);
  await f.engines[0].runtime.beforeSubmit!('SELL');
  await f.worker.stop();
});

test('cold-start environment rotation cannot attach a new wallet to unresolved old-wallet orders', async () => {
  const env=liveEnv();let authChecks=0, applied=0;
  const old=credentialsFromEnvironment({...env,WALLET_PRIVATE_KEY:nextCredentials().walletPrivateKey})!;
  const f=fixture(env,{verifyCredentials:async()=>{authChecks++;},applyCredentials:()=>{applied++;}});
  await f.store.mutateState(state=>{
    state.ledger=[{id:'old-wallet-order',timestamp:f.now(),amount:1,mode:'live',resolved:false,
      executionAccount:old.walletAddress,signerAddress:old.walletAddress}];
    state.config.isPaperTrading=false;state.config.enableAutoTrade=true;
  });
  await f.worker.step();const state=await f.store.readState();
  assert.equal(f.worker.phase,'waiting_for_reconciliation');assert.equal(f.engines.length,0);
  assert.equal(authChecks,0);assert.equal(applied,0);assert.equal(f.worker.canExecute(),false);
  assert.equal(state.status.readiness.credentialIdentityMatches,false);
  await f.worker.stop();
});

test('unknown live-order wallet identity requires recovery; matching identities allow read-only reconciliation', async () => {
  const env=liveEnv();let authChecks=0;
  const f=fixture(env,{verifyCredentials:async()=>{authChecks++;}});
  await f.store.mutateState(state=>{state.ledger=[{id:'legacy-live',timestamp:f.now(),amount:1,mode:'live',resolved:false}];});
  await f.worker.step();assert.equal(f.worker.phase,'waiting_for_reconciliation');assert.equal(authChecks,0);
  const known=credentialsFromEnvironment(env)!;
  await f.store.mutateState(state=>{state.ledger[0].executionAccount=known.walletAddress;state.ledger[0].signerAddress=known.walletAddress;});
  f.advance(10_000);await f.worker.step();
  assert.equal(f.engines.length,1);assert.equal(authChecks,1);
  await f.worker.stop();
});
