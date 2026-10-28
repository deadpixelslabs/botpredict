import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';

// Protocol: https://dev.predict.fun/request-format-1915501m0
// Heartbeats: https://dev.predict.fun/heartbeats-1915508m0
const ENDPOINT = 'wss://ws.predict.fun/ws';
const STATUSES = new Set(['OPEN', 'MATCHING_NOT_ENABLED', 'CANCEL_ONLY', 'CLOSED']);
type Level = [number, number];

export interface PredictStreamOrderbook {
  marketId: number;
  updateTimestampMs: number;
  receivedAt: number;
  asks: Level[];
  bids: Level[];
  settlementsPending?: { asks: Level[]; bids: Level[] };
}

export interface PredictOrderbookFeedOptions {
  websocketFactory?: (url: string, options: WebSocket.ClientOptions) => WebSocket;
  wallClock?: () => number;
  monotonicClock?: () => number;
  jitter?: () => number;
  maxSnapshotAgeMs?: number;
}

/** Optional streaming cache; construction never opens a connection.
 * One active market keeps subscriptions bounded across five-minute rollovers.
 * Missing snapshots, failed subscriptions and closed markets return null so
 * the caller can use its bounded REST fallback without inventing a quote.
 */
export class PredictOrderbookFeed extends EventEmitter {
  private socket: WebSocket | null = null;
  private running = false;
  private connected = false;
  private apiKey = '';
  private activeMarket: string | null = null;
  private generation = 0;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  private lastHeartbeatAt = 0;
  private lastHeartbeatTimestamp = 0;
  private nextRequestId = 0;
  private authRejected = false;
  private readonly pending = new Map<number, { topic: string; sentAt: number }>();
  private readonly acknowledged = new Set<string>();
  private book: PredictStreamOrderbook | null = null;
  private lastEmittedBook: PredictStreamOrderbook | null = null;
  private lastBookTimestamp = 0;
  private lastTradingTimestamp = 0;
  private bookReceivedMono = 0;
  private bookSourceAgeAtReceive = 0;
  private tradingStatus: { marketId: number; tsMs: number; tradingStatus: string } | null = null;
  private readonly wallClock: () => number;
  private readonly monotonicClock: () => number;
  private readonly websocketFactory: NonNullable<PredictOrderbookFeedOptions['websocketFactory']>;
  private readonly jitter: () => number;
  private readonly maxSnapshotAgeMs: number;

  constructor(options: PredictOrderbookFeedOptions = {}) {
    super();
    this.wallClock = options.wallClock ?? Date.now;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.websocketFactory = options.websocketFactory ?? ((url, config) => new WebSocket(url, config));
    this.jitter = options.jitter ?? Math.random;
    this.maxSnapshotAgeMs = options.maxSnapshotAgeMs ?? 5000;
    if (!Number.isFinite(this.maxSnapshotAgeMs) || this.maxSnapshotAgeMs <= 0) throw new Error('Invalid snapshot age');
  }

