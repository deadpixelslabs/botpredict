export interface SignalResult {
  score: number;
  raw: any;
  label: string;
  available?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function clamp(v: number, lo = -100, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

export function ema(data: number[], period: number): number {
  if (data.length === 0) return 0;
  const k = 2 / (period + 1);
  let e = data[0];
  for (let i = 1; i < data.length; i++) e = data[i] * k + e * (1 - k);
  return e;
}

export function sma(data: number[], period: number): number {
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

/**
 * Full EMA series (not just the final value) — needed to build a true
 * MACD signal line, which is itself an EMA of the MACD line over time.
 */
export function emaSeries(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const k = 2 / (period + 1);
  const out = [data[0]];
  for (let i = 1; i < data.length; i++) out.push(data[i] * k + out[i - 1] * (1 - k));
  return out;
}

export function stdDev(data: number[]): number {
  const m = sma(data, data.length);
  const variance = data.reduce((s, v) => s + (v - m) ** 2, 0) / data.length;
  return Math.sqrt(variance);
}

// ─── Signal 1: EMA Trend (weight 15) ─────────────────────────────────────────

export function signalEmaTrend(closes: number[]): SignalResult {
  if (closes.length < 25) return { score: 0, raw: null, label: 'EMA Trend' };

  const e9  = ema(closes, 9);
  const e21 = ema(closes, 21);
  const e9_prev  = ema(closes.slice(0, -3), 9);
  const e21_prev = ema(closes.slice(0, -3), 21);

  const price = closes[closes.length - 1];
  const delta = (e9 - e21) / price;          // Current gap as % of price
  const deltaPrev = (e9_prev - e21_prev) / price; // Previous gap
  const acceleration = delta - deltaPrev;         // Is gap widening?

  // Score: direction × magnitude × acceleration bonus
  const baseScore = clamp(delta * 8000, -80, 80);
  const accelBonus = clamp(acceleration * 20000, -20, 20);
  const score = clamp(baseScore + accelBonus);

  return {
    score,
    raw: { e9, e21, delta, acceleration },
    label: 'EMA 9/21 trend',
  };
}

// ─── Signal 2: RSI Divergence (weight 12) ────────────────────────────────────

export function calcRsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  const gains: number[] = [], losses: number[] = [];
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) {
      gains.push(d);
    } else {
      losses.push(Math.abs(d));
    }
  }
  const avgG = gains.length ? gains.reduce((a, b) => a + b, 0) / period : 0.0001;
  const avgL = losses.length ? losses.reduce((a, b) => a + b, 0) / period : 0.0001;
  return 100 - 100 / (1 + avgG / avgL);
}

export function signalRsiDivergence(closes: number[]): SignalResult {
  if (closes.length < 20) return { score: 0, raw: null, label: 'RSI' };

  const rsi = calcRsi(closes);
  const rsiPrev = calcRsi(closes.slice(0, -5));

  const priceTrend = closes[closes.length - 1] - closes[closes.length - 6];
  const rsiTrend = rsi - rsiPrev;

  let score = 0;

  // Overbought / Oversold
  if (rsi < 25)       score = 90;
  else if (rsi < 32)  score = 65;
  else if (rsi < 40)  score = 30;
  else if (rsi > 75)  score = -90;
  else if (rsi > 68)  score = -65;
  else if (rsi > 60)  score = -30;
  else score = (rsi - 50) * -2.5; // Linear between 40–60

  // Bearish divergence: price up but RSI down
  if (priceTrend > 0 && rsiTrend < -3) score -= 25;
  // Bullish divergence: price down but RSI up
  if (priceTrend < 0 && rsiTrend > 3) score += 25;

  return { score: clamp(score), raw: { rsi, rsiPrev, priceTrend, rsiTrend }, label: 'RSI divergence' };
}

// ─── Signal 3: MACD Histogram Delta (weight 12) ──────────────────────────────

