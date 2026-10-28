import { getMode } from "./core/config";
import * as epochEngine from "./core/epochEngine";
import { hybridBrain, CandleData } from "./genius";
import { agentDecide } from "./agent";

export interface MarketData {
  closes: number[];
  highs?: number[] | null;
  lows?: number[] | null;
  opens?: number[] | null;
  volumes?: number[] | null;
  depth?: any;
  candleOpenTime?: number | null;
  tradeHistory?: Array<{ predicted: string, actual: string }>;
}

export interface PredictionResult {
  direction: 'UP' | 'DOWN' | 'SKIP' | 'SETTLING';
  confidence: number;
  confidencePct: number;
  netScore: number;
  momentumScore: number;
  mrScore: number;
  agreementRatio: number;
  clusterAgreement: boolean;
  regime: any;
  entropy: any;
  hurst: number;
  signals: any;
  signalDetails?: any[];
  guard: any;
  mode?: string;
  summary: string;
  timestamp: number;
  isExhausted?: boolean;
  exhaustionReason?: string;
  epoch?: {
    epochStart: number;
    locked: boolean;
    secondsIntoEpoch?: number;
    settleUntil?: number;
    sampledCandidates?: number;
  };
}

/**
 * Core analysis function — ONE snapshot, computed fresh every call.
 *
 * If you call this directly in a polling loop you will get flicker, because
 * each call sees slightly different data. For an actual 5-minute UP/DOWN
 * call that stays fixed for the whole window, use `analyzeEpoch()` instead.
 *
 * @param data Market indicators and prices
 * @param opts Prediction configuration options
 */
