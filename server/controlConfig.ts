import { timingSafeEqual } from 'node:crypto';
import type { ArbitrageConfig } from './arbitrage-engine';

const ranges: Record<string, [number, number, boolean?]> = {
  minPriceMovePct: [0.001, 5], detectionWindowMs: [50, 10000, true],
  minEdge: [0.001, 0.5], minConfidence: [0.1, 1],
  volumeSpikeMultiplier: [1, 20], orderBookImbalanceThreshold: [0, 1],
  maxTradeAmount: [0.01, 10000], maxTradesPerHour: [1, 1000, true],
  maxDailyLoss: [0.01, 100000], cooldownMs: [100, 3600000, true],
  kellyFraction: [0.01, 0.25], hedgeRatio: [0, 1],
  executionSlippage: [0, 0.02], predictSyncIntervalMs: [1000, 30000, true],
  takeProfitPct: [0.001, 1], stopLossPct: [0.001, 1],
};
const booleans = new Set(['isPaperTrading', 'enableAutoTrade', 'debug']);
const aliases: Record<string, string> = {
  maxDailyLossUsdt: 'maxDailyLoss', betAmountUsdt: 'maxTradeAmount',
};

export function validateControlConfig(input: unknown, env = process.env): Partial<ArbitrageConfig> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Configuration must be an object');
  const output: Record<string, number | boolean> = {};
  for (const [originalKey, value] of Object.entries(input)) {
    const key = Object.hasOwn(aliases, originalKey) ? aliases[originalKey] : originalKey;
    if (key === 'isLiveTrading') {
      if (typeof value !== 'boolean') throw new Error('isLiveTrading must be a boolean');
      if (output.isPaperTrading !== undefined && output.isPaperTrading !== !value) throw new Error('Conflicting trading modes');
      output.isPaperTrading = !value;
    } else if (booleans.has(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
      if (key === 'isPaperTrading' && output.isPaperTrading !== undefined && output.isPaperTrading !== value) throw new Error('Conflicting trading modes');
      output[key] = value;
    } else if (Object.hasOwn(ranges, key)) {
      const [min, max, integer] = ranges[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
        throw new Error(`${key} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}`);
      }
      if (output[key] !== undefined && output[key] !== value) throw new Error(`Conflicting values for ${key}`);
      output[key] = value;
    } else {
      throw new Error(`Unsupported setting: ${originalKey}. Credentials and connection endpoints belong in the server environment.`);
    }
  }
  if (output.isPaperTrading === false) {
    if (env.ENABLE_LIVE_TRADING !== 'true') throw new Error('Live trading requires ENABLE_LIVE_TRADING=true on the server');
    if (!env.BOT_CONTROL_TOKEN || env.BOT_CONTROL_TOKEN.length < 24) throw new Error('Live trading requires a BOT_CONTROL_TOKEN of at least 24 characters');
    if (!env.WALLET_PRIVATE_KEY || !env.PREDICT_FUN_API_KEY) throw new Error('Live trading requires new wallet credentials and a Predict API key on the server');
  }
  return output as Partial<ArbitrageConfig>;
}

export function publicConfig(config: ArbitrageConfig): Partial<ArbitrageConfig> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => Object.hasOwn(ranges, key) || booleans.has(key))) as Partial<ArbitrageConfig>;
}

export function validControlToken(header: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  const supplied = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sameOriginRequest(origin: string | undefined, host: string | undefined): boolean {
  if (!origin) return true; // CLI clients use the bearer token when configured.
  try { return new URL(origin).host === host; } catch { return false; }
}
