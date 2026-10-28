import { GuardCfg } from "../core/config";

const DEFAULT_GUARD_CFG: GuardCfg = {
  minConfidence: 0.50,
  blockHighImpactWindow: true,
  volSpikeMultiplier: 3.0,
  losingStreakLimit: 4,
  minCandleAgeSeconds: 30,
};

/**
 * Check if current time is within N minutes of a known high-impact event.
 * Known volatility UTC windows:
 *   08:00–08:30  London open
 *   13:30–14:30  US pre-market / economic data
 *   21:00–21:30  Asia close
 */
export function isHighImpactWindow(): boolean {
  const now    = new Date();
  const hUtc   = now.getUTCHours();
  const mUtc   = now.getUTCMinutes();
  const _totMin = hUtc * 60 + mUtc;

  const windows = [
    [7 * 60 + 50, 8 * 60 + 35],  // London open
    [13 * 60 + 20, 14 * 60 + 40], // US open / data releases
    [20 * 60 + 50, 21 * 60 + 35], // Asia close
  ];

  return windows.some(([start, end]) => _totMin >= start && _totMin <= end);
}

/**
 * Check if current candle is "too young" to trust
 */
export function isCandleTooNew(candleOpenTimeMs: number, minAgeSeconds = 30): boolean {
  const ageSeconds = (Date.now() - candleOpenTimeMs) / 1000;
  return ageSeconds < minAgeSeconds;
}

/**
 * Detect abnormal volatility spike (circuit breaker)
 * If last candle's range > multiplier × average range → skip
 */
export function isVolatilitySpike(closes: number[], multiplier = 3.0): boolean {
  const n = closes.length;
  if (n < 15) return false;

  const ranges: number[] = [];
  for (let i = 1; i < n; i++) {
    ranges.push(Math.abs(closes[i] - closes[i - 1]));
  }

  const avgRange = ranges.slice(-14, -1).reduce((a, b) => a + b, 0) / 13;
  const lastRange = ranges[ranges.length - 1];

  return lastRange > avgRange * multiplier;
}

/**
 * Detect consecutive losses streak (drawdown protection)
 */
export function isOnLosingStreak(history: Array<{ predicted: string, actual: string }>, streak = 4): boolean {
  if (history.length < streak) return false;
  const recent = history.slice(-streak);
  return recent.every(h => h.predicted !== h.actual);
}

export interface GuardParams {
  closes?: number[];
  candleOpenTimeMs?: number | null;
  tradeHistory?: Array<{ predicted: string, actual: string }>;
  confidence?: number;
  direction?: 'UP' | 'DOWN' | 'SKIP';
  cfg?: GuardCfg | null;
}

export interface GuardResult {
  allow: boolean;
  reasons: string[];
}

/**
 * Master guard function
 */
export function runGuard({
  closes,
  candleOpenTimeMs = null,
  tradeHistory     = [],
  confidence       = 1,
  direction        = 'SKIP',
  cfg              = null,
}: GuardParams = {}): GuardResult {
  const g = { ...DEFAULT_GUARD_CFG, ...(cfg || {}) };
  const reasons: string[] = [];

  if (direction === 'SKIP') {
    reasons.push('Net score below minimum threshold');
    return { allow: false, reasons };
  }

  if (confidence < g.minConfidence) {
    reasons.push(`Confidence too low: ${(confidence * 100).toFixed(1)}% < ${(g.minConfidence * 100).toFixed(0)}%`);
  }

  if (closes && isVolatilitySpike(closes, g.volSpikeMultiplier)) {
    reasons.push('Volatility spike detected — abnormal candle range');
  }

  if (g.blockHighImpactWindow && isHighImpactWindow()) {
    reasons.push('High-impact market window (London/US open, Asia close)');
  }

  if (candleOpenTimeMs && isCandleTooNew(candleOpenTimeMs, g.minCandleAgeSeconds)) {
    reasons.push('Current candle too new — wait for more data');
  }

  if (isOnLosingStreak(tradeHistory, g.losingStreakLimit)) {
    reasons.push(`${g.losingStreakLimit} consecutive losses — pausing for regime reassessment`);
  }

  return {
    allow:   reasons.length === 0,
    reasons,
  };
}