export function signalMacdDelta(closes: number[]): SignalResult {
  const n = closes.length;
  if (n < 40) return { score: 0, raw: null, label: 'MACD Δhist' };

  const price = closes[n - 1];

  const ema12series = emaSeries(closes, 12);
  const ema26series = emaSeries(closes, 26);
  const macdLineSeries = ema12series.map((v, i) => v - ema26series[i]);
  const signalLineSeries = emaSeries(macdLineSeries, 9);

  const hist     = macdLineSeries[n - 1] - signalLineSeries[n - 1];
  const histPrev = macdLineSeries[n - 3] - signalLineSeries[n - 3];

  const histDelta    = hist - histPrev;         // Rate of change
  const histAccel    = histDelta / (price + 1); // Normalized acceleration

  // Direction from histogram sign + momentum from delta
  const dirScore   = clamp((hist / price) * 40000, -60, 60);
  const deltScore  = clamp(histAccel * 800000, -40, 40);

  return {
    score: clamp(dirScore + deltScore),
    raw: { macdLine: macdLineSeries[n - 1], signalLine: signalLineSeries[n - 1], hist, histDelta },
    label: 'MACD Δhist',
  };
}

// ─── Signal 4: Bollinger Band Squeeze (weight 10) ────────────────────────────

export function signalBollingerSqueeze(closes: number[]): SignalResult {
  const n = closes.length;
  if (n < 22) return { score: 0, raw: null, label: 'BB squeeze' };

  const period = 20;
  const slice  = closes.slice(-period);
  const mean   = sma(slice, period);
  const std    = stdDev(slice);
  const price  = closes[n - 1];

  const upperBand = mean + 2 * std;
  const lowerBand = mean - 2 * std;
  const bbw       = (upperBand - lowerBand) / mean;

  // Historical BB width (previous 20 bars)
  const prevSlice  = closes.slice(-40, -20);
  const prevMean   = sma(prevSlice, period);
  const prevStd    = stdDev(prevSlice);
  const prevBbw    = (4 * prevStd) / prevMean;

  const isSqueeze = bbw < prevBbw * 0.7; // Current width is 30% narrower

  // Position within bands (z-score)
  const zScore = (price - mean) / (std || 1);

  let score;
  if (isSqueeze) {
    // In squeeze: slight bias toward where price is pushing
    score = clamp(zScore * 25);
  } else {
    // Outside squeeze: mean-reversion bias
    score = clamp(-zScore * 40);
  }

  return {
    score,
    raw: { mean, std, bbw, prevBbw, isSqueeze, zScore },
    label: 'BB squeeze',
  };
}

// ─── Signal 5: Volume Surge (weight 10) ──────────────────────────────────────

export function signalVolumeSurge(closes: number[], volumes: number[] | null): SignalResult {
  const n = closes.length;
  if (!volumes || volumes.length < 10 || n < 10) {
    return { score: 0, raw: null, label: 'Volume surge' };
  }

  const recentVol  = volumes[volumes.length - 1];
  const volSlice   = volumes.slice(-20, -1);
  const avgVol     = sma(volSlice, volSlice.length);
  const volRatio   = recentVol / (avgVol || 1);

  const priceDir   = closes[n - 1] > closes[n - 2] ? 1 : -1;
  const surgeScore = clamp((volRatio - 1) * 60, -60, 60);

  // Volume surge aligned with direction = strong signal
  // Volume surge against direction = possible exhaustion reversal
  const score = surgeScore * priceDir;

  return {
    score: clamp(score),
    raw: { recentVol, avgVol, volRatio, priceDir },
    label: 'Volume surge',
  };
}

// ─── Signal 6: OBV Slope (weight 8) ──────────────────────────────────────────

export function signalObvSlope(closes: number[], volumes: number[] | null): SignalResult {
  const n = closes.length;
  if (!volumes || volumes.length < 6 || n < 6) {
    return { score: 0, raw: null, label: 'OBV slope' };
  }

  // Build OBV
  const obv = [0];
  for (let i = 1; i < n; i++) {
    const dir = closes[i] > closes[i - 1] ? 1 : closes[i] < closes[i - 1] ? -1 : 0;
    obv.push(obv[obv.length - 1] + dir * volumes[i]);
  }

  const obvNow  = obv[obv.length - 1];
  const obvPrev = obv[Math.max(0, obv.length - 6)];
  const slope   = obvNow - obvPrev;

  // Divergence check: price up but OBV down = bearish div
  const priceDelta = closes[n - 1] - closes[n - 6];
  const obvDelta   = slope;

  let score = clamp((slope / (closes[n - 1] * 0.01 + 1)) * 0.5, -80, 80);

  // Divergence penalty/bonus
  if (priceDelta > 0 && obvDelta < 0) score -= 30;
  if (priceDelta < 0 && obvDelta > 0) score += 30;

  return {
    score: clamp(score),
    raw: { obvNow, obvPrev, slope, priceDelta, obvDelta },
    label: 'OBV slope',
  };
}

