/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║          SOVEREIGN APEX MIND v5.4.4 — ANTI-GOCEK PRECISION ENGINE           ║
 * ║          BTC 5-Minute UP/DOWN Prediction Engine                              ║
 * ║                                                                              ║
 * ║  v5.4.4 CHANGELOG (vs v5.4.3):                                               ║
 * ║  ✅ [FIX-1] Oracle Cascade tidak lagi BLOCKING                               ║
 * ║         → Cerebras error = fallback ke Gemini, Gemini error = math decision  ║
 * ║         → Oracle hanya sebagai VETO opsional, bukan penentu utama            ║
 * ║  ✅ [FIX-2] Oracle tidak bisa bypass pullback check                          ║
 * ║         → Oracle direction harus lolos isPullbackContra + prob threshold     ║
 * ║  ✅ [FIX-3] ATR threshold disesuaikan untuk 5m candle BTC                    ║
 * ║         → isLowVol: atrPct < 0.0007 (was 0.0010)                            ║
 * ║         → isUltra:  ratio < 0.40 ATAU atrPct < 0.0004                       ║
 * ║  ✅ [FIX-4] Direction voting anti-conflict                                   ║
 * ║         → Jika bull + bear reversal signal konflik → HOLD (bukan coin flip)  ║
 * ║         → Signal count voting: siapa lebih banyak sinyal menang              ║
 * ║  ✅ [FIX-5] logOdds baseline = 0 (neutral, hilangkan DOWN bias)              ║
 * ║  ✅ [FIX-6] OFI minimum threshold sebelum dikalikan multiplier               ║
 * ║         → |OFI| < 0.12 = noise, diabaikan dalam scoring                     ║
 * ║  ✅ [FIX-7] detectTrapCandle(): Anti-fake-move / liquidity grab detector     ║
 * ║         → Wick > 2x body + close kembali ke mid range = TRAP                 ║
 * ║         → Trap candle aktif = penalti -0.35 untuk arah yang ter-trap         ║
 * ║  ✅ [FIX-8] calcPullbackScore: macroStrength dikembalikan                    ║
 * ║         → Weak macro (strength < 0.2) = pullback threshold 50% lebih longgar ║
 * ║  ✅ [FIX-9] Conflict resolution di signal voting                             ║
 * ║         → Jika UP score dan DOWN score hampir sama → HOLD                    ║
 * ║  ✅ [FIX-10] 5m-specific VWAP period diturunkan ke 12 (was 24)              ║
 * ║         → VWAP 24 periode di 5m = 2 jam, terlalu lebar untuk scalp          ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import OpenAI from 'openai';
import { GoogleGenAI } from '@google/genai';

// ─────────────────────────────────────────────────────────────────────────────
// TIPE DATA
// ─────────────────────────────────────────────────────────────────────────────

export type PredictionDirection = 'UP' | 'DOWN' | 'HOLD';
export type TradingSession = 'ASIA' | 'LONDON' | 'NEW_YORK' | 'DEAD_ZONE' | 'OVERLAP_LON_NY';
export type MarketRegime = 'STRONG_BULL' | 'WEAK_BULL' | 'STRONG_BEAR' | 'WEAK_BEAR' | 'RANGING' | 'COMPRESSION';
export type WyckoffPhase = 'ACCUMULATION' | 'MARKUP' | 'DISTRIBUTION' | 'MARKDOWN' | 'UNKNOWN';

export interface CandleData {
  open:       number;
  high:       number;
  low:        number;
  close:      number;
  volume:     number;
  timestamp:  number;
  buyVolume?:  number;
  sellVolume?: number;
}

export interface MultiTimeframeData {
  m1?:  CandleData[];
  m5?:  CandleData[];
  m15:  CandleData[];
  h1?:  CandleData[];
  h4?:  CandleData[];
}

export interface BrainTradeRecord {
  timestamp:  number;
  direction:  PredictionDirection;
  outcome:   'WIN' | 'LOSS' | 'PENDING';
  session:    TradingSession;
  regime:     MarketRegime;
  confidence: number;
  reason:     string;
  metrics: {
    rsi: number; zScore: number; adx: number; ofi: number;
    hurst: number; entropy: number; mtf: number; close: number;
  };
}

export interface BrainOrderInstruction {
  direction:           PredictionDirection;
  confidence:          number;
  tradeAmount:         number;
  limitOrderDurationMs: number;
  reason:              string;
  meta?:               BrainMeta;
}

export interface BrainMeta {
  zScore: number; rsi: number; hurst: number; entropy: number;
  ema9: number; ema21: number; ema50: number;
  adx: number; plusDI: number; minusDI: number;
  atr: number; atrPct: number;
  ofi: number; vwap: number;
  bbSqueeze: boolean; bbWidth: number;
  regime: MarketRegime; wyckoff: WyckoffPhase;
  mtfScore: number; mtfDetails: string;
  session: TradingSession;
  doubleBottom: boolean; doubleTop: boolean;
  sweepBull: boolean; sweepBear: boolean;
  fvgBull: boolean; fvgBear: boolean;
  bullEngulf: boolean; bearEngulf: boolean;
  bullPinbar: boolean; bearPinbar: boolean;
  hammer: boolean; shootingStar: boolean;
  rejection: number;
  activeSignals: string[];
  rawScore: number;
  threshold: number;
  consecutiveLosses: number;
  streak: number;
  bayesWR: number;
  aggressiveMode: boolean;
  pullbackScore: number;
  shortMomentumFlip: string | null;
  reversalEpochCount: number;
  isLowVolCompression: boolean;
  isUltraCompression: boolean;
  trendDecay?: any;
  momentumDiv?: any;
  pullbackClass?: any;
  finalVoteScore?: number;
  counterTrendActive?: boolean;
  compressionRatio: number;
  atrPctShort: number;
  microMomDirection: 'UP' | 'DOWN' | null;
  microMomStrength: number;
  microMomTicks: number;
  // v5.4.4 additions
  trapCandleUp: boolean;   // last candle = bull fake / trap wick up
  trapCandleDown: boolean; // last candle = bear fake / trap wick down
  signalConflict: boolean; // bull & bear signals hampir seimbang
}

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────

export interface AggressiveConfig {
  minProbability:          number;
  disableEntropyGate:      boolean;
  disableDeadZonePenalty:  boolean;
  disableLossStreakMTF:    boolean;
  disableEMAGuard:         boolean;
  disableRSIExtreme:       boolean;
  losingStreakPause:       number;
  minCandlesRequired:      number;
  epochDurationMs:         number;
  cancelDurationMs:        number;
  flatStake:               number;
  debugSignals:            boolean;
}

export const AGGRESSIVE_PRESET: AggressiveConfig = {
  minProbability:          0.53,
  disableEntropyGate:      true,
  disableDeadZonePenalty:  true,
  disableLossStreakMTF:    true,
  disableEMAGuard:         true,
  disableRSIExtreme:       true,
  losingStreakPause:       8,
  minCandlesRequired:      15,
  epochDurationMs:   5 * 60 * 1000,
  cancelDurationMs: 90 * 1000,
  flatStake:               0.5,
  debugSignals:            true,
};

export const NORMAL_PRESET: AggressiveConfig = {
  minProbability:          0.55,
  disableEntropyGate:      false,
  disableDeadZonePenalty:  false,
  disableLossStreakMTF:    false,
  disableEMAGuard:         false,
  disableRSIExtreme:       false,
  losingStreakPause:       5,
  minCandlesRequired:      20,
  epochDurationMs:   5 * 60 * 1000,
  cancelDurationMs: 90 * 1000,
  flatStake:               0.5,
  debugSignals:            false,
};

export const HYPER_PRESET: AggressiveConfig = {
  minProbability:          0.51,
  disableEntropyGate:      true,
  disableDeadZonePenalty:  true,
  disableLossStreakMTF:    true,
  disableEMAGuard:         true,
  disableRSIExtreme:       true,
  losingStreakPause:       12,
  minCandlesRequired:       8,
  epochDurationMs:   5 * 60 * 1000,
  cancelDurationMs: 90 * 1000,
  flatStake:               0.5,
  debugSignals:            true,
};

export interface BrainState {
  streakCount:       number;
  totalTrades:       number;
  winTrades:         number;
  consecutiveLosses: number;
  dynamicThreshold:  number;
  recentTrades:      BrainTradeRecord[];
  bayesAlpha:        number;
  bayesBeta:         number;
  sessionStats:      Record<TradingSession, { wins: number; total: number }>;
  regimeStats:       Record<string, { wins: number; total: number }>;
}

interface EpochReversalState {
  dir: 'UP' | 'DOWN';
  epochCount: number;
  lastEpochTs: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SOVEREIGN APEX MIND v5.4.4
// ─────────────────────────────────────────────────────────────────────────────

export class SovereignApexMind {

  private streak:       number;
  private totalTrades:  number;
  private winTrades:    number;
  private consLosses:   number;
  private dynThreshold: number;
  private recentTrades: BrainTradeRecord[];
  private bayesA: number;
  private bayesB: number;
  private sessionStats: Record<TradingSession, { wins: number; total: number }>;
  private regimeStats:  Record<string, { wins: number; total: number }>;

  private epochReversalState: EpochReversalState | null = null;
  private cfg: AggressiveConfig;

  private readonly RSI_P   = 14;
  private readonly EMA_F   = 9;
  private readonly EMA_M   = 21;
  private readonly EMA_S   = 50;
  private readonly ATR_P   = 14;
  private readonly ADX_P   = 14;
  private readonly BB_P    = 20;
  private readonly HURST_W = 50;
  private readonly ENTR_W  = 20;
  private readonly OFI_W   = 8;
  // [FIX-10] VWAP period 12 untuk 5m (= 1 jam, lebih relevan untuk scalp)
  private readonly VWAP_P  = 12;

  private cerebras: OpenAI | null = null;
  private gemini: GoogleGenAI | null = null;
  private mistral: OpenAI | null = null;

