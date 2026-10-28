import { REGIMES, RegimeResult } from "../core/regime";
import { getMode, ModeConfig } from "../core/config";
import { SignalResult } from "./indicators";

export interface SignalDef {
  key: string;
  weight: number;
  affinity: 'momentum' | 'mr' | 'universal' | 'breakout';
  optional?: boolean;
}

export const SIGNAL_DEFS: SignalDef[] = [
  { key: 'ema_trend',    weight: 15, affinity: 'momentum'  },
  { key: 'rsi_div',      weight: 12, affinity: 'mr'        },
  { key: 'macd_delta',   weight: 12, affinity: 'momentum'  },
  { key: 'bb_squeeze',   weight: 10, affinity: 'breakout'  },
  { key: 'volume_surge', weight: 10, affinity: 'universal' },
  { key: 'obv_slope',    weight:  8, affinity: 'momentum'  },
  { key: 'cmf',          weight:  8, affinity: 'universal' },
  { key: 'candle',       weight:  8, affinity: 'mr'        },
  { key: 'microstr',     weight:  9, affinity: 'universal' },
  { key: 'hurst_bias',   weight:  8, affinity: 'momentum'  },
  { key: 'obi',          weight: 12, affinity: 'universal', optional: true },
];

export interface ScorerOptions {
  cfg?: ModeConfig;
  prevDirection?: 'UP' | 'DOWN' | 'SKIP' | null;
}

export interface ConfluenceResult {
  netScore: number;
  confidence: number;
  confidencePct: number;
  direction: 'UP' | 'DOWN' | 'SKIP';
  momentumScore: number;
  mrScore: number;
  agreementRatio: number;
  signalDetails: Array<{
    key: string;
    label: string;
    score: number;
    weight: string;
    contribution: string;
  }>;
  regimeAdjustedWeights: Record<string, string>;
  clusterAgreement: boolean;
  isExhausted?: boolean;
  exhaustionReason?: string;
}