// ─── Signal 7: Chaikin Money Flow (weight 8) ─────────────────────────────────

export function signalCmf(closes: number[], highs: number[] | null, lows: number[] | null, volumes: number[] | null, period = 14): SignalResult {
  const n = closes.length;

  // Fallback: close-only CMF approximation
  if (!highs || !lows || !volumes || highs.length < period) {
    const slice = closes.slice(-period);
    const std   = stdDev(slice);
    const price = closes[n - 1];
    const mean  = sma(slice, period);
    const rawCmf = (price - mean) / (std || 1) / 3;
    return {
      score: clamp(rawCmf * 80),
      raw: { cmf: rawCmf, mode: 'approx' },
      label: 'CMF (approx)',
    };
  }

  let mfvSum = 0, volSum = 0;
  for (let i = n - period; i < n; i++) {
    const h = highs[i], l = lows[i], c = closes[i], v = volumes[i];
    const range = h - l;
    const mfm = range === 0 ? 0 : ((c - l) - (h - c)) / range;
    mfvSum += mfm * v;
    volSum += v;
  }

  const cmf = volSum === 0 ? 0 : mfvSum / volSum;

  return {
    score: clamp(cmf * 200),
    raw: { cmf, mfvSum, volSum },
    label: 'CMF',
  };
}

// ─── Signal 8: Candle Pattern (weight 8) ─────────────────────────────────────

export function signalCandlePattern(closes: number[], highs: number[] | null, lows: number[] | null, opens: number[] | null): SignalResult {
  const n = closes.length;
  if (n < 3) return { score: 0, raw: null, label: 'Candle pattern' };

  const c0 = closes[n - 1], c1 = closes[n - 2], c2 = closes[n - 3];
  const o0 = opens  ? opens[n - 1]  : c1;
  const o1 = opens  ? opens[n - 2]  : c2;
  const h0 = highs  ? highs[n - 1]  : Math.max(c0, c1);
  const l0 = lows   ? lows[n - 1]   : Math.min(c0, c1);
  const h1 = highs  ? highs[n - 2]  : Math.max(c1, c2);
  const l1 = lows   ? lows[n - 2]   : Math.min(c1, c2);

  const body0    = Math.abs(c0 - o0);
  const body1    = Math.abs(c1 - o1);
  const range0   = h0 - l0;
  const range1   = h1 - l1;
  const bodyRatio0 = range0 > 0 ? body0 / range0 : 0;

  let score = 0;
  let pattern = 'none';

  // Bullish Engulfing
  if (c1 < o1 && c0 > o0 && c0 > o1 && o0 < c1 && body0 > body1 * 0.9) {
    score = 80; pattern = 'bullish_engulfing';
  }
  // Bearish Engulfing
  else if (c1 > o1 && c0 < o0 && c0 < o1 && o0 > c1 && body0 > body1 * 0.9) {
    score = -80; pattern = 'bearish_engulfing';
  }
  // Hammer (bullish pin bar)
  else if (
    bodyRatio0 < 0.35 &&
    (l0 - Math.min(c0, o0)) > body0 * 2.2 &&
    (Math.max(c0, o0) - h0) < body0 * 0.5
  ) {
    score = 70; pattern = 'hammer';
  }
  // Shooting Star (bearish pin bar)
  else if (
    bodyRatio0 < 0.35 &&
    (h0 - Math.max(c0, o0)) > body0 * 2.2 &&
    (l0 - Math.min(c0, o0)) < body0 * 0.5
  ) {
    score = -70; pattern = 'shooting_star';
  }
  // Inside Bar (range contraction → imminent move)
  else if (h0 < h1 && l0 > l1) {
    // Bias based on where close is relative to inside bar range
    const ibMid = (h1 + l1) / 2;
    score = c0 > ibMid ? 35 : -35;
    pattern = 'inside_bar';
  }
  // Doji (indecision)
  else if (bodyRatio0 < 0.1) {
    score = 0; pattern = 'doji';
  }
  // Plain directional body
  else {
    score = c0 > o0 ? clamp(bodyRatio0 * 25) : clamp(-bodyRatio0 * 25);
    pattern = c0 > o0 ? 'bullish_body' : 'bearish_body';
  }

  return { score: clamp(score), raw: { pattern, body0, body1, bodyRatio0 }, label: 'Candle pattern' };
}

