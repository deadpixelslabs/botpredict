export interface EpochState {
  epochStart: number;
  settleUntil: number;
  candidates: any[];
  locked: any | null;
  lastDirection: string | null;
}

export const EPOCH_MS_DEFAULT = 5 * 60 * 1000;

const store = new Map<string, EpochState>(); // symbol -> state

export function resolveEpochStart(epochStartMs: number | null, epochLenMs: number): number {
  const base = epochStartMs || Date.now();
  return Math.floor(base / epochLenMs) * epochLenMs;
}

export function getState(symbol: string): EpochState | null {
  return store.get(symbol) || null;
}

export function initState(symbol: string, epochStart: number, settleWindowMs: number): EpochState {
  const prev = store.get(symbol);
  const state: EpochState = {
    epochStart,
    settleUntil: epochStart + settleWindowMs,
    candidates: [],
    locked: null,
    lastDirection: prev && prev.locked && prev.locked.direction !== 'SKIP'
      ? prev.locked.direction
      : (prev ? prev.lastDirection : null),
  };
  store.set(symbol, state);
  return state;
}

export function reset(symbol: string): void {
  store.delete(symbol);
}

export function resetAll(): void {
  store.clear();
}
