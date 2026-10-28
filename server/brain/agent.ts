/**
 * ╔══════════════════════════════════════════════════════════════════════════════════╗
 * ║       SOVEREIGN APEX AGENT v2.0 — ADAPTIVE SELF-LEARNING MULTI-AGENT SYSTEM    ║
 * ║       Built on top of Sovereign Apex Mind v5.5.0                               ║
 * ║                                                                                  ║
 * ║  UPGRADE v2.0:                                                                   ║
 * ║  ✅ [NEW] Bayesian Pattern Learning (Beta distribution posterior)                ║
 * ║  ✅ [NEW] Temporal Decay — pattern knowledge expiry (30-day half-life)           ║
 * ║  ✅ [NEW] Judge Self-Calibration (Expected Calibration Error tracking)           ║
 * ║  ✅ [NEW] Regime-Isolated Memory (tidak campur pattern antar regime)             ║
 * ║  ✅ [NEW] Multi-Armed Bandit Strategy Selection (UCB1 algorithm)                 ║
 * ║  ✅ [NEW] Cross-Trade Pattern Mining via Reflector (setiap 10 trades)            ║
 * ║  ✅ [NEW] Vector Similarity Memory (kNN trade matching)                          ║
 * ║  ✅ [NEW] Adaptive Threshold Tuning per Regime                                   ║
 * ║  ✅ [NEW] Confidence Calibration Correction                                      ║
 * ║                                                                                  ║
 * ║  ARSITEKTUR AGENT:                                                               ║
 * ║  ┌──────────────────────────────────────────────────────────────────────────┐   ║
 * ║  │  [LAYER 0] Math Engine (brain.ts v5.5.0) → raw signal + vote score      │   ║
 * ║  │  [LAYER 1] News Sentinel → fetch & score BTC sentiment sebelum trade    │   ║
 * ║  │  [LAYER 2] Bull Advocate Agent → argumen terkuat untuk UP               │   ║
 * ║  │  [LAYER 3] Bear Advocate Agent → argumen terkuat untuk DOWN             │   ║
 * ║  │  [LAYER 4] Judge Agent → baca debat + math + news → final verdict      │   ║
 * ║  │  [LAYER 5] Reflector Agent → evaluasi WIN/LOSS + cross-trade mining     │   ║
 * ║  │  [LAYER 6] Memory Manager → Bayesian stats, vector similarity, decay    │   ║
 * ║  │  [LAYER 7] Strategy Bandit → UCB1 preset selection per regime           │   ║
 * ║  │  [LAYER 8] Calibrator → adjust Judge confidence via ECE tracking        │   ║
 * ║  └──────────────────────────────────────────────────────────────────────────┘   ║
 * ╚══════════════════════════════════════════════════════════════════════════════════╝
 */

import OpenAI from 'openai';
import * as fs from 'fs';
import * as https from 'https';

import {
  SovereignApexMind,
  CandleData,
  BrainOrderInstruction,
  BrainMeta,
  MarketRegime,
  TradingSession,
  AGGRESSIVE_PRESET,
  HYPER_PRESET,
  NORMAL_PRESET,
  AggressiveConfig,
} from './genius';

// ─────────────────────────────────────────────────────────────────────────────
// TIPE DATA INTI
// ─────────────────────────────────────────────────────────────────────────────

export type AgentRole = 'BULL_ADVOCATE' | 'BEAR_ADVOCATE' | 'JUDGE' | 'REFLECTOR';

export interface AgentArgument {
  role: AgentRole;
  direction: 'UP' | 'DOWN' | 'HOLD';
  confidence: number;
  arguments: string[];
  weakness: string[];
  rawReasoning: string;
}

export interface DebateResult {
  bullArg: AgentArgument;
  bearArg: AgentArgument;
  judgeVerdict: JudgeVerdict;
  debateDuration: number;
}

export interface JudgeVerdict {
  direction: 'UP' | 'DOWN' | 'HOLD';
  confidence: number;
  winningAgent: 'BULL' | 'BEAR' | 'NEUTRAL';
  winMargin: number;
  reasoning: string;
  adjustedThreshold?: number;
  shouldTrade: boolean;
  rawConfidence?: number; // confidence sebelum calibration
}

