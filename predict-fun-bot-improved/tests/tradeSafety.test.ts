import test from 'node:test';
import assert from 'node:assert/strict';
import { feeCollateralPerShare, estimateBuyShares, estimateSellProceeds, expectedNetEdge, getResolvedWinner, getRiskSnapshot, tradeMode } from '../server/tradeSafety';

const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('fee reserve uses full-notional bound without increasing total budget', () => {
  near(feeCollateralPerShare(0.5, 200), 0.01);
  near(estimateBuyShares(1, 0.5, 200), 1.96 / 1.02);
  near(feeCollateralPerShare(0.8, 200), 0.016);
  near(estimateBuyShares(1, 0.8, 200), 1.225 / 1.02);
  near(estimateBuyShares(1, 0.5, 0), 2);
});

test('round trip through unchanged market loses estimated fees', () => {
  const shares = estimateBuyShares(1, 0.5, 200);
  near(estimateSellProceeds(shares, 0.5, 200), 0.9604 / 1.02);
  assert.ok(expectedNetEdge(0.51, 0.5, 200) < 0);
  assert.ok(expectedNetEdge(0.55, 0.5, 200) > 0);
});

test('invalid amounts, fee schedules and probabilities fail closed', () => {
  for (const p of [0, 1, NaN, Infinity, -0.2]) assert.throws(() => estimateBuyShares(1, p, 200));
  assert.throws(() => estimateBuyShares(-1, 0.5, 200));
  assert.throws(() => estimateSellProceeds(Infinity, 0.5, 200));
  assert.throws(() => feeCollateralPerShare(0.5, NaN));
  assert.throws(() => feeCollateralPerShare(0.5, 10001));
  assert.throws(() => expectedNetEdge(2, 0.5, 200));
});

test('closed, ambiguous and conflicting markets never become fabricated outcomes', () => {
  assert.equal(getResolvedWinner({ status: 'REGISTERED', tradingStatus: 'CLOSED', resolution: { name: 'UP' } }), null);
  assert.equal(getResolvedWinner({ status: 'RESOLVED', resolution: { name: 'UNKNOWN' }, variantData: {startPrice: 100, endPrice: 90} }), null);
  assert.equal(getResolvedWinner({ status: 'RESOLVED', outcomes: [{name:'Up',status:'WON'}] }), 'UP');
  assert.equal(getResolvedWinner({ status: 'RESOLVED', resolution: {name:'Down'} }), 'DOWN');
  assert.equal(getResolvedWinner({ status: 'RESOLVED', outcomes: [{name:'Up',status:'WON'}], resolution: {name:'Down'} }), null);
  assert.equal(getResolvedWinner({ status: 'RESOLVED', outcomes: [{name:'Up',status:'WON'},{name:'Down',status:'WON'}] }), null);
  assert.equal(getResolvedWinner({ status: 'RESOLVED', variantData: {startPrice:100,endPrice:100} }), null);
});

test('risk counters survive restart, use settlement day and isolate modes', () => {
  const now = Date.UTC(2026,9,29,0,10);
  const ledger = [
    {id:'live-loss', mode:'live' as const, timestamp:now-7200000,resolvedAt:now-10000,amount:2,pnl:-2,resolved:true},
    {id:'live-win', mode:'live' as const, timestamp:now-50000,resolvedAt:now-10000,amount:1,pnl:0.5,resolved:true},
    {id:'live-pending', mode:'live' as const,timestamp:now-30000,amount:3,resolved:false},
    {id:'cancelled', mode:'live' as const,timestamp:now-20000,amount:1,pnl:-100,resolved:true,isCancelled:true},
    {id:'Paper_1',timestamp:now-10000,resolvedAt:now-5000,amount:1,pnl:9,resolved:true},
    {id:'old-loss',mode:'live' as const,timestamp:now-86400000,resolvedAt:now-86400000,amount:1,pnl:-1,resolved:true},
  ];
  assert.deepEqual(getRiskSnapshot(ledger,false,now), {tradesThisHour:3,dailyPnl:-1.5,pendingExposure:3});
  assert.deepEqual(getRiskSnapshot(JSON.parse(JSON.stringify(ledger)),false,now), getRiskSnapshot(ledger,false,now));
  assert.deepEqual(getRiskSnapshot(ledger,true,now), {tradesThisHour:1,dailyPnl:9,pendingExposure:0});
  assert.equal(tradeMode({id:'PaperFallback_2'}),'paper');
  assert.equal(tradeMode({id:'Paper_1',mode:'live'}),'live');
});