export function computeConfluenceScore(
  signals: Record<string, SignalResult>,
  regime: RegimeResult,
  opts: ScorerOptions = {}
): ConfluenceResult {
  const cfg = opts.cfg || getMode('conservative');
  const prevDirection = opts.prevDirection || null;

  let weightedSum = 0;
  let totalWeight = 0;
  let momentumSum = 0, momentumW = 0;
  let mrSum = 0, mrW = 0;

  // ── Dynamic Trend Exhaustion / Climax Detection ─────────────────────────
  let isExhausted = false;
  let exhaustionReason = "";
  let mrBoost = 1.0;
  let momDampen = 1.0;

  const rsiSig = signals['rsi_div'];
  const bbSig = signals['bb_squeeze'];
  const candleSig = signals['candle'];

  if (rsiSig && rsiSig.raw) {
    const rsi = rsiSig.raw.rsi;
    const bbZ = bbSig && bbSig.raw ? bbSig.raw.zScore : 0;

    // 1. Extreme Overstretch (RSI extreme + BB outer bands penetration) -> Price climax/exhaustion
    if ((rsi > 74 && bbZ > 1.8) || (rsi < 26 && bbZ < -1.8)) {
      isExhausted = true;
      exhaustionReason = `Klimaks Trend (RSI ${rsi.toFixed(1)}, BB Z-Score ${bbZ.toFixed(2)}). Menahan lagging momentum, melipatgandakan bobot pembalikan (MR).`;
      mrBoost = 2.4;
      momDampen = 0.3;
    }
    // 2. Clear Active Divergence at overextended areas
    else if ((rsi > 64 && rsiSig.raw.rsiTrend < -1.5 && rsiSig.raw.priceTrend > 0) ||
             (rsi < 36 && rsiSig.raw.rsiTrend > 1.5 && rsiSig.raw.priceTrend < 0)) {
      isExhausted = true;
      exhaustionReason = `Divergensi RSI aktif (${rsi.toFixed(1)} vs previous ${rsiSig.raw.rsiPrev.toFixed(1)}). Menguatkan sinyal pembalikan (MR).`;
      mrBoost = 1.9;
      momDampen = 0.45;
    }
    // 3. Clear Candlestick Reversal Pattern at overstretched boundaries
    else if (candleSig && candleSig.raw && ['shooting_star', 'hammer', 'bearish_engulfing', 'bullish_engulfing'].includes(candleSig.raw.pattern)) {
      const pattern = candleSig.raw.pattern;
      if ((rsi > 60 && ['shooting_star', 'bearish_engulfing'].includes(pattern)) ||
          (rsi < 40 && ['hammer', 'bullish_engulfing'].includes(pattern))) {
        isExhausted = true;
        exhaustionReason = `Candle pembalikan arah (${pattern}) dikonfirmasi oleh RSI (${rsi.toFixed(1)}). Mengutamakan arah pembalikan.`;
        mrBoost = 1.8;
        momDampen = 0.5;
      }
    }
  }

  const rows: Array<{ key: string; label: string; score: number; weight: number }> = [];
  const regimeAdjustedWeights: Record<string, string> = {};

  for (const def of SIGNAL_DEFS) {
    const sig = signals[def.key];
    if (!sig) continue;
    if (def.optional && sig.available === false) continue;

    // Apply regime-based weight multiplier and custom exhaustion adjusters
    let mult = 1.0;
    if (def.affinity === 'momentum') mult = regime.momentum_mult * momDampen;
    else if (def.affinity === 'mr')  mult = regime.mr_mult * mrBoost;
    else if (def.affinity === 'breakout') mult = regime.breakout_mult;

    const effectiveWeight = def.weight * mult;
    regimeAdjustedWeights[def.key] = effectiveWeight.toFixed(2);

    weightedSum  += sig.score * effectiveWeight;
    totalWeight  += effectiveWeight;

    // Cluster scores
    if (def.affinity === 'momentum') { momentumSum += sig.score * def.weight; momentumW += def.weight; }
    if (def.affinity === 'mr')       { mrSum       += sig.score * def.weight; mrW       += def.weight; }

    rows.push({ key: def.key, label: sig.label, score: sig.score, weight: effectiveWeight });
  }

  const netScore = totalWeight > 0 ? weightedSum / totalWeight : 0;
  const netSign  = Math.sign(netScore);

  // ── Signal agreement (quality filter) ──────────────────────────────────
  let agreeWeight = 0, activeWeight = 0;
  for (const r of rows) {
    if (Math.abs(r.score) < 5) continue; // near-zero = "no opinion", excluded
    activeWeight += r.weight;
    if (Math.sign(r.score) === netSign) agreeWeight += r.weight;
  }
  const agreementRatio = activeWeight > 0 ? agreeWeight / activeWeight : 0;

  const signalDetails = rows.map(r => ({
    key:    r.key,
    label:  r.label,
    score:  r.score,
    weight: r.weight.toFixed(1),
    contribution: (totalWeight > 0 ? (r.score * r.weight) / totalWeight : 0).toFixed(2),
  }));

  // ── Confidence derivation ───────────────────────────────────────────────
  const absScore     = Math.abs(netScore);
  let confidence     = Math.min(0.5 + absScore / 200, 0.92);

  // Penalize for regime noise
  confidence        *= regime.confidence;

  // Bonus/Penalty based on clusters
  const momDir = momentumW > 0 ? Math.sign(momentumSum / momentumW) : 0;
  const mrDir  = mrW > 0      ? Math.sign(mrSum / mrW)              : 0;
  if (momDir !== 0 && mrDir !== 0 && momDir === mrDir) {
    confidence = Math.min(confidence * cfg.CLUSTER_AGREEMENT_BONUS, 0.95);
  }

  if (momDir !== 0 && mrDir !== 0 && momDir !== mrDir) {
    confidence *= cfg.CLUSTER_DISAGREEMENT_PENALTY;
  }

  // Hard discount when internal agreement is weak
  if (agreementRatio < cfg.SIGNAL_AGREEMENT_MIN) {
    confidence *= Math.max(0.3, agreementRatio / cfg.SIGNAL_AGREEMENT_MIN);
  }

  // ── Direction decision ──────────────────────────────────────────────────
  const MIN_SCORE      = cfg.MIN_SCORE;
  const MIN_CONFIDENCE = cfg.MIN_CONFIDENCE;

  let direction: 'UP' | 'DOWN' | 'SKIP' = 'SKIP';
  if (cfg.label === 'aggressive') {
    // Aggressive mode is design to always provide an direction (maximum trades)
    direction = netScore >= 0 ? 'UP' : 'DOWN';
  } else if (regime.regime === REGIMES.NOISE) {
    direction = 'SKIP'; // Hard skip in noise regime
  } else if (netScore > MIN_SCORE && confidence >= MIN_CONFIDENCE) {
    direction = 'UP';
  } else if (netScore < -MIN_SCORE && confidence >= MIN_CONFIDENCE) {
    direction = 'DOWN';
  }

  // ── Hysteresis (anti-whipsaw across epochs) ────────────────────────────
  if (cfg.label !== 'aggressive' && direction !== 'SKIP' && prevDirection && prevDirection !== direction) {
    const flipThreshold = MIN_SCORE * cfg.HYSTERESIS_FLIP_MULT;
    if (Math.abs(netScore) < flipThreshold) {
      direction = 'SKIP'; // not enough conviction to reverse
    }
  }

  return {
    netScore:              parseFloat(netScore.toFixed(3)),
    confidence:            parseFloat(confidence.toFixed(4)),
    confidencePct:         parseFloat((confidence * 100).toFixed(1)),
    direction,
    momentumScore:         momentumW > 0 ? parseFloat((momentumSum / momentumW).toFixed(2)) : 0,
    mrScore:               mrW > 0      ? parseFloat((mrSum       / mrW).toFixed(2))       : 0,
    agreementRatio:        parseFloat(agreementRatio.toFixed(3)),
    signalDetails,
    regimeAdjustedWeights,
    clusterAgreement:      momDir === mrDir && momDir !== 0,
    isExhausted,
    exhaustionReason,
  };
}
