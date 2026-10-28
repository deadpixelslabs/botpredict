import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { PredictOrderbookFeed, type PredictStreamOrderbook } from '../server/PredictOrderbookFeed';

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.CONNECTING;
  sent: any[] = [];
  terminated = false;
  send(payload: string, callback?: (error?: Error) => void) { this.sent.push(JSON.parse(payload)); callback?.(); }
  terminate() { this.terminated = true; this.readyState = WebSocket.CLOSED; this.emit('close', 1006); }
  open() { this.readyState = WebSocket.OPEN; this.emit('open'); }
  frame(value: unknown) { this.emit('message', Buffer.from(JSON.stringify(value))); }
}

function fixture() {
  let wall = 1_700_000_000_000, mono = 0;
  const connections: Array<{ url: string; config: WebSocket.ClientOptions; socket: FakeSocket }> = [];
  const books: PredictStreamOrderbook[] = [];
  const warnings: string[] = [];
  const feed = new PredictOrderbookFeed({
    websocketFactory: (url, config) => {
      const socket = new FakeSocket();
      connections.push({ url, config, socket });
      return socket as unknown as WebSocket;
    }, wallClock: () => wall, monotonicClock: () => mono, jitter: () => .5,
  });
  feed.on('book', book => books.push(book));
  feed.on('warning', warning => warnings.push(warning));
  const socket = () => connections[connections.length - 1].socket;
  const ack = () => socket().sent.filter(r => r.method === 'subscribe').forEach(r => socket().frame({ type: 'R', requestId: r.requestId, success: true }));
  const book = (time = wall, overrides: Record<string, unknown> = {}, topic = 'predictOrderbook/123') => socket().frame({ type: 'M', topic, data: { version: 1, marketId: 123, updateTimestampMs: time, asks: [[.51, 20], [.52, 30]], bids: [[.49, 40], [.48, 50]], ...overrides } });
  const status = (tradingStatus = 'OPEN', time = wall) => socket().frame({ type: 'M', topic: 'predictTradingStatus/123', data: { marketId: 123, tradingStatus, tsMs: time } });
  return { feed, connections, books, warnings, socket, ack, book, status,
    start: () => { feed.subscribeMarket(123); feed.start('test-key'); socket().open(); },
    advance: (ms: number) => { wall += ms; mono += ms; },
    wall: () => wall,
  };
}

test('constructor is passive; handshake uses header; subscriptions and heartbeat match official protocol', () => {
  const f = fixture();
  assert.equal(f.connections.length, 0);
  f.start();
  try {
    assert.equal(f.connections[0].url, 'wss://ws.predict.fun/ws');
    assert.deepEqual(f.connections[0].config.headers, { 'x-api-key': 'test-key' });
    assert.deepEqual(f.socket().sent, [
      { method: 'subscribe', requestId: 0, params: ['predictOrderbook/123'] },
      { method: 'subscribe', requestId: 1, params: ['predictTradingStatus/123'] },
    ]);
    f.socket().frame({ type: 'M', topic: 'heartbeat', data: f.wall() });
    assert.deepEqual(f.socket().sent.at(-1), { method: 'heartbeat', data: f.wall() });
    f.socket().frame({ type: 'M', topic: 'heartbeat', data: f.wall() });
    f.socket().frame({ type: 'M', topic: 'heartbeat', data: f.wall() - 36000 });
    assert.equal(f.socket().sent.filter(r => r.method === 'heartbeat').length, 1);
  } finally { f.feed.stop(); }
});

test('fresh acknowledged book requires OPEN status; old transition time is valid for a status snapshot', () => {
  const f = fixture(); f.start();
  try {
    f.book();
    f.status('OPEN', f.wall() - 60000);
    assert.equal(f.feed.getLatestBook(123), null);
    f.ack();
    assert.equal(f.feed.getLatestBook(123)?.asks[0][0], .51);
    assert.equal(f.books.length, 1);
    assert.equal(f.feed.getLatestBook(456), null);
    f.advance(1);
    f.status('CANCEL_ONLY');
    assert.equal(f.feed.getLatestBook(123), null);
    f.advance(1);
    f.status('OPEN');
    assert.equal(f.feed.getLatestBook(123), null); // Requires a new quote after a stop.
    f.book();
    assert.ok(f.feed.getLatestBook(123));
  } finally { f.feed.stop(); }
});