export async function analyze(data: MarketData, opts: {
  mode?: 'conservative' | 'aggressive';
  prevDirection?: 'UP' | 'DOWN' | 'SKIP' | null;
  trimForming?: boolean;
  candleIntervalMs?: number;
} = {}): Promise<PredictionResult> {
  const {
    closes,
    highs    = null,
    lows     = null,
    opens    = null,
    volumes  = null,
    depth    = null,
    candleOpenTime = null,
  } = data;

  const closes1m = (data as any).closes1m;

  const minCandles = 15;
  if (!closes || closes.length < minCandles) {
    return _skipResult(`Insufficient data — need at least ${minCandles} closes`, {});
  }

  // Construct Candles array
  const count = closes.length;
  const candles: CandleData[] = [];
  for (let i = 0; i < count; i++) {
    candles.push({
      open: opens?.[i] ?? closes[i],
      high: highs?.[i] ?? closes[i],
      low: lows?.[i] ?? closes[i],
      close: closes[i],
      volume: volumes?.[i] ?? 0,
      timestamp: candleOpenTime ? candleOpenTime - (count - 1 - i) * 300000 : Date.now() - (count - 1 - i) * 300000,
    });
  }

  // Trim the forming candle if it is currently incomplete/forming (standard active epoch check)
  const isForming = candleOpenTime && (Date.now() - candleOpenTime) < 300000;
  const doTrim = opts.trimForming !== undefined ? opts.trimForming : true;
  const closedCandles = (isForming && doTrim) ? candles.slice(0, -1) : candles;

  if (closedCandles.length < minCandles) {
    return _skipResult(`Insufficient closed data after trimming — need at least ${minCandles} closes`, {});
  }

  const historicalCandles = closedCandles.slice(0, -1);
  const lastClosedCandle = closedCandles[closedCandles.length - 1];

  const orderBook = (depth && depth.bids && depth.asks) ? depth : undefined;
  const recentTrades = orderBook ? [] : undefined; // fallback empty array enables flow imbalance calculations

  function debugCandles(candles: any[]) {
    if (!candles || candles.length === 0) return;
    const closes = candles.map(c => c.close);
    const unique = new Set(closes).size;
    const duplicateRatio = 1 - unique / closes.length;
    
    // Cek urutan timestamp
    let outOfOrder = 0;
    for (let i = 1; i < candles.length; i++) {
      if (candles[i].timestamp <= candles[i-1].timestamp) outOfOrder++;
    }
    
    // Cek gap interval
    const gaps = candles.slice(1).map((c, i) => c.timestamp - candles[i].timestamp);
    const expectedGap = 15 * 60 * 1000;
    const weirdGaps = gaps.filter(g => g !== expectedGap).length;
    
    console.log({
      totalCandles: candles.length,
      uniqueCloses: unique,
      duplicateRatio: (duplicateRatio * 100).toFixed(1) + '%',
      outOfOrderTimestamps: outOfOrder,
      weirdGaps,
      firstTimestamp: new Date(candles[0].timestamp).toISOString(),
      lastTimestamp: new Date(candles[candles.length-1].timestamp).toISOString(),
    });
  }

  debugCandles(historicalCandles);

  const agentDecision = await agentDecide(
    historicalCandles,
    lastClosedCandle
  );

  const instruction = agentDecision.mathResult;
  const meta = instruction.meta;

  const finalDirection = agentDecision.direction === 'HOLD' ? 'SKIP' : agentDecision.direction;

  const result: PredictionResult = {
    direction:        finalDirection,
    confidence:       agentDecision.confidence,
    confidencePct:    agentDecision.confidence * 100,
    netScore:         0,
    momentumScore:    0,
    mrScore:          0,
    agreementRatio:   agentDecision.confidence,
    clusterAgreement: true,
    regime:           { regime: meta?.regime || 'AMBIGUOUS' },
    entropy:          { shannon: 0.5 },
    hurst:            meta?.hurst || 0.5,
    signals:          {} as any,
    signalDetails:    [
      ...(meta ? [
        { key: "RSI", score: meta.rsi },
        { key: "Z-Score", score: meta.zScore },
        { key: "ADX", score: meta.adx },
        { key: "Hurst", score: meta.hurst },
        { key: "Entropy", score: meta.entropy },
        { key: "OFI", score: meta.ofi },
        { key: "Raw Score", score: meta.rawScore },
        { key: "KNN Boost", score: agentDecision.knnInsight },
        { key: "Pattern Boost", score: agentDecision.patternBoost },
        { key: "News Sentiment", score: agentDecision.newsSentiment?.score || 0 }
      ] : []),
      { key: "Debate Winner", score: agentDecision.debate?.judgeVerdict.winningAgent || "NEUTRAL" }
    ],
    guard:            { allow: finalDirection !== 'SKIP', reasons: [] },
    mode:             opts.mode || 'aggressive',
    summary:          agentDecision.reason,
    timestamp:        Date.now(),
  };

  return result;
}

/**
 * Epoch-locked analysis — THE function you want for a 5-minute UP/DOWN market.
 *
 * Call this as often as you like (e.g. every few seconds while the epoch is
 * live). For the first `settleWindowMs` of a new epoch it samples snapshots
 * and picks the strongest one; after that, it returns the exact same frozen
 * result every time, no matter what the market does, until the next epoch
 * boundary arrives.
 *
 * @param symbol Symbol string key (e.g., 'BTCUSDT') — state is tracked per symbol
 * @param data Market indicators and prices
 * @param opts Epoch and mode configurations
 */
