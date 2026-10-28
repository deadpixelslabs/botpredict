/**
 * BinanceFeed.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Real-time BTC/USDT price feed dari Binance via WebSocket.
 * Menggunakan kombinasi:
 *   1. bookTicker  → best bid/ask, update setiap perubahan
 *   2. aggTrade    → executed trades
 *   3. depth (L2)  → order book imbalance untuk signal strength
 *
 * Actual delivery latency depends on network, exchange and host load.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { performance } from 'node:perf_hooks';

export interface BinanceFeedOptions {
  /** Test seam; production always uses a real WebSocket. */
  websocketFactory?: (url: string) => WebSocket;
  wallClock?: () => number;
  monotonicClock?: () => number;
  maxTickAgeMs?: number;
}

type StreamName = 'bookTicker' | 'aggTrade' | 'depth';

export interface BinanceTick {
  symbol:    string;
  bidPrice:  number;
  askPrice:  number;
  midPrice:  number;   // (bid+ask)/2
  lastPrice: number;   // last trade price
  timestamp: number;   // local receive time (Date.now())
  serverTime?: number; // binance event time
  bidQty:    number;
  askQty:    number;
  spread:    number;   // ask - bid
  spreadBps: number;   // spread dalam basis points
}

export interface BinanceTrade {
  price:     number;
  qty:       number;
  isBuyerMaker: boolean; // true = sell aggressor (price drop), false = buy aggressor (price up)
  timestamp: number;
}

export interface OrderBookImbalance {
  bidVolume:  number;   // total bid volume (top 5 levels)
  askVolume:  number;   // total ask volume (top 5 levels)
  imbalance:  number;   // (bid - ask) / (bid + ask), range -1 to +1
  timestamp:  number;
}

export interface PriceMomentum {
  priceChange50ms?: number;
  priceChange100ms?: number;
  priceChange150ms?: number;
  priceChange500ms?: number;
  priceChange1s:  number;  // perubahan harga 1 detik terakhir (USD)
  priceChange3s:  number;  // perubahan harga 3 detik terakhir
  priceChange5s:  number;  // perubahan harga 5 detik terakhir
  velocityPerSec: number;  // rate of change (USD/sec)
  direction:      'UP' | 'DOWN' | 'FLAT';
  magnitude:      'STRONG' | 'MODERATE' | 'WEAK';
  timestamp:      number;
}

export type BinanceFeedEvent =
  | { type: 'tick';      data: BinanceTick }
  | { type: 'trade';     data: BinanceTrade }
  | { type: 'imbalance'; data: OrderBookImbalance }
  | { type: 'momentum';  data: PriceMomentum }
  | { type: 'connected' }
  | { type: 'disconnected'; code: number; reason: string }
  | { type: 'error'; error: Error };

export class BinanceFeed extends EventEmitter {
  private wsBook:  WebSocket | null = null;
  private wsTrade: WebSocket | null = null;
  private wsDepth: WebSocket | null = null;

  private latestTick: BinanceTick | null = null;
  private priceHistory: Array<{ price: number; ts: number }> = [];

  private readonly reconnectDelays = new Map<StreamName, number>();
  private readonly reconnectTimers = new Map<StreamName, NodeJS.Timeout>();
  private readonly maxReconnectDelay = 30000;
  private isRunning = false;
  private generation = 0;
  private momentumInterval: NodeJS.Timeout | null = null;
  private historyHead = 0;
  private latestTickMonotonicAt = -Infinity;
  private lastBookUpdateId = -Infinity;
  private lastDepthUpdateId = -Infinity;
  private lastTradeId = -Infinity;
  private readonly wallClock: () => number;
  private readonly monotonicClock: () => number;
  private readonly websocketFactory: (url: string) => WebSocket;
  private readonly maxTickAgeMs: number;

  private readonly SYMBOL = 'btcusdt';
  private readonly WS_BASES = [
    'wss://data-stream.binance.vision/ws',
    'wss://stream.binance.com:443/ws',
    'wss://stream.binance.com:9443/ws'
  ];
  private currentBaseIndex = 0;

  private get WS_BASE(): string {
    return this.WS_BASES[this.currentBaseIndex] || 'wss://data-stream.binance.vision/ws';
  }