  start(apiKey: string): void {
    if (typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('Predict streaming requires an API key');
    if (this.running && this.apiKey === apiKey) return;
    if (this.running) this.stop();
    this.running = true;
    this.apiKey = apiKey;
    this.authRejected = false;
    this.reconnectAttempt = 0;
    this.connect();
  }

  subscribeMarket(marketId: string | number): void {
    const id = canonicalId(marketId);
    if (id === null) throw new Error('Invalid Predict market ID');
    if (id === this.activeMarket) return;
    if (this.activeMarket && this.connected) {
      this.sendRequest('unsubscribe', `predictOrderbook/${this.activeMarket}`);
      this.sendRequest('unsubscribe', `predictTradingStatus/${this.activeMarket}`);
    }
    this.activeMarket = id;
    this.clearMarketCache();
    this.pending.clear();
    this.acknowledged.clear();
    this.subscribeActiveMarket();
  }

  getLatestBook(marketId: string | number, maxAgeMs = 2500): PredictStreamOrderbook | null {
    const id = canonicalId(marketId);
    if (!this.running || !this.connected || id !== this.activeMarket || !this.book ||
        !Number.isFinite(maxAgeMs) || maxAgeMs <= 0 || this.tradingStatus?.tradingStatus !== 'OPEN' ||
        !this.acknowledged.has(`predictOrderbook/${id}`) || !this.acknowledged.has(`predictTradingStatus/${id}`)) return null;
    // Source age advances on a monotonic clock. A wall-clock adjustment or
    // re-reading the cache must never make an old orderbook look fresh again.
    const age = this.bookSourceAgeAtReceive + this.monotonicClock() - this.bookReceivedMono;
    return age >= 0 && age <= maxAgeMs ? this.book : null;
  }

  stop(): void {
    this.running = false;
    this.connected = false;
    this.generation++;
    this.apiKey = '';
    this.cancelTimers();
    this.pending.clear();
    this.acknowledged.clear();
    this.clearMarketCache();
    const socket = this.socket;
    this.socket = null;
    socket?.terminate();
    this.emit('status', { connected: false });
  }

  private connect(): void {
    if (!this.running || this.authRejected) return;
    const generation = ++this.generation;
    const current = () => this.running && generation === this.generation;
    let socket: WebSocket;
    try {
      socket = this.websocketFactory(ENDPOINT, {
        headers: { 'x-api-key': this.apiKey }, handshakeTimeout: 5000, maxPayload: 1024 * 1024,
      });
    } catch {
      this.emit('warning', 'Predict streaming connection unavailable; using REST fallback.');
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.on('open', () => {
      if (!current()) { socket.terminate(); return; }
      this.connected = true;
      this.lastHeartbeatAt = this.monotonicClock();
      this.lastHeartbeatTimestamp = 0;
      this.clearMarketCache();
      this.pending.clear();
      this.acknowledged.clear();
      this.subscribeActiveMarket();
      this.watchdogTimer = setInterval(() => {
        if (!current()) return;
        const now = this.monotonicClock();
        if (now - this.lastHeartbeatAt > 35000 || [...this.pending.values()].some(p => now - p.sentAt > 10000)) {
          this.emit('warning', 'Predict streaming liveness timeout; reconnecting.');
          socket.terminate();
        }
      }, 5000);
      this.watchdogTimer.unref();
      this.emit('status', { connected: true });
    });
    socket.on('message', raw => {
      if (!current() || !this.connected) return;
      try { this.handleMessage(JSON.parse(raw.toString())); }
      catch { /* Invalid frames cannot refresh the executable cache. */ }
    });
    socket.on('error', (error: Error) => {
      if (!current()) return;
      // Never log raw request/config objects: the handshake contains a secret.
      if (/\b(?:401|403)\b/.test(error.message)) this.authRejected = true;
      this.emit('warning', this.authRejected
        ? 'Predict streaming authentication rejected; REST fallback remains available.'
        : 'Predict streaming connection interrupted; using REST fallback.');
    });
    socket.on('close', () => {
      if (!current()) return;
      this.connected = false;
      this.socket = null;
      if (this.watchdogTimer) clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
      this.pending.clear();
      this.acknowledged.clear();
      this.clearMarketCache();
      this.emit('status', { connected: false });
      this.scheduleReconnect();
    });
  }

  private handleMessage(message: any): void {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'R') {
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      if (message.success === true) {
        this.acknowledged.add(request.topic);
        this.emitBookIfReady();
      } else {
        this.acknowledged.delete(request.topic);
        this.invalidateBook();
        this.clearMarketCache();
        this.emit('warning', 'Predict streaming subscription rejected; using REST fallback.');
      }
      return;
    }
    if (message.type !== 'M' || typeof message.topic !== 'string') return;
    if (message.topic === 'heartbeat') {
      if (!this.validTimestamp(message.data, 35000) || message.data <= this.lastHeartbeatTimestamp) return;
      this.lastHeartbeatTimestamp = message.data;
      this.lastHeartbeatAt = this.monotonicClock();
      this.reconnectAttempt = 0;
      this.send({ method: 'heartbeat', data: message.data });
      return;
    }
    if (!this.activeMarket) return;
    const data = message.data;
    if (!data || typeof data !== 'object' || canonicalId(data.marketId) !== this.activeMarket) return;
    if (message.topic === `predictTradingStatus/${this.activeMarket}`) {
      const timestamp = data.tsMs;
      // Status snapshots describe current state; their timestamp is the last
      // transition time and can predate the subscription by minutes.
      if (!this.validTimestamp(timestamp, Infinity) || !STATUSES.has(data.tradingStatus) ||
          timestamp <= this.lastTradingTimestamp) return;
      this.lastTradingTimestamp = timestamp;
      this.tradingStatus = Object.freeze({ marketId: Number(this.activeMarket), tsMs: timestamp, tradingStatus: data.tradingStatus });
      if (data.tradingStatus !== 'OPEN') this.book = null;
      this.emit('tradingStatus', this.tradingStatus);
      this.emitBookIfReady();
      return;
    }
    if (message.topic !== `predictOrderbook/${this.activeMarket}`) return;
    const timestamp = data.updateTimestampMs;
    if (!this.validTimestamp(timestamp) || timestamp <= this.lastBookTimestamp) return;
    this.lastBookTimestamp = timestamp;
    const asks = parseLevels(data.asks, true), bids = parseLevels(data.bids, false);
    if (!asks || !bids || !asks.length || !bids.length || bids[0][0] >= asks[0][0]) { this.invalidateBook(); return; }
    const book: PredictStreamOrderbook = {
      marketId: Number(this.activeMarket), updateTimestampMs: timestamp,
      receivedAt: this.wallClock(), asks, bids,
    };
    if (data.settlementsPending) {
      const pendingAsks = parseLevels(data.settlementsPending.asks, true);
      const pendingBids = parseLevels(data.settlementsPending.bids, false);
      if (!pendingAsks || !pendingBids) { this.invalidateBook(); return; }
      book.settlementsPending = Object.freeze({ asks: pendingAsks, bids: pendingBids });
    }
    this.book = Object.freeze(book);
    this.bookReceivedMono = this.monotonicClock();
    this.bookSourceAgeAtReceive = Math.max(0, this.wallClock() - timestamp);
    this.reconnectAttempt = 0;
    this.emitBookIfReady();
  }

  private invalidateBook(): void {
    this.book = null;
    this.emit('quoteInvalidated', { marketId: this.activeMarket });
  }

  private validTimestamp(value: unknown, maxAgeMs = this.maxSnapshotAgeMs): value is number {
    const now = this.wallClock();
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 &&
      value <= now + 1000 && now - value <= maxAgeMs;
  }

  private emitBookIfReady(): void {
    if (!this.activeMarket) return;
    const book = this.getLatestBook(this.activeMarket, this.maxSnapshotAgeMs);
    if (book && book !== this.lastEmittedBook) {
      this.lastEmittedBook = book;
      this.emit('book', book);
    }
  }

  private subscribeActiveMarket(): void {
    if (!this.connected || !this.activeMarket) return;
    this.sendRequest('subscribe', `predictOrderbook/${this.activeMarket}`);
    this.sendRequest('subscribe', `predictTradingStatus/${this.activeMarket}`);
  }

  private sendRequest(method: 'subscribe' | 'unsubscribe', topic: string): void {
    const requestId = this.nextRequestId++;
    if (method === 'subscribe') this.pending.set(requestId, { topic, sentAt: this.monotonicClock() });
    this.send({ method, requestId, params: [topic] });
  }

  private send(message: Record<string, unknown>): void {
    const socket = this.socket;
    if (!socket || !this.connected || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify(message), error => { if (error) socket.terminate(); });
    } catch { socket.terminate(); }
  }

