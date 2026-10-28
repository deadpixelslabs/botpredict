import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PredictFunArbitrageEngine } from '../server/arbitrage-engine';

const originalNow = Date.now;
afterEach(() => { Date.now = originalNow; });

async function fixture(afterFence: (engine: any, advance: (ms: number) => void) => void) {
  const epoch = Math.floor(originalNow() / 300000) * 300;
  let now = epoch * 1000 + 60000;
  Date.now = () => now;
  let value: any;
  value = new PredictFunArbitrageEngine({isPaperTrading:true,enableAutoTrade:true}, {
    loadTrades: async () => [], saveTrades: async () => {}, canExecute: () => true,
    beforeSubmit: async () => { afterFence(value, milliseconds => { now += milliseconds; }); },
  });
  await value.ready(); value.isRunning = true;
  value.lastPredictOdds = {timestamp:now,upOdds:2,downOdds:2};
  value.predictMarketDetails = {epoch,market:{tradingStatus:'OPEN'}};
  return {value,epoch,signalAt:now};
}

test('a quote that expires during the remote fence cannot reach submission', async () => {
  const {value,epoch,signalAt} = await fixture((_engine,advance) => advance(3000));
  await assert.rejects(value.beforeLiveSubmit('BUY',epoch,signalAt), /quote changed or expired/);
});

test('new stream data cannot revive the original entry signal after a slow durable fence', async () => {
  const {value,epoch,signalAt} = await fixture((engine,advance) => { advance(2100); engine.lastPredictOdds.timestamp = Date.now(); });
  await assert.rejects(value.beforeLiveSubmit('BUY',epoch,signalAt), /signal expired/);
});

test('a market closing while ownership is checked invalidates both buy and sell submissions', async () => {
  const {value,epoch,signalAt} = await fixture(engine => { engine.predictMarketDetails.market.tradingStatus = 'CLOSED'; });
  await assert.rejects(value.beforeLiveSubmit('BUY',epoch,signalAt), /quote changed or expired/);
  await assert.rejects(value.beforeLiveSubmit('SELL',epoch), /quote changed or expired/);
});
