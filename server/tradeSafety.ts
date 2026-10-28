/**
 * Pure execution/accounting guards. Fee values are conservative taker estimates;
 * actual settlement fees and wallet balances remain authoritative.
 * Uses the market feeRateBps as a full-notional bound, not a verified fee curve.
 * Both fee denomination and actual settlement cost require receipt reconciliation.
 */
export type TradingMode = 'paper' | 'live';

export interface RiskTrade {
  id: string;
  timestamp: number;
  resolvedAt?: number;
  mode?: TradingMode | 'unknown';
  amount: number;
  pnl?: number;
  resolved?: boolean;
  isSold?: boolean;
  isCancelled?: boolean;
}

function requireNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be finite and non-negative`);
}

function validatePriceAndFee(price: number, feeRateBps: number): void {
  if (!Number.isFinite(price) || price <= 0 || price >= 1) throw new RangeError('Share price must be strictly between 0 and 1');
  requireNonNegative(feeRateBps, 'feeRateBps');
  if (feeRateBps > 10000) throw new RangeError('feeRateBps exceeds 10000');
}

/** Full-notional fee reserve per share; does not assume a discounted price curve. */
export function feeCollateralPerShare(price: number, feeRateBps: number): number {
  validatePriceAndFee(price, feeRateBps);
  return (feeRateBps / 10000) * price;
}

/** Reserve collateral fee before estimating received shares; conservative across fee denominations. */
export function estimateBuyShares(budget: number, price: number, feeRateBps: number): number {
  requireNonNegative(budget, 'budget');
  const fee = feeCollateralPerShare(price, feeRateBps);
  return (budget / (1 + feeRateBps / 10000) / price) * Math.max(0, 1 - fee / price);
}

/** SELL fees are estimated in collateral, with no account discount or maker rebate. */
export function estimateSellProceeds(shares: number, price: number, feeRateBps: number): number {
  requireNonNegative(shares, 'shares');
  const fee = feeCollateralPerShare(price, feeRateBps);
  return shares * Math.max(0, price - fee);
}

/** Probability margin above break-even after the conservative BUY share fee. */
export function expectedNetEdge(fairProbability: number, buyPrice: number, feeRateBps: number): number {
  if (!Number.isFinite(fairProbability) || fairProbability < 0 || fairProbability > 1) throw new RangeError('Probability must be between 0 and 1');
  const retainedFraction = 1 - feeCollateralPerShare(buyPrice, feeRateBps) / buyPrice;
  if (retainedFraction <= 0) return -Infinity;
  return fairProbability - buyPrice * (1 + feeRateBps / 10000) / retainedFraction;
}

export function tradeMode(trade: Pick<RiskTrade, 'id' | 'mode'>): TradingMode {
  if (trade.mode === 'paper' || trade.mode === 'live') return trade.mode;
  // Migration for historical files created before explicit mode was persisted.
  return /^Paper(?:Fallback)?_/.test(trade.id) ? 'paper' : 'live';
}

/** UTC calendar day; restart-safe because counters are rebuilt from the ledger. */
export function getRiskSnapshot(trades: readonly RiskTrade[], isPaper: boolean, now = Date.now()): {
  tradesThisHour: number;
  dailyPnl: number;
  pendingExposure: number;
} {
  const currentMode: TradingMode = isPaper ? 'paper' : 'live';
  const date = new Date(now);
  const dayStart = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  let tradesThisHour = 0;
  let dailyPnl = 0;
  let pendingExposure = 0;
  for (const trade of trades) {
    if (trade.mode === 'unknown' || tradeMode(trade) !== currentMode) continue;
    // Cancelled submissions still count against the API/order attempt rate limit.
    if (Number.isFinite(trade.timestamp) && trade.timestamp > now - 3600000 && trade.timestamp <= now) tradesThisHour++;
    if (!trade.resolved && !trade.isSold && !trade.isCancelled && Number.isFinite(trade.amount)) {
      pendingExposure += Math.max(0, trade.amount);
    }
    if (!trade.resolved || trade.isCancelled || !Number.isFinite(trade.pnl)) continue;
    // Old ledgers lack settlement timestamps. Entry timestamp is a migration-only
    // approximation; all newly resolved records must persist resolvedAt.
    const settledAt = trade.resolvedAt ?? trade.timestamp;
    if (Number.isFinite(settledAt) && settledAt >= dayStart && settledAt <= now) dailyPnl += trade.pnl!;
  }
  return { tradesThisHour, dailyPnl, pendingExposure };
}

function direction(value: unknown): 'UP' | 'DOWN' | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().toUpperCase();
  return name === 'UP' || name === 'DOWN' ? name : null;
}

/** CLOSED only means trading stopped. A named, authoritative resolution is needed. */
export function getResolvedWinner(market: any): 'UP' | 'DOWN' | null {
  if (!market || String(market.status).toUpperCase() !== 'RESOLVED') return null;
  const winners: Array<'UP' | 'DOWN'> = [];
  if (Array.isArray(market.outcomes)) {
    for (const outcome of market.outcomes) {
      if (String(outcome?.status).toUpperCase() !== 'WON') continue;
      const winner = direction(outcome?.name);
      if (!winner) return null;
      winners.push(winner);
    }
  }
  const resolutionWinner = direction(market.resolution?.name);
  if (resolutionWinner) winners.push(resolutionWinner);
  const unique = new Set(winners);
  return unique.size === 1 ? unique.values().next().value! : null;
}