  constructor(state?: Partial<BrainState>, config: AggressiveConfig = AGGRESSIVE_PRESET) {
    this.cfg          = config;
    this.streak       = state?.streakCount        ?? 0;
    this.totalTrades  = state?.totalTrades         ?? 0;
    this.winTrades    = state?.winTrades           ?? 0;
    this.consLosses   = state?.consecutiveLosses   ?? 0;
    this.dynThreshold = state?.dynamicThreshold    ?? config.minProbability;
    this.recentTrades = state?.recentTrades        ?? [];
    this.bayesA       = state?.bayesAlpha ?? 1;
    this.bayesB       = state?.bayesBeta  ?? 1;
    this.sessionStats = state?.sessionStats ?? {
      ASIA:           { wins: 0, total: 0 },
      LONDON:         { wins: 0, total: 0 },
      NEW_YORK:       { wins: 0, total: 0 },
      OVERLAP_LON_NY: { wins: 0, total: 0 },
      DEAD_ZONE:      { wins: 0, total: 0 },
    };
    this.regimeStats = state?.regimeStats ?? {};

    const cerebrasKey = process.env.CEREBRAS_API_KEY || "";
    if (cerebrasKey) {
      this.cerebras = new OpenAI({
        apiKey: cerebrasKey,
        baseURL: process.env.CEREBRAS_API_ENDPOINT || 'https://api.cerebras.ai/v1',
        maxRetries: 2,
        timeout: 8000, // [FIX-1] Timeout ketat agar tidak blocking terlalu lama
      });
    }
    const mistralKey = process.env.MISTRAL_API_KEY || "oMa7CqyOXWX9O3MzFSOsCCyw4B7pEh00";
    if (mistralKey) {
      this.mistral = new OpenAI({
        apiKey: mistralKey,
        baseURL: process.env.MISTRAL_API_ENDPOINT || 'https://api.mistral.ai/v1',
        maxRetries: 2,
        timeout: 8000,
      });
    }
    if (process.env.GEMINI_API_KEY) {
      this.gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    const wr  = this.totalTrades > 0 ? ((this.winTrades / this.totalTrades) * 100).toFixed(1) : '0.0';
    const bWR = ((this.bayesA / (this.bayesA + this.bayesB)) * 100).toFixed(1);
    console.log('╔══════════════════════════════════════════════════════╗');
    console.log('║  SOVEREIGN APEX MIND v5.4.4 — ANTI-GOCEK PRECISION  ║');
    console.log('╚══════════════════════════════════════════════════════╝');
    console.log(`⚡ Threshold: ${(this.dynThreshold * 100).toFixed(1)}% | Stake: $${this.cfg.flatStake}`);
    console.log(`🛡  Guards: Entropy=${!config.disableEntropyGate} | EMA=${!config.disableEMAGuard} | LossPause=${config.losingStreakPause}`);
    console.log(`📊 History: ${this.totalTrades} trades | WR: ${wr}% | BayesWR: ${bWR}% | LossStreak: ${this.consLosses}`);
  }

  public getState(): BrainState {
    return {
      streakCount: this.streak, totalTrades: this.totalTrades, winTrades: this.winTrades,
      consecutiveLosses: this.consLosses, dynamicThreshold: this.dynThreshold,
      recentTrades: this.recentTrades, bayesAlpha: this.bayesA, bayesBeta: this.bayesB,
      sessionStats: this.sessionStats, regimeStats: this.regimeStats,
    };
  }

  public updateTradeHistory(result: 'WIN' | 'LOSS'): void {
    this.totalTrades++;
    if (result === 'WIN') { this.winTrades++; this.streak++; this.consLosses = 0; this.bayesA++; }
    else                  { this.streak = 0; this.consLosses++; this.bayesB++; }

    const pendingIdx = [...this.recentTrades].reverse().findIndex(t => t.outcome === 'PENDING');
    if (pendingIdx !== -1) {
      const ri = this.recentTrades.length - 1 - pendingIdx;
      const t  = this.recentTrades[ri];
      t.outcome = result;
      this.sessionStats[t.session].total++;
      if (result === 'WIN') this.sessionStats[t.session].wins++;
      const rg = t.regime;
      if (!this.regimeStats[rg]) this.regimeStats[rg] = { wins: 0, total: 0 };
      this.regimeStats[rg].total++;
      if (result === 'WIN') this.regimeStats[rg].wins++;
      console.log(`📝 [Trade Result] ${t.direction} → ${result} | session:${t.session} regime:${rg}`);
    }
    if (this.recentTrades.length > 20) this.recentTrades.shift();
    const wr  = ((this.winTrades / this.totalTrades) * 100).toFixed(1);
    const bWR = ((this.bayesA / (this.bayesA + this.bayesB)) * 100).toFixed(1);
    console.log(`📊 ${this.totalTrades} trades | WR:${wr}% | Bayes:${bWR}% | Streak:${this.streak} | Loss:${this.consLosses}`);
  }

  public reconfigure(config: { preset?: 'AGGRESSIVE_PRESET' | 'NORMAL_PRESET' | 'HYPER_PRESET' | string }): void {
    if (config.preset) {
      if (config.preset === 'NORMAL_PRESET') {
        this.cfg = { ...NORMAL_PRESET };
      } else if (config.preset === 'HYPER_PRESET') {
        this.cfg = { ...HYPER_PRESET };
      } else {
        this.cfg = { ...AGGRESSIVE_PRESET };
      }
      this.dynThreshold = this.cfg.minProbability;
      console.log(`⚙️  [reconfigure] Preset → ${config.preset} | Threshold = ${(this.dynThreshold * 100).toFixed(1)}%`);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // INDICATOR ENGINE
  // ───────────────────────────────────────────────────────────────────────────

  private zScore(closes: number[], p = 20): number {
    const w = closes.slice(-p);
    if (w.length < 3) return 0;
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const s = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
    return s === 0 ? 0 : (w[w.length - 1] - m) / s;
  }

  private rsi(closes: number[], p = this.RSI_P): number {
    if (closes.length < p + 1) return 50;
    const sl = closes.slice(-(p * 3 + 1));
    let ag = 0, al = 0;
    for (let i = 1; i <= p; i++) {
      const d = sl[i] - sl[i - 1];
      if (d > 0) ag += d; else al += Math.abs(d);
    }
    ag /= p; al /= p;
    for (let i = p + 1; i < sl.length; i++) {
      const d = sl[i] - sl[i - 1];
      ag = (ag * (p - 1) + Math.max(0, d)) / p;
      al = (al * (p - 1) + Math.max(0, -d)) / p;
    }
    return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }

  private ema(closes: number[], p: number): number[] {
    if (!closes.length) return [];
    const k = 2 / (p + 1);
    let e = closes.slice(0, Math.min(p, closes.length)).reduce((a, b) => a + b, 0) / Math.min(p, closes.length);
    return closes.map((v, i) => {
      if (i < p) return e;
      e = v * k + e * (1 - k);
      return e;
    });
  }

  private atr(candles: CandleData[], p = this.ATR_P): number[] {
    if (candles.length < 2) return [0];
    const trs = [candles[0].high - candles[0].low];
    for (let i = 1; i < candles.length; i++) {
      const pc = candles[i - 1].close;
      trs.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - pc),
        Math.abs(candles[i].low - pc),
      ));
    }
    const initLen = Math.min(p, trs.length);
    let a = trs.slice(0, initLen).reduce((x, y) => x + y, 0) / initLen;
    const out: number[] = [];
    for (let i = 0; i < initLen; i++) out.push(a);
    for (let i = initLen; i < trs.length; i++) { a = (a * (p - 1) + trs[i]) / p; out.push(a); }
    return out;
  }

  private adx(candles: CandleData[]): { adx: number; plusDI: number; minusDI: number } {
    const minL = this.ADX_P * 2 + 1;
    if (candles.length < minL) return { adx: 20, plusDI: 25, minusDI: 25 };
    const sl = candles.slice(-minL);
    const trs: number[] = [], dmP: number[] = [], dmM: number[] = [];
    for (let i = 1; i < sl.length; i++) {
      const hd = sl[i].high - sl[i - 1].high, ld = sl[i - 1].low - sl[i].low;
      trs.push(Math.max(
        sl[i].high - sl[i].low,
        Math.abs(sl[i].high - sl[i - 1].close),
        Math.abs(sl[i].low - sl[i - 1].close),
      ));
      dmP.push(hd > ld && hd > 0 ? hd : 0);
      dmM.push(ld > hd && ld > 0 ? ld : 0);
    }
    const smooth = (a: number[]) => {
      let s = a.slice(0, this.ADX_P).reduce((x, y) => x + y, 0);
      const o = [s];
      for (let i = this.ADX_P; i < a.length; i++) { s = s - s / this.ADX_P + a[i]; o.push(s); }
      return o;
    };
    const sT = smooth(trs), sP = smooth(dmP), sM = smooth(dmM);
    const dxs = sT.map((t, i) => {
      if (t === 0) return 0;
      const p = (sP[i] / t) * 100, m = (sM[i] / t) * 100;
      return (p + m) === 0 ? 0 : (Math.abs(p - m) / (p + m)) * 100;
    });
    const adxVal = dxs.slice(-this.ADX_P).reduce((a, b) => a + b, 0) / this.ADX_P;
    const L = sT.length - 1;
    return {
      adx: Math.min(100, adxVal),
      plusDI:  sT[L] > 0 ? (sP[L] / sT[L]) * 100 : 25,
      minusDI: sT[L] > 0 ? (sM[L] / sT[L]) * 100 : 25,
    };
  }

  private bb(closes: number[]): { upper: number; middle: number; lower: number; width: number; squeeze: boolean } {
    const w = closes.slice(-this.BB_P);
    if (w.length < this.BB_P) {
      const v = w[w.length - 1];
      return { upper: v, middle: v, lower: v, width: 0, squeeze: false };
    }
    const m = w.reduce((a, b) => a + b, 0) / w.length;
    const s = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length);
    const u = m + 2 * s, l = m - 2 * s;
    const width = m > 0 ? (u - l) / m : 0;
    return { upper: u, middle: m, lower: l, width, squeeze: width < 0.035 };
  }