export async function analyzeEpoch(symbol: string, data: MarketData, opts: {
  epochStartMs?: number | null;
  epochLenMs?: number;
  settleWindowMs?: number;
  mode?: 'conservative' | 'aggressive';
  trimForming?: boolean;
  candleIntervalMs?: number;
} = {}): Promise<PredictionResult> {
  const {
    epochStartMs = null,
    epochLenMs   = epochEngine.EPOCH_MS_DEFAULT,
    settleWindowMs,
    mode = 'aggressive',
    ...rest
  } = opts;

  const cfg = getMode(mode);
  const epochStart = epochEngine.resolveEpochStart(epochStartMs, epochLenMs);

  let state = epochEngine.getState(symbol);
  if (!state || state.epochStart !== epochStart) {
    state = epochEngine.initState(symbol, epochStart, settleWindowMs ?? cfg.SETTLE_WINDOW_MS);
  }

  // Already locked for this epoch → return the frozen call, untouched.
  if (state.locked) {
    return {
      ...state.locked,
      epoch: {
        epochStart,
        locked: true,
        secondsIntoEpoch: Math.floor((Date.now() - epochStart) / 1000),
      },
    };
  }

  // Still settling → take a fresh snapshot and add it to the candidate pool.
  const result = await analyze(data, { ...rest, mode, prevDirection: state.lastDirection as any });
  state.candidates.push(result);

  const now = Date.now();
  const settlingDone = now >= state.settleUntil || state.candidates.length >= 5; // safety cap

  if (!settlingDone) {
    return {
      ...result,
      direction: 'SETTLING',
      epoch: { epochStart, locked: false, settleUntil: state.settleUntil },
    };
  }

  // Lock in: pick the highest-confidence candidate
  const finalResult = _resolveCandidates(state.candidates);
  state.locked = finalResult;
  if (finalResult.direction !== 'SKIP') state.lastDirection = finalResult.direction;

  return {
    ...finalResult,
    epoch: {
      epochStart,
      locked: true,
      secondsIntoEpoch: Math.floor((now - epochStart) / 1000),
      sampledCandidates: state.candidates.length,
    },
  };
}

/**
 * Clear epoch-lock state for a symbol (e.g. on process restart / manual reset).
 */
export function resetEpoch(symbol: string): void {
  epochEngine.reset(symbol);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function _resolveCandidates(candidates: any[]): any {
  const tally = { UP: 0, DOWN: 0 };
  for (const c of candidates) {
    if (c.direction === 'UP' || c.direction === 'DOWN') {
      tally[c.direction] += c.confidence;
    }
  }

  if (tally.UP === 0 && tally.DOWN === 0) {
    return candidates[candidates.length - 1];
  }

  const winningDirection = tally.UP >= tally.DOWN ? 'UP' : 'DOWN';
  const pool = candidates
    .filter(c => c.direction === winningDirection)
    .sort((a, b) => b.confidence - a.confidence);

  return pool[0];
}

function _skipResult(reason: string, partial: any): PredictionResult {
  return {
    direction: 'SKIP',
    confidence: 0,
    confidencePct: 0,
    netScore: 0,
    momentumScore: 0,
    mrScore: 0,
    agreementRatio: 0,
    clusterAgreement: false,
    regime: null,
    entropy: null,
    hurst: 0.5,
    signals: null,
    guard: { allow: false, reasons: [reason] },
    summary: `SKIP — ${reason}`,
    timestamp: Date.now(),
    ...partial,
  };
}

function _buildSummary(direction: string, score: any, regime: any, guard: any): string {
  if (direction === 'SKIP') {
    const reason = guard.reasons[0] || 'No clear edge';
    return `SKIP — ${reason}`;
  }

  const arrow    = direction === 'UP' ? '↑' : '↓';
  const conf     = score.confidencePct.toFixed(1);
  const net      = score.netScore.toFixed(1);
  const agree    = (score.agreementRatio * 100).toFixed(0);
  const clust    = score.clusterAgreement ? ' [clusters agree]' : '';
  const regName  = regime.regime;

  let base = `${direction} ${arrow} | score ${net} | conf ${conf}% | agree ${agree}% | ${regName}${clust}`;
  if (score.isExhausted) {
    base += ` [REVERSAL: ${score.exhaustionReason}]`;
  }
  return base;
}

/**
 * Convenience: extract just closes/volumes/etc from klines array
 */
export function parseKlines(klines: any[]): {
  closes: number[];
  opens: number[];
  highs: number[];
  lows: number[];
  volumes: number[];
} {
  return {
    closes:  klines.map(k => k.close),
    opens:   klines.map(k => k.open),
    highs:   klines.map(k => k.high),
    lows:    klines.map(k => k.low),
    volumes: klines.map(k => k.volume),
  };
}
