import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { PredictFunArbitrageEngine, type ArbitrageTrade } from '../server/arbitrage-engine';

const dirs: string[] = [];
const originalNow = Date.now;
const originalGet = axios.get;
const originalLive = process.env.ENABLE_LIVE_TRADING;
afterEach(() => {
  Date.now = originalNow;
  axios.get = originalGet;
  if (originalLive === undefined) delete process.env.ENABLE_LIVE_TRADING; else process.env.ENABLE_LIVE_TRADING = originalLive;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function engine() {
  const dir = mkdtempSync(join(tmpdir(), 'predict-engine-')); dirs.push(dir);
  const value = new PredictFunArbitrageEngine({ memoryFilePath: join(dir, 'ledger.json'), isPaperTrading: true, maxTradeAmount: .25 });
  await (value as any).historyLoad;
  return value as any;
}
const signal = { direction: 'UP', edge: .3, confidence: .9, fairOdds: 1.2, marketOdds: 2.5, momentum: 1, volumeSpike: true, orderBookImbalance: .8, latencyMs: 10, reason: 'fixture' };
function setup(engine: any) {
  const epoch = Math.floor(originalNow() / 300000) * 300;
  const now = epoch * 1000 + 60000;
  Date.now = () => now;
  engine.isRunning = true;
  engine.cfg.enableAutoTrade = true;
  engine.cfg.isPaperTrading = true;
  engine.currentStartPrice = 100000;
  engine.currentPrice = 100020;
  engine.lastPredictOdds = {upOdds: 2.5, downOdds: 1/.61, timestamp: now - 10};
  engine.lastUpBid = .39;
  engine.lastDownBid = .60;
  engine.predictMarketDetails = { epoch, market: {id:1,tradingStatus:'OPEN',feeRateBps:200,decimalPrecision:3}, upOutcome:{name:'Up',onChainId:'1',bestAsk:{price:.4}}, downOutcome:{name:'Down',onChainId:'2',bestAsk:{price:.61}}, book:{asks:[[.4,100]],bids:[[.39,100]]} };
  return {epoch,now};
}

test('active paper execution respects configured stake and stores worst permitted limit', async () => {
  const value = await engine(); setup(value);
  value.cfg.executionSlippage = .01;
  await value.executeTrade(signal);
  assert.equal(value.trades.length, 1);
  const trade = value.trades[0];
  assert.equal(trade.mode, 'paper');
  assert.equal(trade.amount, .25);
  assert.ok(Math.abs(1 / trade.entryOdds - .411) < 1e-9 || Math.abs(1 / trade.entryOdds - .41) < 1e-9);
  assert.equal(trade.isFilled, true);
  assert.ok(trade.sharesQuantity < .25 / .4);
  await value.executeTrade(signal);
  assert.equal(value.trades.length, 1, 'one open position prevents duplicate entry');
});

test('stale orderbooks, insufficient depth and fee-adjusted negative edge block execution', async () => {
  const value = await engine(); const {now} = setup(value);
  value.lastPredictOdds.timestamp = now - 3000;
  await value.executeTrade(signal); assert.equal(value.trades.length, 0);
  value.lastPredictOdds.timestamp = now;
  value.predictMarketDetails.book.asks = [[.4,.01]];
  await value.executeTrade(signal); assert.equal(value.trades.length, 0);
  value.predictMarketDetails.book.asks = [[.4,100]];
  await value.executeTrade({...signal,fairOdds:1/.41}); assert.equal(value.trades.length, 0);
});

test('fast-spike signals cannot bypass negative mathematical edge', async () => {
  const value = await engine(); const {now} = setup(value);
  value.currentStartPrice = 100000;
  value.lastPredictOdds.upOdds = 1/.6;
  value.handleLatencySignal({ ...signal, timestamp:now, direction:'UP', binancePrice:99900, isFastSpike:true, priceDeltaPct:.5, velocity:1, obImbalance:.8 });
  assert.equal(value.trades.length, 0);
});

test('closed or unavailable venue market cannot fabricate a settlement from Binance', async () => {
  const value = await engine(); const {epoch,now} = setup(value);
  await value.executeTrade(signal);
  Date.now = () => now + 300000;
  axios.get = (async () => ({data:{data:{markets:[{categorySlug:`btc-updown-5m-${epoch}`,status:'REGISTERED',tradingStatus:'CLOSED',resolution:{name:'Up'}}]}}})) as any;
  await value.checkTradesResolution();
  assert.equal(value.trades[0].resolved, false);
  axios.get = (async () => {throw new Error('offline');}) as any;
  await value.checkTradesResolution();
  assert.equal(value.trades[0].resolved, false);
  axios.get = (async () => ({data:{data:{markets:[{categorySlug:`btc-updown-5m-${epoch}`,status:'RESOLVED',outcomes:[{name:'Up',status:'WON'}],variantDetails:{crypto:{startPrice:100,endPrice:101}}}]}}})) as any;
  await value.checkTradesResolution();
  assert.equal(value.trades[0].resolved, true);
  assert.equal(value.trades[0].closePrice, 101);
  assert.equal(value.trades[0].resolvedAt, Date.now());
  assert.equal(value.trades[0].pnlIsEstimate, true);
});

test('book fetch parses complement sides and clears all executable state on outage', async () => {
  const value = await engine(); const {now} = setup(value);
  value.predictMarketDetails = null;
  axios.get = (async (url: string) => url.includes('/categories/') ? {data:{data:{markets:[{id:1,tradingStatus:'OPEN',feeRateBps:200,decimalPrecision:3,variantDetails:{crypto:{startPrice:100000}},outcomes:[{name:'Up',onChainId:'1'},{name:'Down',onChainId:'2'}]}]}}} : {data:{data:{updateTimestampMs:now,asks:[[.42,100]],bids:[[.40,100]]}}}) as any;
  await value.syncPredictOdds();
  assert.equal(value.currentStartPrice, 100000);
  assert.equal(value.lastDownBid, .58);
  assert.equal(value.lastPredictOdds.downOdds, 1/.60);
  axios.get = (async () => {throw new Error('offline');}) as any;
  await value.syncPredictOdds();
  assert.equal(value.lastPredictOdds, null);
  assert.equal(value.currentStartPrice, null);
  assert.equal(value.predictMarketDetails, null);
  assert.equal(value.latencyDetector.getPredictFunPrice(), null);
});

test('risk counters recover from ledger and reject crossing daily loss budget', async () => {
  const value = await engine(); const {now} = setup(value);
  value.cfg.maxDailyLoss = 1;
  value.trades = [{ id:'Paper_loss',mode:'paper',timestamp:now-10000,resolvedAt:now-5000,amount:.8,pnl:-.8,resolved:true }];
  await value.executeTrade(signal);
  assert.equal(value.trades.length, 1, 'new risk cannot push daily loss beyond limit');
  assert.equal(value.getStats().dailyPnl, -.8);
  const second = new PredictFunArbitrageEngine({memoryFilePath:value.cfg.memoryFilePath,isPaperTrading:true});
  writeFileSync(value.cfg.memoryFilePath, JSON.stringify(value.trades));
  await (second as any).loadTrades();
  assert.equal(second.getStats().dailyPnl,-.8);
});

test('mode switch protects open positions while allowing same-mode live recovery', async () => {
  const value = await engine(); setup(value); await value.executeTrade(signal);
  process.env.ENABLE_LIVE_TRADING = 'true';
  assert.throws(() => value.setConfig({isPaperTrading:false}), /unmanaged/);
  value.trades[0].mode = 'live';
  value.setConfig({isPaperTrading:false});
  assert.equal(value.cfg.isPaperTrading,false);
  assert.throws(() => value.setConfig({isPaperTrading:true}), /unmanaged/);
});

test('unknown legacy history never contributes to live or paper performance', async () => {
  const value = await engine(); setup(value);
  value.trades = [{id:'old',mode:'unknown',timestamp:Date.now(),amount:1,pnl:100,resolved:true,outcome:'WIN'}];
  assert.equal(value.getStats().totalPnl, 0);
  assert.equal(value.getStats().unknownHistoryCount,1);
});

test('dust stays tracked and is not declared sold without execution', async () => {
  const value = await engine(); setup(value);
  value.trades = [{ id:'Paper_dust',mode:'paper',timestamp:Date.now()-200000,amount:.01,entryOdds:2,sharesQuantity:.001,isFilled:true,targetLockTime:Math.floor(Date.now()/300000)*300,resolved:false }];
  await value.checkInstantSellOpportunities(.6,.4);
  assert.equal(value.trades[0].resolved,false);
  assert.equal(value.trades[0].isSold,undefined);
});

test('corrupt ledger disables entries and is never overwritten', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'predict-corrupt-')); dirs.push(dir);
  const file = join(dir,'ledger.json');
  writeFileSync(file,'{invalid json');
  const value = new PredictFunArbitrageEngine({memoryFilePath:file,isPaperTrading:true}) as any;
  await value.historyLoad;
  setup(value); // even a later auto-trade toggle must not bypass storage health
  await value.executeTrade(signal);
  assert.equal(value.trades.length,0);
  assert.equal(value.getStats().storageHealthy,false);
  await assert.rejects(value.saveTrades(),/recovery/);
});