  private hurst(prices: number[]): number {
    const n = prices.length;
    if (n < 20) return 0.5;
    const mean = prices.reduce((s, v) => s + v, 0) / n;
    if (mean === 0 || prices.reduce((s, v) => s + (v - mean) ** 2, 0) / n / (mean * mean) < 1e-10) return 0.5;
    const boxes: number[] = [];
    for (let s = 4; s <= Math.floor(n / 4); s = Math.ceil(s * 1.5)) boxes.push(s);
    if (boxes.length < 3) return 0.5;
    const logS: number[] = [], logF: number[] = [];
    for (const s of boxes) {
      const nb = Math.floor(n / s);
      if (nb < 2) continue;
      let rms = 0, cnt = 0;
      for (let b = 0; b < nb; b++) {
        const seg = prices.slice(b * s, (b + 1) * s);
        const xb = (s - 1) / 2, yb = seg.reduce((a, v) => a + v, 0) / s;
        let num = 0, den = 0;
        seg.forEach((v, i) => { num += (i - xb) * (v - yb); den += (i - xb) ** 2; });
        const sl = den ? num / den : 0, ic = yb - sl * xb;
        rms += seg.reduce((r, v, i) => r + (v - (sl * i + ic)) ** 2, 0) / s;
        cnt++;
      }
      if (cnt > 0 && rms > 0) { logS.push(Math.log(s)); logF.push(Math.log(Math.sqrt(rms / cnt))); }
    }
    if (logS.length < 3) return 0.5;
    const m2 = logS.length;
    const xm = logS.reduce((a, b) => a + b, 0) / m2, ym = logF.reduce((a, b) => a + b, 0) / m2;
    let num = 0, den = 0;
    logS.forEach((x, i) => { num += (x - xm) * (logF[i] - ym); den += (x - xm) ** 2; });
    return Math.max(0.1, Math.min(0.99, den ? num / den : 0.5));
  }

  private entropy(closes: number[], w = this.ENTR_W): number {
    const sl = closes.slice(-w);
    if (sl.length < 5) return 1.0;
    const ret = sl.slice(1).map((v, i) => v - sl[i]);
    const B = 8, mn = Math.min(...ret), mx = Math.max(...ret), rng = mx - mn;
    if (rng === 0) return 0;
    const cnt = new Array(B).fill(0);
    ret.forEach(r => cnt[Math.min(B - 1, Math.floor(((r - mn) / rng) * B))]++);
    let e = 0;
    cnt.forEach(c => { if (c > 0) { const p = c / ret.length; e -= p * Math.log2(p); } });
    return e / Math.log2(B);
  }

  private ofi(candles: CandleData[], w = this.OFI_W): number {
    const sl = candles.slice(-w);
    if (sl.length < 2) return 0;
    let tot = 0;
    for (const c of sl) {
      const rng = c.high - c.low;
      if (rng === 0) continue;
      if (c.buyVolume !== undefined && c.sellVolume !== undefined) {
        tot += (c.buyVolume - c.sellVolume) / (c.buyVolume + c.sellVolume + 1);
      } else {
        const pos = (c.close - c.low) / rng;
        const dir = c.close >= c.open ? 1 : -1;
        tot += (pos - 0.5) * 2 * dir;
      }
    }
    return Math.max(-1, Math.min(1, tot / sl.length));
  }