// ─── Signal 9: Microstructure (weight 9) ─────────────────────────────────────

export function signalMicrostructure(closes: number[]): SignalResult {
  const n = closes.length;
  if (n < 8) return { score: 0, raw: null, label: 'Microstructure' };

  const price  = closes[n - 1];
  const micro  = closes.slice(-6);

  // 5-tick trend (simple linear fit slope)
  const trend5 = micro[5] - micro[0];

  // Acceleration: is the move speeding up or slowing down?
  const momFirst = micro[2] - micro[0]; // First half momentum
  const momLast  = micro[5] - micro[3]; // Last half momentum
  const accel    = momLast - momFirst;  // Positive = accelerating

  // Tick consistency: how many ticks go in same direction?
  let consistent = 0;
  const overallDir = trend5 > 0 ? 1 : -1;
  for (let i = 1; i < micro.length; i++) {
    if (Math.sign(micro[i] - micro[i - 1]) === overallDir) consistent++;
  }
  const consistency = consistent / (micro.length - 1); // 0–1

  const trendScore   = clamp((trend5 / price) * 15000, -60, 60);
  const accelBonus   = clamp((accel  / price) * 8000,  -25, 25);
  const consisBonus  = clamp((consistency - 0.5) * overallDir * 30, -15, 15);

  return {
    score: clamp(trendScore + accelBonus + consisBonus),
    raw: { trend5, accel, consistency, momFirst, momLast },
    label: 'Microstructure',
  };
}

// ─── Signal 10: Hurst Regime Bias (weight 8) ─────────────────────────────────

export function signalHurstBias(closes: number[], hurst: number): SignalResult {
  const n = closes.length;
  if (n < 10) return { score: 0, raw: null, label: 'Hurst bias' };

  const shortTrend = closes[n - 1] - closes[n - 4];
  const priceDir   = shortTrend > 0 ? 1 : -1;

  let score = 0;

  if (hurst > 0.55) {
    // Persistent → follow the trend
    const strength = (hurst - 0.5) * 2; // 0–1 scale
    score = priceDir * strength * 70;
  } else if (hurst < 0.45) {
    // Anti-persistent → fade the trend
    const strength = (0.5 - hurst) * 2;
    score = -priceDir * strength * 70;
  }

  return {
    score: clamp(score),
    raw: { hurst, shortTrend, priceDir },
    label: 'Hurst regime bias',
  };
}

// ─── Order Book Imbalance (bonus signal, weight +12 if available) ─────────────

export function signalOrderBookImbalance(depth: any, levels = 10): SignalResult {
  if (!depth || !depth.bids || !depth.asks) {
    return { score: 0, raw: null, label: 'OBI', available: false };
  }

  const bidVol = depth.bids
    .slice(0, levels)
    .reduce((s: number, [, qty]: any) => s + parseFloat(qty), 0);

  const askVol = depth.asks
    .slice(0, levels)
    .reduce((s: number, [, qty]: any) => s + parseFloat(qty), 0);

  const total    = bidVol + askVol;
  const imbalance = (bidVol - askVol) / (total || 1); // -1 to +1
  const score    = clamp(imbalance * 150); // Amplify — OBI is high signal

  return {
    score,
    raw: { bidVol, askVol, imbalance, levels },
    label: 'Order book imbalance',
    available: true,
  };
}