  constructor(options: BinanceFeedOptions = {}) {
    super();
    this.wallClock = options.wallClock ?? Date.now;
    this.monotonicClock = options.monotonicClock ?? (() => performance.now());
    this.websocketFactory = options.websocketFactory ?? ((url) => new WebSocket(url, { handshakeTimeout: 5000 }));
    this.maxTickAgeMs = options.maxTickAgeMs ?? 1000;
    if (!Number.isFinite(this.maxTickAgeMs) || this.maxTickAgeMs <= 0) {
      throw new Error('maxTickAgeMs must be positive');
    }
    this.setMaxListeners(20);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC: Start semua feed
  // ─────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.generation++;
    this.resetBookState();
    console.log('[BinanceFeed] Starting WebSocket feeds...');
    this.connectBookTicker();
    this.connectAggTrade();
    this.connectDepth();
    this.startMomentumCalculator();
  }

  stop(): void {
    this.isRunning = false;
    this.generation++;
    if (this.momentumInterval) clearInterval(this.momentumInterval);
    this.momentumInterval = null;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    this.reconnectDelays.clear();
    for (const ws of [this.wsBook, this.wsTrade, this.wsDepth]) ws?.terminate();
    this.wsBook = this.wsTrade = this.wsDepth = null;
    this.resetBookState();
    console.log('[BinanceFeed] Stopped');
  }

  getLatestTick(): BinanceTick | null {
    return this.isRunning && this.monotonicClock() - this.latestTickMonotonicAt <= this.maxTickAgeMs
      ? this.latestTick : null;
  }

  private resetBookState(): void {
    this.latestTick = null;
    this.latestTickMonotonicAt = -Infinity;
    this.priceHistory = [];
    this.historyHead = 0;
    this.lastBookUpdateId = -Infinity;
  }

  getCurrentMomentum(): PriceMomentum | null {
    return this.calculateMomentum();
  }

