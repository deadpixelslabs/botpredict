import test from 'node:test';
import assert from 'node:assert/strict';
import { LatencyDetector, type ArbitrageSignal } from '../server/LatencyDetector';

const BASE = 1_800_000_000_000;
function setup(overrides: Record<string, number> = {}) {
  const detector = new LatencyDetector({ debug: false, minConfidence: 0.5, minConsistencyMs: 0, ...overrides });
  const state = detector as any;
  state.isActive = true; // Exercise event handlers without opening WebSockets.
  const signals: ArbitrageSignal[] = [];
  detector.on('signal', signal => signals.push(signal));
  const feed = state.feed;
  // Stub the feed-owned monotonic lookback API, never open real sockets.
  feed.getPriceLookback = (msAgo: number, maxAgeMs: number) => {
    const history = feed.priceHistory;
    const latest = history[history.length - 1];
    if (!latest) return null;
    for (let i = history.length - 1; i >= 0; i--) {
      const age = latest.ts - history[i].ts;
      if (age >= msAgo) return age <= maxAgeMs ? { price: history[i].price, age } : null;
    }
    return null;
  };
  function tick(price = 100_020, ts = Date.now()) {
    feed.priceHistory = [
      { price: 100_000, ts: ts - 300 },
      { price: 100_000, ts: ts - 250 },
      { price: 100_000, ts: ts - 150 },
      { price: 100_000, ts: ts - 50 },
      { price, ts },
    ];
    feed.emit('update', { type: 'tick', data: {
      midPrice: price, timestamp: ts, serverTime: ts + 60_000,
      bidPrice: price - 1, askPrice: price + 1,
    } });
  }
  return { detector, state, feed, signals, tick };
}

test('missing or stale Predict reference never fabricates a latency edge', t => {
  t.mock.method(Date, 'now', () => BASE);
  const x = setup();
  x.tick();
  assert.equal(x.signals.length, 0);
  x.detector.updatePredictFunPrice(100_000, BASE - 4000);
  x.tick();
  assert.equal(x.signals.length, 0);
  assert.equal(x.detector.getPredictFunPrice(), null);
});

test('signal quality reflects missing evidence instead of a forced 99%', t => {
  t.mock.method(Date, 'now', () => BASE);
  const x = setup();
  x.detector.updatePredictFunPrice(100_000, BASE);
  x.tick();
  assert.equal(x.signals.length, 1);
  assert.equal(x.signals[0].direction, 'UP');
  assert.equal(x.signals[0].timestamp, BASE, 'local clock is used, not Binance server clock');
  assert.equal(x.signals[0].scoreBreakdown.obScore, 0.5);
  assert.equal(x.signals[0].scoreBreakdown.tradeFlowScore, 0.5);
  assert.equal(x.signals[0].scoreBreakdown.consistencyScore, 0);
  assert.ok(x.signals[0].confidence < 0.8);
  assert.ok(x.signals[0].reason.includes('uncalibrated'));
});

test('minimum USD delta, velocity and quality settings are enforced', t => {
  t.mock.method(Date, 'now', () => BASE);
  for (const config of [{ minPriceDeltaUsd: 50 }, { minVelocity: 1000 }, { minConfidence: 0.99 }]) {
    const x = setup(config);
    x.detector.updatePredictFunPrice(100_000);
    x.tick();
    assert.equal(x.signals.length, 0, JSON.stringify(config));
  }
});

test('invalid Binance tick and a history gap fail closed', t => {
  t.mock.method(Date, 'now', () => BASE);
  const x = setup();
  x.detector.updatePredictFunPrice(100_000);
  x.tick(NaN);
  x.tick(100_020, BASE - 2000);
  x.feed.priceHistory = [{ price: 100_000, ts: BASE - 5000 }, { price: 100_020, ts: BASE }];
  x.feed.emit('update', { type: 'tick', data: { midPrice: 100_020, timestamp: BASE } });
  assert.equal(x.signals.length, 0);
});

test('source timestamps cannot refresh an old snapshot or replace a newer one', t => {
  t.mock.method(Date, 'now', () => BASE);
  const x = setup();
  x.detector.updatePredictFunPrice(100_000, BASE - 20);
  x.detector.updatePredictFunPrice(90_000, BASE - 50);
  assert.equal(x.detector.getPredictFunPrice(), 100_000);
  x.detector.updatePredictFunPrice(Infinity);
  assert.equal(x.detector.getPredictFunPrice(), null);
});

test('consistency requires continuous valid evidence and resets after missing reference', t => {
  let now = BASE;
  t.mock.method(Date, 'now', () => now);
  const x = setup({ minConsistencyMs: 100 });
  x.detector.updatePredictFunPrice(100_000);
  x.tick();
  assert.equal(x.signals.length, 0);
  now += 60;
  x.detector.clearPredictFunPrice();
  x.tick();
  now += 60;
  x.detector.updatePredictFunPrice(100_000);
  x.tick();
  assert.equal(x.signals.length, 0);
  now += 101;
  x.tick(100_021);
  assert.equal(x.signals.length, 1);
  assert.equal(x.signals[0].consistencyMs, 101);
});

test('disconnect invalidates both venue references before reconnect', t => {
  t.mock.method(Date, 'now', () => BASE);
  const x = setup();
  x.detector.updatePredictFunPrice(100_000);
  x.feed.emit('update', { type: 'disconnected' });
  assert.equal(x.detector.getPredictFunPrice(), null);
  assert.equal(x.detector.getLatestBinancePrice(), null);
  x.tick();
  assert.equal(x.signals.length, 0);
});

test('malformed detector configuration is rejected', () => {
  assert.throws(() => new LatencyDetector({ minConfidence: NaN }), /Invalid/);
  assert.throws(() => new LatencyDetector({ minConfidence: 1.01 }), /Invalid/);
  assert.throws(() => new LatencyDetector({ maxPredictFunStalenessMs: 0 }), /Invalid/);
});