  private vwap(candles: CandleData[], p = this.VWAP_P): number {
    const w = candles.slice(-p);
    if (!w.length) return 0;
    let pv = 0, vol = 0;
    for (const c of w) { const t = (c.high + c.low + c.close) / 3; pv += t * c.volume; vol += c.volume; }
    return vol > 0 ? pv / vol : w[w.length - 1].close;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // HELPERS
  // ───────────────────────────────────────────────────────────────────────────

  private session(ts: number): TradingSession {
    const h = new Date(ts).getUTCHours();
    if (h >= 12 && h < 16) return 'OVERLAP_LON_NY';
    if (h >= 7  && h < 12) return 'LONDON';
    if (h >= 16 && h < 21) return 'NEW_YORK';
    if (h >= 0  && h <  7) return 'ASIA';
    return 'DEAD_ZONE';
  }

  private hold(reason: string, confidence = 0, meta?: BrainMeta): BrainOrderInstruction {
    return { direction: 'HOLD', confidence, tradeAmount: 0, limitOrderDurationMs: 0, reason, meta };
  }

  private formatCandlesForLLM(candles: CandleData[], vwap: number, lastClose: number): string {
    const recent = candles.slice(-5);
    const lines = recent.map((c, i) =>
      `Bar-${5-i}: O:${c.open.toFixed(1)} H:${c.high.toFixed(1)} L:${c.low.toFixed(1)} C:${c.close.toFixed(1)} V:${c.volume.toFixed(0)}`
    );
    return lines.join('\n') + `\nVWAP:${vwap.toFixed(1)} | Last:${lastClose.toFixed(1)}`;
  }

  private formatMemoryForLLM(): string {
    const wr = this.totalTrades > 0 ? (this.winTrades / this.totalTrades * 100).toFixed(1) : '0.0';
    return `Trades:${this.totalTrades} | WR:${wr}% | ConsLoss:${this.consLosses} | Streak:${this.streak}`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // [FIX-7 NEW v5.4.4] TRAP CANDLE DETECTOR — Anti Fake Move / Liquidity Grab
  // ───────────────────────────────────────────────────────────────────────────
  /**
   * Mendeteksi "trap candle" = candle dengan wick besar yang spike ke satu arah
   * lalu close kembali ke middle atau berlawanan arah.
   * Ini adalah tanda klasik liquidity grab sebelum reversal.
   *
   * Contoh: Candle spike UP tinggi tapi close di bawah mid → TRAP UP = bearish bias
   *         Candle spike DOWN dalam tapi close di atas mid → TRAP DOWN = bullish bias
   */
  private detectTrapCandle(candles: CandleData[]): {
    trapCandleUp: boolean;    // spike ke atas = bear trap (menipu bull)
    trapCandleDown: boolean;  // spike ke bawah = bull trap (menipu bear)
    trapStrength: number;     // 0–1 seberapa kuat trap-nya
  } {
    if (candles.length < 3) {
      return { trapCandleUp: false, trapCandleDown: false, trapStrength: 0 };
    }

    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];

    const body      = Math.abs(last.close - last.open);
    const range     = last.high - last.low;
    const midRange  = (last.high + last.low) / 2;
    const upperWick = last.high - Math.max(last.close, last.open);
    const lowerWick = Math.min(last.close, last.open) - last.low;

    if (range === 0) return { trapCandleUp: false, trapCandleDown: false, trapStrength: 0 };

    // Kondisi trap candle:
    // 1. Wick ke satu sisi >= 2.5x body (wick dominan)
    // 2. Close harus kembali ke sisi berlawanan dari wick (konfirmasi rejection)
    // 3. Wick harus lebih besar dari ATR recent (bukan wick biasa)

    const atrSeries = this.atr(candles.slice(-6), 4);
    const recentAtr = atrSeries[atrSeries.length - 1] || range;
    const wickAtrRatio = Math.max(upperWick, lowerWick) / (recentAtr || 1);

    // Trap UP: wick besar ke atas + close di bawah midRange
    const trapCandleUp = (
      upperWick >= 2.5 * Math.max(body, 1) &&       // wick atas dominan
      last.close < midRange &&                        // close rejected ke bawah
      upperWick / range > 0.40 &&                    // wick lebih dari 40% range
      wickAtrRatio > 0.8                             // wick signifikan vs ATR
    );

    // Trap DOWN: wick besar ke bawah + close di atas midRange
    const trapCandleDown = (
      lowerWick >= 2.5 * Math.max(body, 1) &&
      last.close > midRange &&
      lowerWick / range > 0.40 &&
      wickAtrRatio > 0.8
    );

    // Strength = seberapa kuat rejection (wickAtrRatio clipped 0-1)
    const trapStrength = Math.min(1, wickAtrRatio / 3);

    if (this.cfg.debugSignals && (trapCandleUp || trapCandleDown)) {
      const type = trapCandleUp ? '🔴 TRAP UP (bearish)' : '🟢 TRAP DOWN (bullish)';
      console.log(`⚠️  [TrapCandle] ${type} | wick/atr=${wickAtrRatio.toFixed(2)} | str=${trapStrength.toFixed(2)}`);
    }

    return { trapCandleUp, trapCandleDown, trapStrength };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MICRO-TICK MOMENTUM DETECTOR
  // ───────────────────────────────────────────────────────────────────────────
  private detectMicroMomentum(closes: number[], atrPctShort: number): {
    direction: 'UP' | 'DOWN' | null;
    strength: number;
    consecutiveTicks: number;
  } {
    if (closes.length < 4) return { direction: null, strength: 0, consecutiveTicks: 0 };

    const recent = closes.slice(-5);
    const diffs  = recent.slice(1).map((v, i) => v - recent[i]);

    let upCount = 0, downCount = 0;
    for (let i = diffs.length - 1; i >= 0; i--) {
      if (diffs[i] > 0)      { if (downCount > 0) break; upCount++; }
      else if (diffs[i] < 0) { if (upCount > 0) break; downCount++; }
      else break;
    }

    const ticks = Math.max(upCount, downCount);
    const dir: 'UP' | 'DOWN' | null = upCount > downCount ? 'UP'
                                     : downCount > upCount ? 'DOWN'
                                     : null;

    const totalMove = Math.abs(recent[recent.length - 1] - recent[0]);
    const refAtr    = (atrPctShort * recent[0]) || 1;
    const moveRatio = Math.min(1, totalMove / refAtr);
    const strength  = Math.min(1, (ticks / 4) * 0.6 + moveRatio * 0.4);

    return { direction: dir, strength, consecutiveTicks: ticks };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PULLBACK SCORE (WITH MACRO STRENGTH - FIX-8)
  // ───────────────────────────────────────────────────────────────────────────
  private calcPullbackScore(params: {
    candles: CandleData[];
    rsiVal: number; ofiVal: number; zScoreVal: number; atrVal: number;
    ema9: number; ema21: number;
    candleRunCount: number; lastCandleIsGreen: boolean;
    macroDominant: 'BULL' | 'BEAR' | 'FLAT';
    macroStrength: number; // [FIX-8] dikembalikan
    sweepBull: boolean; sweepBear: boolean;
    bullEngulf: boolean; bearEngulf: boolean;
    hammer: boolean; shootingStar: boolean;
    bullPinbar: boolean; bearPinbar: boolean;
    vwapVal: number; lastClose: number;
  }): { score: number; signals: string[] } {
    const sigs: Array<{ id: string; v: number }> = [];
    const {
      rsiVal, ofiVal, zScoreVal, candleRunCount, lastCandleIsGreen,
      macroDominant, macroStrength, sweepBull, sweepBear,
      bullEngulf, bearEngulf, hammer, shootingStar, bullPinbar, bearPinbar,
      vwapVal, lastClose, ema9, ema21
    } = params;

    // [FIX-8] Jika macro lemah (strength < 0.2), pullback signals dilemahkan 50%
    // agar tidak terlalu mudah mem-block trade yang sebenarnya valid
    const macroFactor = macroStrength < 0.20 ? 0.5 : 1.0;

    if (macroDominant === 'BULL' && rsiVal > 72) {
      sigs.push({ id: 'pb_rsi_ob_in_bull', v: -0.18 * macroFactor });
    } else if (macroDominant === 'BULL' && rsiVal > 65) {
      sigs.push({ id: 'pb_rsi_warn_bull', v: -0.09 * macroFactor });
    } else if (macroDominant === 'BEAR' && rsiVal < 28) {
      sigs.push({ id: 'pb_rsi_os_in_bear', v: +0.18 * macroFactor });
    } else if (macroDominant === 'BEAR' && rsiVal < 35) {
      sigs.push({ id: 'pb_rsi_warn_bear', v: +0.09 * macroFactor });
    }

    if (macroDominant === 'BULL' && !lastCandleIsGreen && candleRunCount >= 2) {
      const str = Math.min(0.15, 0.06 + candleRunCount * 0.04) * macroFactor;
      sigs.push({ id: 'pb_red_run_in_bull', v: -str });
    } else if (macroDominant === 'BEAR' && lastCandleIsGreen && candleRunCount >= 2) {
      const str = Math.min(0.15, 0.06 + candleRunCount * 0.04) * macroFactor;
      sigs.push({ id: 'pb_green_run_in_bear', v: +str });
    }

    if (macroDominant === 'BULL' && ofiVal < -0.25) {
      sigs.push({ id: 'pb_ofi_contra_bull', v: -0.14 });
    } else if (macroDominant === 'BEAR' && ofiVal > +0.25) {
      sigs.push({ id: 'pb_ofi_contra_bear', v: +0.14 });
    }

    if (macroDominant === 'BULL' && zScoreVal > 1.8) {
      sigs.push({ id: 'pb_z_ext_bull', v: -0.12 });
    } else if (macroDominant === 'BEAR' && zScoreVal < -1.8) {
      sigs.push({ id: 'pb_z_ext_bear', v: +0.12 });
    }

    if (macroDominant === 'BULL' && ema9 < ema21 * 0.9998) {
      sigs.push({ id: 'pb_ema_cross_bear_in_bull', v: -0.10 * macroFactor });
    } else if (macroDominant === 'BEAR' && ema9 > ema21 * 1.0002) {
      sigs.push({ id: 'pb_ema_cross_bull_in_bear', v: +0.10 * macroFactor });
    }

    const vwapDev = vwapVal > 0 ? (lastClose - vwapVal) / vwapVal : 0;
    if (macroDominant === 'BULL' && vwapDev > 0.005) { // 0.008 → 0.005 untuk 5m
      sigs.push({ id: 'pb_above_vwap_ext', v: -0.08 });
    } else if (macroDominant === 'BEAR' && vwapDev < -0.005) {
      sigs.push({ id: 'pb_below_vwap_ext', v: +0.08 });
    }

    if (macroDominant === 'BULL' && (bearEngulf || shootingStar || bearPinbar)) {
      sigs.push({ id: 'pb_reversal_candle_in_bull', v: -0.16 });
    } else if (macroDominant === 'BEAR' && (bullEngulf || hammer || bullPinbar)) {
      sigs.push({ id: 'pb_reversal_candle_in_bear', v: +0.16 });
    }

    if (macroDominant === 'BULL' && sweepBear) {
      sigs.push({ id: 'pb_sweep_bear_in_bull', v: -0.13 });
    } else if (macroDominant === 'BEAR' && sweepBull) {
      sigs.push({ id: 'pb_sweep_bull_in_bear', v: +0.13 });
    }

    const totalScore = sigs.reduce((a, s) => a + s.v, 0);
    const signalStrs = sigs
      .filter(s => Math.abs(s.v) >= 0.04)
      .sort((a, b) => Math.abs(b.v) - Math.abs(a.v))
      .map(s => `${s.id}(${s.v > 0 ? '+' : ''}${(s.v * 100).toFixed(0)}%)`);

    return { score: Math.max(-1, Math.min(1, totalScore)), signals: signalStrs };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MACRO TREND ENGINE
  // ───────────────────────────────────────────────────────────────────────────
  private macroTrend(candles: CandleData[]): {
    short:  { slope: number; strength: number; direction: 'UP' | 'DOWN' | 'FLAT' };
    medium: { slope: number; strength: number; direction: 'UP' | 'DOWN' | 'FLAT' };
    long:   { slope: number; strength: number; direction: 'UP' | 'DOWN' | 'FLAT' };
    composite: number;
    dominant: 'BULL' | 'BEAR' | 'FLAT';
    dominantStrength: number;
  } {
    const linReg = (closes: number[]) => {
      const n = closes.length;
      if (n < 3) return { slope: 0, strength: 0 };
      const xm = (n - 1) / 2;
      const ym = closes.reduce((a, b) => a + b, 0) / n;
      let num = 0, denX = 0, ssTot = 0;
      closes.forEach((y, i) => {
        num   += (i - xm) * (y - ym);
        denX  += (i - xm) ** 2;
        ssTot += (y - ym) ** 2;
      });
      const slope = denX ? num / denX : 0;
      let ssRes = 0;
      closes.forEach((y, i) => { ssRes += (y - (ym + slope * (i - xm))) ** 2; });
      const r2 = ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : 0;
      return { slope, strength: r2 };
    };

    const classify = (slope: number, strength: number, ref: number) => {
      const slopePct = ref > 0 ? slope / ref : 0;
      const FLAT_THRESHOLD = 0.00015;
      let direction: 'UP' | 'DOWN' | 'FLAT' = 'FLAT';
      if (slopePct >  FLAT_THRESHOLD) direction = 'UP';
      if (slopePct < -FLAT_THRESHOLD) direction = 'DOWN';
      return { slope: slopePct, strength, direction };
    };

    const closes = candles.map(c => c.close);
    const ref = closes[closes.length - 1] || 1;
    const short  = classify(...Object.values(linReg(closes.slice(-5)))  as [number, number], ref);
    const medium = classify(...Object.values(linReg(closes.slice(-15))) as [number, number], ref);
    const long   = classify(...Object.values(linReg(closes.slice(-30))) as [number, number], ref);

    const dirScore = (d: { slope: number; strength: number; direction: string }) => {
      const sign = d.direction === 'UP' ? 1 : d.direction === 'DOWN' ? -1 : 0;
      return sign * d.strength;
    };

    const composite = dirScore(long) * 0.40 + dirScore(medium) * 0.35 + dirScore(short) * 0.25;
    let dominant: 'BULL' | 'BEAR' | 'FLAT' = 'FLAT';
    if (composite >  0.12) dominant = 'BULL';
    if (composite < -0.12) dominant = 'BEAR';

    return { short, medium, long, composite, dominant, dominantStrength: Math.abs(composite) };
  }

  private regime(
    candles: CandleData[],
    hurst: number, adxVal: number, plusDI: number, minusDI: number, atrVal: number, close: number,
    macro: ReturnType<SovereignApexMind['macroTrend']>,
  ): MarketRegime {
    const atrPct = atrVal / close;
    if (macro.dominant === 'BULL') return (macro.dominantStrength > 0.4 || adxVal > 25) ? 'STRONG_BULL' : 'WEAK_BULL';
    if (macro.dominant === 'BEAR') return (macro.dominantStrength > 0.4 || adxVal > 25) ? 'STRONG_BEAR' : 'WEAK_BEAR';
    if (hurst > 0.55 && adxVal > 22) return plusDI > minusDI ? 'WEAK_BULL' : 'WEAK_BEAR';
    // [FIX-3] Threshold compression disesuaikan untuk 5m
    if (atrPct < 0.0007) return 'COMPRESSION';
    return 'RANGING';
  }

  private wyckoff(candles: CandleData[]): WyckoffPhase {
    if (candles.length < 15) return 'UNKNOWN';
    const w = candles.slice(-15);
    const closes = w.map(c => c.close);
    const change = (closes[closes.length - 1] - closes[0]) / closes[0];
    const v1 = w.slice(0, 7).reduce((a, c) => a + c.volume, 0) / 7;
    const v2 = w.slice(7).reduce((a, c) => a + c.volume, 0) / 8;
    const vt = v2 / v1;
    if (Math.abs(change) < 0.012 && vt > 1.15 && closes[closes.length - 1] < Math.min(...closes.slice(0, 7)) * 1.02) return 'ACCUMULATION';
    if (Math.abs(change) < 0.012 && vt > 1.15 && closes[closes.length - 1] > Math.max(...closes.slice(0, 7)) * 0.98) return 'DISTRIBUTION';
    if (change > 0.008 && vt >= 0.75) return 'MARKUP';
    if (change < -0.008 && vt >= 0.75) return 'MARKDOWN';
    return 'UNKNOWN';
  }

  private mtfScore(mtf: MultiTimeframeData): { score: number; details: string } {
    const analyze = (candles: CandleData[], label: string, weight: number): { s: number; tag: string } => {
      if (candles.length < 8) return { s: 0, tag: '' };
      const cl = candles.map(c => c.close);
      const r  = this.rsi(cl);
      const e9 = this.ema(cl, 9), e21 = this.ema(cl, 21);
      const em9 = e9[e9.length - 1], em21 = e21[e21.length - 1];
      let s = 0, tag = '';
      if (em9 > em21 * 1.0005)       { s += 0.4; tag = `${label}:↑`; }
      else if (em9 < em21 * 0.9995)  { s -= 0.4; tag = `${label}:↓`; }
      if (r > 55)      { s += 0.3; tag += ` RSI${r.toFixed(0)}↑`; }
      else if (r < 45) { s -= 0.3; tag += ` RSI${r.toFixed(0)}↓`; }
      return { s: Math.max(-1, Math.min(1, s)) * weight, tag };
    };
    const parts: { s: number; tag: string }[] = [];
    if (mtf.h4  && mtf.h4.length  >= 8) parts.push(analyze(mtf.h4,  'H4',  0.45));
    if (mtf.h1  && mtf.h1.length  >= 8) parts.push(analyze(mtf.h1,  'H1',  0.30));
    if (mtf.m15 && mtf.m15.length >= 8) parts.push(analyze(mtf.m15, 'M15', 0.20));
    if (mtf.m5  && mtf.m5.length  >= 8) parts.push(analyze(mtf.m5,  'M5',  0.05));
    const score   = parts.reduce((a, p) => a + p.s, 0);
    const details = parts.map(p => p.tag).filter(Boolean).join(' | ');
    return { score: Math.max(-1, Math.min(1, score)), details };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SMC + CANDLE PATTERNS
  // ───────────────────────────────────────────────────────────────────────────
  private getDynamicSwingLevels(candles: CandleData[], period = 20): { support: number; resistance: number } {
    const subset = candles.slice(-period);
    let support = Infinity, resistance = -Infinity;
    for (let i = 1; i < subset.length - 1; i++) {
      const prev = subset[i - 1], curr = subset[i], next = subset[i + 1];
      if (curr.low  <= prev.low  && curr.low  <= next.low)  support    = Math.min(support,    curr.low);
      if (curr.high >= prev.high && curr.high >= next.high) resistance = Math.max(resistance, curr.high);
    }
    if (support    === Infinity)  support    = Math.min(...subset.map(c => c.low));
    if (resistance === -Infinity) resistance = Math.max(...subset.map(c => c.high));
    return { support, resistance };
  }

  private detectDoublePatterns(candles: CandleData[], support: number, resistance: number) {
    if (candles.length < 10) return { doubleBottom: false, doubleTop: false };
    const subset = candles.slice(-10);
    const last   = subset[subset.length - 1];

    const threshSupport = support * 1.0008;
    const supportHits   = subset.map((c, i) => c.low <= threshSupport ? i : -1).filter(i => i >= 0);
    const doubleBottom  = supportHits.length >= 2
      && supportHits[supportHits.length - 1] - supportHits[0] >= 3
      && last.close > last.open;

    const threshResistance = resistance * 0.9992;
    const resistanceHits   = subset.map((c, i) => c.high >= threshResistance ? i : -1).filter(i => i >= 0);
    const doubleTop        = resistanceHits.length >= 2
      && resistanceHits[resistanceHits.length - 1] - resistanceHits[0] >= 3
      && last.close < last.open;

    return { doubleBottom, doubleTop };
  }

  private detectLiquiditySweep(candles: CandleData[]) {
    if (candles.length < 5) return { isSweepBullish: false, isSweepBearish: false };
    const subset    = candles.slice(-5);
    const last      = subset[4];
    const prevLows  = subset.slice(0, 4).map(c => c.low);
    const prevHighs = subset.slice(0, 4).map(c => c.high);
    return {
      isSweepBullish: last.low < Math.min(...prevLows) && last.close > Math.min(...prevLows),
      isSweepBearish: last.high > Math.max(...prevHighs) && last.close < Math.max(...prevHighs),
    };
  }

  private detectFVG(candles: CandleData[]) {
    if (candles.length < 3) return { isFvgBullish: false, isFvgBearish: false };
    const t0 = candles[candles.length - 1];
    const t2 = candles[candles.length - 3];
    return { isFvgBullish: t2.high < t0.low, isFvgBearish: t2.low > t0.high };
  }

  private candlePatterns(candles: CandleData[]) {
    if (candles.length < 2) {
      return {
        isBullishEngulfing: false, isBearishEngulfing: false,
        isBullishPinbar: false, isBearishPinbar: false,
        isHammer: false, isShootingStar: false,
        bodySize: 0, upperShadow: 0, lowerShadow: 0, rejectionRatio: 0
      };
    }
    const last = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const atrs = this.atr(candles);
    const atr  = atrs[atrs.length - 1] || 1;

    const bodySize    = Math.abs(last.close - last.open);
    const upperShadow = last.high - Math.max(last.close, last.open);
    const lowerShadow = Math.min(last.close, last.open) - last.low;
    const rejectionRatio = bodySize === 0 ? 0 : Math.max(upperShadow, lowerShadow) / bodySize;

    const prevBody  = Math.abs(prev.close - prev.open);
    const prevIsRed   = prev.close < prev.open;
    const prevIsGreen = prev.close > prev.open;
    const lastIsGreen = last.close > last.open;
    const lastIsRed   = last.close < last.open;

    const isBullishEngulfing = prevIsRed && lastIsGreen
      && last.close >= prev.open && last.open <= prev.close && bodySize > prevBody * 1.05;
    const isBearishEngulfing = prevIsGreen && lastIsRed
      && last.close <= prev.open && last.open >= prev.close && bodySize > prevBody * 1.05;

    const isBullishPinbar = lowerShadow >= 2.0 * bodySize && upperShadow <= 0.5 * bodySize && rejectionRatio >= 1.5 && lowerShadow > atr * 0.3;
    const isBearishPinbar = upperShadow >= 2.0 * bodySize && lowerShadow <= 0.5 * bodySize && rejectionRatio >= 1.5 && upperShadow > atr * 0.3;
    const isHammer       = lastIsGreen && lowerShadow >= 2.5 * bodySize && upperShadow < bodySize * 0.5;
    const isShootingStar = lastIsRed && upperShadow >= 2.5 * bodySize && lowerShadow < bodySize * 0.5;

    return {
      isBullishEngulfing, isBearishEngulfing, isBullishPinbar, isBearishPinbar,
      isHammer, isShootingStar, bodySize, upperShadow, lowerShadow, rejectionRatio
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PROBABILITY ENGINE v2 (FIX-5: neutral baseline, FIX-6: OFI threshold)
  // ───────────────────────────────────────────────────────────────────────────
  private calcProbabilityV2(params: {
    direction: PredictionDirection;
    zScore: number; rsi: number; hurst: number;
    adx: number; plusDI: number; minusDI: number;
    regime: MarketRegime; wyckoff: WyckoffPhase;
    ofiVal: number; mtfAlignment: number;
    earlyReversal: boolean; vptDivergence: boolean;
    bbSqueeze: boolean;
    isBullishEngulfing: boolean; isBearishEngulfing: boolean;
    isBullishPinbar: boolean; isBearishPinbar: boolean;
    isHammer: boolean; isShootingStar: boolean;
    doubleBottom: boolean; doubleTop: boolean;
    isSweepBullish: boolean; isSweepBearish: boolean;
    isFvgBullish: boolean; isFvgBearish: boolean;
    session: TradingSession;
    entropy: number; consecutiveLosses: number;
    isLowVolCompression: boolean;
    isUltraCompression: boolean;
    microMomDirection: 'UP' | 'DOWN' | null;
    microMomStrength: number;
    microMomTicks: number;
    // [FIX-7] Trap candle inputs
    trapCandleUp: boolean;
    trapCandleDown: boolean;
    trapStrength: number;
  }): { probability: number; activeSignals: string[]; rawScore: number; signalConflict: boolean } {
    const { direction: dir, isLowVolCompression, isUltraCompression } = params;
    const isBull = dir === 'UP';

    // [FIX-5] Baseline = 0 (neutral), bukan -0.1 (was biased toward DOWN)
    let logOdds = 0;
    const signals: string[] = [];

    // Track scores per arah untuk conflict detection [FIX-9]
    let bullScore = 0, bearScore = 0;

    // Macro Regime
    const macroWeight = 0.15;
    if (params.regime === 'STRONG_BULL')      { 
        logOdds += isBull ? macroWeight : -macroWeight; 
        if (isBull) bullScore += macroWeight; else bearScore += macroWeight;
        signals.push(`StrongBull`); 
    }
    else if (params.regime === 'STRONG_BEAR') { 
        logOdds += isBull ? -macroWeight : macroWeight; 
        if (isBull) bearScore += macroWeight; else bullScore += macroWeight;
        signals.push(`StrongBear`); 
    }
    else if (params.regime === 'WEAK_BULL')   { logOdds += isBull ? 0.08 : -0.05; }
    else if (params.regime === 'WEAK_BEAR')   { logOdds += isBull ? -0.05 : 0.08; }

    // MTF
    if (Math.abs(params.mtfAlignment) > 0.15) {
      const w = params.mtfAlignment * 0.20;
      logOdds += isBull ? w : -w;
      signals.push(`MTF:${w > 0 ? '+' : ''}${(w*100).toFixed(0)}%`);
    }

    // [FIX-6] OFI dengan minimum threshold — noise kecil diabaikan
    const OFI_MIN_THRESHOLD = 0.12;
    const ofiMult = isUltraCompression ? 2.5 : isLowVolCompression ? 1.8 : 1.0;
    const rawOfi  = params.ofiVal;
    if (Math.abs(rawOfi) >= OFI_MIN_THRESHOLD) {
      const weightedOFI = rawOfi * ofiMult;
      const ofiBonus = (isBull ? weightedOFI : -weightedOFI) * 0.22;
      logOdds += ofiBonus;
      signals.push(`OFI:${ofiBonus > 0 ? '+' : ''}${(ofiBonus * 100).toFixed(0)}%`);
    }

    // [FIX-7] Trap Candle Penalty
    if (params.trapCandleUp) {
      // Spike atas = bearish rejection → penalti untuk BULL, bonus untuk BEAR
      const trapPenalty = 0.35 * params.trapStrength;
      logOdds += isBull ? -trapPenalty : +trapPenalty;
      signals.push(`TrapUp(${isBull ? '-' : '+'}${(trapPenalty * 100).toFixed(0)}%)`);
      if (isBull) bullScore += trapPenalty * 2; // counter-weight
    }
    if (params.trapCandleDown) {
      // Spike bawah = bullish rejection → penalti untuk BEAR, bonus untuk BULL
      const trapPenalty = 0.35 * params.trapStrength;
      logOdds += isBull ? +trapPenalty : -trapPenalty;
      signals.push(`TrapDown(${isBull ? '+' : '-'}${(trapPenalty * 100).toFixed(0)}%)`);
      if (!isBull) bearScore += trapPenalty * 2;
    }

    // SMC Structures
    if (isBull) {
      if (params.doubleBottom)  { logOdds += 0.65; bullScore += 0.65; signals.push('DoubleBottom+0.65'); }
      if (params.isSweepBullish){ logOdds += 0.50; bullScore += 0.50; signals.push('SweepBull+0.50'); }
      if (params.isFvgBullish)  { logOdds += 0.22; bullScore += 0.22; signals.push('FVGBull+0.22'); }
    } else {
      if (params.doubleTop)     { logOdds += 0.65; bearScore += 0.65; signals.push('DoubleTop+0.65'); }
      if (params.isSweepBearish){ logOdds += 0.50; bearScore += 0.50; signals.push('SweepBear+0.50'); }
      if (params.isFvgBearish)  { logOdds += 0.22; bearScore += 0.22; signals.push('FVGBear+0.22'); }
    }

    // Candle Patterns
    if (isBull) {
      if (params.isBullishEngulfing){ logOdds += 0.40; bullScore += 0.40; signals.push('BullEngulf+0.40'); }
      if (params.isBullishPinbar)   { logOdds += 0.35; bullScore += 0.35; signals.push('BullPinbar+0.35'); }
      if (params.isHammer)          { logOdds += 0.30; bullScore += 0.30; signals.push('Hammer+0.30'); }
    } else {
      if (params.isBearishEngulfing){ logOdds += 0.40; bearScore += 0.40; signals.push('BearEngulf+0.40'); }
      if (params.isBearishPinbar)   { logOdds += 0.35; bearScore += 0.35; signals.push('BearPinbar+0.35'); }
      if (params.isShootingStar)    { logOdds += 0.30; bearScore += 0.30; signals.push('ShootStar+0.30'); }
    }

    // Mean Reversion (Z-Score & RSI)
    const mrBoost   = isUltraCompression ? 1.6 : isLowVolCompression ? 1.3 : 1.0;
    const zThresh   = 1.3 / mrBoost;
    const rsiOB     = 70 - (mrBoost * 2);
    const rsiOS     = 30 + (mrBoost * 2);

    if (params.zScore > zThresh && !isBull)  { const w = 0.30 * mrBoost; logOdds += w; bearScore += w; signals.push(`ZScore_OB+${w.toFixed(2)}`); }
    if (params.zScore < -zThresh && isBull)  { const w = 0.30 * mrBoost; logOdds += w; bullScore += w; signals.push(`ZScore_OS+${w.toFixed(2)}`); }
    if (params.rsi > rsiOB && !isBull)       { logOdds += 0.25; bearScore += 0.25; signals.push(`RSI_OB+0.25`); }
    if (params.rsi < rsiOS && isBull)        { logOdds += 0.25; bullScore += 0.25; signals.push(`RSI_OS+0.25`); }

    // Micro Momentum
    if (params.microMomDirection && params.microMomTicks >= 2) {
      const mmW = isUltraCompression ? 0.22 : isLowVolCompression ? 0.14 : 0.06;
      const align = (params.microMomDirection === 'UP' && isBull) || (params.microMomDirection === 'DOWN' && !isBull);
      const mmBonus = align ? (params.microMomStrength * mmW) : -(params.microMomStrength * mmW * 0.5);
      logOdds += mmBonus;
      if (mmBonus > 0) { if (isBull) bullScore += mmBonus; else bearScore += mmBonus; }
      signals.push(`MicroMom:${params.microMomDirection}${mmBonus > 0 ? '+' : ''}${(mmBonus * 100).toFixed(0)}%`);
    }

    // BB Squeeze + micro agreement
    if (params.bbSqueeze && params.microMomDirection && Math.abs(params.ofiVal) >= OFI_MIN_THRESHOLD) {
      const ofiAlign = (params.ofiVal > 0 && params.microMomDirection === 'UP') || (params.ofiVal < 0 && params.microMomDirection === 'DOWN');
      if (ofiAlign) {
        const sb = 0.20;
        const sbw = (params.microMomDirection === 'UP' && isBull) || (params.microMomDirection === 'DOWN' && !isBull) ? sb : -sb;
        logOdds += sbw;
        signals.push(`SqueezeBreakout${sbw > 0 ? '+' : ''}${(sbw * 100).toFixed(0)}%`);
      }
    }

    // Session bonus
    if (params.session === 'OVERLAP_LON_NY') { logOdds += 0.04; signals.push('Overlap+0.04'); }

    // [FIX-9] Signal Conflict Detection
    // Jika skor bull dan bear hampir seimbang = pasar tidak jelas = indikasi konflik
    const totalAbsScore = bullScore + bearScore;
    const signalConflict = totalAbsScore > 0.3 &&
      Math.min(bullScore, bearScore) / Math.max(bullScore, bearScore, 0.01) > 0.55;

    if (signalConflict) {
      logOdds -= 0.15; // Penalti konflik: turunkan confidence
      signals.push(`SignalConflict(-15%)`);
      if (this.cfg.debugSignals) {
        console.log(`⚠️  [SignalConflict] bull=${bullScore.toFixed(2)} bear=${bearScore.toFixed(2)} → penalti konflik diterapkan`);
      }
    }

    const probability = 1 / (1 + Math.exp(-logOdds));
    return {
      probability: Math.max(0.30, Math.min(0.95, probability)),
      activeSignals: signals,
      rawScore: logOdds,
      signalConflict,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ORACLE CASCADE — NON-BLOCKING (FIX-1 + FIX-2)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * [FIX-1] Oracle sekarang NON-BLOCKING:
   * - Cerebras gagal → coba Gemini
   * - Gemini gagal → return null (bukan HOLD), fallback ke math decision
   *
   * [FIX-2] Oracle hanya bisa VETO atau CONFIRM, tidak bisa generate arah baru
   * yang memintas pullback check dan probability check.
   */
  private async askOracle(
    mathDirection: PredictionDirection,
    mathProbability: number,
    candlesContext: string,
    memoryContext: string,
  ): Promise<{ veto: boolean; reason: string } | null> {
    const prompt = `You are SOVEREIGN APEX MIND v5.4.4 — Anti-Gocek Oracle for BTC 5m.
The math engine suggests: ${mathDirection} (P=${(mathProbability * 100).toFixed(1)}%).
Review the market context below and issue a VETO if you strongly disagree, or CONFIRM to proceed.
Respond ONLY in pure JSON (no markdown, no backticks):
{"decision":"CONFIRM_TRADE"|"VETO_HOLD","reason":"1 sharp technical sentence in English"}

Context:
${candlesContext}
Memory: ${memoryContext}`;

    // Phase 1: Try Mistral
    const mistralModel = process.env.MISTRAL_MODEL || 'codestral-2501';
    if (this.mistral) {
      try {
        console.log("🌀 [Mistral Oracle] Auditing math decision...");
        const res = await this.mistral.chat.completions.create({
          model: mistralModel,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 200,
        });
        const raw = (res.choices[0].message.content?.trim() || '{}')
          .replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const parsed = JSON.parse(raw);
        return { veto: parsed.decision === 'VETO_HOLD', reason: parsed.reason || '' };
      } catch (err: any) {
        console.warn(`⚠️ [Mistral Timeout/Error]: ${err.message} — trying Cerebras...`);
      }
    }

    // Phase 2: Try Cerebras
    if (this.cerebras) {
      try {
        console.log("🧠 [Cerebras Oracle] Auditing math decision...");
        const res = await this.cerebras.chat.completions.create({
          model: process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          max_tokens: 200,
        });
        const raw = (res.choices[0].message.content?.trim() || '{}')
          .replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const parsed = JSON.parse(raw);
        return { veto: parsed.decision === 'VETO_HOLD', reason: parsed.reason || '' };
      } catch (err: any) {
        console.warn(`⚠️ [Cerebras Timeout/Error]: ${err.message} — trying Gemini...`);
      }
    }

    // Phase 3: Try Gemini
    if (this.gemini) {
      try {
        console.log("♊ [Gemini Oracle] Fail-safe cascade...");
        const response = await this.gemini.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });
        const raw = (response.text?.trim() || '{}')
          .replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
        const parsed = JSON.parse(raw);
        return { veto: parsed.decision === 'VETO_HOLD', reason: parsed.reason || '' };
      } catch (err: any) {
        console.error(`❌ [Gemini Failed]: ${err.message} — falling back to math decision`);
      }
    }

    // Phase 3: Both failed → return null = proceed with math
    return null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // MAIN ANALYSIS ENGINE
  // ───────────────────────────────────────────────────────────────────────────
  private analyzeInternal(
    historicalCandles: CandleData[],
    lastClosedCandle: CandleData,
  ): { instruction: BrainOrderInstruction; meta: BrainMeta; mathDirection: PredictionDirection; mathProb: number } {

    const candles = [...historicalCandles, lastClosedCandle];
    const closes  = candles.map(c => c.close);
    const lastClose = lastClosedCandle.close;

    if (closes.length < this.cfg.minCandlesRequired) {
      const m = this.buildEmptyMeta(lastClosedCandle);
      return { instruction: this.hold(`Data buffer kurang: ${closes.length} < ${this.cfg.minCandlesRequired}`, 0, m), meta: m, mathDirection: 'HOLD', mathProb: 0 };
    }

    // ── [FIX-3] Dual ATR — disesuaikan untuk 5m BTC ──────────────────────────
    const atrLongSeries  = this.atr(candles, 14);
    const atrShortSeries = this.atr(candles.slice(-6), Math.min(4, candles.length - 1));
    const atrLong        = atrLongSeries[atrLongSeries.length - 1];
    const atrShort       = atrShortSeries[atrShortSeries.length - 1];
    const compressionRatio = atrLong > 0 ? atrShort / atrLong : 1.0;
    const atrPctLong     = atrLong  / lastClose;
    const atrPctShort    = atrShort / lastClose;

    // [FIX-3] Threshold lebih sensitif untuk 5m (BTC 5m typical ATR ~0.06–0.12%)
    const isLowVolCompression = atrPctLong  < 0.0007 || compressionRatio < 0.70;
    const isUltraCompression  = compressionRatio < 0.40 || atrPctShort < 0.0004;

    if (this.cfg.debugSignals) {
      const cl = isUltraCompression ? '🔴ULTRA' : isLowVolCompression ? '🟡LOW' : '🟢NORMAL';
      console.log(`📉 [Comp] ${cl} ratio=${compressionRatio.toFixed(3)} atrS=${(atrPctShort*10000).toFixed(2)}bps atrL=${(atrPctLong*10000).toFixed(2)}bps`);
    }

    // ── Adaptive Lookback ─────────────────────────────────────────────────────
    const zLookback   = isUltraCompression ? 5  : isLowVolCompression ? 8  : 20;
    const rsiLookback = isUltraCompression ? 6  : isLowVolCompression ? 9  : this.RSI_P;
    const ofiLookback = isUltraCompression ? 3  : isLowVolCompression ? 4  : this.OFI_W;

    const zScoreVal  = this.zScore(closes, zLookback);
    const rsiVal     = this.rsi(closes, rsiLookback);
    const ofiVal     = this.ofi(candles, ofiLookback);
    const entropyVal = this.entropy(closes);
    const hurstVal   = this.hurst(closes);
    const vwapVal    = this.vwap(candles);
    const bbVal      = this.bb(closes);

    const ema9arr  = this.ema(closes, this.EMA_F);
    const ema21arr = this.ema(closes, this.EMA_M);
    const ema50arr = this.ema(closes, this.EMA_S);
    const ema9  = ema9arr[ema9arr.length - 1];
    const ema21 = ema21arr[ema21arr.length - 1];
    const ema50 = ema50arr[ema50arr.length - 1];

    const emaCross: 'BULLISH' | 'BEARISH' | 'NEUTRAL' =
      ema9 > ema21 * 1.0001 ? 'BULLISH' : ema9 < ema21 * 0.9999 ? 'BEARISH' : 'NEUTRAL';

    const { adx: adxVal, plusDI, minusDI } = this.adx(candles);
    const sessionVal  = this.session(lastClosedCandle.timestamp);
    const macro       = this.macroTrend(candles);
    const wyckoffPhase = this.wyckoff(candles);
    const regimeVal   = this.regime(candles, hurstVal, adxVal, plusDI, minusDI, atrLong, lastClose, macro);

    const { support, resistance }         = this.getDynamicSwingLevels(candles);
    const { doubleBottom, doubleTop }     = this.detectDoublePatterns(candles, support, resistance);
    const { isSweepBullish, isSweepBearish } = this.detectLiquiditySweep(candles);
    const { isFvgBullish, isFvgBearish } = this.detectFVG(candles);
    const cp  = this.candlePatterns(candles);
    const microMom = this.detectMicroMomentum(closes, atrPctShort);

    // [FIX-7] Trap Candle Detection
    const { trapCandleUp, trapCandleDown, trapStrength } = this.detectTrapCandle(candles);

    // Consecutive run count
    let consecutiveDirCount = 0;
    const lastIsGreen = lastClosedCandle.close > lastClosedCandle.open;
    for (let i = candles.length - 2; i >= 0; i--) {
      if ((candles[i].close > candles[i].open) === lastIsGreen) consecutiveDirCount++;
      else break;
    }

    // VPT Divergence
    const VTPT_W   = 6;
    const priorW   = candles.slice(-(VTPT_W + 1), -1);
    const priorT   = priorW.length > 0 ? priorW[priorW.length-1].close - priorW[0].close : 0;
    const avgPVol  = priorW.length > 0 ? priorW.reduce((a,c) => a + c.volume, 0) / priorW.length : 1;
    const lastRet  = lastClosedCandle.close - lastClosedCandle.open;
    const volRatio = avgPVol > 0 ? lastClosedCandle.volume / avgPVol : 0;
    const isVolSpike = volRatio > 1.4;
    const bullVPT = priorT < 0 && lastRet > 0 && isVolSpike;
    const bearVPT = priorT > 0 && lastRet < 0 && isVolSpike;

    // ── [FIX-4] Direction Voting — Anti-Conflict ─────────────────────────────
    const bullSignalCount =
      (isSweepBullish ? 1 : 0) + (doubleBottom ? 1 : 0) +
      (cp.isBullishEngulfing ? 1 : 0) + (cp.isBullishPinbar ? 1 : 0) + (cp.isHammer ? 1 : 0) +
      (isFvgBullish ? 1 : 0) + (bullVPT ? 1 : 0) + (trapCandleDown ? 1 : 0);

    const bearSignalCount =
      (isSweepBearish ? 1 : 0) + (doubleTop ? 1 : 0) +
      (cp.isBearishEngulfing ? 1 : 0) + (cp.isBearishPinbar ? 1 : 0) + (cp.isShootingStar ? 1 : 0) +
      (isFvgBearish ? 1 : 0) + (bearVPT ? 1 : 0) + (trapCandleUp ? 1 : 0);

    let baseDirection: PredictionDirection;

    if (isUltraCompression && microMom.direction && microMom.consecutiveTicks >= 3) {
      // Ultra compression: micro momentum override
      baseDirection = microMom.direction;
      console.log(`⚡ [P11/ULTRA] Micro-run override → ${baseDirection} (${microMom.consecutiveTicks} ticks)`);
    } else if (bullSignalCount > bearSignalCount) {
      baseDirection = 'UP';
    } else if (bearSignalCount > bullSignalCount) {
      baseDirection = 'DOWN';
    } else if (bullSignalCount === bearSignalCount && bullSignalCount > 0) {
      // [FIX-4] Tie dengan signal ada = conflict → fallback ke macro, jika macro FLAT → HOLD
      if (macro.dominant !== 'FLAT') {
        baseDirection = macro.dominant === 'BULL' ? 'UP' : 'DOWN';
      } else {
        // HOLD jika tie dan macro tidak memberikan arah
        const m = this.buildMetaObject({
          zScoreVal, rsiVal, hurstVal, entropyVal, ema9, ema21, ema50, adxVal, plusDI, minusDI,
          atrLong, atrPctLong, ofiVal, vwapVal, bbVal, regimeVal, wyckoffPhase, sessionVal,
          doubleBottom, doubleTop, isSweepBullish, isSweepBearish, isFvgBullish, isFvgBearish,
          cp, rawScore: 0, pullbackScore: 0, pbSignals: [],
          microMom, compressionRatio, atrPctShort, isLowVolCompression, isUltraCompression,
          trapCandleUp, trapCandleDown, signalConflict: true,
        });
        return {
          instruction: this.hold(`⚠️ Signal conflict: bull=${bullSignalCount} bear=${bearSignalCount}, macro=FLAT → HOLD`, 0, m),
          meta: m, mathDirection: 'HOLD', mathProb: 0
        };
      }
    } else {
      // Tidak ada signal reversal → ikut macro atau OFI
      if (macro.dominant !== 'FLAT') {
        baseDirection = macro.dominant === 'BULL' ? 'UP' : 'DOWN';
      } else {
        // Fallback: zScore mean reversion (lebih reliable dari OFI saat FLAT)
        baseDirection = zScoreVal < -0.5 ? 'UP' : zScoreVal > 0.5 ? 'DOWN' : ofiVal >= 0 ? 'UP' : 'DOWN';
      }
    }

    // Pullback Score
    const pbResult = this.calcPullbackScore({
      candles, rsiVal, ofiVal, zScoreVal, atrVal: atrLong, ema9, ema21,
      candleRunCount: consecutiveDirCount, lastCandleIsGreen: lastIsGreen,
      macroDominant: macro.dominant, macroStrength: macro.dominantStrength,
      sweepBull: isSweepBullish, sweepBear: isSweepBearish,
      bullEngulf: cp.isBullishEngulfing, bearEngulf: cp.isBearishEngulfing,
      hammer: cp.isHammer, shootingStar: cp.isShootingStar,
      bullPinbar: cp.isBullishPinbar, bearPinbar: cp.isBearishPinbar,
      vwapVal, lastClose,
    });

    // Probability
    const { probability, activeSignals, rawScore, signalConflict } = this.calcProbabilityV2({
      direction: baseDirection, zScore: zScoreVal, rsi: rsiVal, hurst: hurstVal,
      adx: adxVal, plusDI, minusDI, regime: regimeVal, wyckoff: wyckoffPhase,
      ofiVal, mtfAlignment: 0,
      earlyReversal: bullSignalCount > 0 || bearSignalCount > 0,
      vptDivergence: bullVPT || bearVPT,
      bbSqueeze: bbVal.squeeze,
      isBullishEngulfing: cp.isBullishEngulfing, isBearishEngulfing: cp.isBearishEngulfing,
      isBullishPinbar: cp.isBullishPinbar, isBearishPinbar: cp.isBearishPinbar,
      isHammer: cp.isHammer, isShootingStar: cp.isShootingStar,
      doubleBottom, doubleTop, isSweepBullish, isSweepBearish, isFvgBullish, isFvgBearish,
      session: sessionVal, entropy: entropyVal, consecutiveLosses: this.consLosses,
      isLowVolCompression, isUltraCompression,
      microMomDirection: microMom.direction, microMomStrength: microMom.strength, microMomTicks: microMom.consecutiveTicks,
      trapCandleUp, trapCandleDown, trapStrength,
    });

    const meta = this.buildMetaObject({
      zScoreVal, rsiVal, hurstVal, entropyVal, ema9, ema21, ema50, adxVal, plusDI, minusDI,
      atrLong, atrPctLong, ofiVal, vwapVal, bbVal, regimeVal, wyckoffPhase, sessionVal,
      doubleBottom, doubleTop, isSweepBullish, isSweepBearish, isFvgBullish, isFvgBearish,
      cp, rawScore, pullbackScore: pbResult.score, pbSignals: pbResult.signals,
      microMom, compressionRatio, atrPctShort, isLowVolCompression, isUltraCompression,
      trapCandleUp, trapCandleDown, signalConflict,
      activeSignals,
    });

    // Circuit Breakers - DISABLED per user request "hilangkan pause saat losestreak"
    // if (this.consLosses >= this.cfg.losingStreakPause) {
    //   return { instruction: this.hold(`⏸️ Auto-pause: ${this.consLosses} loss streak`, 0, meta), meta, mathDirection: 'HOLD', mathProb: 0 };
    // }

    // EMA Guard
    if (!this.cfg.disableEMAGuard && emaCross !== 'NEUTRAL') {
      const emaPenalty = isUltraCompression ? 0.01 : isLowVolCompression ? 0.03 : 0.08;
      const isEMAMismatch = (baseDirection === 'UP' && emaCross === 'BEARISH') || (baseDirection === 'DOWN' && emaCross === 'BULLISH');
      if (isEMAMismatch && Math.abs(rawScore) < emaPenalty) {
        return { instruction: this.hold(`💤 EMA Guard: ${emaCross} vs ${baseDirection}`, probability, meta), meta, mathDirection: 'HOLD', mathProb: probability };
      }
    }

    // Pullback Contra Check
    const pbThreshold = isUltraCompression ? 0.18 : isLowVolCompression ? 0.28 : 0.38;
    const isPullbackContra = (baseDirection === 'UP' && pbResult.score < -pbThreshold) || (baseDirection === 'DOWN' && pbResult.score > pbThreshold);
    if (isPullbackContra) {
      return {
        instruction: this.hold(`💤 Pullback block: score=${pbResult.score.toFixed(3)} | ${pbResult.signals.join(',')}`, probability, meta),
        meta, mathDirection: 'HOLD', mathProb: probability
      };
    }

    // Final math check
    if (probability < this.dynThreshold) {
      return {
        instruction: this.hold(`💤 P=${(probability*100).toFixed(1)}% < ${(this.dynThreshold*100).toFixed(1)}%`, probability, meta),
        meta, mathDirection: baseDirection, mathProb: probability
      };
    }

    // TRADE!
    const reason = `🚀 [Math v5.4.4] ${baseDirection} P=${(probability*100).toFixed(1)}% | ${activeSignals.join(',')}`;
    const instruction: BrainOrderInstruction = {
      direction: baseDirection,
      confidence: probability,
      tradeAmount: this.cfg.flatStake,
      limitOrderDurationMs: this.cfg.cancelDurationMs,
      reason,
      meta,
    };

    this.recentTrades.push({
      timestamp: Date.now(), direction: baseDirection, outcome: 'PENDING',
      session: sessionVal, regime: regimeVal, confidence: probability, reason,
      metrics: { rsi: rsiVal, zScore: zScoreVal, adx: adxVal, ofi: ofiVal, hurst: hurstVal, entropy: entropyVal, mtf: 0, close: lastClose }
    });
    if (this.recentTrades.length > 20) this.recentTrades.shift();

    return { instruction, meta, mathDirection: baseDirection, mathProb: probability };
  }

  // ── Meta Builder helpers ────────────────────────────────────────────────────
  private buildEmptyMeta(c: CandleData): BrainMeta {
    return {
      zScore: 0, rsi: 50, hurst: 0.5, entropy: 1, ema9: c.close, ema21: c.close, ema50: c.close,
      adx: 20, plusDI: 25, minusDI: 25, atr: 0, atrPct: 0, ofi: 0, vwap: c.close,
      bbSqueeze: false, bbWidth: 0, regime: 'RANGING', wyckoff: 'UNKNOWN', mtfScore: 0, mtfDetails: '',
      session: this.session(c.timestamp), doubleBottom: false, doubleTop: false,
      sweepBull: false, sweepBear: false, fvgBull: false, fvgBear: false,
      bullEngulf: false, bearEngulf: false, bullPinbar: false, bearPinbar: false,
      hammer: false, shootingStar: false, rejection: 0, activeSignals: [], rawScore: 0,
      threshold: this.dynThreshold, consecutiveLosses: this.consLosses, streak: this.streak,
      bayesWR: this.bayesA / (this.bayesA + this.bayesB), aggressiveMode: true,
      pullbackScore: 0, shortMomentumFlip: null, reversalEpochCount: 0,
      isLowVolCompression: false, isUltraCompression: false, compressionRatio: 1,
      atrPctShort: 0, microMomDirection: null, microMomStrength: 0, microMomTicks: 0,
      trapCandleUp: false, trapCandleDown: false, signalConflict: false,
    };
  }

  private buildMetaObject(p: {
    zScoreVal: number; rsiVal: number; hurstVal: number; entropyVal: number;
    ema9: number; ema21: number; ema50: number; adxVal: number; plusDI: number; minusDI: number;
    atrLong: number; atrPctLong: number; ofiVal: number; vwapVal: number;
    bbVal: { squeeze: boolean; width: number };
    regimeVal: MarketRegime; wyckoffPhase: WyckoffPhase; sessionVal: TradingSession;
    doubleBottom: boolean; doubleTop: boolean; isSweepBullish: boolean; isSweepBearish: boolean;
    isFvgBullish: boolean; isFvgBearish: boolean;
    cp: any; rawScore: number; pullbackScore: number; pbSignals: string[];
    microMom: { direction: 'UP'|'DOWN'|null; strength: number; consecutiveTicks: number };
    compressionRatio: number; atrPctShort: number;
    isLowVolCompression: boolean; isUltraCompression: boolean;
    trapCandleUp: boolean; trapCandleDown: boolean; signalConflict: boolean;
    activeSignals?: string[];
  }): BrainMeta {
    return {
      zScore: p.zScoreVal, rsi: p.rsiVal, hurst: p.hurstVal, entropy: p.entropyVal,
      ema9: p.ema9, ema21: p.ema21, ema50: p.ema50,
      adx: p.adxVal, plusDI: p.plusDI, minusDI: p.minusDI,
      atr: p.atrLong, atrPct: p.atrPctLong, ofi: p.ofiVal, vwap: p.vwapVal,
      bbSqueeze: p.bbVal.squeeze, bbWidth: p.bbVal.width,
      regime: p.regimeVal, wyckoff: p.wyckoffPhase, mtfScore: 0, mtfDetails: '',
      session: p.sessionVal,
      doubleBottom: p.doubleBottom, doubleTop: p.doubleTop,
      sweepBull: p.isSweepBullish, sweepBear: p.isSweepBearish,
      fvgBull: p.isFvgBullish, fvgBear: p.isFvgBearish,
      bullEngulf: p.cp.isBullishEngulfing, bearEngulf: p.cp.isBearishEngulfing,
      bullPinbar: p.cp.isBullishPinbar, bearPinbar: p.cp.isBearishPinbar,
      hammer: p.cp.isHammer, shootingStar: p.cp.isShootingStar,
      rejection: p.cp.rejectionRatio ?? 0,
      activeSignals: [...(p.activeSignals ?? []), ...p.pbSignals],
      rawScore: p.rawScore, threshold: this.dynThreshold,
      consecutiveLosses: this.consLosses, streak: this.streak,
      bayesWR: this.bayesA / (this.bayesA + this.bayesB), aggressiveMode: true,
      pullbackScore: p.pullbackScore, shortMomentumFlip: p.microMom.direction,
      reversalEpochCount: this.epochReversalState?.epochCount ?? 0,
      isLowVolCompression: p.isLowVolCompression, isUltraCompression: p.isUltraCompression,
      compressionRatio: p.compressionRatio, atrPctShort: p.atrPctShort,
      microMomDirection: p.microMom.direction, microMomStrength: p.microMom.strength,
      microMomTicks: p.microMom.consecutiveTicks,
      trapCandleUp: p.trapCandleUp, trapCandleDown: p.trapCandleDown, signalConflict: p.signalConflict,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PUBLIC ENTRY POINT
  // ───────────────────────────────────────────────────────────────────────────
  public async analyzeNewEpoch(
    historicalCandles: CandleData[],
    lastClosedCandle: CandleData,
    marketPrice?: number,
  ): Promise<BrainOrderInstruction> {

    // Chrono Guard
    let sorted = [...historicalCandles];
    if (sorted.length >= 2 && sorted[0].timestamp > sorted[sorted.length - 1].timestamp) {
      sorted.reverse();
      console.log("🔄 [CHRONO GUARD] Corrected candle order to ascending.");
    }

    // Math engine (synchronous core logic)
    const { instruction: mathResult, meta, mathDirection, mathProb } = this.analyzeInternal(sorted, lastClosedCandle);

    // [FIX-1] Oracle sebagai OPTIONAL audit — kegagalan oracle tidak blocking
    if (mathDirection !== 'HOLD' && mathProb >= this.dynThreshold && (this.cerebras || this.gemini)) {
      const candlesCtx = this.formatCandlesForLLM([...sorted, lastClosedCandle], meta.vwap, lastClosedCandle.close);
      const memCtx     = this.formatMemoryForLLM();

      try {
        const oracleResult = await this.askOracle(mathDirection, mathProb, candlesCtx, memCtx);

        if (oracleResult === null) {
          // Kedua oracle gagal → proceed math, tidak perlu hold
          console.log("⚡ [Oracle Fallback] Both oracles failed — proceeding with math decision.");
          return mathResult;
        }

        if (oracleResult.veto) {
          console.log(`🛑 [Oracle VETO]: ${oracleResult.reason}`);
          // [FIX-2] Oracle hanya bisa veto, arah dari oracle tidak bisa bypass pullback check
          return this.hold(`🛑 [Oracle VETO]: ${oracleResult.reason}`, mathProb, meta);
        } else {
          console.log(`✅ [Oracle CONFIRM]: ${oracleResult.reason}`);
          // Tambahkan konfirmasi oracle ke reason
          return {
            ...mathResult,
            reason: `🚀 [Oracle Confirmed] ${oracleResult.reason} | ${mathResult.reason}`,
          };
        }
      } catch (err: any) {
        // [FIX-1] Error pada oracle logic = lanjut dengan math
        console.warn(`⚠️ [Oracle Error]: ${err.message} — proceeding with math.`);
        return mathResult;
      }
    }

    return mathResult;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

export const sovereignApexMind = new SovereignApexMind({}, AGGRESSIVE_PRESET);
export const hybridBrain = sovereignApexMind;

export async function analyzeEpoch(
  historicalCandles: CandleData[],
  lastClosedCandle: CandleData,
  marketPrice?: number,
): Promise<BrainOrderInstruction> {
  return sovereignApexMind.analyzeNewEpoch(historicalCandles, lastClosedCandle, marketPrice);
}

export function updateResult(result: 'WIN' | 'LOSS'): void {
  sovereignApexMind.updateTradeHistory(result);
}

export function getBrainState(): BrainState {
  return sovereignApexMind.getState();
}
