import { EntropyScoreResult } from "./entropy";

export enum REGIMES {
  TRENDING = 'TRENDING',
  MEAN_REV = 'MEAN_REV',
  BREAKOUT = 'BREAKOUT',
  NOISE    = 'NOISE',
}

/**
 * ATR-based normalized volatility
 * Returns volatility as % of price (normalized ATR)
 */
export function volatilityScore(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 0;

  let atrSum = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    atrSum += Math.abs(closes[i] - closes[i - 1]);
  }
  const atr = atrSum / period;
  const normAtr = atr / closes[closes.length - 1];
  return normAtr;
}

/**
 * Bollinger Band Width — proxy for squeeze / expansion state
 */
export function bbWidth(prices: number[], period = 20): number {
  if (prices.length < period) return 0;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / period);
  return (std * 4) / mean; // 2σ × 2 bands / price
}

export interface RegimeResult {
  regime: REGIMES;
  momentum_mult: number;
  mr_mult: number;
  breakout_mult: number;
  confidence: number;
  description: string;
  hurst: number;
  entropy: number;
}

/**
 * Classify current market regime
 */
export function classifyRegime(hurst: number, entropy: EntropyScoreResult, prices: number[]): RegimeResult {
  const normVol = volatilityScore(prices);
  const bw = bbWidth(prices);
  const isSqueeze = bw < 0.003; // BB width < 0.3% = squeeze

  // --- Scoring system ---
  let trending = 0;
  let meanRev  = 0;
  let noisy    = 0;

  // Hurst contributions
  if (hurst > 0.60) trending += 3;
  else if (hurst > 0.55) trending += 2;
  else if (hurst > 0.51) trending += 1;
  else if (hurst < 0.40) meanRev += 3;
  else if (hurst < 0.45) meanRev += 2;
  else if (hurst < 0.49) meanRev += 1;
  else noisy += 2; // 0.49–0.51 = pure noise zone

  // Entropy contributions
  if (entropy.shannon < 0.60) trending += 2;
  else if (entropy.shannon < 0.72) trending += 1;
  else if (entropy.shannon > 0.93) noisy += 3;
  else if (entropy.shannon > 0.85) noisy += 1;

  if (entropy.permutation < 0.65) meanRev += 1;

  // Volatility / squeeze contributions
  if (isSqueeze) {
    // Squeeze → imminent breakout, not yet directional
    return {
      regime: REGIMES.BREAKOUT,
      momentum_mult: 0.8,
      mr_mult: 0.8,
      breakout_mult: 1.4,
      confidence: 0.55,
      description: 'Volatility squeeze — breakout imminent',
      hurst,
      entropy: entropy.combined,
    };
  }

  if (normVol > 0.006) noisy += 1; // High vol chop

  // Resolve regime
  const maxScore = Math.max(trending, meanRev, noisy);

  let regime: REGIMES;
  let momentum_mult: number;
  let mr_mult: number;
  let confidence: number;
  let description: string;

  if (noisy >= maxScore && noisy >= 3) {
    regime = REGIMES.NOISE;
    momentum_mult = 0.3;
    mr_mult = 0.3;
    confidence = 0.2;
    description = 'Random walk — no reliable edge';
  } else if (trending > meanRev) {
    const strength = trending;
    regime = REGIMES.TRENDING;
    momentum_mult = 1.0 + strength * 0.08;
    mr_mult = 0.6;
    confidence = Math.min(0.85, 0.5 + strength * 0.07);
    description = `Trending regime (H=${hurst.toFixed(3)}, strength=${strength})`;
  } else {
    const strength = meanRev;
    regime = REGIMES.MEAN_REV;
    momentum_mult = 0.7;
    mr_mult = 1.0 + strength * 0.09;
    confidence = Math.min(0.82, 0.5 + strength * 0.07);
    description = `Mean-reversion regime (H=${hurst.toFixed(3)}, strength=${strength})`;
  }

  return {
    regime,
    momentum_mult,
    mr_mult,
    breakout_mult: 1.0,
    confidence,
    description,
    hurst,
    entropy: entropy.combined,
  };
}
