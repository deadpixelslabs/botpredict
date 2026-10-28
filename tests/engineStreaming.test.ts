import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import axios from 'axios';
import { PredictFunArbitrageEngine } from '../server/arbitrage-engine';

const originalGet = axios.get;
const originalNow = Date.now;
const dirs: string[] = [];
afterEach(() => {
  axios.get = originalGet; Date.now = originalNow;
  dirs.splice(0).forEach(dir => rmSync(dir, {recursive:true,force:true}));
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'predict-stream-integration-')); dirs.push(dir);
  const value = new PredictFunArbitrageEngine({memoryFilePath:join(dir,'ledger.json')}) as any;
  await value.historyLoad;
  const epoch = Math.floor(originalNow() / 300000) * 300;
  const now = epoch * 1000 + 60000; Date.now = () => now;
  value.isRunning = true;
  value.predictMarketDetails = {epoch, market:{id:1, tradingStatus:'OPEN',decimalPrecision:3,variantDetails:{crypto:{startPrice:100000}}},upOutcome:{name:'Up'},downOutcome:{name:'Down'},book:null};
  value.lastMarketRefresh = now;
  const book = {marketId:1, updateTimestampMs:now-10, asks:[[.42,100]],bids:[[.40,100]]};
  return {value,book,now};
}
test('stream events update executable prices immediately and fresh stream skips REST orderbook polling', async () => {
  const {value,book} = await fixture();
  value.predictFeed.getLatestBook = () => book;
  value.predictFeed.emit('book', book);
  assert.equal(value.lastUpBid,.40);
  assert.equal(value.lastDownBid,.58);
  assert.equal(value.getStats().quoteSource,'STREAM');
  let reads = 0; axios.get = (async () => {reads++;throw new Error('REST must not run');}) as any;
  await value.syncPredictOdds();
  assert.equal(reads,0);
  assert.equal(value.lastPredictOdds.timestamp,book.updateTimestampMs);
});
test('a CLOSED venue event blocks a seemingly fresh REST book and clears the detector', async () => {
  const {value,book} = await fixture();
  value.predictFeed.getLatestBook = () => book;
  value.predictFeed.emit('book',book);
  value.predictFeed.emit('tradingStatus',{marketId:1,tradingStatus:'CLOSED'});
  assert.equal(value.lastPredictOdds,null);
  assert.equal(value.latencyDetector.getPredictFunPrice(),null);
  const seeminglyOpen = {...value.predictMarketDetails,market:{...value.predictMarketDetails.market,tradingStatus:'OPEN'}};
  assert.equal(value.ingestPredictBook(seeminglyOpen,book),false);
});
test('stream disconnect invalidates its quote; bounded REST recovers without inventing a price', async () => {
  const {value,book} = await fixture();
  value.predictFeed.getLatestBook = () => book;
  value.predictFeed.emit('book',book);
  value.predictFeed.emit('status',{connected:false});
  assert.equal(value.lastPredictOdds,null);
  value.predictFeed.getLatestBook = () => null;
  let reads = 0; axios.get = (async () => {reads++;return {data:{data:book}};}) as any;
  await value.syncPredictOdds();
  assert.equal(reads,1);
  assert.equal(value.getStats().quoteSource,'REST');
});
test('REST cannot regress newer stream quotes or use malformed deeper levels', async () => {
  const {value,book,now} = await fixture();
  value.predictFeed.getLatestBook = () => book;
  value.predictFeed.emit('book',book);
  assert.equal(value.ingestPredictBook(value.predictMarketDetails,{...book,updateTimestampMs:now-100}),false);
  assert.equal(value.ingestPredictBook(value.predictMarketDetails,{...book,asks:[[.42,100],[.41,100]]}),false);
  assert.equal(value.ingestPredictBook(value.predictMarketDetails,{...book,bids:[[.40,100],[.39,-20]]}),false);
  value.predictFeed.emit('book',{...book,marketId:99});
  assert.equal(value.lastPredictOdds.timestamp,book.updateTimestampMs);
});
test('a newer invalid stream snapshot immediately revokes the preceding engine quote', async () => {
  const {value,book} = await fixture();
  value.predictFeed.getLatestBook = () => book;
  value.predictFeed.emit('book',book);
  assert.ok(value.lastPredictOdds);
  value.predictFeed.emit('quoteInvalidated',{marketId:1});
  assert.equal(value.lastPredictOdds,null);
  assert.equal(value.latencyDetector.getPredictFunPrice(),null);
});
