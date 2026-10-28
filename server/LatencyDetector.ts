/**
 * LatencyDetector.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Core engine: mendeteksi divergence harga Binance vs predict.fun
 * dan menghasilkan sinyal arbitrase berdasarkan latency gap.
 *
 * STRATEGI:
 *   - Monitor harga Binance real-time (via WebSocket <50ms latency)
 *   - Bandingkan dengan last known price predict.fun
 *   - Jika delta signifikan → sinyal entry sebelum predict.fun sinkron
 *
 * SIGNAL QUALITY LAYERS:
 *   1. Price Delta     — seberapa besar divergence ($)
 *   2. Momentum        — kecepatan pergerakan (velocity USD/s)
 *   3. Order Book      — imbalance konfirmasi arah
 *   4. Trade Flow      — buy/sell aggressor ratio
 *   5. Consistency     — apakah arah konsisten dalam 2-5 detik terakhir
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { EventEmitter } from 'events';
import {
  BinanceFeed, BinanceTick, BinanceTrade,
  OrderBookImbalance, PriceMomentum,
} from './BinanceFeed';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export type SignalDirection = 'UP' | 'DOWN';
export type SignalStrength  = 'STRONG' | 'MODERATE' | 'WEAK';

export interface ArbitrageSignal {
  direction:      SignalDirection;
  strength:       SignalStrength;
  confidence:     number;          // 0..1 heuristic evidence quality, NOT a calibrated win probability
  priceDelta:     number;          // Binance - predictFun price (USD)
  priceDeltaPct:  number;          // delta sebagai % dari harga
  binancePrice:   number;
  predictFunPrice: number;
  velocity:       number;          // USD/sec
  obImbalance:    number;          // order book imbalance -1 to +1
  tradeFlowScore: number;          // buy/sell flow score -1 to +1
  consistencyMs:  number;          // berapa lama signal konsisten (ms)
  timestamp:      number;
  reason:         string;
  isFastSpike?:   boolean;
  // Komponen scoring detail
  scoreBreakdown: {
    deltaScore:       number;
    momentumScore:    number;
    obScore:          number;
    tradeFlowScore:   number;
    consistencyScore: number;
    total:            number;
  };
}

export interface DetectorConfig {
  // Minimum delta untuk trigger signal (USD)
  minPriceDeltaUsd: number;
  // Minimum delta sebagai % harga
  minPriceDeltaPct: number;
  // Minimum velocity untuk konfirmasi trend (USD/sec)
  minVelocity: number;
  // Minimum confidence untuk emit signal
  minConfidence: number;
  // Minimum durasi konsistensi sinyal (ms)
  minConsistencyMs: number;
  // Cooldown antar signal (ms) — hindari spam
  signalCooldownMs: number;
  // Window untuk trade flow analysis (ms)
  tradeFlowWindowMs: number;
  // Maximum age data predict.fun sebelum dianggap stale (ms)
  maxPredictFunStalenessMs: number;
  // Maximum local receive age of the Binance tick (ms)
  maxBinanceStalenessMs: number;
  // Debug logging
  debug: boolean;
}

export const DEFAULT_DETECTOR_CONFIG: DetectorConfig = {
  minPriceDeltaUsd:          3,      // min $3 divergence
  minPriceDeltaPct:          0.008,  // min 0.008% (ultra-sensitive micro-spike detection)
  minVelocity:               1.0,    // min $1/sec movement
  minConfidence:             0.65,   // evidence quality threshold; not probability
  minConsistencyMs:          50,     // require persistent direction before entry
  signalCooldownMs:          250,    // suppress duplicate bursts
  tradeFlowWindowMs:         1000,   // 1-second trade flow analysis
  maxPredictFunStalenessMs:  3000,   // reject an old reference rather than inventing an edge
  maxBinanceStalenessMs:     1500,
  debug:                     false,
};

// ─────────────────────────────────────────────────────────────────────────────
// TRADE FLOW TRACKER
// ─────────────────────────────────────────────────────────────────────────────

interface TradeFlowEntry {
  price: number;
  qty:   number;
  isBuy: boolean; // true = buyer aggressor
  ts:    number;
}

class TradeFlowTracker {
  private trades: TradeFlowEntry[] = [];
  private windowMs: number;

  constructor(windowMs: number) { this.windowMs = windowMs; }

  add(trade: BinanceTrade): void {
    const now = Date.now();
    if (!Number.isFinite(trade.price) || trade.price <= 0 || !Number.isFinite(trade.qty) || trade.qty <= 0 ||
        !Number.isFinite(trade.timestamp) || trade.timestamp > now + 1000 || now - trade.timestamp > this.windowMs) return;
    this.trades.push({
      price: trade.price,
      qty:   trade.qty,
      isBuy: !trade.isBuyerMaker, // isBuyerMaker=true means SELL aggressor
      ts:    trade.timestamp,
    });
    this.prune();
  }

  /**
   * Score dari -1 (pure sell flow) sampai +1 (pure buy flow)
   * Weighted by volume
   */
  getScore(): number {
    this.prune();
    if (this.trades.length === 0) return 0;

    let buyVol  = 0;
    let sellVol = 0;
    for (const t of this.trades) {
      if (t.isBuy) buyVol  += t.qty;
      else         sellVol += t.qty;
    }
    const total = buyVol + sellVol;
    return total > 0 ? (buyVol - sellVol) / total : 0;
  }

  getBuyRatio(): number {
    this.prune();
    const total = this.trades.length;
    if (total === 0) return 0.5;
    return this.trades.filter(t => t.isBuy).length / total;
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMs;
    this.trades = this.trades.filter(t => t.ts >= cutoff);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSISTENCY TRACKER
// Tracks apakah signal arah konsisten selama N ms
// ─────────────────────────────────────────────────────────────────────────────

class ConsistencyTracker {
  private currentDir:   SignalDirection | null = null;
  private dirStartTime: number = 0;

  update(dir: SignalDirection): number {
    const now = Date.now();
    if (dir !== this.currentDir) {
      this.currentDir   = dir;
      this.dirStartTime = now;
      return 0;
    }
    return now - this.dirStartTime;
  }

  getConsistency(): { dir: SignalDirection | null; ms: number } {
    return {
      dir: this.currentDir,
      ms:  this.currentDir ? Date.now() - this.dirStartTime : 0,
    };
  }

  reset(): void {
    this.currentDir   = null;
    this.dirStartTime = 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LATENCY DETECTOR (main class)
// ─────────────────────────────────────────────────────────────────────────────

export class LatencyDetector extends EventEmitter {
  private cfg:        DetectorConfig;
  private feed:       BinanceFeed;
  private flowTracker: TradeFlowTracker;
  private consistency: ConsistencyTracker;

  // State
  private predictFunPrice:    number | null = null;
  private predictFunUpdatedAt: number = 0;
  private latestTick:         BinanceTick | null = null;
  private latestImbalance:    OrderBookImbalance | null = null;
  private latestMomentum:     PriceMomentum | null = null;
  private lastSignalAt:       number = 0;
  private lastProcessedTickPrice: number | null = null;
  private isActive:           boolean = false;
  private _lastNoDataLogAt:   number = 0; // throttle untuk diagnostic log (FIX: debugging "no signal")

  // Stats
  public stats = {
    signalsEmitted:   0,
    signalsRejected:  0,
    avgDeltaOnSignal: 0,
    avgConfidence:    0,
  };

  constructor(cfg: Partial<DetectorConfig> = {}) {
    super();
    this.cfg         = validateConfig({ ...DEFAULT_DETECTOR_CONFIG, ...cfg });
    this.feed        = new BinanceFeed();
    this.flowTracker = new TradeFlowTracker(this.cfg.tradeFlowWindowMs);
    this.consistency = new ConsistencyTracker();

    this.setupFeedListeners();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PUBLIC
  // ─────────────────────────────────────────────────────────────────────────

  start(): void {
    if (this.isActive) return;
    this.clearMarketState();
    this.isActive = true;
    this.feed.start();
    console.log('[LatencyDetector] Started — waiting for Binance feed...');
  }

  stop(): void {
    this.isActive = false;
    this.feed.stop();
    this.clearMarketState();
    console.log('[LatencyDetector] Stopped');
  }

  /**
   * Update harga predict.fun dari polling atau SDK callback.
   * Harus dipanggil setiap kali ada update harga dari predict.fun.
   */
  updatePredictFunPrice(price: number, observedAt: number = Date.now()): void {
    const now = Date.now();
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(observedAt) ||
        observedAt <= 0 || observedAt > now + 1000 || now - observedAt > this.cfg.maxPredictFunStalenessMs) {
      this.predictFunPrice = null;
      this.predictFunUpdatedAt = 0;
      this.consistency.reset();
      return;
    }
    // Late responses must not replace a newer snapshot.
    if (observedAt < this.predictFunUpdatedAt) return;
    this.predictFunPrice = price;
    this.predictFunUpdatedAt = observedAt;
  }

  clearPredictFunPrice(): void {
    this.predictFunPrice = null;
    this.predictFunUpdatedAt = 0;
    this.consistency.reset();
  }

  getLatestBinancePrice(): number | null {
    return this.latestTick?.midPrice ?? null;
  }

  getPredictFunPrice(): number | null {
    return this.predictFunPrice;
  }

  getCurrentDelta(): number | null {
    if (!this.latestTick || this.predictFunPrice === null) return null;
    return this.latestTick.midPrice - this.predictFunPrice;
  }

  reconfigure(cfg: Partial<DetectorConfig>): void {
    this.cfg = validateConfig({ ...this.cfg, ...cfg });
    this.flowTracker = new TradeFlowTracker(this.cfg.tradeFlowWindowMs);
    this.consistency.reset();
    console.log('[LatencyDetector] Reconfigured:', cfg);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // FEED LISTENERS
  // ─────────────────────────────────────────────────────────────────────────

  private setupFeedListeners(): void {
    this.feed.on('update', (event: any) => {
      if (!this.isActive) return;

      switch (event.type) {
        case 'tick':
          this.latestTick = event.data;
          this.checkForSignal();
          break;

        case 'trade':
          this.flowTracker.add(event.data);
          break;

        case 'imbalance':
          this.latestImbalance = event.data;
          break;

        case 'momentum':
          this.latestMomentum = event.data;
          break;

        case 'connected':
          console.log('[LatencyDetector] Binance feed LIVE');
          this.emit('status', { connected: true });
          break;

        case 'disconnected':
          console.warn('[LatencyDetector] Binance feed disconnected');
          this.clearMarketState();
          this.emit('status', { connected: false });
          break;
      }
    });
  }

  private clearMarketState(): void {
    this.latestTick = null;
    this.latestImbalance = null;
    this.latestMomentum = null;
    this.lastProcessedTickPrice = null;
    this.lastSignalAt = 0;
    this.clearPredictFunPrice();
    this.flowTracker = new TradeFlowTracker(this.cfg.tradeFlowWindowMs);
  }

  private checkForSignal(): void {
    if (!this.isActive || !this.latestTick) return;
    // Every local history, age check, and cooldown uses the same clock.
    const now = Date.now();
    const tick = this.latestTick;
    const reject = () => {
      this.consistency.reset();
      this.stats.signalsRejected++;
    };
    if (!Number.isFinite(tick.midPrice) || tick.midPrice <= 0 ||
        !Number.isFinite(tick.timestamp) || tick.timestamp > now + 1000 ||
        now - tick.timestamp > this.cfg.maxBinanceStalenessMs ||
        this.predictFunPrice === null || !Number.isFinite(this.predictFunPrice) ||
        now - this.predictFunUpdatedAt > this.cfg.maxPredictFunStalenessMs) {
      reject();
      return;
    }
    if (now - this.lastSignalAt < this.cfg.signalCooldownMs) return;
    const binPrice = tick.midPrice;
    if (binPrice === this.lastProcessedTickPrice) return;

    // Require a real 250 ms baseline. The feed owns its monotonic history;
    // keep wall-clock freshness checks separate from movement durations.
    const getPriceAgo = (msAgo: number) =>
      this.feed.getPriceLookback(msAgo, Math.max(msAgo * 2, 50));
    const trend150 = getPriceAgo(150);
    const trend250 = getPriceAgo(250);
    if (!trend150 || !trend250) { reject(); return; }
    const minMovePct = Math.max(0.005, this.cfg.minPriceDeltaPct);
    let candidate: { direction: SignalDirection; movePct: number; age: number; price: number } | null = null;
    for (const lookback of [5, 10, 25, 50, 100, 150, 200, 250]) {
      const point = getPriceAgo(lookback);
      if (!point) continue;
      const movePct = (binPrice - point.price) / point.price * 100;
      if (Math.abs(movePct) >= minMovePct) {
        candidate = { direction: movePct > 0 ? 'UP' : 'DOWN', movePct, age: point.age, price: point.price };
        break;
      }
    }
    if (!candidate) { reject(); return; }
    const sign = candidate.direction === 'UP' ? 1 : -1;
    const move150 = (binPrice - trend150.price) / trend150.price * 100;
    const move250 = (binPrice - trend250.price) / trend250.price * 100;
    if (sign * move150 < -0.002 || sign * move250 < -0.002) { reject(); return; }

    const pfPrice = this.predictFunPrice;
    const delta = binPrice - pfPrice;
    const absDelta = Math.abs(delta);
    const requiredDelta = Math.max(this.cfg.minPriceDeltaUsd, pfPrice * this.cfg.minPriceDeltaPct / 100);
    if (sign * delta < requiredDelta) { reject(); return; }
    // Derive velocity from the measured triggering window, not an old timer.
    const velocity = (binPrice - candidate.price) / (candidate.age / 1000);
    if (!Number.isFinite(velocity) || sign * velocity < this.cfg.minVelocity) { reject(); return; }
    const consistencyMs = this.consistency.update(candidate.direction);
    if (consistencyMs < this.cfg.minConsistencyMs) return;

    const imbalance = this.latestImbalance;
    const obImbalance = imbalance && Number.isFinite(imbalance.imbalance) &&
      now - imbalance.timestamp <= this.cfg.maxBinanceStalenessMs && imbalance.timestamp <= now + 1000
      ? Math.max(-1, Math.min(1, imbalance.imbalance)) : 0;
    const flowScore = this.flowTracker.getScore();
    const clamp = (value: number) => Math.max(0, Math.min(1, value));
    const deltaScore = clamp(absDelta / Math.max(requiredDelta * 2, 0.01));
    const momentumScore = clamp(sign * velocity / Math.max(this.cfg.minVelocity * 2, 0.01));
    const obScore = clamp((1 + sign * obImbalance) / 2);
    const tradeFlowScore = clamp((1 + sign * flowScore) / 2);
    const consistencyScore = clamp(consistencyMs / Math.max(100, this.cfg.minConsistencyMs));
    // This is an evidence score. No probability calibration is claimed.
    const total = 0.30 * deltaScore + 0.25 * momentumScore + 0.15 * obScore +
      0.15 * tradeFlowScore + 0.15 * consistencyScore;
    if (total < this.cfg.minConfidence) { this.stats.signalsRejected++; return; }
    const strength: SignalStrength = total >= 0.8 ? 'STRONG' : total >= 0.65 ? 'MODERATE' : 'WEAK';
    const signal: ArbitrageSignal = {
      direction: candidate.direction,
      strength,
      confidence: total,
      priceDelta: delta,
      priceDeltaPct: delta / pfPrice * 100,
      binancePrice: binPrice,
      predictFunPrice: pfPrice,
      velocity,
      obImbalance,
      tradeFlowScore: flowScore,
      consistencyMs,
      timestamp: now,
      isFastSpike: true,
      reason: `${candidate.direction} move ${candidate.movePct.toFixed(4)}% over observed ${candidate.age}ms; ` +
        `model-reference delta $${delta.toFixed(2)}; evidence quality ${(total * 100).toFixed(1)}% (uncalibrated)`,
      scoreBreakdown: { deltaScore, momentumScore, obScore, tradeFlowScore, consistencyScore, total },
    };
    this.lastSignalAt = now;
    this.lastProcessedTickPrice = binPrice;
    this.stats.signalsEmitted++;
    this.stats.avgDeltaOnSignal += (absDelta - this.stats.avgDeltaOnSignal) / this.stats.signalsEmitted;
    this.stats.avgConfidence += (total - this.stats.avgConfidence) / this.stats.signalsEmitted;
    if (this.cfg.debug) console.log(`[LatencyDetector] ${signal.reason}`);
    this.emit('signal', signal);
  }
}

function validateConfig(config: DetectorConfig): DetectorConfig {
  for (const key of ['minPriceDeltaUsd', 'minPriceDeltaPct', 'minVelocity', 'minConfidence',
    'minConsistencyMs', 'signalCooldownMs', 'tradeFlowWindowMs', 'maxPredictFunStalenessMs',
    'maxBinanceStalenessMs'] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0) throw new Error(`Invalid detector config: ${key}`);
  }
  if (config.minConfidence > 1 || config.tradeFlowWindowMs <= 0 ||
      config.maxPredictFunStalenessMs <= 0 || config.maxBinanceStalenessMs <= 0) {
    throw new Error('Invalid detector confidence or freshness configuration');
  }
  return config;
}