  private scheduleReconnect(): void {
    if (!this.running || this.authRejected || this.reconnectTimer) return;
    const base = Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5));
    const random = Math.max(0, Math.min(1, this.jitter()));
    const delay = Math.round(base * (0.8 + 0.4 * random));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearMarketCache(): void {
    this.book = null;
    this.lastEmittedBook = null;
    this.lastBookTimestamp = 0;
    this.lastTradingTimestamp = 0;
    this.tradingStatus = null;
    this.bookReceivedMono = 0;
    this.bookSourceAgeAtReceive = 0;
  }

  private cancelTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.reconnectTimer = this.watchdogTimer = null;
  }
}

function canonicalId(value: unknown): string | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || !/^\d+$/.test(String(value))) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? String(numeric) : null;
}

function parseLevels(value: unknown, ascending: boolean): Level[] | null {
  if (!Array.isArray(value) || value.length > 5000) return null;
  const levels: Level[] = [];
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 ||
        !entry.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    const [price, quantity] = entry;
    if (price <= 0 || price >= 1 || quantity < 0) return null;
    if (quantity === 0) continue;
    const previous = levels[levels.length - 1]?.[0];
    if (previous !== undefined && (ascending ? price <= previous : price >= previous)) return null;
    levels.push(Object.freeze([price, quantity]) as Level);
  }
  return Object.freeze(levels) as Level[];
}