  /** Actual prior quote age, anchored to the latest quote on the monotonic clock. */
  getPriceLookback(msAgo: number, maxAgeMs = Math.max(msAgo * 2, 50)): { price: number; age: number } | null {
    if (!this.getLatestTick() || !Number.isFinite(msAgo) || msAgo <= 0 ||
        !Number.isFinite(maxAgeMs) || maxAgeMs < msAgo) return null;
    const target = this.latestTickMonotonicAt - msAgo;
    let lo = this.historyHead, hi = this.priceHistory.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.priceHistory[mid].ts <= target) { found = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (found < 0) return null;
    const point = this.priceHistory[found];
    const age = this.latestTickMonotonicAt - point.ts;
    return age <= maxAgeMs ? { price: point.price, age } : null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // bookTicker: best bid/ask, update setiap perubahan
  // ─────────────────────────────────────────────────────────────────────────

  private connectBookTicker(): void {
    const url = `${this.WS_BASE}/${this.SYMBOL}@bookTicker`;
    this.wsBook = this.createWS(url, 'bookTicker', (raw) => {
      const d = JSON.parse(raw);
      // d.b = best bid price, d.B = best bid qty
      // d.a = best ask price, d.A = best ask qty
      const bid = Number(d.b);
      const ask = Number(d.a);
      const bidQty = Number(d.B);
      const askQty = Number(d.A);
      if (d.s !== undefined && d.s !== 'BTCUSDT') return;
      if (![bid, ask, bidQty, askQty].every(Number.isFinite) || bid <= 0 || ask < bid || bidQty < 0 || askQty < 0) return;
      const updateId = Number(d.u);
      if (Number.isFinite(updateId)) {
        if (updateId <= this.lastBookUpdateId) return;
        this.lastBookUpdateId = updateId;
      }

      const mid    = (bid + ask) / 2;
      const spread = ask - bid;

      const tick: BinanceTick = {
        symbol:     'BTCUSDT',
        bidPrice:   bid,
        askPrice:   ask,
        midPrice:   mid,
        lastPrice:  this.latestTick?.lastPrice ?? mid,
        timestamp:  this.wallClock(),
        serverTime: Number.isFinite(Number(d.E ?? d.T)) ? Number(d.E ?? d.T) : undefined,
        bidQty,
        askQty,
        spread,
        spreadBps:  (spread / mid) * 10000,
      };

      this.latestTick = tick;

      // Spot bookTicker has no server timestamp. Keep every lookback on one
      // monotonic receive clock; mixing exchange time with Date.now invents moves.
      const tickTime = this.monotonicClock();
      this.latestTickMonotonicAt = tickTime;
      this.priceHistory.push({ price: tick.midPrice, ts: tickTime });
      const cutoff = tickTime - 30000;
      while (this.historyHead < this.priceHistory.length && this.priceHistory[this.historyHead].ts < cutoff) this.historyHead++;
      this.historyHead = Math.max(this.historyHead, this.priceHistory.length - 20000);
      if (this.historyHead > 1024) {
        this.priceHistory = this.priceHistory.slice(this.historyHead);
        this.historyHead = 0;
      }

      this.emit('update', { type: 'tick', data: tick } as BinanceFeedEvent);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // aggTrade: individual trade executions (ultra-low latency)
  // ─────────────────────────────────────────────────────────────────────────

  private connectAggTrade(): void {
    const url = `${this.WS_BASE}/${this.SYMBOL}@aggTrade`;
    this.wsTrade = this.createWS(url, 'aggTrade', (raw) => {
      const d = JSON.parse(raw);
      const price = Number(d.p), qty = Number(d.q), tradeId = Number(d.a);
      if (d.s !== undefined && d.s !== 'BTCUSDT') return;
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(qty) || qty <= 0 || typeof d.m !== 'boolean') return;
      if (Number.isFinite(tradeId)) {
        if (tradeId <= this.lastTradeId) return;
        this.lastTradeId = tradeId;
      }
      const trade: BinanceTrade = {
        price,
        qty,
        isBuyerMaker: d.m,   // true = seller hit bid = bearish
        timestamp:    this.wallClock(),
      };

      // Update lastPrice
      if (this.latestTick) {
        this.latestTick = { ...this.latestTick, lastPrice: trade.price };
      }

      this.emit('update', { type: 'trade', data: trade } as BinanceFeedEvent);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Depth (L2 order book): top 5 levels untuk imbalance
  // ─────────────────────────────────────────────────────────────────────────

  private connectDepth(): void {
    const url = `${this.WS_BASE}/${this.SYMBOL}@depth5@100ms`;
    this.wsDepth = this.createWS(url, 'depth', (raw) => {
      const d = JSON.parse(raw);
      // d.bids = [[price, qty], ...]
      // d.asks = [[price, qty], ...]

      if (!Array.isArray(d.bids) || !Array.isArray(d.asks) || !d.bids.length || !d.asks.length) return;
      const validLevels = (levels: any[]) => levels.every(level => Array.isArray(level) && Number.isFinite(Number(level[0])) && Number(level[0]) > 0 && Number.isFinite(Number(level[1])) && Number(level[1]) >= 0);
      if (!validLevels(d.bids) || !validLevels(d.asks)) return;
      const updateId = Number(d.lastUpdateId);
      if (Number.isFinite(updateId)) {
        if (updateId <= this.lastDepthUpdateId) return;
        this.lastDepthUpdateId = updateId;
      }
      const bidVolume = d.bids.slice(0, 5).reduce((sum: number, level: any[]) => sum + Number(level[1]), 0);
      const askVolume = d.asks.slice(0, 5).reduce((sum: number, level: any[]) => sum + Number(level[1]), 0);

      const total = bidVolume + askVolume;
      const imb: OrderBookImbalance = {
        bidVolume,
        askVolume,
        imbalance: total > 0 ? (bidVolume - askVolume) / total : 0,
        timestamp: this.wallClock(),
      };

      this.emit('update', { type: 'imbalance', data: imb } as BinanceFeedEvent);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Momentum calculator — runs setiap 50ms
  // ─────────────────────────────────────────────────────────────────────────

  private startMomentumCalculator(): void {
    if (this.momentumInterval) clearInterval(this.momentumInterval);
    this.momentumInterval = setInterval(() => {
      if (!this.isRunning) return;
      const m = this.calculateMomentum();
      if (m) this.emit('update', { type: 'momentum', data: m } as BinanceFeedEvent);
    }, 50);
    this.momentumInterval.unref();
  }

  private calculateMomentum(): PriceMomentum | null {
    if (!this.isRunning || this.priceHistory.length - this.historyHead < 2) return null;
    const now = this.monotonicClock();
    if (now - this.latestTickMonotonicAt > this.maxTickAgeMs) return null;
    const current = this.priceHistory[this.priceHistory.length - 1].price;

    // Binary search avoids seven full-array allocations on every 50ms tick.
    const find = (msAgo: number): number | null => {
      const target = now - msAgo;
      let lo = this.historyHead, hi = this.priceHistory.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        if (this.priceHistory[mid].ts <= target) { found = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (found < 0 || now - this.priceHistory[found].ts > msAgo * 1.6) return null;
      return this.priceHistory[found].price;
    };

    const p50ms = find(50);
    const p100ms = find(100);
    const p150ms = find(150);
    const p500ms = find(500);
    const p1s = find(1000);
    const p3s = find(3000);
    const p5s = find(5000);

    const change50ms = p50ms != null ? current - p50ms : 0;
    const change100ms = p100ms != null ? current - p100ms : 0;
    const change150ms = p150ms != null ? current - p150ms : 0;
    const change500ms = p500ms != null ? current - p500ms : 0;
    const change1s = p1s != null ? current - p1s : 0;
    const change3s = p3s != null ? current - p3s : 0;
    const change5s = p5s != null ? current - p5s : 0;

    // Use change50ms extrapolated to per sec for ultra-fast velocity response
    const velocity = change50ms * (1000 / 50); 

    const threshold50ms = current * 0.00001; // 0.001%
    const threshold100ms = current * 0.00002; // 0.002%
    const threshold150ms = current * 0.00003; // 0.003%

    let direction: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
    if (change50ms > threshold50ms || change100ms > threshold100ms || change150ms > threshold150ms) {
      direction = 'UP';
    } else if (change50ms < -threshold50ms || change100ms < -threshold100ms || change150ms < -threshold150ms) {
      direction = 'DOWN';
    }

    const absVel = Math.abs(velocity);
    let magnitude: 'STRONG' | 'MODERATE' | 'WEAK' = 'WEAK';
    if (absVel > 10) magnitude = 'STRONG';
    else if (absVel > 3) magnitude = 'MODERATE';

    return { priceChange50ms: change50ms, priceChange100ms: change100ms, priceChange150ms: change150ms, priceChange500ms: change500ms, priceChange1s: change1s, priceChange3s: change3s, priceChange5s: change5s, velocityPerSec: velocity, direction, magnitude, timestamp: this.wallClock() };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket factory dengan auto-reconnect
  // ─────────────────────────────────────────────────────────────────────────

  private createWS(url: string, name: StreamName, onMessage: (raw: string) => void): WebSocket {
    const ws = this.websocketFactory(url);
    const generation = this.generation;
    const isCurrent = () => this.isRunning && generation === this.generation;

    ws.on('open', () => {
      if (!isCurrent()) { ws.terminate(); return; }
      console.log(`[BinanceFeed:${name}] Connected`);
      this.reconnectDelays.set(name, 1000);
      if (name === 'bookTicker') {
        this.resetBookState();
        this.emit('update', { type: 'connected' });
      }
      if (name === 'aggTrade') this.lastTradeId = -Infinity;
      if (name === 'depth') this.lastDepthUpdateId = -Infinity;
    });

    ws.on('message', (data) => {
      if (!isCurrent()) return;
      try { onMessage(data.toString()); } catch {
        // A malformed frame must never produce a tick or interrupt the feed.
        console.warn(`[BinanceFeed:${name}] Invalid market-data frame ignored`);
      }
    });

    // ws replies to ping frames automatically, preserving the server payload.
    ws.on('error', (err) => {
      if (!isCurrent()) return;
      console.error(`[BinanceFeed:${name}] Error:`, err.message);
      this.emit('update', { type: 'error', error: err });
    });

    ws.on('close', (code, reason) => {
      if (!isCurrent()) return;
      if (name === 'bookTicker') {
        this.resetBookState();
        this.emit('update', { type: 'disconnected', code, reason: reason.toString() });
      }
      // Rotate only among global Binance spot feeds. Futures and Binance.US
      // have different prices/liquidity and cannot substitute for BTCUSDT spot.
      this.currentBaseIndex = (this.currentBaseIndex + 1) % this.WS_BASES.length;
      if (this.reconnectTimers.has(name)) return;
      const delay = this.reconnectDelays.get(name) ?? 1000;
      this.reconnectDelays.set(name, Math.min(delay * 2, this.maxReconnectDelay));
      const timer = setTimeout(() => {
        this.reconnectTimers.delete(name);
        if (!isCurrent()) return;
        if (name === 'bookTicker') this.connectBookTicker();
        if (name === 'aggTrade') this.connectAggTrade();
        if (name === 'depth') this.connectDepth();
      }, delay);
      timer.unref();
      this.reconnectTimers.set(name, timer);
    });

    return ws;
  }
}