test('old or mismatched source snapshots never become executable quotes', async () => {
  const value = await engine(); const {now} = setup(value);
  const details = value.predictMarketDetails;
  assert.equal(value.ingestPredictBook(details,{marketId:999,updateTimestampMs:now,asks:[[.42,100]],bids:[[.40,100]]}),false);
  assert.equal(value.ingestPredictBook(details,{marketId:1,updateTimestampMs:now-5000,asks:[[.42,100]],bids:[[.40,100]]}),false);
  assert.equal(value.ingestPredictBook(details,{marketId:1,updateTimestampMs:now,asks:[[.39,100]],bids:[[.40,100]]}),false);
});

test('partial sale proceeds survive final market redemption and original cost remains intact', async () => {
  const value = await engine(); const {epoch,now} = setup(value);
  value.trades = [{id:'Paper_partial',mode:'paper',direction:'UP',timestamp:now-10000,amount:1,entryOdds:2,sharesQuantity:.5,soldProceeds:.8,isFilled:true,targetLockTime:epoch,resolved:false,signal}];
  Date.now = () => now + 300000;
  axios.get = (async () => ({data:{data:{markets:[{categorySlug:`btc-updown-5m-${epoch}`,status:'RESOLVED',resolution:{name:'Up'}}]}}})) as any;
  await value.checkTradesResolution();
  assert.ok(Math.abs(value.trades[0].pnl-.3)<1e-9);
  assert.equal(value.trades[0].amount,1);
});

test('paper exit uses worst sell limit and real depth instead of optimistic top bid', async () => {
  const value = await engine(); setup(value);
  value.cfg.executionSlippage = .01;
  await value.executeTrade(signal);
  value.predictMarketDetails.book.bids = [[.43,100]];
  await value.checkInstantSellOpportunities(.43,.57);
  assert.equal(value.trades[0].resolved,false,'raw price gain cannot bypass net-fee take-profit');
  value.predictMarketDetails.book.bids = [[.60,.01]];
  await value.checkInstantSellOpportunities(.60,.40);
  assert.equal(value.trades[0].resolved,false,'no full-size paper fill without executable depth');
  value.predictMarketDetails.book.bids = [[.60,100]];
  const shares = value.trades[0].sharesQuantity;
  await value.checkInstantSellOpportunities(.60,.40);
  assert.equal(value.trades[0].resolved,true);
  assert.ok(Math.abs(value.trades[0].sellPrice-.59)<1e-9);
  assert.ok(Math.abs(value.trades[0].pnl-(shares*.59*.98-.25))<1e-9);
});
