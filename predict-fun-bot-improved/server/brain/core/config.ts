export interface GuardCfg {
  minConfidence: number;
  blockHighImpactWindow: boolean;
  volSpikeMultiplier: number;
  losingStreakLimit: number;
  minCandleAgeSeconds: number;
}

export interface ModeConfig {
  label: string;
  MIN_SCORE: number;
  MIN_CONFIDENCE: number;
  SIGNAL_AGREEMENT_MIN: number;
  CLUSTER_AGREEMENT_BONUS: number;
  CLUSTER_DISAGREEMENT_PENALTY: number;
  HYSTERESIS_FLIP_MULT: number;
  SETTLE_WINDOW_MS: number;
  guard: GuardCfg;
}

export const MODES: Record<string, ModeConfig> = {
  conservative: {
    label: 'conservative',
    MIN_SCORE: 14,
    MIN_CONFIDENCE: 0.50,
    SIGNAL_AGREEMENT_MIN: 0.58,
    CLUSTER_AGREEMENT_BONUS: 1.12,
    CLUSTER_DISAGREEMENT_PENALTY: 0.78,
    HYSTERESIS_FLIP_MULT: 1.6,
    SETTLE_WINDOW_MS: 15000,
    guard: {
      minConfidence: 0.50,
      blockHighImpactWindow: true,
      volSpikeMultiplier: 3.0,
      losingStreakLimit: 3,
      minCandleAgeSeconds: 30,
    },
  },
  aggressive: {
    label: 'aggressive',
    MIN_SCORE: 0.1,
    MIN_CONFIDENCE: 0.10,
    SIGNAL_AGREEMENT_MIN: 0.10,
    CLUSTER_AGREEMENT_BONUS: 1.25,
    CLUSTER_DISAGREEMENT_PENALTY: 0.90,
    HYSTERESIS_FLIP_MULT: 1.0,
    SETTLE_WINDOW_MS: 3000,
    guard: {
      minConfidence: 0.10,
      blockHighImpactWindow: false,
      volSpikeMultiplier: 99.0,
      losingStreakLimit: 99,
      minCandleAgeSeconds: 0,
    },
  },
};

export function getMode(name = 'aggressive'): ModeConfig {
  return MODES[name] || MODES.aggressive;
}