export interface NewsSentiment {
  score: number;
  summary: string;
  headlines: string[];
  fetchedAt: number;
  cached: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// [NEW v2.0] BAYESIAN PATTERN STATS
// ─────────────────────────────────────────────────────────────────────────────

export interface PatternBayes {
  wins: number;
  losses: number;
  pending: number;
  // Bayesian: posterior mean dari Beta(α, β) dengan α=wins+1, β=losses+1
  bayesianWR: number;
  // Recent outcomes sebagai sliding window (1=WIN, 0=LOSS), max 20 entries
  recentOutcomes: number[];
  // EMA win-rate dengan α=0.2 (lebih responsif ke perubahan tren)
  emaWR: number;
  // Timestamp trade terakhir untuk temporal decay
  lastUpdated: number;
  // Regime di mana pattern ini paling sering terjadi
  dominantRegime: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// [NEW v2.0] JUDGE CALIBRATION — Expected Calibration Error tracking
// ─────────────────────────────────────────────────────────────────────────────

export interface CalibrationBucket {
  // Bucket "0.6" = prediksi confidence 0.60–0.69
  totalPredicted: number;   // jumlah trade di bucket ini
  totalWins: number;        // actual wins
  avgPredictedConf: number; // rata-rata confidence yang diprediksi Judge
}

export interface JudgeCalibration {
  // Kunci: "0.5", "0.6", "0.7", "0.8", "0.9"
  buckets: Record<string, CalibrationBucket>;
  ece: number;              // Expected Calibration Error (0 = perfect, <0.1 = good)
  correctionFactor: number; // multiplier untuk confidence Judge (awalnya 1.0)
  totalCalibrated: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// [NEW v2.0] MULTI-ARMED BANDIT — UCB1 untuk preset selection
// ─────────────────────────────────────────────────────────────────────────────

export interface BanditArm {
  name: string;             // "AGGRESSIVE" | "NORMAL" | "HYPER"
  totalReward: number;      // sum of rewards (WIN=1, LOSS=0)
  pulls: number;            // jumlah kali dipilih
  ucbScore: number;         // Upper Confidence Bound score
  lastUsed: number;         // timestamp
}

export interface StrategyBandit {
  arms: Record<string, BanditArm>;
  totalPulls: number;
  // Per-regime bandit (regime punya distribusi reward berbeda)
  regimeArms: Record<string, Record<string, BanditArm>>;
}

// ─────────────────────────────────────────────────────────────────────────────
// [NEW v2.0] TRADE VECTOR EMBEDDING untuk similarity search
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeVector {
  id: string;
  // 12-dimensional vector: [rsi, zscore, ofi, adx, hurst, bbSqueeze,
  //   trendDecay, divergenceStr, voteScore, newsScore, patternBoost, atrPct]
  vector: number[];
  direction: 'UP' | 'DOWN';
  outcome: 'WIN' | 'LOSS' | 'PENDING';
  regime: string;
  session: string;
  timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADE MEMORY (diperluas dari v1.0)
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeMemory {
  id: string;
  timestamp: number;
  direction: 'UP' | 'DOWN';
  outcome?: 'WIN' | 'LOSS';
  session: TradingSession;
  regime: MarketRegime;
  mathSignal: { direction: 'UP' | 'DOWN' | 'HOLD'; confidence: number; voteScore: number };
  debateWinner: 'BULL' | 'BEAR' | 'NEUTRAL';
  newsScore: number;
  confidence: number;
  rawJudgeConfidence?: number;    // [NEW] untuk calibration
  reflectionNote?: string;
  patternTags: string[];
  // [NEW v2.0]
  similarTradeIds?: string[];     // kNN match IDs
  knnVote?: { wins: number; losses: number; k: number }; // voting dari similar trades
  presetUsed?: string;            // "AGGRESSIVE" | "NORMAL" | "HYPER"
  winMargin?: number;             // judge win margin
}

export interface PatternStats {
  tag: string;
  wins: number;
  losses: number;
  pending: number;
  winRate: number;
  bayesianWR: number;   // [NEW]
  emaWR: number;        // [NEW]
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT MEMORY STORE v2.0
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentMemoryStore {
  version: string;
  lastUpdated: number;
  totalTrades: number;
  wins: number;
  losses: number;
  trades: TradeMemory[];
  // [UPGRADED] Bayesian pattern stats, isolated per regime
  patternStats: Record<string, PatternBayes>;
  regimePatternStats: Record<string, Record<string, PatternBayes>>;  // [NEW]
  sessionStats: Record<string, { wins: number; losses: number }>;
  regimeStats: Record<string, { wins: number; losses: number }>;
  // [NEW v2.0]
  judgeCalibration: JudgeCalibration;
  strategyBandit: StrategyBandit;
  tradeVectors: TradeVector[];          // untuk kNN similarity search
  recentReflections: string[];
  adaptiveNotes: string[];
  // [NEW] Adaptive threshold per regime
  regimeThresholds: Record<string, number>;
  // [NEW] Cross-trade mining insights
  miningInsights: string[];
  lastMiningAt: number;                 // timestamp terakhir cross-trade mining
}

export interface AgentTradeDecision {
  shouldTrade: boolean;
  direction: 'UP' | 'DOWN' | 'HOLD';
  confidence: number;
  tradeAmount: number;
  reason: string;
  mathResult: BrainOrderInstruction;
  debate: DebateResult | null;
  newsSentiment: NewsSentiment | null;
  memoryInsight: string;
  patternBoost: number;
  // [NEW v2.0]
  knnInsight: string;
  calibrationNote: string;
  selectedPreset: string;
  auditTrail: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG AGENT
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  cerebrasApiKey: string;
  cerebrasModel: string;
  cerebrasEndpoint: string;
  memoryFilePath: string;
  newsApiKey?: string;
  newsCacheDurationMs: number;
  enableDebate: boolean;
  enableNewsSentiment: boolean;
  enableReflection: boolean;
  enableMemoryBoost: boolean;
  // [NEW v2.0]
  enableKNN: boolean;                   // kNN similarity search
  enableCalibration: boolean;           // Judge confidence calibration
  enableBandit: boolean;                // UCB1 strategy selection
  enableCrossTradeMinig: boolean;       // Reflector cross-trade mining
  knnK: number;                         // jumlah similar trades untuk vote (default 7)
  knnMinSimilarity: number;             // minimum cosine similarity (default 0.80)
  crossMiningInterval: number;          // mining tiap N trades (default 10)
  patternDecayHalfLifeDays: number;     // half-life temporal decay (default 30)
  bayesianPriorStrength: number;        // pseudo-count untuk Bayes prior (default 1)
  debateTimeoutMs: number;
  minDebateConfidence: number;
  maxMemoryTrades: number;
  maxVectorEntries: number;             // [NEW] max trade vectors disimpan
  brainConfig: AggressiveConfig;
  debugMode: boolean;
}

export const DEFAULT_AGENT_CONFIG: AgentConfig = {
  cerebrasApiKey:       process.env.CEREBRAS_API_KEY     || '',
  cerebrasModel:        process.env.CEREBRAS_MODEL        || 'gpt-oss-120b',
  cerebrasEndpoint:     process.env.CEREBRAS_API_ENDPOINT || 'https://api.cerebras.ai/v1',
  memoryFilePath:       process.env.MEMORY_FILE_PATH      || './sovereign_memory_v2.json',
  newsApiKey:           process.env.CRYPTOPANIC_KEY       || '',
  newsCacheDurationMs:  5 * 60 * 1000,
  enableDebate:         true,
  enableNewsSentiment:  true,
  enableReflection:     true,
  enableMemoryBoost:    true,
  enableKNN:            true,
  enableCalibration:    true,
  enableBandit:         true,
  enableCrossTradeMinig: true,
  knnK:                 7,
  knnMinSimilarity:     0.70,
  crossMiningInterval:  10,
  patternDecayHalfLifeDays: 30,
  bayesianPriorStrength: 1,
  debateTimeoutMs:      25000,
  minDebateConfidence:  0.52,
  maxMemoryTrades:      500,
  maxVectorEntries:     300,
  brainConfig:          AGGRESSIVE_PRESET,
  debugMode:            true,
};

// ─────────────────────────────────────────────────────────────────────────────
// SOVEREIGN APEX AGENT v2.0
// ─────────────────────────────────────────────────────────────────────────────

export class SovereignApexAgent {

  private cerebras: OpenAI;
  private mistral: OpenAI | null = null; // Integrated
  private brain: SovereignApexMind;
  private cfg: AgentConfig;
  private memory: AgentMemoryStore;
  private newsCache: NewsSentiment | null = null;
  private currentPreset: string = 'AGGRESSIVE';

  constructor(config: Partial<AgentConfig> = {}) {
    this.cfg = { ...DEFAULT_AGENT_CONFIG, ...config };

    this.cerebras = new OpenAI({
      apiKey:     this.cfg.cerebrasApiKey,
      baseURL:    this.cfg.cerebrasEndpoint,
      maxRetries: 3,
    });

    const mistralKey = process.env.MISTRAL_API_KEY || "oMa7CqyOXWX9O3MzFSOsCCyw4B7pEh00";
    if (mistralKey) {
      this.mistral = new OpenAI({
        apiKey: mistralKey,
        baseURL: process.env.MISTRAL_API_ENDPOINT || "https://api.mistral.ai/v1",
        maxRetries: 3,
      });
    }

    this.brain = new SovereignApexMind({}, this.cfg.brainConfig);
    this.memory = this.loadMemory();

    this.log('╔══════════════════════════════════════════════════════════════════════╗');
    this.log('║  SOVEREIGN APEX AGENT v2.0 — ADAPTIVE SELF-LEARNING SYSTEM          ║');
    this.log('╚══════════════════════════════════════════════════════════════════════╝');
    this.log(`🧠 Brain: v5.5.0 | Model: ${this.cfg.cerebrasModel}`);
    if (this.mistral) {
      this.log(`🌀 Mistral: codestral-2501 Enabled as primary LLM!`);
    }
    this.log(`💾 Memory: ${this.memory.totalTrades} trades | WR: ${this.getWinRate()}%`);
    this.log(`📐 ECE: ${this.memory.judgeCalibration.ece.toFixed(3)} | CalFactor: ${this.memory.judgeCalibration.correctionFactor.toFixed(3)}`);
    this.log(`🎰 Bandit pulls: ${this.memory.strategyBandit.totalPulls}`);
    this.log(`🔧 KNN=${this.cfg.enableKNN} | Calibrate=${this.cfg.enableCalibration} | Bandit=${this.cfg.enableBandit}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UNIFIED LLM QUERY HANDLER (Primary: Mistral codestral-2501, Secondary: Cerebras)
  // ─────────────────────────────────────────────────────────────────────────

  private async queryLLM(prompt: string, maxTokens: number, temperature: number, roleName: string): Promise<string> {
    const mistralModel = process.env.MISTRAL_MODEL || 'codestral-2501';
    if (this.mistral) {
      try {
        const resp = await this.mistral.chat.completions.create({
          model: mistralModel,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: maxTokens,
          temperature: temperature,
        });
        const text = resp.choices[0].message.content?.trim() || '{}';
        this.log(`🌀 [Mistral Success for ${roleName}]!`);
        return text;
      } catch (err: any) {
        this.log(`⚠️ [Mistral Fail for ${roleName}]: ${err.message || err} — trying Cerebras fallback...`);
      }
    }

    const resp = await this.cerebras.chat.completions.create({
      model: this.cfg.cerebrasModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: maxTokens,
      temperature: temperature,
    });
    this.log(`🧠 [Cerebras Success for ${roleName}]!`);
    return resp.choices[0].message.content?.trim() || '{}';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MEMORY MANAGER
  // ─────────────────────────────────────────────────────────────────────────

  private loadMemory(): AgentMemoryStore {
    try {
      if (fs.existsSync(this.cfg.memoryFilePath)) {
        const raw = fs.readFileSync(this.cfg.memoryFilePath, 'utf-8');
        const parsed = JSON.parse(raw) as AgentMemoryStore;
        // Migrate v1 memory jika perlu
        return this.migrateMemory(parsed);
      }
    } catch (err) {
      this.log(`⚠️ Memory load error, fresh start: ${err}`);
    }
    return this.freshMemory();
  }

  private migrateMemory(old: any): AgentMemoryStore {
    // Upgrade v1.0 → v2.0: inject missing fields dengan defaults
    const migrated: AgentMemoryStore = {
      ...this.freshMemory(),
      ...old,
      version: '2.0',
    };

    // Upgrade patternStats ke Bayesian format jika masih lama
    if (old.patternStats) {
      for (const [tag, stats] of Object.entries(old.patternStats as any)) {
        const s = stats as any;
        if (!s.bayesianWR) {
          const w = s.wins || 0;
          const l = s.losses || 0;
          migrated.patternStats[tag] = {
            wins: w, losses: l, pending: s.pending || 0,
            bayesianWR: (w + this.cfg.bayesianPriorStrength) / (w + l + 2 * this.cfg.bayesianPriorStrength),
            recentOutcomes: [],
            emaWR: w / Math.max(1, w + l),
            lastUpdated: Date.now(),
            dominantRegime: 'UNKNOWN',
          };
        }
      }
    }

    this.log(`💾 Memory migrated/loaded: ${migrated.trades.length} trades`);
    return migrated;
  }

  private freshMemory(): AgentMemoryStore {
    return {
      version: '2.0',
      lastUpdated: Date.now(),
      totalTrades: 0, wins: 0, losses: 0,
      trades: [],
      patternStats: {},
      regimePatternStats: {},
      sessionStats: {},
      regimeStats: {},
      judgeCalibration: {
        buckets: {},
        ece: 0,
        correctionFactor: 1.0,
        totalCalibrated: 0,
      },
      strategyBandit: {
        arms: {
          AGGRESSIVE: { name: 'AGGRESSIVE', totalReward: 0, pulls: 0, ucbScore: Infinity, lastUsed: 0 },
          NORMAL:     { name: 'NORMAL',     totalReward: 0, pulls: 0, ucbScore: Infinity, lastUsed: 0 },
          HYPER:      { name: 'HYPER',      totalReward: 0, pulls: 0, ucbScore: Infinity, lastUsed: 0 },
        },
        totalPulls: 0,
        regimeArms: {},
      },
      tradeVectors: [],
      recentReflections: [],
      adaptiveNotes: [],
      regimeThresholds: {},
      miningInsights: [],
      lastMiningAt: 0,
    };
  }

  private saveMemory(): void {
    try {
      this.memory.lastUpdated = Date.now();
      if (this.memory.trades.length > this.cfg.maxMemoryTrades) {
        this.memory.trades = this.memory.trades.slice(-this.cfg.maxMemoryTrades);
      }
      if (this.memory.tradeVectors.length > this.cfg.maxVectorEntries) {
        this.memory.tradeVectors = this.memory.tradeVectors.slice(-this.cfg.maxVectorEntries);
      }
      fs.writeFileSync(this.cfg.memoryFilePath, JSON.stringify(this.memory, null, 2), 'utf-8');
    } catch (err) {
      this.log(`⚠️ Memory save error: ${err}`);
    }
  }

  private getWinRate(): string {
    const total = this.memory.wins + this.memory.losses;
    return total > 0 ? ((this.memory.wins / total) * 100).toFixed(1) : '0.0';
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [NEW v2.0] BAYESIAN PATTERN STATS
  // ─────────────────────────────────────────────────────────────────────────

  private updatePatternBayes(tag: string, outcome: 'WIN' | 'LOSS', regime: string): void {
    // Global stats
    if (!this.memory.patternStats[tag]) {
      this.memory.patternStats[tag] = {
        wins: 0, losses: 0, pending: 0,
        bayesianWR: 0.5,
        recentOutcomes: [],
        emaWR: 0.5,
        lastUpdated: Date.now(),
        dominantRegime: regime,
      };
    }

    const s = this.memory.patternStats[tag];
    const isWin = outcome === 'WIN' ? 1 : 0;

    if (outcome === 'WIN') s.wins++; else s.losses++;

    // Update sliding window (max 20)
    s.recentOutcomes.push(isWin);
    if (s.recentOutcomes.length > 20) s.recentOutcomes.shift();

    // Bayesian posterior: Beta(α, β) mean = α/(α+β)
    const α = s.wins + this.cfg.bayesianPriorStrength;
    const β = s.losses + this.cfg.bayesianPriorStrength;
    s.bayesianWR = α / (α + β);

    // EMA win-rate dengan α=0.15 (memberi bobot lebih pada recent)
    s.emaWR = s.emaWR * 0.85 + isWin * 0.15;
    s.lastUpdated = Date.now();

    // Regime-specific stats
    if (!this.memory.regimePatternStats[regime]) {
      this.memory.regimePatternStats[regime] = {};
    }
    if (!this.memory.regimePatternStats[regime][tag]) {
      this.memory.regimePatternStats[regime][tag] = { ...s };
    }
    const rs = this.memory.regimePatternStats[regime][tag];
    if (outcome === 'WIN') rs.wins++; else rs.losses++;
    const rα = rs.wins + this.cfg.bayesianPriorStrength;
    const rβ = rs.losses + this.cfg.bayesianPriorStrength;
    rs.bayesianWR = rα / (rα + rβ);
    rs.lastUpdated = Date.now();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [NEW v2.0] TEMPORAL DECAY — boost/penalty meluruh seiring waktu
  // ─────────────────────────────────────────────────────────────────────────

  private getDecayedPatternBoost(tag: string, regime: string): number {
    // Prioritas: regime-specific stats > global stats
    const regimeStats = this.memory.regimePatternStats[regime]?.[tag];
    const globalStats = this.memory.patternStats[tag];
    const stats = regimeStats || globalStats;
    if (!stats) return 0;

    const total = stats.wins + stats.losses;
    if (total < 3) return 0;

    // Temporal decay: half-life = cfg.patternDecayHalfLifeDays
    const ageDays = (Date.now() - stats.lastUpdated) / 86400000;
    const decayFactor = Math.exp(-ageDays * Math.LN2 / this.cfg.patternDecayHalfLifeDays);

    // Gunakan weighted combo: 60% Bayesian WR + 40% EMA WR
    const effectiveWR = 0.6 * stats.bayesianWR + 0.4 * stats.emaWR;
    const rawBoost = (effectiveWR - 0.5) * 0.4;

    // Scale berdasarkan confidence (lebih banyak data = lebih confident)
    const confidenceScale = Math.min(1.0, total / 20);

    return rawBoost * decayFactor * confidenceScale;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PATTERN MEMORY — extract tags & recall (upgraded v2.0)
  // ─────────────────────────────────────────────────────────────────────────

  private extractPatternTags(meta: BrainMeta, direction: 'UP' | 'DOWN'): string[] {
    const tags: string[] = [];
    tags.push(`regime_${meta.regime.toLowerCase()}`);
    tags.push(`session_${meta.session.toLowerCase()}`);
    if (meta.trendDecay?.isBullExhausted) tags.push('bull_exhaustion');
    if (meta.trendDecay?.isBearExhausted) tags.push('bear_exhaustion');
    if (meta.momentumDiv?.bearishDiv)      tags.push('bear_divergence');
    if (meta.momentumDiv?.bullishDiv)      tags.push('bull_divergence');
    if (meta.pullbackClass?.classification === 'REVERSAL') tags.push('reversal_signal');
    if (meta.pullbackClass?.classification === 'PULLBACK') tags.push('pullback_signal');
    if (meta.sweepBull)      tags.push('liquidity_sweep_bull');
    if (meta.sweepBear)      tags.push('liquidity_sweep_bear');
    if (meta.doubleBottom)   tags.push('double_bottom');
    if (meta.doubleTop)      tags.push('double_top');
    if (meta.bullEngulf)     tags.push('bull_engulf');
    if (meta.bearEngulf)     tags.push('bear_engulf');
    if (meta.bbSqueeze)      tags.push('bb_squeeze');
    if (meta.isUltraCompression) tags.push('ultra_compression');
    if (meta.rsi > 70)       tags.push('rsi_overbought');
    if (meta.rsi < 30)       tags.push('rsi_oversold');
    if (Math.abs(meta.zScore) > 2) tags.push('zscore_extreme');
    tags.push(`dir_${direction.toLowerCase()}`);
    return tags;
  }

  private recallMemoryInsight(
    tags: string[],
    direction: 'UP' | 'DOWN',
    session: TradingSession,
    regime: MarketRegime,
  ): { insight: string; patternBoost: number } {
    if (!this.cfg.enableMemoryBoost || this.memory.trades.length < 5) {
      return { insight: 'Memory belum cukup (< 5 trades)', patternBoost: 0 };
    }

    const insights: string[] = [];
    let totalBoost = 0;
    let boostCount = 0;

    for (const tag of tags) {
      const boost = this.getDecayedPatternBoost(tag, regime);
      const stats = this.memory.patternStats[tag];
      if (!stats) continue;

      const total = stats.wins + stats.losses;
      if (total < 3) continue;

      const bwr = (stats.bayesianWR * 100).toFixed(0);
      const ageDays = ((Date.now() - stats.lastUpdated) / 86400000).toFixed(0);

      if (Math.abs(boost) > 0.02) {
        const icon = boost > 0 ? '✅' : '❌';
        insights.push(`${icon} "${tag}" BWR=${bwr}% n=${total} age=${ageDays}d boost=${boost > 0 ? '+' : ''}${boost.toFixed(3)}`);
        totalBoost += boost;
        boostCount++;
      }
    }

    // Session stats
    const sessKey = `${session}_${direction}`;
    const sessStats = this.memory.sessionStats[sessKey];
    if (sessStats) {
      const sessTotal = (sessStats.wins || 0) + (sessStats.losses || 0);
      if (sessTotal >= 5) {
        const sessWR = (sessStats.wins || 0) / sessTotal;
        insights.push(`📅 ${session} ${direction}: WR=${(sessWR * 100).toFixed(0)}% (n=${sessTotal})`);
        totalBoost += (sessWR - 0.5) * 0.25;
        boostCount++;
      }
    }

    if (this.memory.recentReflections.length > 0) {
      insights.push(`🪞 ${this.memory.recentReflections[this.memory.recentReflections.length - 1]}`);
    }
    if (this.memory.miningInsights.length > 0) {
      insights.push(`⛏️ Mining: ${this.memory.miningInsights[this.memory.miningInsights.length - 1]}`);
    }

    const patternBoost = boostCount > 0
      ? Math.max(-0.20, Math.min(0.20, totalBoost / boostCount))
      : 0;

    return {
      insight: insights.length > 0 ? insights.join(' | ') : 'Tidak ada pattern match signifikan',
      patternBoost,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [NEW v2.0] VECTOR SIMILARITY MEMORY — kNN trade matching
  // ─────────────────────────────────────────────────────────────────────────

  private buildTradeVector(meta: BrainMeta, newsScore: number, patternBoost: number): number[] {
    // 12-dimensional normalized vector
    const normalize = (val: number, min: number, max: number) =>
      Math.max(0, Math.min(1, (val - min) / (max - min)));

    return [
      normalize(meta.rsi, 0, 100),
      normalize(meta.zScore, -4, 4),
      normalize(meta.ofi, -1, 1),
      normalize(meta.adx, 0, 80),
      normalize(meta.hurst, 0, 1),
      meta.bbSqueeze ? 1 : 0,
      meta.trendDecay?.isBullExhausted ? 1 : 0,
      meta.trendDecay?.isBearExhausted ? 1 : 0,
      normalize(meta.momentumDiv?.totalDivStrength ?? 0, 0, 5),
      normalize(meta.finalVoteScore ?? 0, -1, 1),
      normalize(newsScore, -1, 1),
      normalize(patternBoost, -0.2, 0.2),
    ];
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return normA === 0 || normB === 0 ? 0 : dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private knnLookup(
    currentVector: number[],
    direction: 'UP' | 'DOWN',
  ): { insight: string; knnBoost: number; similarIds: string[]; vote: { wins: number; losses: number; k: number } } {
    const totalFinished = this.memory.tradeVectors.filter(tv => tv.outcome !== 'PENDING').length;
    if (!this.cfg.enableKNN || totalFinished < 1) {
      return { insight: 'KNN: belum cukup data', knnBoost: 0, similarIds: [], vote: { wins: 0, losses: 0, k: 0 } };
    }

    // Filter hanya trade dengan outcome (bukan pending) dan direction sama
    const candidates = this.memory.tradeVectors.filter(
      tv => tv.outcome !== 'PENDING' && tv.direction === direction
    );

    if (candidates.length < 1) {
      return { insight: 'KNN: kandidat belum cukup', knnBoost: 0, similarIds: [], vote: { wins: 0, losses: 0, k: 0 } };
    }

    // Hitung similarity ke semua candidates
    const scored = candidates
      .map(tv => ({ tv, sim: this.cosineSimilarity(currentVector, tv.vector) }))
      .filter(x => x.sim >= this.cfg.knnMinSimilarity)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, this.cfg.knnK);

    if (scored.length === 0) {
      return { insight: 'KNN: tidak ada match di atas threshold', knnBoost: 0, similarIds: [], vote: { wins: 0, losses: 0, k: 0 } };
    }

    const wins   = scored.filter(x => x.tv.outcome === 'WIN').length;
    const losses = scored.filter(x => x.tv.outcome === 'LOSS').length;
    const k = scored.length;
    const knnWR  = wins / k;

    // KNN boost: lebih tinggi ketika consensus kuat
    const knnBoost = (knnWR - 0.5) * 0.30 * Math.min(1, k / this.cfg.knnK);

    const avgSim = (scored.reduce((s, x) => s + x.sim, 0) / k * 100).toFixed(0);
    const insight = `KNN(k=${k}, avgSim=${avgSim}%): ${wins}W/${losses}L → WR=${(knnWR * 100).toFixed(0)}% boost=${knnBoost > 0 ? '+' : ''}${knnBoost.toFixed(3)}`;

    return {
      insight,
      knnBoost,
      similarIds: scored.map(x => x.tv.id),
      vote: { wins, losses, k },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [NEW v2.0] JUDGE CALIBRATION — ECE tracking & confidence correction
  // ─────────────────────────────────────────────────────────────────────────

  private applyCalibrationCorrection(rawConfidence: number): { calibrated: number; note: string } {
    if (!this.cfg.enableCalibration || this.memory.judgeCalibration.totalCalibrated < 20) {
      return { calibrated: rawConfidence, note: 'Calibration: belum cukup data' };
    }

    const corrected = Math.max(0.50, Math.min(0.99,
      rawConfidence * this.memory.judgeCalibration.correctionFactor
    ));

    const note = `Calibration: ECE=${this.memory.judgeCalibration.ece.toFixed(3)} factor=${this.memory.judgeCalibration.correctionFactor.toFixed(3)} ${rawConfidence.toFixed(3)}→${corrected.toFixed(3)}`;
    return { calibrated: corrected, note };
  }

  private updateCalibration(predictedConf: number, outcome: 'WIN' | 'LOSS'): void {
    if (!this.cfg.enableCalibration) return;

    const bucketKey = (Math.floor(predictedConf * 10) / 10).toFixed(1);
    if (!this.memory.judgeCalibration.buckets[bucketKey]) {
      this.memory.judgeCalibration.buckets[bucketKey] = {
        totalPredicted: 0, totalWins: 0, avgPredictedConf: predictedConf,
      };
    }

    const bucket = this.memory.judgeCalibration.buckets[bucketKey];
    bucket.totalPredicted++;
    if (outcome === 'WIN') bucket.totalWins++;
    // Update running average
    bucket.avgPredictedConf = (bucket.avgPredictedConf * (bucket.totalPredicted - 1) + predictedConf) / bucket.totalPredicted;

    this.memory.judgeCalibration.totalCalibrated++;

    // Recompute ECE
    this.recomputeCalibration();
  }

  private recomputeCalibration(): void {
    const cal = this.memory.judgeCalibration;
    let ece = 0;
    let totalN = 0;

    for (const bucket of Object.values(cal.buckets)) {
      if (bucket.totalPredicted < 3) continue;
      const actualWR = bucket.totalWins / bucket.totalPredicted;
      const predWR   = bucket.avgPredictedConf;
      ece += Math.abs(actualWR - predWR) * bucket.totalPredicted;
      totalN += bucket.totalPredicted;
    }

    cal.ece = totalN > 0 ? ece / totalN : 0;

    // Hitung correction factor: jika ECE > 0.05 dan ada systematic bias
    if (cal.totalCalibrated >= 30) {
      let totalPred = 0, totalActual = 0, n = 0;
      for (const bucket of Object.values(cal.buckets)) {
        if (bucket.totalPredicted < 3) continue;
        totalPred   += bucket.avgPredictedConf * bucket.totalPredicted;
        totalActual += bucket.totalWins;
        n           += bucket.totalPredicted;
      }
      if (n > 0 && totalPred > 0) {
        const avgPred   = totalPred / n;
        const avgActual = totalActual / n;
        // Jika Judge overconfident (prediksi 0.7 tapi actual 0.6), reduce confidence
        const newFactor = avgActual / avgPred;
        // Smooth update agar tidak drastis
        cal.correctionFactor = cal.correctionFactor * 0.8 + newFactor * 0.2;
        cal.correctionFactor = Math.max(0.7, Math.min(1.3, cal.correctionFactor));
      }
    }

    this.log(`📐 Calibration updated: ECE=${cal.ece.toFixed(3)} factor=${cal.correctionFactor.toFixed(3)}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [NEW v2.0] MULTI-ARMED BANDIT — UCB1 preset selection
  // ─────────────────────────────────────────────────────────────────────────

  private selectPreset(regime: string): string {
    if (!this.cfg.enableBandit) return 'AGGRESSIVE';

    const bandit = this.memory.strategyBandit;
    bandit.totalPulls++;

    // Gunakan regime-specific bandit jika ada cukup data
    let arms = bandit.arms;
    if (bandit.regimeArms[regime]) {
      const regimePulls = Object.values(bandit.regimeArms[regime])
        .reduce((s, a) => s + a.pulls, 0);
      if (regimePulls >= 15) {
        arms = bandit.regimeArms[regime];
      }
    }

    // UCB1: select arm dengan score tertinggi = avgReward + C * sqrt(ln(N)/n)
    const C = Math.SQRT2; // exploration constant
    const N = bandit.totalPulls;

    let bestArm = 'AGGRESSIVE';
    let bestScore = -Infinity;

    for (const [name, arm] of Object.entries(arms)) {
      if (arm.pulls === 0) {
        // Arm belum pernah dicoba → prioritas eksplorasi
        arms[name].ucbScore = Infinity;
        bestArm = name;
        bestScore = Infinity;
        break;
      }
      const avgReward = arm.totalReward / arm.pulls;
      const ucb = avgReward + C * Math.sqrt(Math.log(N) / arm.pulls);
      arms[name].ucbScore = ucb;
      if (ucb > bestScore) {
        bestScore = ucb;
        bestArm = name;
      }
    }

    this.log(`🎰 Bandit selected: ${bestArm} (UCB=${bestScore === Infinity ? '∞' : bestScore.toFixed(3)})`);
    return bestArm;
  }

  private updateBandit(preset: string, regime: string, outcome: 'WIN' | 'LOSS'): void {
    if (!this.cfg.enableBandit) return;

    const reward = outcome === 'WIN' ? 1 : 0;
    const bandit = this.memory.strategyBandit;

    // Global arm
    if (bandit.arms[preset]) {
      bandit.arms[preset].totalReward += reward;
      bandit.arms[preset].pulls++;
      bandit.arms[preset].lastUsed = Date.now();
    }

    // Regime-specific arm
    if (!bandit.regimeArms[regime]) {
      bandit.regimeArms[regime] = {
        AGGRESSIVE: { name: 'AGGRESSIVE', totalReward: 0, pulls: 0, ucbScore: Infinity, lastUsed: 0 },
        NORMAL:     { name: 'NORMAL',     totalReward: 0, pulls: 0, ucbScore: Infinity, lastUsed: 0 },
        HYPER:      { name: 'HYPER',      totalReward: 0, pulls: 0, ucbScore: Infinity, lastUsed: 0 },
      };
    }
    if (bandit.regimeArms[regime][preset]) {
      bandit.regimeArms[regime][preset].totalReward += reward;
      bandit.regimeArms[regime][preset].pulls++;
    }
  }

  private applyPreset(preset: string): void {
    if (this.currentPreset === preset) return;
    this.currentPreset = preset;
    switch (preset) {
      case 'HYPER':       this.brain.reconfigure({ preset: 'HYPER' }); break;
      case 'NORMAL':      this.brain.reconfigure({ preset: 'NORMAL' }); break;
      case 'AGGRESSIVE':
      default:            this.brain.reconfigure({ preset: 'AGGRESSIVE' }); break;
    }
    this.log(`⚙️ Preset changed to: ${preset}`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [NEW v2.0] ADAPTIVE THRESHOLD per REGIME
  // ─────────────────────────────────────────────────────────────────────────

  private getAdaptiveThreshold(regime: string, baseThreshold: number): number {
    const regimeStats = this.memory.regimeStats[regime];
    if (!regimeStats) return baseThreshold;

    const total = regimeStats.wins + regimeStats.losses;
    if (total < 10) return baseThreshold;

    const regimeWR = regimeStats.wins / total;

    // Regime dengan WR rendah → naikkan threshold (lebih selektif)
    // Regime dengan WR tinggi → turunkan threshold (lebih agresif)
    const adjustment = (0.5 - regimeWR) * 0.10;
    const adaptive = Math.max(0.50, Math.min(0.80, baseThreshold + adjustment));

    if (adaptive !== baseThreshold) {
      this.log(`📐 Adaptive threshold for ${regime}: ${baseThreshold.toFixed(3)} → ${adaptive.toFixed(3)} (regimeWR=${(regimeWR*100).toFixed(0)}%)`);
    }

    this.memory.regimeThresholds[regime] = adaptive;
    return adaptive;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NEWS SENTINEL
  // ─────────────────────────────────────────────────────────────────────────

  private async fetchNewsSentiment(): Promise<NewsSentiment> {
    const now = Date.now();
    if (this.newsCache && (now - this.newsCache.fetchedAt) < this.cfg.newsCacheDurationMs) {
      return { ...this.newsCache, cached: true };
    }

    const headlines: string[] = [];

    if (this.cfg.newsApiKey) {
      try {
        const data = await this.httpGet(
          `https://cryptopanic.com/api/v1/posts/?auth_token=${this.cfg.newsApiKey}&currencies=BTC&filter=hot&limit=10`
        );
        const parsed = JSON.parse(data);
        if (parsed.results) {
          for (const item of parsed.results.slice(0, 8)) {
            headlines.push(item.title);
          }
        }
      } catch (err) {
        this.log(`⚠️ CryptoPanic error: ${err}`);
      }
    }

    if (headlines.length === 0) {
      headlines.push('[No external news API — using AI sentiment analysis]');
    }

    let sentimentScore = 0;
    let summary = 'Neutral';

    try {
      const prompt = `You are a BTC crypto market sentiment analyst.
Headlines: ${headlines.join(' | ')}
Rate overall BTC sentiment from -1.0 (very bearish) to +1.0 (very bullish).
Respond ONLY in JSON: {"score": 0.0, "summary": "one sentence Indonesian", "bias": "BULLISH|BEARISH|NEUTRAL"}`;

      let raw = await this.queryLLM(prompt, 200, 0.1, 'NEWS_SENTIMENT');
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const parsed = JSON.parse(raw);
      sentimentScore = Math.max(-1, Math.min(1, parsed.score ?? 0));
      summary = parsed.summary ?? 'Neutral';
    } catch (err) {
      this.log(`⚠️ News sentiment error: ${err}`);
    }

    const result: NewsSentiment = { score: sentimentScore, summary, headlines, fetchedAt: now, cached: false };
    this.newsCache = result;
    this.log(`📰 News: ${sentimentScore > 0 ? '+' : ''}${sentimentScore.toFixed(2)} | ${summary}`);
    return result;
  }

  private httpGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { timeout: 8000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('HTTP timeout')); });
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BULL ADVOCATE AGENT
  // ─────────────────────────────────────────────────────────────────────────

  private async runBullAdvocate(
    meta: BrainMeta, mathResult: BrainOrderInstruction,
    newsScore: number, memoryInsight: string, knnInsight: string,
  ): Promise<AgentArgument> {
    const prompt = `You are the BULL ADVOCATE in a BTC 5-minute trading debate.
Build the STRONGEST possible case for UP (price will rise next 5 minutes).

MARKET DATA:
RSI=${meta.rsi.toFixed(1)} | ZScore=${meta.zScore.toFixed(2)} | OFI=${meta.ofi.toFixed(3)}
ADX=${meta.adx.toFixed(1)} | +DI=${meta.plusDI.toFixed(1)} | -DI=${meta.minusDI.toFixed(1)}
EMA9=${meta.ema9.toFixed(1)} | EMA21=${meta.ema21.toFixed(1)} | EMA50=${meta.ema50.toFixed(1)}
Regime=${meta.regime} | Wyckoff=${meta.wyckoff} | Session=${meta.session}
Hurst=${meta.hurst.toFixed(3)} | BBSqueeze=${meta.bbSqueeze} | ATR%=${(meta.atrPct * 100).toFixed(3)}%
BullExhaust=${meta.trendDecay?.isBullExhausted} | BearExhaust=${meta.trendDecay?.isBearExhausted}
BullDiv=${meta.momentumDiv?.bullishDiv} | BearDiv=${meta.momentumDiv?.bearishDiv}
DivStr=${meta.momentumDiv?.totalDivStrength?.toFixed(2)}
PullbackClass=${meta.pullbackClass?.classification} | StructBreak=${meta.pullbackClass?.isStructureBreak}
DoubleBottom=${meta.doubleBottom} | SweepBull=${meta.sweepBull} | FVGBull=${meta.fvgBull}
BullEngulf=${meta.bullEngulf} | BullPinbar=${meta.bullPinbar} | Hammer=${meta.hammer}
MathVote=${meta.finalVoteScore?.toFixed(3)} | CounterTrend=${meta.counterTrendActive}
News=${newsScore.toFixed(2)} | Memory=${memoryInsight.slice(0, 100)} | KNN=${knnInsight.slice(0, 80)}

Respond ONLY in JSON:
{
  "direction": "UP",
  "confidence": 0.74,
  "arguments": ["Arg 1 bahasa Indonesia", "Arg 2", "Arg 3"],
  "weakness": ["Kelemahan 1", "Kelemahan 2"],
  "rawReasoning": "Analisis 3-4 kalimat bahasa Indonesia"
}`;

    try {
      let raw = await this.queryLLM(prompt, 800, 0.25, 'BULL_ADVOCATE');
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const parsed = JSON.parse(raw);
      return {
        role: 'BULL_ADVOCATE', direction: 'UP',
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
        arguments: parsed.arguments ?? [],
        weakness: parsed.weakness ?? [],
        rawReasoning: parsed.rawReasoning ?? '',
      };
    } catch (err) {
      this.log(`⚠️ Bull Advocate error: ${err}`);
      return { role: 'BULL_ADVOCATE', direction: 'UP', confidence: 0.5, arguments: ['Error'], weakness: [], rawReasoning: '' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // BEAR ADVOCATE AGENT
  // ─────────────────────────────────────────────────────────────────────────

  private async runBearAdvocate(
    meta: BrainMeta, mathResult: BrainOrderInstruction,
    newsScore: number, memoryInsight: string, knnInsight: string,
  ): Promise<AgentArgument> {
    const prompt = `You are the BEAR ADVOCATE in a BTC 5-minute trading debate.
Build the STRONGEST possible case for DOWN (price will fall next 5 minutes).

MARKET DATA:
RSI=${meta.rsi.toFixed(1)} | ZScore=${meta.zScore.toFixed(2)} | OFI=${meta.ofi.toFixed(3)}
ADX=${meta.adx.toFixed(1)} | +DI=${meta.plusDI.toFixed(1)} | -DI=${meta.minusDI.toFixed(1)}
EMA9=${meta.ema9.toFixed(1)} | EMA21=${meta.ema21.toFixed(1)} | EMA50=${meta.ema50.toFixed(1)}
Regime=${meta.regime} | Wyckoff=${meta.wyckoff} | Session=${meta.session}
Hurst=${meta.hurst.toFixed(3)} | BBSqueeze=${meta.bbSqueeze} | ATR%=${(meta.atrPct * 100).toFixed(3)}%
BullExhaust=${meta.trendDecay?.isBullExhausted} | BearExhaust=${meta.trendDecay?.isBearExhausted}
BullDiv=${meta.momentumDiv?.bullishDiv} | BearDiv=${meta.momentumDiv?.bearishDiv}
DivStr=${meta.momentumDiv?.totalDivStrength?.toFixed(2)}
PullbackClass=${meta.pullbackClass?.classification} | StructBreak=${meta.pullbackClass?.isStructureBreak}
DoubleTop=${meta.doubleTop} | SweepBear=${meta.sweepBear} | FVGBear=${meta.fvgBear}
BearEngulf=${meta.bearEngulf} | BearPinbar=${meta.bearPinbar} | ShootingStar=${meta.shootingStar}
MathVote=${meta.finalVoteScore?.toFixed(3)} | CounterTrend=${meta.counterTrendActive}
News=${newsScore.toFixed(2)} | Memory=${memoryInsight.slice(0, 100)} | KNN=${knnInsight.slice(0, 80)}

Respond ONLY in JSON:
{
  "direction": "DOWN",
  "confidence": 0.71,
  "arguments": ["Arg 1 bahasa Indonesia", "Arg 2", "Arg 3"],
  "weakness": ["Kelemahan 1", "Kelemahan 2"],
  "rawReasoning": "Analisis 3-4 kalimat bahasa Indonesia"
}`;

    try {
      let raw = await this.queryLLM(prompt, 800, 0.25, 'BEAR_ADVOCATE');
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const parsed = JSON.parse(raw);
      return {
        role: 'BEAR_ADVOCATE', direction: 'DOWN',
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
        arguments: parsed.arguments ?? [],
        weakness: parsed.weakness ?? [],
        rawReasoning: parsed.rawReasoning ?? '',
      };
    } catch (err) {
      this.log(`⚠️ Bear Advocate error: ${err}`);
      return { role: 'BEAR_ADVOCATE', direction: 'DOWN', confidence: 0.5, arguments: ['Error'], weakness: [], rawReasoning: '' };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // JUDGE AGENT (upgraded dengan KNN context)
  // ─────────────────────────────────────────────────────────────────────────

  private async runJudge(
    bullArg: AgentArgument, bearArg: AgentArgument,
    meta: BrainMeta, mathResult: BrainOrderInstruction,
    newsScore: number, memoryInsight: string,
    patternBoost: number, knnInsight: string, knnBoost: number,
    calibrationNote: string,
  ): Promise<JudgeVerdict> {
    const mathDir   = mathResult.direction;
    const mathConf  = mathResult.confidence;
    const voteScore = meta.finalVoteScore ?? 0;

    const prompt = `You are the SUPREME JUDGE in a BTC 5-minute trading decision.
Make the FINAL autonomous trade decision using ALL evidence.

═══ MATH ENGINE v5.5.0 ═══
Math Direction: ${mathDir} | Math Confidence: ${(mathConf * 100).toFixed(1)}%
Vote Net Score: ${voteScore > 0 ? '+' : ''}${voteScore.toFixed(3)}
Regime: ${meta.regime} | Wyckoff: ${meta.wyckoff} | Session: ${meta.session}
Active Signals: ${meta.activeSignals?.slice(0, 5).join(', ') ?? 'none'}
BullExhaust=${meta.trendDecay?.isBullExhausted} | BearExhaust=${meta.trendDecay?.isBearExhausted}
Bull Div=${meta.momentumDiv?.bullishDiv} | Bear Div=${meta.momentumDiv?.bearishDiv} | Str=${meta.momentumDiv?.totalDivStrength?.toFixed(2)}
Pullback: ${meta.pullbackClass?.classification} (conf=${meta.pullbackClass?.confidence?.toFixed(2)})
Counter-Trend: ${meta.counterTrendActive}

═══ BULL ADVOCATE (${(bullArg.confidence * 100).toFixed(1)}%) ═══
${bullArg.arguments.map((a, i) => `${i + 1}. ${a}`).join('\n')}
Weakness: ${bullArg.weakness.join(' | ')}

═══ BEAR ADVOCATE (${(bearArg.confidence * 100).toFixed(1)}%) ═══
${bearArg.arguments.map((a, i) => `${i + 1}. ${a}`).join('\n')}
Weakness: ${bearArg.weakness.join(' | ')}

═══ EXTERNAL CONTEXT ═══
News Sentiment: ${newsScore > 0 ? '+' : ''}${newsScore.toFixed(2)}
Pattern Memory Boost: ${patternBoost > 0 ? '+' : ''}${patternBoost.toFixed(3)}
KNN Similarity: ${knnInsight}
KNN Boost: ${knnBoost > 0 ? '+' : ''}${knnBoost.toFixed(3)}
Calibration: ${calibrationNote}
Memory: ${memoryInsight.slice(0, 150)}

═══ DECISION RULES ═══
- Weigh ALL evidence: math, debate, news, memory, KNN historical patterns
- Only HOLD if genuinely ambiguous (win margin < 0.05)
- KNN with 5+ samples is high-confidence historical evidence
- Counter-trend with strong divergence/exhaustion = trust it

Respond ONLY in JSON:
{
  "direction": "UP"|"DOWN"|"HOLD",
  "confidence": 0.73,
  "winningAgent": "BULL"|"BEAR"|"NEUTRAL",
  "winMargin": 0.15,
  "shouldTrade": true,
  "adjustedThreshold": 0.53,
  "reasoning": "Keputusan final 4-6 kalimat bahasa Indonesia",
  "adaptiveNote": "Catatan 1 kalimat untuk trade berikutnya"
}`;

    try {
      let raw = await this.queryLLM(prompt, 1000, 0.10, 'JUDGE');
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const parsed = JSON.parse(raw);

      if (parsed.adaptiveNote) {
        this.memory.adaptiveNotes.push(`[${new Date().toISOString()}] ${parsed.adaptiveNote}`);
        if (this.memory.adaptiveNotes.length > 20) this.memory.adaptiveNotes.shift();
      }

      return {
        direction:         parsed.direction     ?? 'HOLD',
        confidence:        Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
        rawConfidence:     Math.max(0, Math.min(1, parsed.confidence ?? 0.5)),
        winningAgent:      parsed.winningAgent  ?? 'NEUTRAL',
        winMargin:         Math.max(0, Math.min(1, parsed.winMargin ?? 0)),
        reasoning:         parsed.reasoning     ?? '',
        adjustedThreshold: parsed.adjustedThreshold,
        shouldTrade:       parsed.shouldTrade   ?? false,
      };
    } catch (err) {
      this.log(`⚠️ Judge error: ${err}`);
      return {
        direction: mathDir === 'HOLD' ? 'HOLD' : mathDir as 'UP' | 'DOWN',
        confidence: mathConf, rawConfidence: mathConf,
        winningAgent: 'NEUTRAL', winMargin: 0,
        reasoning: 'Judge error — fallback to math',
        shouldTrade: mathDir !== 'HOLD' && mathConf >= this.cfg.minDebateConfidence,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // [NEW v2.0] REFLECTOR — single trade + cross-trade mining
  // ─────────────────────────────────────────────────────────────────────────

  private async runReflector(trade: TradeMemory, outcome: 'WIN' | 'LOSS'): Promise<string> {
    if (!this.cfg.enableReflection) return '';

    const patternSummary = trade.patternTags
      .map(tag => {
        const s = this.memory.patternStats[tag];
        if (!s) return `${tag}(new)`;
        const total = s.wins + s.losses;
        return `${tag}(BWR=${(s.bayesianWR * 100).toFixed(0)}%/n=${total})`;
      })
      .join(', ');

    const prompt = `You are the REFLECTOR agent for a BTC 5-minute autonomous trading system.

TRADE SUMMARY:
Direction: ${trade.direction} | Outcome: ${outcome}
Session: ${trade.session} | Regime: ${trade.regime}
Math Signal: ${trade.mathSignal.direction} @ ${(trade.mathSignal.confidence * 100).toFixed(1)}%
Debate Winner: ${trade.debateWinner}
News at Trade: ${trade.newsScore > 0 ? '+' : ''}${trade.newsScore.toFixed(2)}
Preset Used: ${trade.presetUsed ?? 'AGGRESSIVE'}
Patterns (Bayesian WR): ${patternSummary}
KNN Vote: ${trade.knnVote ? `${trade.knnVote.wins}W/${trade.knnVote.losses}L (k=${trade.knnVote.k})` : 'N/A'}

${outcome === 'WIN'
  ? 'WINNING trade. Identify most reliable signals.'
  : 'LOSING trade. What went wrong? What was misleading?'}

Respond ONLY in JSON:
{
  "insight": "Refleksi 2-3 kalimat bahasa Indonesia",
  "patternToAvoid": "pattern_name atau null",
  "patternToEmphasize": "pattern_name atau null",
  "regimeNote": "catatan 1 kalimat tentang regime ${trade.regime}",
  "knnWasAccurate": true|false
}`;

    try {
      let raw = await this.queryLLM(prompt, 400, 0.15, 'REFLECTOR');
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const parsed = JSON.parse(raw);
      const insight = parsed.insight ?? `${outcome} on ${trade.regime}`;
      this.memory.recentReflections.push(`[${new Date().toISOString()}] ${insight}`);
      if (this.memory.recentReflections.length > 10) this.memory.recentReflections.shift();
      this.log(`🪞 [Reflector] ${outcome}: ${insight}`);
      return insight;
    } catch (err) {
      this.log(`⚠️ Reflector error: ${err}`);
      return `${outcome} — reflection unavailable`;
    }
  }

  // [NEW v2.0] Cross-trade pattern mining (setiap N trades)
  private async runCrossTradeMining(): Promise<void> {
    if (!this.cfg.enableCrossTradeMinig) return;
    const tradesSinceLastMining = this.memory.totalTrades - this.memory.lastMiningAt;
    if (tradesSinceLastMining < this.cfg.crossMiningInterval) return;

    const recentTrades = this.memory.trades
      .filter(t => t.outcome)
      .slice(-20);

    if (recentTrades.length < 10) return;

    this.log('⛏️ [CrossMining] Running cross-trade pattern analysis...');

    const tradeSummary = recentTrades.map(t =>
      `${t.direction} ${t.outcome} | ${t.regime} | ${t.session} | ` +
      `tags:[${t.patternTags.slice(0, 4).join(',')}] | ` +
      `conf=${t.confidence.toFixed(2)} | knn=${t.knnVote ? `${t.knnVote.wins}W/${t.knnVote.losses}L` : 'N/A'}`
    ).join('\n');

    const wins = recentTrades.filter(t => t.outcome === 'WIN').length;
    const losses = recentTrades.filter(t => t.outcome === 'LOSS').length;

    const prompt = `You are the MINING AGENT for an autonomous BTC trading system.
Analyze the last ${recentTrades.length} trades to extract actionable patterns.

TRADES (last 20):
${tradeSummary}

STATS: ${wins}W / ${losses}L = ${((wins/(wins+losses))*100).toFixed(0)}% WR

Identify:
1. Which pattern combinations are most profitable?
2. Which conditions consistently cause LOSS?
3. Any session/regime bias?
4. Is KNN (similarity search) helping or hurting?

Respond ONLY in JSON:
{
  "insight": "Temuan utama dalam 2-3 kalimat bahasa Indonesia",
  "winningCombination": "deskripsi combo pattern terbaik",
  "losingPattern": "deskripsi pola loss yang perlu dihindari",
  "sessionBias": "rekomendasi session",
  "knnAccuracy": "evaluasi kNN accuracy dari trades",
  "thresholdRecommendation": "apakah threshold perlu dinaikkan/diturunkan?"
}`;

    try {
      let raw = await this.queryLLM(prompt, 600, 0.15, 'MINING_AGENT');
      raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const parsed = JSON.parse(raw);
      const insight = parsed.insight ?? 'Mining complete';
      this.memory.miningInsights.push(`[${new Date().toISOString()}] ${insight}`);
      if (this.memory.miningInsights.length > 10) this.memory.miningInsights.shift();
      this.memory.lastMiningAt = this.memory.totalTrades;
      this.log(`⛏️ [CrossMining] ${insight}`);
    } catch (err) {
      this.log(`⚠️ CrossMining error: ${err}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // MAIN ENTRY — analyzeAndDecide
  // Pipeline: Bandit → Math → News → Memory → KNN → Debate+Calibration → Judge → Decision
  // ─────────────────────────────────────────────────────────────────────────

  public async analyzeAndDecide(
    historicalCandles: CandleData[],
    lastClosedCandle: CandleData,
    marketPrice?: number,
  ): Promise<AgentTradeDecision> {
    const auditTrail: string[] = [];
    const startTime = Date.now();
    const log = (msg: string) => { auditTrail.push(`[${Date.now() - startTime}ms] ${msg}`); this.log(msg); };

    log('═══ SOVEREIGN APEX AGENT v2.0 — NEW EPOCH ═══');

    // ── STEP 0: Bandit — select preset
    let selectedPreset = 'AGGRESSIVE';
    if (this.cfg.enableBandit) {
      // Will be refined after we know regime (post-math)
      // For now select globally; will re-select after regime known
    }

    // ── STEP 0.5: Math Engine
    log('⚙️  [Step 0] Running Math Engine v5.5.0...');
    const mathResult = await this.brain.analyzeNewEpoch(historicalCandles, lastClosedCandle, marketPrice);
    const meta = mathResult.meta;

    if (!meta) {
      log('❌ Math engine returned no meta');
      return this.buildHoldDecision('Math engine: no meta / insufficient data', mathResult, auditTrail);
    }

    // ── STEP 0.6: Select preset via Bandit (now with regime context)
    selectedPreset = this.selectPreset(meta.regime);
    this.applyPreset(selectedPreset);
    log(`⚙️  Preset: ${selectedPreset} | Math: ${mathResult.direction} @ ${(mathResult.confidence * 100).toFixed(1)}% | Regime: ${meta.regime}`);

    if (mathResult.reason.includes('Auto-pause')) {
      log('⏸️ Auto-pause aktif');
      return this.buildHoldDecision(mathResult.reason, mathResult, auditTrail);
    }

    const direction = mathResult.direction === 'HOLD'
      ? (meta.finalVoteScore ?? 0) >= 0 ? 'UP' as const : 'DOWN' as const
      : mathResult.direction as 'UP' | 'DOWN';

    // ── STEP 1: News
    let newsSentiment: NewsSentiment | null = null;
    if (this.cfg.enableNewsSentiment) {
      log('📰 [Step 1] Fetching news...');
      try {
        newsSentiment = await fetchWithTimeout(this.fetchNewsSentiment.bind(this), 10000);
      } catch {
        log('⚠️ News timeout — skip');
      }
    }
    const newsScore = newsSentiment?.score ?? 0;

    // ── STEP 2: Memory recall (Bayesian + decay)
    log('💾 [Step 2] Memory recall (Bayesian)...');
    const patternTags = this.extractPatternTags(meta, direction);
    const { insight: memoryInsight, patternBoost } = this.recallMemoryInsight(patternTags, direction, meta.session, meta.regime);
    log(`💾 Boost: ${patternBoost > 0 ? '+' : ''}${patternBoost.toFixed(3)} | ${memoryInsight.slice(0, 80)}...`);

    // ── STEP 3: KNN similarity search
    log('🔍 [Step 3] KNN similarity search...');
    const currentVector = this.buildTradeVector(meta, newsScore, patternBoost);
    const { insight: knnInsight, knnBoost, similarIds, vote: knnVote } = this.knnLookup(currentVector, direction);
    log(`🔍 ${knnInsight}`);

    // ── STEP 4: Multi-agent debate
    let debate: DebateResult | null = null;
    let judgeVerdict: JudgeVerdict;

    if (this.cfg.enableDebate) {
      log('🥊 [Step 4] Multi-agent debate...');
      const debateStart = Date.now();

      try {
        const [bullArg, bearArg] = await Promise.all([
          fetchWithTimeout(() => this.runBullAdvocate(meta, mathResult, newsScore, memoryInsight, knnInsight), this.cfg.debateTimeoutMs),
          fetchWithTimeout(() => this.runBearAdvocate(meta, mathResult, newsScore, memoryInsight, knnInsight), this.cfg.debateTimeoutMs),
        ]);

        log(`🐂 Bull (${(bullArg.confidence * 100).toFixed(0)}%): ${bullArg.arguments[0]?.slice(0, 60)}...`);
        log(`🐻 Bear (${(bearArg.confidence * 100).toFixed(0)}%): ${bearArg.arguments[0]?.slice(0, 60)}...`);

        // Calibration note sebelum Judge
        const { note: calibrationNote } = this.applyCalibrationCorrection(0.7); // placeholder
        log('⚖️  Judge deliberating...');

        judgeVerdict = await fetchWithTimeout(
          () => this.runJudge(
            bullArg, bearArg, meta, mathResult, newsScore,
            memoryInsight, patternBoost, knnInsight, knnBoost, calibrationNote
          ),
          this.cfg.debateTimeoutMs
        );

        // Apply calibration correction to Judge's raw confidence
        const { calibrated, note: calNote } = this.applyCalibrationCorrection(judgeVerdict.confidence);
        judgeVerdict.rawConfidence = judgeVerdict.confidence;
        judgeVerdict.confidence = calibrated;

        debate = { bullArg, bearArg, judgeVerdict, debateDuration: Date.now() - debateStart };
        log(`⚖️  Judge: ${judgeVerdict.direction} @ ${(judgeVerdict.confidence * 100).toFixed(1)}% (raw: ${((judgeVerdict.rawConfidence ?? judgeVerdict.confidence) * 100).toFixed(1)}%)`);
        log(`⚖️  ${calNote}`);
        log(`⚖️  Winner: ${judgeVerdict.winningAgent} | Margin: ${judgeVerdict.winMargin.toFixed(2)}`);

      } catch (err) {
        log(`⚠️ Debate error: ${err} — fallback to math`);
        judgeVerdict = {
          direction, confidence: mathResult.confidence, rawConfidence: mathResult.confidence,
          winningAgent: 'NEUTRAL', winMargin: 0,
          reasoning: `Debate timeout — math: ${mathResult.reason}`,
          shouldTrade: mathResult.direction !== 'HOLD',
        };
      }
    } else {
      judgeVerdict = {
        direction, confidence: mathResult.confidence + patternBoost + knnBoost,
        rawConfidence: mathResult.confidence,
        winningAgent: 'NEUTRAL', winMargin: Math.abs(meta.finalVoteScore ?? 0),
        reasoning: mathResult.reason,
        shouldTrade: mathResult.direction !== 'HOLD' && mathResult.confidence >= this.cfg.minDebateConfidence,
      };
    }

    // ── STEP 5: Compute final confidence & adaptive threshold
    const finalDirection  = judgeVerdict.direction;
    const combinedBoost   = patternBoost + knnBoost;
    const finalConfidence = Math.max(0, Math.min(1, judgeVerdict.confidence + combinedBoost));

    const baseThreshold   = judgeVerdict.adjustedThreshold ?? this.cfg.brainConfig.minProbability;
    const adaptiveThreshold = this.getAdaptiveThreshold(meta.regime, baseThreshold);

    const shouldTrade = finalDirection !== 'HOLD'
      && finalConfidence >= adaptiveThreshold
      && judgeVerdict.shouldTrade
      && judgeVerdict.winMargin >= 0.03;

    log(`📊 Final: ${finalDirection} @ ${(finalConfidence * 100).toFixed(1)}% | Thresh: ${(adaptiveThreshold * 100).toFixed(1)}% | Boosts: pattern=${patternBoost > 0 ? '+' : ''}${patternBoost.toFixed(3)} knn=${knnBoost > 0 ? '+' : ''}${knnBoost.toFixed(3)} | Trade: ${shouldTrade}`);

    // ── STEP 6: Register trade in memory + store vector
    const calNote = this.applyCalibrationCorrection(judgeVerdict.rawConfidence ?? judgeVerdict.confidence).note;

    if (shouldTrade) {
      const tradeId = `${Date.now()}_${finalDirection}`;

      const tradeMemory: TradeMemory = {
        id: tradeId, timestamp: Date.now(),
        direction: finalDirection, outcome: undefined,
        session: meta.session, regime: meta.regime,
        mathSignal: {
          direction: mathResult.direction,
          confidence: mathResult.confidence,
          voteScore: meta.finalVoteScore ?? 0,
        },
        debateWinner: debate?.judgeVerdict.winningAgent ?? 'NEUTRAL',
        newsScore, confidence: finalConfidence,
        rawJudgeConfidence: judgeVerdict.rawConfidence,
        patternTags, similarTradeIds: similarIds,
        knnVote, presetUsed: selectedPreset,
        winMargin: judgeVerdict.winMargin,
      };

      this.memory.trades.push(tradeMemory);
      this.memory.totalTrades++;

      // Store vector
      this.memory.tradeVectors.push({
        id: tradeId, vector: currentVector,
        direction: finalDirection, outcome: 'PENDING',
        regime: meta.regime, session: meta.session,
        timestamp: Date.now(),
      });

      this.saveMemory();
      log(`💾 Trade registered: ${tradeId}`);
    }

    const finalReason = [
      `🤖 [Agent v2.0] ${finalDirection} @ ${(finalConfidence * 100).toFixed(1)}%`,
      `Math: ${mathResult.direction}(${(mathResult.confidence * 100).toFixed(0)}%)`,
      debate ? `Debate: ${judgeVerdict.winningAgent}(m=${judgeVerdict.winMargin.toFixed(2)})` : 'NoDebate',
      `News: ${newsScore > 0 ? '+' : ''}${newsScore.toFixed(2)}`,
      `PBoost: ${patternBoost > 0 ? '+' : ''}${patternBoost.toFixed(3)}`,
      `KNN: ${knnBoost > 0 ? '+' : ''}${knnBoost.toFixed(3)}(${knnVote.wins}W/${knnVote.losses}L)`,
      `Preset: ${selectedPreset}`,
      `| ${judgeVerdict.reasoning.slice(0, 100)}`,
    ].join(' | ');

    log(`✅ Decision in ${Date.now() - startTime}ms`);

    return {
      shouldTrade,
      direction:       shouldTrade ? finalDirection : 'HOLD',
      confidence:      finalConfidence,
      tradeAmount:     this.cfg.brainConfig.flatStake,
      reason:          finalReason,
      mathResult, debate, newsSentiment,
      memoryInsight, patternBoost,
      knnInsight, calibrationNote: calNote,
      selectedPreset, auditTrail,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // UPDATE TRADE OUTCOME
  // ─────────────────────────────────────────────────────────────────────────

  public async updateOutcome(result: 'WIN' | 'LOSS'): Promise<void> {
    this.brain.updateTradeHistory(result);

    if (result === 'WIN') this.memory.wins++;
    else this.memory.losses++;

    const pending = [...this.memory.trades].reverse().find(t => !t.outcome);
    if (pending) {
      pending.outcome = result;

      // Update Bayesian pattern stats
      for (const tag of pending.patternTags) {
        this.updatePatternBayes(tag, result, pending.regime);
      }

      // Update session stats
      const sessKey = `${pending.session}_${pending.direction}`;
      if (!this.memory.sessionStats[sessKey]) this.memory.sessionStats[sessKey] = { wins: 0, losses: 0 };
      if (result === 'WIN') this.memory.sessionStats[sessKey].wins++;
      else this.memory.sessionStats[sessKey].losses++;

      // Update regime stats
      if (!this.memory.regimeStats[pending.regime]) this.memory.regimeStats[pending.regime] = { wins: 0, losses: 0 };
      if (result === 'WIN') this.memory.regimeStats[pending.regime].wins++;
      else this.memory.regimeStats[pending.regime].losses++;

      // Update Judge calibration
      if (pending.rawJudgeConfidence) {
        this.updateCalibration(pending.rawJudgeConfidence, result);
      }

      // Update bandit
      if (pending.presetUsed) {
        this.updateBandit(pending.presetUsed, pending.regime, result);
      }

      // Update vector outcome
      const vec = this.memory.tradeVectors.find(v => v.id === pending.id);
      if (vec) vec.outcome = result;

      // Run Reflector
      if (this.cfg.enableReflection) {
        const reflection = await this.runReflector(pending, result);
        pending.reflectionNote = reflection;
      }

      // Cross-trade mining
      await this.runCrossTradeMining();

      this.log(`📝 [Outcome] ${pending.direction} → ${result} | WR: ${this.getWinRate()}% | ECE: ${this.memory.judgeCalibration.ece.toFixed(3)}`);
    }

    this.saveMemory();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────────────

  private buildHoldDecision(reason: string, mathResult: BrainOrderInstruction, auditTrail: string[]): AgentTradeDecision {
    return {
      shouldTrade: false, direction: 'HOLD', confidence: 0,
      tradeAmount: 0, reason,
      mathResult, debate: null, newsSentiment: null,
      memoryInsight: '', patternBoost: 0,
      knnInsight: '', calibrationNote: '', selectedPreset: 'AGGRESSIVE',
      auditTrail,
    };
  }

  private log(msg: string): void {
    if (this.cfg.debugMode) {
      console.log(`[SAAgent v2] ${msg}`);
    }
  }

  public getMemoryStats() {
    const topPatterns: PatternStats[] = Object.entries(this.memory.patternStats)
      .map(([tag, s]) => ({
        tag,
        wins: s.wins, losses: s.losses, pending: s.pending,
        winRate: (s.wins + s.losses) > 0 ? s.wins / (s.wins + s.losses) : 0,
        bayesianWR: s.bayesianWR,
        emaWR: s.emaWR,
      }))
      .filter(p => p.wins + p.losses >= 3)
      .sort((a, b) => Math.abs(b.bayesianWR - 0.5) - Math.abs(a.bayesianWR - 0.5))
      .slice(0, 10);

    const banditStats = Object.entries(this.memory.strategyBandit.arms).map(([name, arm]) => ({
      name,
      avgReward: arm.pulls > 0 ? (arm.totalReward / arm.pulls * 100).toFixed(1) + '%' : 'N/A',
      pulls: arm.pulls,
      ucb: arm.ucbScore === Infinity ? '∞' : arm.ucbScore.toFixed(3),
    }));

    return {
      totalTrades: this.memory.totalTrades,
      wins: this.memory.wins,
      losses: this.memory.losses,
      winRate: this.getWinRate(),
      topPatterns,
      recentReflections: this.memory.recentReflections.slice(-5),
      miningInsights: this.memory.miningInsights.slice(-3),
      calibration: {
        ece: this.memory.judgeCalibration.ece.toFixed(3),
        correctionFactor: this.memory.judgeCalibration.correctionFactor.toFixed(3),
        totalCalibrated: this.memory.judgeCalibration.totalCalibrated,
      },
      bandit: banditStats,
      regimeThresholds: this.memory.regimeThresholds,
      vectorCount: this.memory.tradeVectors.length,
    };
  }

  public getBrainState() { return this.brain.getState(); }
  public reconfigure(preset: string) { this.brain.reconfigure({ preset }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────────────────────────────────────

async function fetchWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export const sovereignAgent = new SovereignApexAgent();

export async function agentDecide(
  historicalCandles: CandleData[],
  lastClosedCandle: CandleData,
  marketPrice?: number,
): Promise<AgentTradeDecision> {
  return sovereignAgent.analyzeAndDecide(historicalCandles, lastClosedCandle, marketPrice);
}

export async function agentUpdateOutcome(result: 'WIN' | 'LOSS'): Promise<void> {
  return sovereignAgent.updateOutcome(result);
}

export function getAgentMemoryStats() {
  return sovereignAgent.getMemoryStats();
}
