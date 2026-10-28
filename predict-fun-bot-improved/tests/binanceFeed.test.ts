import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { BinanceFeed, type BinanceFeedEvent } from '../server/BinanceFeed';

class FakeSocket extends EventEmitter {
  terminated = false;
  terminate() { this.terminated = true; }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

function fixture() {
  let time = 0;
  let wall = 1_700_000_000_000;
  const sockets: Array<{ url: string; socket: FakeSocket }> = [];
  const events: BinanceFeedEvent[] = [];
  const feed = new BinanceFeed({
    websocketFactory: url => {
      const socket = new FakeSocket();
      sockets.push({ url, socket });
      return socket as unknown as WebSocket;
    },
    wallClock: () => wall,
    monotonicClock: () => time,
  });
  feed.on('update', event => events.push(event));
  feed.start();
  sockets.forEach(({ socket }) => socket.emit('open'));
  return {
    feed, sockets, events,
    time: (value: number) => { time = value; },
    wall: (value: number) => { wall = value; },
    quote: (id: number, mid: number, extra: Record<string, unknown> = {}) => {
      sockets[sockets.length - 3].socket.frame({ u: id, s: 'BTCUSDT', b: String(mid - .5), a: String(mid + .5), B: '2', A: '3', ...extra });
    },
  };
}

test('momentum uses a single monotonic clock even if exchange/wall clocks differ', () => {
  const f = fixture();
  try {
    f.quote(1, 65000, { T: 1 });
    f.time(50);
    f.wall(5000); // Wall time can move backwards without inventing a spike.
    f.quote(2, 65010, { T: 9_999_999_999_999 });
    const momentum = f.feed.getCurrentMomentum();
    assert.equal(momentum?.priceChange50ms, 10);
    assert.equal(momentum?.velocityPerSec, 200);
    assert.equal(momentum?.direction, 'UP');
    assert.equal(momentum?.timestamp, 5000);
    assert.deepEqual(f.feed.getPriceLookback(50), { price: 65000, age: 50 });
    assert.equal(f.feed.getPriceLookback(250), null);
    f.time(1051);
    assert.equal(f.feed.getCurrentMomentum(), null);
    assert.equal(f.feed.getLatestTick(), null);
  } finally { f.feed.stop(); }
});

test('rejects malformed, crossed, wrong-symbol and replayed quotes', () => {
  const f = fixture();
  try {
    f.quote(10, 65000);
    f.quote(9, 66000);
    f.quote(11, 65000, { b: 'Infinity' });
    f.quote(12, 65000, { a: '64000' });
    f.quote(13, 65000, { B: '-1' });
    f.quote(14, 65000, { s: 'ETHUSDT' });
    assert.equal(f.events.filter(e => e.type === 'tick').length, 1);
    assert.equal(f.feed.getLatestTick()?.midPrice, 65000);
  } finally { f.feed.stop(); }
});

test('replayed trades and invalid depth never contaminate flow or imbalance', () => {
  const f = fixture();
  try {
    const trades = f.sockets[1].socket;
    const depth = f.sockets[2].socket;
    trades.frame({ a: 10, p: '65000', q: '2', m: false, s: 'BTCUSDT' });
    trades.frame({ a: 10, p: '66000', q: '200', m: true, s: 'BTCUSDT' });
    trades.frame({ a: 11, p: '-1', q: '2', m: false });
    depth.frame({ lastUpdateId: 10, bids: [['65000', '4']], asks: [['65001', '2']] });
    depth.frame({ lastUpdateId: 9, bids: [['65000', '100']], asks: [['65001', '2']] });
    depth.frame({ lastUpdateId: 11, bids: [['65000', 'NaN']], asks: [['65001', '2']] });
    depth.frame({ lastUpdateId: 12, bids: [], asks: [] });
    assert.equal(f.events.filter(e => e.type === 'trade').length, 1);
    const imbalances = f.events.filter(e => e.type === 'imbalance');
    assert.equal(imbalances.length, 1);
    assert.equal(imbalances[0].data.imbalance, 1 / 3);
  } finally { f.feed.stop(); }
});

test('stop clears timers/history and ignores frames from a previous session', () => {
  const f = fixture();
  const oldBook = f.sockets[0].socket;
  f.quote(1, 65000);
  f.time(50);
  f.quote(2, 65010);
  const firstInterval = (f.feed as any).momentumInterval;
  f.feed.stop();
  assert.equal((f.feed as any).momentumInterval, null);
  assert.equal(firstInterval._destroyed, true);
  assert.ok(f.sockets.every(s => s.socket.terminated));
  assert.equal(f.feed.getLatestTick(), null);
  assert.equal(f.feed.getPriceLookback(50), null);
  const count = f.events.length;
  oldBook.frame({ b: '1', a: '2', B: '1', A: '1' });
  assert.equal(f.events.length, count);
  f.feed.start();
  f.sockets.slice(-3).forEach(s => s.socket.emit('open'));
  oldBook.frame({ b: '1', a: '2', B: '1', A: '1' });
  assert.equal(f.feed.getLatestTick(), null);
  assert.equal(f.feed.getCurrentMomentum(), null);
  assert.notEqual((f.feed as any).momentumInterval, firstInterval);
  assert.ok(f.sockets.every(s => !s.url.includes('fstream') && !s.url.includes('binance.us')));
  f.feed.stop();
});

test('disconnect invalidates tick and stop cancels pending reconnect', () => {
  const f = fixture();
  f.quote(1, 65000);
  f.sockets[0].socket.emit('close', 1006, Buffer.from('network'));
  assert.equal(f.feed.getLatestTick(), null);
  assert.equal((f.feed as any).reconnectTimers.size, 1);
  f.feed.stop();
  assert.equal((f.feed as any).reconnectTimers.size, 0);
});


test('lookback never invents a recent sample across a long gap', () => {
  const f = fixture();
  try {
    f.quote(1, 65000);
    f.time(1000);
    f.quote(2, 65020);
    assert.equal(f.feed.getPriceLookback(5), null);
    assert.equal(f.feed.getPriceLookback(250), null);
    assert.deepEqual(f.feed.getPriceLookback(1000), { price: 65000, age: 1000 });
  } finally { f.feed.stop(); }
});
