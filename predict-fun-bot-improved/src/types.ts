/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SystemConfig {
  bscRpc: string;
  walletPrivateKey: string;
  walletAddress: string;
  smartWalletAddress?: string;
  betAmountUsdt: number;
  minConfidence: number; // 0 to 1
  minPriceMovePct?: number; // minimum price move to trigger (e.g. 0.02)
  isLiveTrading: boolean; // toggle between Live & Simulation
  maxDailyLossUsdt: number;
  predictContractAddress: string;
  brainMode?: 'conservative' | 'aggressive';
  brainPreset?: 'AGGRESSIVE_PRESET' | 'NORMAL_PRESET' | 'HYPER_PRESET';
  simulateLiveBalances?: boolean;
  cerebrasApiEndpoint?: string;
  cerebrasModel?: string;
  nvidiaApiEndpoint?: string;
  nvidiaModel?: string;
  mistralApiEndpoint?: string;
  mistralModel?: string;
  biconomyBundlerUrl?: string;
  biconomyPaymasterApiKey?: string;
  predictApiOverrideUrl?: string;
  executionSlippage?: number;
  predictSyncIntervalMs?: number;
}

export interface TradeLog {
  id: string;
  epoch: number;
  timestamp: number;
  position: 'BULL' | 'BEAR';
  amount: number;
  lockPrice?: number;
  closePrice?: number;
  status: 'PENDING' | 'WON' | 'LOST' | 'CLAIMED' | 'REFUNDED' | 'FAILED';
  pnl?: number; // net BNB change
  confidence: number;
  aiExplanation?: string;
  txHash?: string;
  claimTxHash?: string;
  firedSignals?: string[]; // Adaptive reinforcement learning signal trackers
  regime?: string;
  pattern?: string;
  poolPattern?: string;
  pRaw?: number;
  pUp?: number;
  features?: { key: string; value: number }[];
}

export interface LogMessage {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error' | 'success';
  message: string;
}

export interface PredictionState {
  currentEpoch: number;
  secondsRemaining: number;
  bullAmount: number; // total BNB bet Bull
  bearAmount: number; // total BNB bet Bear
  bullPayout: number; // e.g. 1.85
  bearPayout: number; // e.g. 2.15
  btcPrice: number;
  walletBalanceUsdt?: number;
  estimatedGasCostUsdt?: number;
  liveRounds?: RoundPriceState[];
  macroStrategy?: string; // High-level macro analyst strategy from NVIDIA Nemotron
  aiPrediction?: {
    direction: 'BULL' | 'BEAR' | 'HOLD';
    confidence: number;
    reasoning: string;
    detailedSignals?: { key: string; score: number | string }[];
    indicators: {
      rsi: number;
      macd: string; // "BULLISH" | "BEARISH" | "NEUTRAL"
      bollinger: string; // "OVERBOUGHT" | "OVERSOLD" | "NEUTRAL"
      imbalance: number; // on-chain pool imbalance
    };
  };
}

export interface RoundPriceState {
  epoch: number;
  lockPrice: number;
    closePrice: number;
  status: 'BIDDING' | 'LIVE' | 'CLOSED';
}

export interface PerformanceStats {
  winRate: number;
  totalTrades: number;
  wins: number;
  losses: number;
  totalPnLUsdt: number;
  dailyLossUsdt: number;
  simulationWinRate: number;
  simulationTotalTrades: number;
  simulationWins: number;
  simulationLosses: number;
  simulationPnLUsdt: number;
}