test('source timestamp and monotonic age reject replayed, stale, future and mismatched snapshots', () => {
  const f = fixture(); f.start(); f.ack(); f.status(); f.book();
  try {
    const initial = f.feed.getLatestBook(123)!;
    f.advance(1000);
    f.book(initial.updateTimestampMs, { asks: [[.6, 1]] });
    f.book(initial.updateTimestampMs - 1, { asks: [[.6, 1]] });
    f.book(f.wall(), { marketId: 456 });
    f.book(f.wall(), {}, 'predictOrderbook/456');
    f.book(f.wall() + 1001);
    assert.equal(f.feed.getLatestBook(123), initial);
    assert.equal(f.books.length, 1);
    f.advance(1501);
    assert.equal(f.feed.getLatestBook(123, 2500), null);
    f.book(f.wall() - 6000);
    assert.equal(f.feed.getLatestBook(123), null);
    assert.equal(f.feed.getLatestBook(123, NaN), null);
  } finally { f.feed.stop(); }
});

test('malformed/crossed/unsorted/empty depth invalidates cache without reviving an older quote', () => {
  const f = fixture(); f.start(); f.ack(); f.status(); f.book();
  let invalidations = 0;
  f.feed.on('quoteInvalidated', () => invalidations++);
  try {
    const old = f.wall();
    f.advance(1);
    f.book(f.wall(), { bids: [[.7, 1]] });
    assert.equal(f.feed.getLatestBook(123), null);
    assert.ok(invalidations > 0, 'consumers must immediately revoke their cached executable quote');
    f.book(old);
    assert.equal(f.feed.getLatestBook(123), null);
    for (const overrides of [{ asks: [] }, { bids: [[.49, -1]] }, { asks: [[.51, 20], [.50, 10]] }, { asks: [[NaN, 1]] }]) {
      f.advance(1); f.book(f.wall(), overrides);
      assert.equal(f.feed.getLatestBook(123), null);
    }
    f.advance(1); f.book();
    assert.ok(f.feed.getLatestBook(123));
  } finally { f.feed.stop(); }
});

test('market switch unsubscribes old topics and never serves the previous market', () => {
  const f = fixture(); f.start(); f.ack(); f.status(); f.book();
  try {
    f.feed.subscribeMarket(456);
    assert.deepEqual(f.socket().sent.slice(-4).map(r => [r.method, r.params[0]]), [
      ['unsubscribe', 'predictOrderbook/123'], ['unsubscribe', 'predictTradingStatus/123'],
      ['subscribe', 'predictOrderbook/456'], ['subscribe', 'predictTradingStatus/456'],
    ]);
    f.book(); f.status();
    assert.equal(f.feed.getLatestBook(123), null);
    assert.equal(f.feed.getLatestBook(456), null);
    assert.throws(() => f.feed.subscribeMarket('123?apiKey=x'));
  } finally { f.feed.stop(); }
});

test('subscription rejection fails closed and does not disclose raw server errors', () => {
  const f = fixture(); f.start(); f.status(); f.book();
  try {
    f.socket().frame({ type: 'R', requestId: 0, success: false, error: { message: 'test-key secret' } });
    assert.equal(f.feed.getLatestBook(123), null);
    assert.equal(f.warnings.length, 1);
    assert.ok(!f.warnings[0].includes('test-key'));
  } finally { f.feed.stop(); }
});

test('disconnect reconnects with backoff, resubscribes, and stop cancels all timers', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.start(); f.ack(); f.status(); f.book();
  const oldSocket = f.socket();
  oldSocket.terminate();
  assert.equal(f.feed.getLatestBook(123), null);
  context.mock.timers.tick(999);
  assert.equal(f.connections.length, 1);
  context.mock.timers.tick(1);
  assert.equal(f.connections.length, 2);
  f.socket().open();
  assert.deepEqual(f.socket().sent.map(r => r.params[0]), ['predictOrderbook/123', 'predictTradingStatus/123']);
  oldSocket.frame({ type: 'M', topic: 'heartbeat', data: f.wall() });
  assert.equal(oldSocket.sent.filter(r => r.method === 'heartbeat').length, 0);
  f.socket().terminate();
  f.feed.stop();
  context.mock.timers.tick(120000);
  assert.equal(f.connections.length, 2);
  assert.equal((f.feed as any).watchdogTimer, null);
  assert.equal((f.feed as any).reconnectTimer, null);
});

test('liveness watchdog reconnects a silent connection; authentication failure avoids retry loops', context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const f = fixture(); f.start(); f.ack();
  f.advance(36000);
  context.mock.timers.tick(5000);
  assert.equal(f.socket().terminated, true);
  f.feed.stop();
  const auth = fixture(); auth.start();
  auth.socket().emit('error', new Error('Unexpected server response: 401'));
  auth.socket().terminate();
  context.mock.timers.tick(120000);
  assert.equal(auth.connections.length, 1);
  auth.feed.stop();
});
