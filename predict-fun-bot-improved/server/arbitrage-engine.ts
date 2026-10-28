import WebSocket from 'ws';
import axios from 'axios';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { ethers } from 'ethers';
import { LatencyDetector } from './LatencyDetector';
import { PredictOrderbookFeed } from './PredictOrderbookFeed';
import { validateControlConfig, publicConfig } from './controlConfig';
import { estimateBuyShares, estimateSellProceeds, expectedNetEdge, getRiskSnapshot, getResolvedWinner } from './tradeSafety';
import { placePredictOrder, checkAndCancelPredictOrder, checkPredictOrderStatus, getUserPositions, preWarmPredictClient } from './predictClient';

// Reuse TCP/TLS connections across requests instead of renegotiating a handshake every call.
// This alone can shave 50-150ms off each Binance/predict.fun REST round-trip, which matters
// when we're racing a moving market.
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 5000 });
axios.defaults.httpsAgent = keepAliveAgent;

let cachedSystemConfig: any = null;
let lastConfigLoadTime = 0;

// Helper to load platform config dynamically with in-memory caching to prevent synchronous disk I/O latency during fast execution loops
function getSystemConfig() {
  const now = Date.now();
  if (!cachedSystemConfig || now - lastConfigLoadTime >= 1000) {
    try {
      const configPath = path.join(process.cwd(), 'data', 'config.json');
      cachedSystemConfig = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf-8')) : {};
      lastConfigLoadTime = now;
    } catch { cachedSystemConfig ??= {}; }
  }
  return {
    ...cachedSystemConfig,
    walletPrivateKey: process.env.WALLET_PRIVATE_KEY || '',
    smartWalletAddress: process.env.PREDICT_ACCOUNT_ADDRESS || '',
    walletAddress: process.env.WALLET_ADDRESS || '',
  };
}

// Robust helper to fetch exact historical BTC/USDT spot price at a specific timestamp (in seconds)
// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
export interface BinanceTick {
  price: number;
  timestamp: number;
  volume: number;
  isBuyerMaker: boolean;
}

export interface PredictFunOdds {
  marketId: string;
  upOdds: number;      // decimal odds (e.g., 1.85)
  downOdds: number;    // decimal odds (e.g., 2.10)
  timestamp: number;
  expiresAt: number;   // when market closes
}

export interface ArbitrageSignal {
  direction: 'UP' | 'DOWN';
  edge: number;              // expected edge (e.g., 0.05 = 5%)
  confidence: number;        // 0-1
  fairOdds: number;          // calculated fair odds
  marketOdds: number;        // predict.fun odds
  momentum: number;          // price momentum strength
  volumeSpike: boolean;      // sudden volume increase
  orderBookImbalance: number; // -1 to 1
  latencyMs: number;         // how fast we detected
  reason: string;
  isFastSpike?: boolean;     // true if triggered by the hyper-aggressive sniper rule (needs a bigger limit-price buffer)
}

export interface ArbitrageTrade {
  id: string;
  timestamp: number;
  direction: 'UP' | 'DOWN';
  amount: number;
  entryOdds: number;
  fairOdds: number;
  edge: number;
  outcome?: 'WIN' | 'LOSS';
  pnl?: number;
  signal: ArbitrageSignal;
  targetLockTime?: number; // target lock timestamp (seconds, divisible by 300)
  lockPrice?: number;      // BTC price at lock time
  closePrice?: number;     // BTC price at close time
  resolved?: boolean;      // true if resolution done
  
  mode?: 'paper' | 'live' | 'unknown';
  resolvedAt?: number;
  orderId?: string;
  orderExpiration?: number;
  sellExpiration?: number;
  tokenId?: string;
  submittedShares?: number;
  submittedAmount?: number;
  feeRateBps?: number;
  soldProceeds?: number;
  sellSubmittedShares?: number;
  submissionUncertain?: boolean;
  pnlIsEstimate?: boolean;
  lastFillCheckAt?: number;
  lastSellFillCheckAt?: number;
  reconciliationRequired?: boolean;

  // Instant Sell tracking
  sharesQuantity?: number; // How many shares we bought
  entryBtcPrice?: number;  // The BTC price at the moment of entry
  entryBid?: number;       // The bid price at the moment of entry to protect against initial spread
  isSold?: boolean;        // Have we sold it back to the orderbook?
  sellPrice?: number;      // The price per share we sold at

  // Live order status / 5s timeout tracking
  orderHash?: string;      // The order hash returned by placePredictOrder
  isFilled?: boolean;      // Whether the order is filled
  fillTimestamp?: number;  // The timestamp when the order was filled
  isCancelled?: boolean;   // Whether the order was cancelled because it wasn't filled within 5 seconds
  cancelledAt?: number;    // The timestamp when the order was cancelled (gives 15s buffer for late fills)
  isCheckingFill?: boolean; // Avoid concurrent status checking API calls
  isSharesSynced?: boolean; // True if sharesQuantity matches actual on-chain balance

  // Live sell order tracking
  sellOrderHash?: string;       // The order hash returned by the placePredictOrder SELL order
  sellOrderId?: string;         // The order ID returned by the placePredictOrder SELL order
  isSellOrderPlaced?: boolean;  // True if we submitted a sell order to Predict.fun
  sellRetries?: number;         // Number of times we retried selling
  isSellFilled?: boolean;       // True if the sell order is fully filled
  sellOrderTimestamp?: number;  // When the sell order was placed
  isCheckingSellFill?: boolean; // To avoid concurrent status checking for sell orders
  lastSellAttemptTime?: number; // Timing of last sell attempt for cooldown on retries
}

export interface ArbitrageConfig {
  binanceWsUrl: string;
  binanceOrderBookUrl: string;
  predictFunApiUrl: string;
  predictFunApiKey: string;
  
  // Detection thresholds
  minPriceMovePct: number;       // minimum price move to trigger (default 0.05%)
  detectionWindowMs: number;     // window to detect move (default 250ms)
  minEdge: number;               // minimum edge to trade (default 0.03 = 3%)
  minConfidence: number;         // minimum confidence (default 0.60)
  
  // Volume & orderbook
  volumeSpikeMultiplier: number; // volume spike threshold (default 2.5x)
  orderBookImbalanceThreshold: number; // default 0.30
  
  // Risk management
  maxTradeAmount: number;        // max $ per trade (default 10)
  maxTradesPerHour: number;      // rate limit (default 1000)
  maxDailyLoss: number;          // stop loss (default 5000)
  cooldownMs: number;            // cooldown between trades (default 5000ms)
  kellyFraction: number;         // position sizing (default 0.25)
  
  // Execution
  isPaperTrading: boolean;       // paper trade mode (default true)
  enableAutoTrade: boolean;      // auto-place bets (default false)
  enableHedge: boolean;          // hedge in Binance futures (default false)
  hedgeRatio: number;            // hedge percentage (default 0.5)
  executionSlippage?: number;    // slippage tolerance for snipers (e.g. 0.5)
  predictSyncIntervalMs?: number;// fast loop polling delay in ms (e.g. 150)
  
  // Memory
  memoryFilePath: string;        // trade history file

  takeProfitPct?: number;        // take profit ratio (e.g. 0.05 for 5%)
  stopLossPct?: number;          // stop loss ratio (e.g. 0.10 for 10%)

  maxQuoteAgeMs?: number;
  debug: boolean;
}

export const DEFAULT_ARB_CONFIG: ArbitrageConfig = {
  binanceWsUrl: 'wss://data-stream.binance.vision/ws/btcusdt@aggTrade',
  binanceOrderBookUrl: 'wss://data-stream.binance.vision/ws/btcusdt@depth20@100ms',
  predictFunApiUrl: process.env.PREDICT_FUN_API_URL || 'https://api.predict.fun/v1',
  predictFunApiKey: process.env.PREDICT_FUN_API_KEY || '',
  
  minPriceMovePct: 0.008, // Ultra-aggressive: 0.008% ($5 move on $65k BTC)
  detectionWindowMs: 150, // 150ms detection lookback
  minEdge: 0.03,         // 0.8% min edge for frequent sniper entries
  minConfidence: 0.65,    // Low threshold for immediate reaction
  
  volumeSpikeMultiplier: 2.0,
  orderBookImbalanceThreshold: 0.22,
  
  maxTradeAmount: 1,
  maxTradesPerHour: 30,
  maxDailyLoss: 5,
  cooldownMs: 1000,         // 20ms cooldown for near-instant re-evaluation
  kellyFraction: 0.25,
  
  isPaperTrading: true,
  enableAutoTrade: true,
  enableHedge: false,
  hedgeRatio: 0.5,
  executionSlippage: 0.01, // 4c limit buy buffer to sweep asks ahead of MMs
  predictSyncIntervalMs: 1000, // 50ms ultra-fast odds refresh loop
  
  memoryFilePath: './data/verified_arbitrage_trades.json',
  maxQuoteAgeMs: 2500,
  
  takeProfitPct: 0.04, // 4% profit target per trade
  stopLossPct: 0.08,   // 8% stop loss target per trade
  
  debug: true,
};

// ─────────────────────────────────────────────────────────────────────────────
// LATENCY ARBITRAGE ENGINE
// ─────────────────────────────────────────────────────────────────────────────
export class PredictFunArbitrageEngine {
  public cfg: ArbitrageConfig;
  private ws: WebSocket | null = null;
  private latencyDetector: LatencyDetector;
  private predictFeed = new PredictOrderbookFeed();
  private quoteSource: 'STREAM' | 'REST' | null = null;
  private streamTradingStatus: { marketId: string; status: string } | null = null;
  private obWs: WebSocket | null = null;
  private binanceWsCandidates = [
    'wss://data-stream.binance.vision/ws',
    'wss://stream.binance.com:443/ws',
    'wss://stream.binance.com:9443/ws'
  ];
  private currentPriceWsIndex = 0;
  private currentObWsIndex = 0;
  private binanceReconnectTimeout: NodeJS.Timeout | null = null;
  private obReconnectTimeout: NodeJS.Timeout | null = null;
  private isConnectingBinance: boolean = false;
  private isConnectingOb: boolean = false;
  private ticks: BinanceTick[] = [];
  public logs: string[] = [];
  private avgVolume: number = 0;
  private volumeHistory: number[] = [];
  private lastTradeTime: number = 0;
  private lastTradeTimeByDirection: Record<'UP' | 'DOWN', number> = { UP: 0, DOWN: 0 };
  private tradesThisHour: number = 0;
  private hourlyResetTime: number = Date.now();
  private dailyPnl: number = 0;
  private lastDailyReset: number = Date.now();
  private orderBook: { bids: number[]; asks: number[] } = { bids: [], asks: [] };
  public trades: ArbitrageTrade[] = [];
  private currentPrice: number = 0;
  private currentStartPrice: number | null = null;
  private predictSyncInterval: NodeJS.Timeout | null = null;
  private resolutionInterval: NodeJS.Timeout | null = null;
  private fastExecutionInterval: NodeJS.Timeout | null = null;
  private balanceCheckInterval: NodeJS.Timeout | null = null;
  private walletBalanceUsdt: number = 0;
  private lastPredictOdds: { upOdds: number; downOdds: number; timestamp: number } | null = null;
  private predictMarketDetails: { market: any; upOutcome: any; downOutcome: any; epoch: number; book: any } | null = null;
  private lastMarketRefresh = 0;
  private fastLoopBusy = false;
  private balanceSyncBusy = false;
  private portfolioSyncBusy = false;
  private lastBalanceSyncTime = 0;
  private maintenanceIntervals: NodeJS.Timeout[] = [];
  private historyLoad: Promise<void>;
  private storageHealthy = true;
  private lastUpBid: number = 0;
  private lastDownBid: number = 0;
  private lastRealUpBid: number = 0;   // cache of last genuine bestBid.price from API (avoids -0.03 estimate jumps)
  private lastRealDownBid: number = 0;
  private isResolving: boolean = false;
  private isExecutingTrade: boolean = false;
  private lastSyncedEpochStart: number = 0;
  private lastTickTime: number = 0;
  private restFallbackInterval: NodeJS.Timeout | null = null;
  private lastAttemptPrice: Record<'UP' | 'DOWN', number | null> = { UP: null, DOWN: null };
  private lastCancelTime: Record<'UP' | 'DOWN', number> = { UP: 0, DOWN: 0 }; // when a direction's order was last cancelled (zero-fill), used to gate immediate retries
  private consecutiveZeroFillCount: Record<'UP' | 'DOWN', number> = { UP: 0, DOWN: 0 }; // FIX: dipakai buat naikin slippage bertahap tiap kali order gagal fill 0% berturut-turut
  private predictSyncTimeout: NodeJS.Timeout | null = null;
  private isSyncingPredictOdds: boolean = false;
  private lastSignalTimestamp: number = 0;
  private lastPortfolioSyncTime: number = 0;
  
  private static instanceCount = 0;
  constructor(config: Partial<ArbitrageConfig> = {}) {
    PredictFunArbitrageEngine.instanceCount++;
    console.log(`--- ArbitrageEngine instantiated, count: ${PredictFunArbitrageEngine.instanceCount} ---`);
    const saved = publicConfig(getSystemConfig());
    const safeSaved: Partial<ArbitrageConfig> = {};
    // Ignore malformed legacy fields individually; never let persisted secrets configure execution.
    for (const [key, value] of Object.entries(saved)) {
      try { Object.assign(safeSaved, validateControlConfig({ [key]: value })); } catch { /* use safe default */ }
    }
    this.cfg = { ...DEFAULT_ARB_CONFIG, ...safeSaved, ...config };
    this.cfg.isPaperTrading = this.cfg.isPaperTrading || process.env.ENABLE_LIVE_TRADING !== 'true';
    const limits: Record<string, [number, number]> = { minPriceMovePct: [0.001, 5], minConfidence: [0.1, 1], minEdge: [0.001, 0.5], maxTradeAmount: [0.01, 10000], maxTradesPerHour: [1, 1000], maxDailyLoss: [0.01, 100000], cooldownMs: [100, 3600000], predictSyncIntervalMs: [1000, 30000], executionSlippage: [0, 0.02] };
    for (const [key, [min, max]] of Object.entries(limits)) {
      const value = Number((this.cfg as any)[key]);
      (this.cfg as any)[key] = Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : (DEFAULT_ARB_CONFIG as any)[key];
    }

    this.latencyDetector = new LatencyDetector({
      minPriceDeltaPct: this.cfg.minPriceMovePct,
      minConfidence: this.cfg.minConfidence,
      minConsistencyMs: 50,
    });
    this.latencyDetector.on('signal', (signal) => this.handleLatencySignal(signal));
    this.latencyDetector.on('status', (status) => this.log(`[LatencyDetector] Status: ${JSON.stringify(status)}`));
    this.predictFeed.on('book', (book) => this.onPredictStreamBook(book));
    this.predictFeed.on('quoteInvalidated', (event) => {
      if (this.quoteSource === 'STREAM' && String(this.predictMarketDetails?.market.id) === String(event.marketId)) this.clearExecutableQuote();
    });
    this.predictFeed.on('tradingStatus', (status) => {
      this.streamTradingStatus = { marketId: String(status.marketId), status: status.tradingStatus };
      if (String(this.predictMarketDetails?.market.id) === String(status.marketId)) {
        this.predictMarketDetails.market.tradingStatus = status.tradingStatus;
        if (status.tradingStatus !== 'OPEN') this.clearExecutableQuote();
      }
    });
    this.predictFeed.on('status', (status) => {
      if (!status.connected && this.quoteSource === 'STREAM') this.clearExecutableQuote();
    });
    this.predictFeed.on('warning', (message) => this.log(String(message)));

    this.historyLoad = this.loadTrades();
    this.log('╔══════════════════════════════════════════════════════════════════╗');
    this.log('║  PREDICT.FUN LATENCY ARBITRAGE ENGINE v1.0                      ║');
    this.log('╚══════════════════════════════════════════════════════════════════╝');
    this.log(`🎯 Min Edge: ${(this.cfg.minEdge * 100).toFixed(1)}% | Min Conf: ${(this.cfg.minConfidence * 100).toFixed(0)}%`);
    this.log(`⚡ Detection: ${this.cfg.detectionWindowMs}ms window, ${this.cfg.minPriceMovePct}% move`);
    this.log(`💰 Max Trade: $${this.cfg.maxTradeAmount} | Max/Hour: ${this.cfg.maxTradesPerHour} | Max Daily Loss: $${this.cfg.maxDailyLoss}`);
    this.log(`🤖 AutoTrade: ${this.cfg.enableAutoTrade} | Paper: ${this.cfg.isPaperTrading} | Hedge: ${this.cfg.enableHedge}`);
    this.log(`💾 Loaded ${this.trades.length} historical trades`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // START ENGINE
  // ─────────────────────────────────────────────────────────────────────────
  public async start(): Promise<void> {
    if ((this as any).isRunning) return;
    await this.historyLoad;
    (this as any).isRunning = true;
    this.log('🚀 Starting arbitrage engine...');
    
    // Background pre-warm the Predict.fun API client to warm up cache for zero-latency first execution
    const privateKey = getSystemConfig()?.walletPrivateKey || process.env.WALLET_PRIVATE_KEY || '';
    const apiKey = this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
    const predictAccount = getSystemConfig()?.smartWalletAddress || '';
    if (!this.cfg.isPaperTrading && privateKey && apiKey) {
      preWarmPredictClient(privateKey, predictAccount, apiKey).catch((e) => {
        this.log(`⚠️ Background pre-warming warning: ${e.message || e}`);
      });
    }

    // Connect to Binance WebSocket
    this.connectBinanceWs();
    this.latencyDetector.start();
    
    // Start orderbook monitor (separate WebSocket)
    this.connectOrderBookWs();
    
    // Venue updates arrive as events; REST is a bounded fallback and discovery path.
    if (apiKey && process.env.PREDICT_STREAMING !== 'false') this.predictFeed.start(apiKey);
    await this.syncPredictOdds();
    if (!(this as any).isRunning) return;
    
    // Start ultra-low-latency non-overlapping polling loop
    this.startPredictSyncLoop();
    this.resolutionInterval = setInterval(() => this.checkTradesResolution().catch(error => this.log(`Resolution paused: ${error.message}`)), 5000);
    
    // Start REST-based price fallback polling loop (runs every 1000ms)
    // If the WebSocket hasn't delivered a tick in the last 1500ms, this fetches the price via REST
    this.restFallbackInterval = setInterval(() => this.syncPriceViaRestFallback(), 1000);
    
    // Fast execution loop (every 50ms) to check fills and execute instant sells
    this.fastExecutionInterval = setInterval(async () => {
      if (this.fastLoopBusy || !(this as any).isRunning) return;
      this.fastLoopBusy = true;
      try {
        await this.checkLiveOrderFills();
        await this.checkLiveSellFills();
        await this.checkInstantSellOpportunities(this.lastUpBid, this.lastDownBid);

        // Fast throttled portfolio sync when there's a cancelled but unresolved trade
        const now = Date.now();
        const hasPendingSync = this.trades.some(t => t.mode === 'live' && t.isFilled && !t.resolved && !t.isSharesSynced);
        if (hasPendingSync && (now - this.lastPortfolioSyncTime > 3000)) {
          this.syncLivePortfolioPositions().catch(() => {});
        }
      } catch (err) {
        this.log(`⚠️ Fast execution loop error: ${err}`);
      } finally { this.fastLoopBusy = false; }
    }, 100);
    
    this.maintenanceIntervals.push(setInterval(() => this.updateVolumeAverage(), 60000));
    
    this.syncWalletBalance();
    this.balanceCheckInterval = setInterval(() => this.syncWalletBalance(), 30000); // every 30s
    
    this.log('✅ Engine started');
  }

  private startPredictSyncLoop(): void {
    if (this.predictSyncTimeout) {
      clearTimeout(this.predictSyncTimeout);
      this.predictSyncTimeout = null;
    }
    this.syncPredictOddsLoop();
  }

  private async syncPredictOddsLoop(): Promise<void> {
    if (!(this as any).isRunning) return;
    if (this.isSyncingPredictOdds) return;
    this.isSyncingPredictOdds = true;
    try {
      await this.syncPredictOdds();
    } catch (err) {
      // ignore
    } finally {
      this.isSyncingPredictOdds = false;
      const delay = Math.max(1000, this.cfg.predictSyncIntervalMs || 1000);
      if ((this as any).isRunning) this.predictSyncTimeout = setTimeout(() => this.syncPredictOddsLoop(), delay);
    }
  }

  public async stop(): Promise<void> {
    (this as any).isRunning = false;
    this.maintenanceIntervals.forEach(clearInterval);
    this.maintenanceIntervals = [];
    if (this.binanceReconnectTimeout) clearTimeout(this.binanceReconnectTimeout);
    if (this.obReconnectTimeout) clearTimeout(this.obReconnectTimeout);
    this.binanceReconnectTimeout = this.obReconnectTimeout = null;
    this.isConnectingBinance = this.isConnectingOb = false;
    this.log('🛑 Stopping arbitrage engine...');
    this.latencyDetector.stop();
    this.predictFeed.stop();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    if (this.obWs) {
      this.obWs.removeAllListeners();
      this.obWs.close();
      this.obWs = null;
    }
    if (this.predictSyncTimeout) {
      clearTimeout(this.predictSyncTimeout);
      this.predictSyncTimeout = null;
    }
    if (this.predictSyncInterval) {
      clearInterval(this.predictSyncInterval);
      this.predictSyncInterval = null;
    }
    if (this.resolutionInterval) {
      clearInterval(this.resolutionInterval);
      this.resolutionInterval = null;
    }
    if (this.fastExecutionInterval) {
      clearInterval(this.fastExecutionInterval);
      this.fastExecutionInterval = null;
    }
    if (this.restFallbackInterval) {
      clearInterval(this.restFallbackInterval);
      this.restFallbackInterval = null;
    }
    if (this.balanceCheckInterval) {
      clearInterval(this.balanceCheckInterval);
      this.balanceCheckInterval = null;
    }
    await this.saveTrades();
    this.log('✅ Engine stopped');
  }

  private async syncPriceViaRestFallback(): Promise<void> {
    const isWsStale = Date.now() - this.lastTickTime > 1500;
    if (!isWsStale && this.currentPrice > 0) {
      return; // WebSocket is healthy and sending real-time ticks
    }
    
    // WS is stale or not connected. Fall back to resilient REST polling
    const domains = [
      "https://api-gcp.binance.com",
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://api3.binance.com",
      "https://data-api.binance.vision"
    ];
    
    for (const domain of domains) {
      try {
        const url = `${domain}/api/v3/ticker/price?symbol=BTCUSDT`;
        const res = await axios.get(url, { timeout: 1500 });
        if (res.data && res.data.price) {
          const price = parseFloat(res.data.price);
          
          const tick: BinanceTick = {
            price,
            timestamp: Date.now(),
            volume: 0,
            isBuyerMaker: false,
          };
          
          this.currentPrice = price;
          this.lastTickTime = Date.now();
          
          if (this.cfg.debug && Math.random() < 0.05) {
            this.log(`🔄 [REST FALLBACK SYNC] Synced spot price from Binance API: $${price.toFixed(2)}`);
          }
          
          // REST quotes update display only; they carry no observed trade flow or maker side.
          break; // success
        }
      } catch (err) {
        // try next domain
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SYNC PREDICT.FUN ODDS (REAL-TIME)
  // ─────────────────────────────────────────────────────────────────────────
  private async syncPredictOdds(): Promise<void> {
    const apiKey = this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
    const epoch = Math.floor(Date.now() / 300000) * 300;
    const headers = apiKey ? { 'x-api-key': apiKey } : {};
    try {
      let details = this.predictMarketDetails;
      if (details && details.epoch !== epoch) {
        this.latencyDetector.clearPredictFunPrice();
        this.currentStartPrice = null;
        this.lastUpBid = this.lastDownBid = 0;
        this.predictMarketDetails = details = null;
      }
      if (!details || details.epoch !== epoch || Date.now() - this.lastMarketRefresh > 10000) {
        const response = await axios.get(`${this.cfg.predictFunApiUrl}/categories/btc-updown-5m-${epoch}`, { headers, timeout: 3000 });
        const market = response.data?.data?.markets?.find((m: any) => m.tradingStatus === 'OPEN' && (!m.categorySlug || m.categorySlug === `btc-updown-5m-${epoch}`));
        const upOutcome = market?.outcomes?.find((o: any) => String(o.name).toLowerCase() === 'up');
        const downOutcome = market?.outcomes?.find((o: any) => String(o.name).toLowerCase() === 'down');
        if (!market || !upOutcome || !downOutcome) throw new Error('No open two-outcome market');
        const previousBook = details?.epoch === epoch && String(details.market.id) === String(market.id) ? details.book : null;
        details = { market, upOutcome, downOutcome, epoch, book: previousBook };
        this.lastMarketRefresh = Date.now();
      }
      if (this.predictMarketDetails?.epoch !== epoch || String(this.predictMarketDetails?.market.id) !== String(details.market.id)) this.clearExecutableQuote();
      this.predictMarketDetails = details;
      this.predictFeed.subscribeMarket(details.market.id);
      let book = this.predictFeed.getLatestBook(details.market.id, this.cfg.maxQuoteAgeMs || 2500);
      let source: 'STREAM' | 'REST' = book ? 'STREAM' : 'REST';
      if (!book) {
        const response = await axios.get(`${this.cfg.predictFunApiUrl}/markets/${details.market.id}/orderbook`, { headers, timeout: 2000 });
        book = response.data?.data;
        // A stream event may have arrived while REST was in flight.
        const newer = this.predictFeed.getLatestBook(details.market.id, this.cfg.maxQuoteAgeMs || 2500);
        if (newer && newer.updateTimestampMs >= Number(book?.updateTimestampMs || 0)) { book = newer; source = 'STREAM'; }
      }
      if (!this.ingestPredictBook(details, book)) throw new Error('Unusable orderbook');
      this.quoteSource = source;
    } catch {
      this.clearExecutableQuote();
      this.predictMarketDetails = null;
      // No synthetic replacement: an unavailable venue quote is not an executable price.
    }
  }

  private clearExecutableQuote(): void {
    this.lastPredictOdds = null;
    this.quoteSource = null;
    this.currentStartPrice = null;
    this.lastUpBid = this.lastDownBid = 0;
    this.latencyDetector.clearPredictFunPrice();
  }

  private onPredictStreamBook(book: any): void {
    if (!(this as any).isRunning) return;
    const details = this.predictMarketDetails;
    if (!details || String(book?.marketId) !== String(details.market.id)) return;
    const fresh = this.predictFeed.getLatestBook(details.market.id, this.cfg.maxQuoteAgeMs || 2500);
    if (fresh && this.ingestPredictBook(details, fresh)) this.quoteSource = 'STREAM';
  }

  private ingestPredictBook(details: any, book: any): boolean {
    const epoch = Math.floor(Date.now() / 300000) * 300;
    if (!details || details.epoch !== epoch || book?.marketId !== undefined && String(book.marketId) !== String(details.market.id)) return false;
    if (details.market.tradingStatus !== 'OPEN' || this.streamTradingStatus?.marketId === String(details.market.id) && this.streamTradingStatus.status !== 'OPEN') return false;
    if (!Array.isArray(book?.asks) || !Array.isArray(book?.bids)) return false;
    for (const [levels, ascending] of [[book.asks, true], [book.bids, false]] as const) {
      if (!levels.length || levels.length > 5000) return false;
      let previous: number | undefined;
      for (const level of levels) {
        if (!Array.isArray(level) || level.length !== 2) return false;
        const price = Number(level[0]), size = Number(level[1]);
        if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || price >= 1 || size <= 0 || previous !== undefined && (ascending ? price <= previous : price >= previous)) return false;
        previous = price;
      }
    }
    const observedAt = Number(book?.updateTimestampMs);
    if (this.predictMarketDetails?.epoch === epoch && this.lastPredictOdds && observedAt < this.lastPredictOdds.timestamp) return false;
      const upAsk = Number(book?.asks?.[0]?.[0]);
      const upBid = Number(book?.bids?.[0]?.[0]);
      if (!Number.isFinite(observedAt) || Date.now() - observedAt > (this.cfg.maxQuoteAgeMs || 2500) || observedAt > Date.now() + 1000 || !(upBid > 0 && upBid < upAsk && upAsk < 1)) {
        return false;
      }
      const downAsk = Number((1 - upBid).toFixed(details.market.decimalPrecision ?? 3));
      const downBid = Number((1 - upAsk).toFixed(details.market.decimalPrecision ?? 3));
      details.book = book;
      details.upOutcome = { ...details.upOutcome, bestAsk: { price: upAsk }, bestBid: { price: upBid } };
      details.downOutcome = { ...details.downOutcome, bestAsk: { price: downAsk }, bestBid: { price: downBid } };
      this.predictMarketDetails = details;
      this.lastPredictOdds = { upOdds: 1 / upAsk, downOdds: 1 / downAsk, timestamp: observedAt };
      this.lastUpBid = upBid;
      this.lastDownBid = downBid;
      const start = Number(details.market.variantDetails?.crypto?.startPrice ?? details.market.variantData?.startPrice);
      this.currentStartPrice = Number.isFinite(start) && start > 0 ? start : null;
      // The model is a heuristic; feed only observed orderbook data to the detector.
      if (this.currentStartPrice) {
        const probUp = upAsk / (upAsk + downAsk);
        this.latencyDetector.updatePredictFunPrice(this.currentStartPrice + this.inversePhi(probUp) * this.currentStartPrice * 0.0008, observedAt);
      }
    if (!this.currentStartPrice) this.latencyDetector.clearPredictFunPrice();
    return true;
  }

  private async checkInstantSellOpportunities(upBid: number, downBid: number): Promise<void> {
    const quote = this.lastPredictOdds;
    if (!quote || Date.now() - quote.timestamp > (this.cfg.maxQuoteAgeMs || 2500)) return;
    const epoch = Math.floor(Date.now() / 300000) * 300;
    let changed = false;
    for (const trade of this.trades) {
      if (trade.mode !== (this.cfg.isPaperTrading ? 'paper' : 'live') || trade.resolved || trade.isSold || trade.isCancelled || !trade.isFilled || trade.isSellOrderPlaced || trade.submissionUncertain || trade.reconciliationRequired) continue;
      if (trade.targetLockTime !== epoch || this.predictMarketDetails?.epoch !== epoch) continue;
      const shares = trade.sharesQuantity || 0;
      const bid = trade.direction === 'UP' ? upBid : downBid;
      if (!(shares >= 0.01 && bid > 0 && bid < 1)) continue; // retain dust for settlement
      if (Date.now() - (trade.lastSellAttemptTime || 0) < 1500) continue;
      const precision = this.predictMarketDetails.market.decimalPrecision ?? 3;
      const tick = 10 ** -precision;
      const limit = Number(Math.max(tick, Math.floor((bid - Math.min(this.cfg.executionSlippage ?? 0.01, 0.02) + 1e-12) / tick) * tick).toFixed(precision));
      const book = this.predictMarketDetails.book;
      const exitLevels = trade.direction === 'UP' ? book?.bids : book?.asks?.map((level: any) => [Number((1 - Number(level[0])).toFixed(precision)), level[1]]);
      const exitDepth = exitLevels?.filter((level: any) => Number(level[0]) >= limit).reduce((sum: number, level: any) => sum + Number(level[1]), 0) || 0;
      if (!Number.isFinite(exitDepth) || exitDepth < shares) continue;
      const net = estimateSellProceeds(shares, limit, trade.feeRateBps ?? 200);
      const totalReturn = (trade.soldProceeds || 0) + net;
      const pnlPct = (totalReturn - trade.amount) / trade.amount;
      const heldMs = Date.now() - (trade.fillTimestamp || trade.timestamp);
      const exit = pnlPct >= (this.cfg.takeProfitPct ?? 0.04) || (heldMs >= 5000 && pnlPct <= -(this.cfg.stopLossPct ?? 0.08)) || heldMs > 150000 || Date.now() / 1000 - epoch >= 230;
      if (!exit) continue;
      trade.lastSellAttemptTime = Date.now();
      if (trade.mode === 'paper') {
        trade.soldProceeds = totalReturn;
        trade.sharesQuantity = 0;
        trade.sellPrice = limit;
        this.finalizeTrade(trade, totalReturn - trade.amount);
        trade.isSold = true;
        changed = true;
        continue;
      }
      const credentials = getSystemConfig();
      if (!credentials.walletPrivateKey || !credentials.smartWalletAddress && !credentials.walletAddress) continue;
      // A missing exact share balance is reconciled before attempting a sell.
      if (!trade.isSharesSynced) { await this.syncLivePortfolioPositions(); if (!trade.isSharesSynced) continue; }
      const sellShares = trade.sharesQuantity || 0;
      if (sellShares < 0.01) continue;
      trade.isSellOrderPlaced = true;
      trade.sellSubmittedShares = sellShares;
      trade.sellOrderTimestamp = Date.now();
      trade.sellPrice = limit;
      trade.reconciliationRequired = true;
      await this.saveTrades();
      try {
        const result = await placePredictOrder(trade.direction === 'UP' ? 'BULL' : 'BEAR', sellShares, credentials.walletPrivateKey, credentials.smartWalletAddress || '', this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '', limit, trade.targetLockTime, 'SELL', this.predictMarketDetails.market, trade.direction === 'UP' ? this.predictMarketDetails.upOutcome : this.predictMarketDetails.downOutcome);
        trade.sellOrderHash = result.hash;
        trade.sellOrderId = result.orderId;
        trade.sellExpiration = result.expiration;
        trade.reconciliationRequired = false;
      } catch (error: any) {
        if (error.uncertain) {
          trade.sellOrderHash = error.orderHash;
          trade.sellOrderId = error.orderId;
          trade.sellExpiration = error.expiration;
          trade.reconciliationRequired = !error.orderHash;
          this.log(`Sell submission uncertain for ${trade.id}; awaiting reconciliation before any retry.`);
        } else {
          trade.isSellOrderPlaced = false;
          trade.reconciliationRequired = false;
          trade.isSharesSynced = false;
          this.log(`Sell rejected for ${trade.id}: ${error.message}`);
        }
      }
      changed = true;
    }
    if (changed) await this.saveTrades();
  }

  private finalizeTrade(trade: ArbitrageTrade, pnl: number): void {
    trade.resolved = true;
    trade.resolvedAt = Date.now();
    trade.pnl = pnl;
    trade.pnlIsEstimate = true; // fees conservatively estimated until reconciled to settlement receipts
    trade.outcome = pnl > 0 ? 'WIN' : pnl < 0 ? 'LOSS' : undefined;
    this.refreshRisk();
    this.log(`Position ${trade.id} closed; estimated net PnL $${pnl.toFixed(4)}.`);
  }

  private refreshRisk(): void {
    const risk = getRiskSnapshot(this.trades, this.cfg.isPaperTrading, Date.now());
    this.tradesThisHour = risk.tradesThisHour;
    this.dailyPnl = risk.dailyPnl;
  }

  private async checkLiveOrderFills(): Promise<void> {
    if (this.cfg.isPaperTrading) return;
    const credentials = getSystemConfig();
    const apiKey = this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
    if (!credentials.walletPrivateKey || !apiKey || !(credentials.smartWalletAddress || credentials.walletAddress)) return;
    let changed = false;
    for (const trade of this.trades) {
      if (trade.mode !== 'live' || trade.resolved || trade.isSold || trade.isCancelled || trade.isFilled || trade.isCheckingFill || !trade.orderHash || trade.reconciliationRequired) continue;
      if (Date.now() - (trade.lastFillCheckAt || 0) < 1000) continue;
      trade.isCheckingFill = true;
      trade.lastFillCheckAt = Date.now();
      try {
        const args = [trade.orderHash, credentials.walletPrivateKey, credentials.smartWalletAddress || '', apiKey, trade.orderId || ''] as const;
        const status = Date.now() - trade.timestamp >= 1500 ? await checkAndCancelPredictOrder(...args, 100) : await checkPredictOrderStatus(...args);
        if (status.uncertain || !status.filled && !status.cancelConfirmed) continue;
        if (!status.filled && !status.onchainCancelled && Date.now() < ((trade.orderExpiration || Infinity) * 1000 + 1000)) continue;
        const ratio = status.filled ? 1 : status.filledRatio;
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue;
        trade.submissionUncertain = false;
        if (ratio === 0) {
          trade.isCancelled = true;
          trade.cancelledAt = Date.now();
          trade.resolved = true;
          trade.resolvedAt = Date.now();
          trade.pnl = 0;
          this.lastCancelTime[trade.direction] = Date.now();
        } else {
          trade.isFilled = true;
          trade.fillTimestamp = Date.now();
          trade.amount = (status.spentUsdt ?? (trade.submittedAmount || trade.amount) * ratio) * (1 + (trade.feeRateBps ?? 200) / 10000);
          const price = status.averageFillPrice || 1 / trade.entryOdds;
          trade.entryOdds = 1 / price;
          // Exchange amountFilled is gross; only portfolio reconciliation gives sellable shares after fees.
          trade.sharesQuantity = estimateBuyShares(trade.amount, price, trade.feeRateBps ?? 200);
          trade.isSharesSynced = false;
          this.log(`Buy ${trade.id} confirmed ${(ratio * 100).toFixed(2)}% filled; reserved cost $${trade.amount.toFixed(4)}.`);
        }
        changed = true;
      } catch (error: any) { this.log(`Fill reconciliation pending for ${trade.id}: ${error.message}`); }
      finally { trade.isCheckingFill = false; }
    }
    if (changed) { this.refreshRisk(); await this.saveTrades(); }
  }

  private async checkLiveSellFills(): Promise<void> {
    if (this.cfg.isPaperTrading) return;
    const credentials = getSystemConfig();
    const apiKey = this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
    if (!credentials.walletPrivateKey || !apiKey || !(credentials.smartWalletAddress || credentials.walletAddress)) return;
    let changed = false;
    for (const trade of this.trades) {
      if (trade.mode !== 'live' || trade.resolved || !trade.isSellOrderPlaced || trade.isSold || trade.isCheckingSellFill || !trade.sellOrderHash || trade.reconciliationRequired) continue;
      if (Date.now() - (trade.lastSellFillCheckAt || 0) < 1000) continue;
      trade.isCheckingSellFill = true;
      trade.lastSellFillCheckAt = Date.now();
      try {
        const args = [trade.sellOrderHash, credentials.walletPrivateKey, credentials.smartWalletAddress || '', apiKey, trade.sellOrderId || ''] as const;
        const status = Date.now() - (trade.sellOrderTimestamp || 0) >= 3000 ? await checkAndCancelPredictOrder(...args, 100) : await checkPredictOrderStatus(...args);
        if (status.uncertain || !status.filled && !status.cancelConfirmed) continue;
        if (!status.filled && !status.onchainCancelled && Date.now() < ((trade.sellExpiration || Infinity) * 1000 + 1000)) continue;
        const ratio = status.filled ? 1 : status.filledRatio;
        if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) continue;
        const sold = (trade.sellSubmittedShares || 0) * ratio;
        const price = status.averageFillPrice || trade.sellPrice;
        if (sold > 0 && !(price > 0 && price < 1)) { trade.reconciliationRequired = true; continue; }
        trade.soldProceeds = (trade.soldProceeds || 0) + (sold > 0 ? estimateSellProceeds(sold, price!, trade.feeRateBps ?? 200) : 0);
        trade.sharesQuantity = Math.max(0, (trade.sharesQuantity || 0) - sold);
        trade.isSellOrderPlaced = false;
        trade.sellOrderHash = undefined;
        trade.sellOrderId = undefined;
        trade.lastSellAttemptTime = Date.now();
        if (trade.sharesQuantity < 1e-9) {
          trade.isSold = trade.isSellFilled = true;
          this.finalizeTrade(trade, (trade.soldProceeds || 0) - trade.amount);
        }
        // Partial sale keeps original cost and accumulated proceeds, including dust for settlement.
        changed = true;
      } catch (error: any) { this.log(`Sell reconciliation pending for ${trade.id}: ${error.message}`); }
      finally { trade.isCheckingSellFill = false; }
    }
    if (changed) await this.saveTrades();
  }

  private async syncLivePortfolioPositions(): Promise<void> {
    if (this.cfg.isPaperTrading || this.portfolioSyncBusy || Date.now() - this.lastPortfolioSyncTime < 3000) return;
    const credentials = getSystemConfig();
    const apiKey = this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
    if (!credentials.walletPrivateKey || !apiKey || !(credentials.smartWalletAddress || credentials.walletAddress)) return;
    this.portfolioSyncBusy = true;
    this.lastPortfolioSyncTime = Date.now();
    try {
      const positions = await getUserPositions(credentials.walletPrivateKey, credentials.smartWalletAddress || '', apiKey);
      for (const trade of this.trades) {
        if (trade.mode !== 'live' || trade.resolved || !trade.isFilled || trade.isSellOrderPlaced || trade.submissionUncertain) continue;
        // Reconcile only positions opened by this bot; never import and auto-sell unrelated wallet holdings.
        const position = positions.find((pos: any) => {
          const token = String(pos.outcome?.onChainId ?? pos.tokenId ?? pos.onChainId ?? '');
          const slug = pos.market?.categorySlug || pos.market?.slug || pos.categorySlug || '';
          const direction = String(pos.outcome?.name || pos.outcomeName || '').toUpperCase();
          return (trade.tokenId && token === trade.tokenId) || (slug === `btc-updown-5m-${trade.targetLockTime}` && direction === trade.direction);
        });
        if (!position) continue;
        let balance = Number(position.amount ?? position.balance ?? position.quantity);
        if (balance > 1e10) balance /= 1e18;
        if (!Number.isFinite(balance) || balance < 0) continue;
        // A larger wallet balance can include pre-existing shares; cap to this bot's tracked quantity.
        trade.sharesQuantity = Math.min(trade.sharesQuantity || 0, balance);
        trade.isSharesSynced = true;
      }
      await this.saveTrades();
    } catch (error: any) { this.log(`Portfolio reconciliation unavailable: ${error.message}`); }
    finally { this.portfolioSyncBusy = false; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CHECK TRADES RESOLUTION (REAL-TIME EPOCH BASED)
  // ─────────────────────────────────────────────────────────────────────────
  private async checkTradesResolution(): Promise<void> {
    if (this.isResolving) return;
    this.isResolving = true;
    try {
      await this.checkLiveOrderFills();
      await this.checkLiveSellFills();
      await this.syncLivePortfolioPositions();
      const apiKey = this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
      let changed = false;
      const markets = new Map<number, any>();
      for (const trade of this.trades) {
        if (trade.mode !== (this.cfg.isPaperTrading ? 'paper' : 'live') || trade.resolved || trade.isSold || trade.isCancelled || !trade.isFilled || trade.isSellOrderPlaced || trade.submissionUncertain || trade.reconciliationRequired) continue;
        if (trade.mode === 'live' && !trade.isSharesSynced) continue;
        const epoch = trade.targetLockTime;
        if (!epoch || Date.now() / 1000 < epoch + 300) continue;
        try {
          if (!markets.has(epoch)) {
            const response = await axios.get(`${this.cfg.predictFunApiUrl}/categories/btc-updown-5m-${epoch}`, { headers: apiKey ? { 'x-api-key': apiKey } : {}, timeout: 3000 });
            markets.set(epoch, response.data?.data?.markets?.find((m: any) => m.categorySlug === `btc-updown-5m-${epoch}`) || null);
          }
          const market = markets.get(epoch);
          const winner = getResolvedWinner(market);
          if (!winner) continue; // CLOSED is not RESOLVED; Binance price is not the settlement oracle.
          trade.lockPrice = Number(market.variantDetails?.crypto?.startPrice ?? market.variantData?.startPrice) || trade.lockPrice;
          trade.closePrice = Number(market.variantDetails?.crypto?.endPrice ?? market.variantData?.endPrice) || trade.closePrice;
          const redemption = winner === trade.direction ? trade.sharesQuantity || 0 : 0;
          this.finalizeTrade(trade, (trade.soldProceeds || 0) + redemption - trade.amount);
          changed = true;
        } catch (error: any) { this.log(`Venue resolution pending for ${trade.id}: ${error.message}`); }
      }
      if (changed) await this.saveTrades();
    } finally { this.isResolving = false; }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONNECT BINANCE PRICE WEBSOCKET
  // ─────────────────────────────────────────────────────────────────────────
  private connectBinanceWs(): void {
    if (!(this as any).isRunning || this.isConnectingBinance) return;
    this.isConnectingBinance = true;

    if (this.binanceReconnectTimeout) {
      clearTimeout(this.binanceReconnectTimeout);
      this.binanceReconnectTimeout = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.terminate();
      } catch (e) {}
    }

    if (this.cfg.binanceWsUrl.includes('stream.binance.com:9443')) {
      this.cfg.binanceWsUrl = this.cfg.binanceWsUrl.replace('stream.binance.com:9443/ws', 'data-stream.binance.vision/ws');
    }

    this.ws = new WebSocket(this.cfg.binanceWsUrl);
    
    this.ws.on('open', () => {
      this.isConnectingBinance = false;
      this.log(`🔌 Connected to Binance Spot Price WebSocket (${this.cfg.binanceWsUrl})`);
    });
    
    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.p) {
          const tick: BinanceTick = {
            price: parseFloat(msg.p),
            timestamp: Date.now(),
            volume: parseFloat(msg.q || '0'),
            isBuyerMaker: !!msg.m,
          };
          this.currentPrice = tick.price;
          this.lastTickTime = Date.now();
          this.processTick(tick);
        }
      } catch (err) {
        this.log(`⚠️ Parse error: ${err}`);
      }
    });
    
    const reconnect = () => {
      this.isConnectingBinance = false;
      if ((this as any).isRunning && !this.binanceReconnectTimeout) {
        this.binanceReconnectTimeout = setTimeout(() => {
          this.binanceReconnectTimeout = null;
          this.connectBinanceWs();
        }, 3000);
      }
    };

    this.ws.on('error', (err) => {
      if (err.message && (err.message.includes('451') || err.message.includes('Unexpected server response'))) {
        this.currentPriceWsIndex = (this.currentPriceWsIndex + 1) % this.binanceWsCandidates.length;
        const nextBase = this.binanceWsCandidates[this.currentPriceWsIndex];
        const streamPath = this.cfg.binanceWsUrl.split('/ws/')[1] || 'btcusdt@aggTrade';
        this.cfg.binanceWsUrl = `${nextBase}/${streamPath}`;
        this.log(`⚠️ Price WS received HTTP 451 (geoblocked). Rotating price feed to fallback: ${this.cfg.binanceWsUrl}`);
      } else {
        this.log(`❌ WebSocket error: ${err.message}`);
      }
      reconnect();
    });
    
    this.ws.on('close', () => {
      reconnect();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CONNECT BINANCE ORDER BOOK WEBSOCKET
  // ─────────────────────────────────────────────────────────────────────────
  private connectOrderBookWs(): void {
    if (!(this as any).isRunning || this.isConnectingOb) return;
    this.isConnectingOb = true;

    if (this.obReconnectTimeout) {
      clearTimeout(this.obReconnectTimeout);
      this.obReconnectTimeout = null;
    }

    if (this.obWs) {
      try {
        this.obWs.removeAllListeners();
        this.obWs.terminate();
      } catch (e) {}
    }

    if (this.cfg.binanceOrderBookUrl.includes('stream.binance.com:9443')) {
      this.cfg.binanceOrderBookUrl = this.cfg.binanceOrderBookUrl.replace('stream.binance.com:9443/ws', 'data-stream.binance.vision/ws');
    }

    this.obWs = new WebSocket(this.cfg.binanceOrderBookUrl);
    
    this.obWs.on('open', () => {
      this.isConnectingOb = false;
      this.log(`🔌 Connected to Binance Order Book WebSocket (${this.cfg.binanceOrderBookUrl})`);
    });
    
    this.obWs.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.orderBook = {
          bids: msg.bids ? msg.bids.map((b: string[]) => parseFloat(b[1])) : [],
          asks: msg.asks ? msg.asks.map((a: string[]) => parseFloat(a[1])) : [],
        };
      } catch (err) {
        // ignore parsing errors
      }
    });
    
    const reconnect = () => {
      this.isConnectingOb = false;
      if ((this as any).isRunning && !this.obReconnectTimeout) {
        this.obReconnectTimeout = setTimeout(() => {
          this.obReconnectTimeout = null;
          this.connectOrderBookWs();
        }, 3000);
      }
    };

    this.obWs.on('error', (err) => {
      if (err.message && (err.message.includes('451') || err.message.includes('Unexpected server response'))) {
        this.currentObWsIndex = (this.currentObWsIndex + 1) % this.binanceWsCandidates.length;
        const nextBase = this.binanceWsCandidates[this.currentObWsIndex];
        const streamPath = this.cfg.binanceOrderBookUrl.split('/ws/')[1] || 'btcusdt@depth20@100ms';
        this.cfg.binanceOrderBookUrl = `${nextBase}/${streamPath}`;
        this.log(`⚠️ Orderbook WS received HTTP 451 (geoblocked). Rotating orderbook feed to fallback: ${this.cfg.binanceOrderBookUrl}`);
      } else {
        this.log(`⚠️ Orderbook WS error: ${err.message}`);
      }
      reconnect();
    });
    
    this.obWs.on('close', () => {
      reconnect();
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PROCESS TICK (REAL-TIME DETECTOR ENGINE TRIGGER)
  // ─────────────────────────────────────────────────────────────────────────
  private async processTick(tick: BinanceTick): Promise<void> {
    // Add to history
    this.ticks.push(tick);
    this.volumeHistory.push(tick.volume);
    
    // Keep only recent ticks (last 10 seconds for macro trend)
    const cutoff = Date.now() - 10000;
    this.ticks = this.ticks.filter(t => t.timestamp > cutoff);
    this.volumeHistory = this.volumeHistory.slice(-100);

    // Dynamic Spike/Retrace tracker resets
    if (this.currentPrice > 0) {
      const minMove = this.cfg.minPriceMovePct; // e.g., 0.015 (representing 0.015%)
      
      // UP Tracker Reset
      if (this.lastAttemptPrice['UP'] !== null) {
        const diffPct = ((this.currentPrice - this.lastAttemptPrice['UP']) / this.lastAttemptPrice['UP']) * 100;
        if (diffPct <= -minMove) {
          this.log(`🔄 [SPIKE RESET] BTC Price retraced down by ${diffPct.toFixed(4)}% from last UP attempt price $${this.lastAttemptPrice['UP'].toFixed(2)}. Resetting UP spike tracker.`);
          this.lastAttemptPrice['UP'] = null;
        } else if (diffPct >= minMove * 1.5) {
          this.log(`🚀 [SPIKE EXTENSION] BTC Price expanded up by ${diffPct.toFixed(4)}% from last UP attempt price $${this.lastAttemptPrice['UP'].toFixed(2)}. Clearing UP lock to allow next trade.`);
          this.lastAttemptPrice['UP'] = null;
        }
      }
      
      // DOWN Tracker Reset
      if (this.lastAttemptPrice['DOWN'] !== null) {
        const diffPct = ((this.currentPrice - this.lastAttemptPrice['DOWN']) / this.lastAttemptPrice['DOWN']) * 100;
        if (diffPct >= minMove) {
          this.log(`🔄 [SPIKE RESET] BTC Price retraced up by ${diffPct.toFixed(4)}% from last DOWN attempt price $${this.lastAttemptPrice['DOWN'].toFixed(2)}. Resetting DOWN spike tracker.`);
          this.lastAttemptPrice['DOWN'] = null;
        } else if (diffPct <= -minMove * 1.5) {
          this.log(`🚀 [SPIKE EXTENSION] BTC Price expanded down by ${diffPct.toFixed(4)}% from last DOWN attempt price $${this.lastAttemptPrice['DOWN'].toFixed(2)}. Clearing DOWN lock to allow next trade.`);
          this.lastAttemptPrice['DOWN'] = null;
        }
      }
    }
    
    // Check rate limits
    this.refreshRisk();
    if (this.tradesThisHour >= this.cfg.maxTradesPerHour) {
      return;
    }
    if (this.dailyPnl <= -this.cfg.maxDailyLoss) {
      this.log(`🛑 Daily loss limit reached: $${this.dailyPnl.toFixed(2)} / -$${this.cfg.maxDailyLoss}`);
      return;
    }
    
    // Cooldown check
    if (Date.now() - this.lastTradeTime < this.cfg.cooldownMs) {
      return;
    }
    
    // Detect arbitrage opportunity
    const signal = this.detectArbitrage(tick);
    
    if (signal) {
      // Don't trade if we already have ANY active unresolved and unsold trade.
      // Focus on exactly 1 active trade at a time across all directions.
      const hasAnyActiveTrade = this.trades.some(
        t => !t.resolved && !t.isSold && !t.isCancelled
      );
      if (hasAnyActiveTrade || this.isExecutingTrade) {
        return;
      }
      
      // If we are flat, clear the spike locks so we don't get stuck indefinitely
      if (!hasAnyActiveTrade) {
        this.lastAttemptPrice['UP'] = null;
        this.lastAttemptPrice['DOWN'] = null;
      }
      
      // Strict directional cooldown of 100ms to prevent duplicate/spam order placement in the same direction
      const lastDirTradeTime = this.lastTradeTimeByDirection[signal.direction] || 0;
      if (Date.now() - lastDirTradeTime < 100) {
        return;
      }
      
      if (signal.edge >= this.cfg.minEdge && signal.confidence >= this.cfg.minConfidence) {
        this.log(`🎯 ARBITRAGE SIGNAL: ${signal.direction} | Edge: ${(signal.edge * 100).toFixed(1)}% | Conf: ${(signal.confidence * 100).toFixed(0)}%`);
        this.log(`   Fair Odds: ${signal.fairOdds.toFixed(2)} | Market: ${signal.marketOdds.toFixed(2)} | Latency: ${signal.latencyMs}ms`);
        this.log(`   Reason: ${signal.reason}`);
        
        // Prevent entering new trades in the wild beginning (0-3s) of the epoch,
        // and also the last part of the active trading window (>=155s) to guarantee scalp/exit room.
        const nowSec = Math.floor(Date.now() / 1000);
        const secondsIntoEpoch = nowSec % 300;
        
        if (secondsIntoEpoch < 2) {
          this.log(`⏳ [BLOCK TRADE] Waiting for epoch start to stabilize (seconds into epoch: ${secondsIntoEpoch}s). No trade placed.`);
          return;
        }
        if (secondsIntoEpoch >= 285) {
          this.log(`⏳ [BLOCK TRADE] Skip entering new trades near market close (seconds into epoch: ${secondsIntoEpoch}s). No trade placed.`);
          return;
        }
        
        if (this.cfg.enableAutoTrade) {
          // Disable direct aggTrade sniping as it is highly vulnerable to bid-ask spread crossing noise.
          // We rely exclusively on the high-precision, low-latency LatencyDetector (bookTicker mid price) stream.
          // await this.executeTrade(signal);
        }
      }
    }
  }

  
  // ─────────────────────────────────────────────────────────────────────────
  // LATENCY SIGNAL HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  private handleLatencySignal(latencySignal: any): void {
    // Check rate limits
    this.refreshRisk();
    if (this.tradesThisHour >= this.cfg.maxTradesPerHour) {
      this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: limit transaksi per jam tercapai (${this.tradesThisHour}/${this.cfg.maxTradesPerHour}).`);
      return;
    }
    if (!(this as any).isRunning || !this.lastPredictOdds || Date.now() - this.lastPredictOdds.timestamp > (this.cfg.maxQuoteAgeMs || 2500) || Date.now() - latencySignal.timestamp > 750 || latencySignal.timestamp > Date.now() + 1000) return;
    if (latencySignal.timestamp <= this.lastSignalTimestamp) return;
    this.lastSignalTimestamp = latencySignal.timestamp;
    if (this.dailyPnl <= -this.cfg.maxDailyLoss) {
      this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: batas rugi harian tercapai ($${this.dailyPnl.toFixed(2)} / -$${this.cfg.maxDailyLoss}).`);
      return;
    }
    if (Date.now() - this.lastTradeTime < this.cfg.cooldownMs) {
      // Hanya log sesekali untuk cooldown agar tidak spamming
      if (Math.random() < 0.2) {
        this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: dalam masa cooldown engine (${Date.now() - this.lastTradeTime}ms < ${this.cfg.cooldownMs}ms).`);
      }
      return;
    }
    
    // Prevent entering new trades in the wild beginning (0-3s) and last part of the active trading window
    const nowSec = Math.floor(Date.now() / 1000);
    const secondsIntoEpoch = nowSec % 300;
    if (secondsIntoEpoch < 2 || secondsIntoEpoch >= 285) {
      this.log(`⏳ [BLOCK SIGNAL] Skipping trade entry due to epoch boundary constraint (seconds into epoch: ${secondsIntoEpoch}s).`);
      return;
    }
    
    const hasAnyActiveTrade = this.trades.some(t => t.mode !== 'unknown' && !t.resolved && !t.isSold);
    if (hasAnyActiveTrade || this.isExecutingTrade) {
      if (this.cfg.debug && Math.random() < 0.1) {
        this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: masih ada trade aktif (hasAnyActiveTrade=${hasAnyActiveTrade}) atau lagi eksekusi (isExecutingTrade=${this.isExecutingTrade}).`);
      }
      return;
    }
    
    // If we are completely flat, clear the spike locks so we don't get stuck indefinitely
    this.lastAttemptPrice['UP'] = null;
    this.lastAttemptPrice['DOWN'] = null;
    
    // Enforce the spike lock: if we have an active lastAttemptPrice, we MUST wait for the reset/extension!
    if (this.lastAttemptPrice[latencySignal.direction] !== null) {
      this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: harga belum retracing/extending dari peak sebelumnya ($${this.lastAttemptPrice[latencySignal.direction]?.toFixed(2)}). Lock aktif.`);
      return;
    }
    
    const lastDirTradeTime = this.lastTradeTimeByDirection[latencySignal.direction] || 0;
    if (Date.now() - lastDirTradeTime < 100) {
      this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: directional cooldown < 100ms.`);
      return;
    }
    
    // Bypass the redundant lag-inducing momentum check. LatencyDetector already performs ultra-high-precision multi-window checks!
    // This removes unnecessary milliseconds of execution delay.
    const isPriceMovingCorrectly = true;
    
    // Convert to ArbitrageSignal format for executeTrade
    const upOdds = this.lastPredictOdds?.upOdds || 2.0;
    const downOdds = this.lastPredictOdds?.downOdds || 2.0;
    const upPrice = 1 / upOdds;
    const downPrice = 1 / downOdds;
    
    const marketOdds = latencySignal.direction === 'UP' ? upOdds : downOdds;
    const marketPrice = 1 / marketOdds;
      
    // Enforce safe price boundary [0.30, 0.60] (30c to 60c) as requested
    if (marketPrice < 0.30 || marketPrice > 0.60) {
      this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: marketPrice ${(marketPrice * 100).toFixed(0)}¢ di luar rentang aman [30¢, 60¢].`);
      return;
    }
    
    // Calculate the fair probability and the true option edge
    const startPrice = this.currentStartPrice || latencySignal.binancePrice;
    const baseStdDev = startPrice * 0.0008;
    const stdDev = Math.max(15, baseStdDev);
    const zScore = (latencySignal.binancePrice - startPrice) / stdDev;
    const fairProbUp = this.phi(zScore);
    const fairProbDown = 1 - fairProbUp;
    
    const edgeUp = fairProbUp - upPrice;
    const edgeDown = fairProbDown - downPrice;
    const realEdge = latencySignal.direction === 'UP' ? edgeUp : edgeDown;
    
    // Strict mathematical safety gate: If the calculated option edge is negative, 
    // it means Predict.fun has already adjusted or is overpriced against our spike.
    // Trading on a negative edge leads to instant loss!
    if (realEdge <= 0) {
      this.log(`⛔ [SIGNAL DROPPED] ${latencySignal.direction} ditolak: real mathematical edge is negative atau zero (${(realEdge * 100).toFixed(2)}%).`);
      return;
    }
    
    // POST-CANCEL RISK GATE (mirrors detectArbitrage): if this direction's last order was
    // cancelled with zero fill in the last 4 seconds, require a slightly bigger edge and
    // confidence before retrying, so we don't chase a price that completely ran away.
    const msSinceCancel = Date.now() - (this.lastCancelTime[latencySignal.direction] || 0);
    const isPostCancelRetry = msSinceCancel < 4000;
    const requiredEdge = isPostCancelRetry ? Math.max(this.cfg.minEdge * 1.2, 0.010) : this.cfg.minEdge;
    const requiredConfidence = isPostCancelRetry 
      ? Math.max(this.cfg.minConfidence * 0.9, 0.45) 
      : this.cfg.minConfidence * 0.8; // Optimize confidence threshold for speed
    
    if (realEdge < requiredEdge || latencySignal.confidence < Math.max(this.cfg.minConfidence, requiredConfidence)) return;
    const edge = realEdge;

    const fairOdds = latencySignal.direction === 'UP' ? 1 / fairProbUp : 1 / fairProbDown;
    
    const signal: ArbitrageSignal = {
      direction: latencySignal.direction,
      edge,
      confidence: latencySignal.confidence,
      fairOdds,
      marketOdds,
      momentum: latencySignal.velocity,
      volumeSpike: latencySignal.tradeFlowScore > 0.5,
      orderBookImbalance: latencySignal.obImbalance,
      latencyMs: Math.max(0, Date.now() - latencySignal.timestamp),
      reason: latencySignal.reason
    };
    
    this.log(`🎯 LATENCY SIGNAL: ${signal.direction} | Edge: ${(signal.edge * 100).toFixed(1)}% | Conf: ${(signal.confidence * 100).toFixed(0)}%`);
    this.log(`   Reason: ${signal.reason}`);
    
    if (this.cfg.enableAutoTrade) {
      this.executeTrade(signal).catch(error => this.log(`Execution paused: ${error.message}`));
    }
  }

  private inversePhi(p: number): number {
    const a1 = -3.969683028665376e+01, a2 = 2.209460984245205e+02,
          a3 = -2.759285104469687e+02, a4 = 1.383577518672690e+02,
          a5 = -3.066479806614716e+01, a6 = 2.506628277459239e+00;
    const b1 = -5.447609879822406e+01, b2 = 1.615858368580409e+02,
          b3 = -1.556989798598866e+02, b4 = 6.680131188771972e+01,
          b5 = -1.328068155288572e+01;
    const c1 = -7.784894002430293e-03, c2 = -3.223964580411365e-01,
          c3 = -2.400758277161838e+00, c4 = -2.549732539343734e+00,
          c5 = 4.374664141464968e+00, c6 = 2.938163982698783e+00;
    const d1 = 7.784695709041462e-03, d2 = 3.224671290700398e-01,
          d3 = 2.445134137142996e+00, d4 = 3.754408661907416e+00;
    const p_low = 0.02425;
    const p_high = 1 - p_low;
    let q, r;

    if (p < 0 || p > 1) return 0;
    if (p < p_low) {
        q = Math.sqrt(-2 * Math.log(p));
        return (((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
               ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
    } else if (p <= p_high) {
        q = p - 0.5;
        r = q * q;
        return (((((a1 * r + a2) * r + a3) * r + a4) * r + a5) * r + a6) * q /
               (((((b1 * r + b2) * r + b3) * r + b4) * r + b5) * r + 1);
    } else {
        q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c1 * q + c2) * q + c3) * q + c4) * q + c5) * q + c6) /
                ((((d1 * q + d2) * q + d3) * q + d4) * q + 1);
    }
  }


  private phi(z: number): number {
    const p = 0.2316419;
    const b1 = 0.319381530;
    const b2 = -0.356563782;
    const b3 = 1.781477937;
    const b4 = -1.821255978;
    const b5 = 1.330274429;
    
    const t = 1 / (1 + p * Math.abs(z));
    const absZ = Math.abs(z);
    const exponent = -absZ * absZ / 2;
    const pdf = Math.exp(exponent) / Math.sqrt(2 * Math.PI);
    const cdf = 1 - pdf * (b1 * t + b2 * t * t + b3 * Math.pow(t, 3) + b4 * Math.pow(t, 4) + b5 * Math.pow(t, 5));
    
    return z >= 0 ? cdf : 1 - cdf;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DETECT ARBITRAGE OPPORTUNITY
  // ─────────────────────────────────────────────────────────────────────────
  private detectArbitrage(currentTick: BinanceTick): ArbitrageSignal | null {
    if (this.ticks.length < 5) return null;
    
    // We check immediate momentum across 4 different windows to guarantee high-precision sniper entries:
    // 1. micro (last 300ms)
    // 2. short (last 1000ms)
    // 3. medium (last 2000ms)
    // 4. macro (last 10000ms)
    const now = Date.now();
    
    // Use historical lookback search for ultra-accurate movement calculation, preventing miss on quiet periods!
    const getPriceAgo = (msAgo: number): number => {
      if (this.ticks.length === 0) return currentTick.price;
      const targetTs = now - msAgo;
      const olderTicks = this.ticks.filter(t => t.timestamp <= targetTs);
      if (olderTicks.length > 0) {
        const tick = olderTicks[olderTicks.length - 1];
        const maxAge = msAgo * 1.6;
        if (now - tick.timestamp > maxAge) {
          return currentTick.price; // Too old, treat as flat
        }
        return tick.price;
      }
      return currentTick.price; // No older points, treat as flat
    };
    const priceDetectMs = getPriceAgo(this.cfg.detectionWindowMs);
    const moveDetectPct = ((currentTick.price - priceDetectMs) / priceDetectMs) * 100;
    const momentum = Math.min(1, Math.abs(moveDetectPct) / this.cfg.minPriceMovePct);

    // Order book imbalance
    const orderBookImbalance = this.calcOrderBookImbalance();
    
    // Fetch current starting/target price of the epoch
    const startPrice = this.currentStartPrice || currentTick.price;
    
    // Calculate remaining seconds in epoch
    const nowSec = Math.floor(Date.now() / 1000);
    const secondsIntoEpoch = nowSec % 300;
    const remainingSec = Math.max(30, 300 - secondsIntoEpoch);
    
    // Standard deviation (volatility) for the 5-minute epoch (using stable startPrice basis to eliminate price drift)
    // 0.08% of start price (approx $50 when BTC is $64k) represents a solid 5m volatility base.
    const baseStdDev = startPrice * 0.0008;
    const stdDev = Math.max(15, baseStdDev);
    
    // Calculate standard Z-score of current price relative to start price
    const zScore = (currentTick.price - startPrice) / stdDev;
    
    // Calculate fair probabilities using standard normal cumulative distribution (CDF)
    const fairProbUp = this.phi(zScore);
    const fairProbDown = 1 - fairProbUp;
    
    // Fetch current Predict.fun probabilities
    const upOdds = this.lastPredictOdds?.upOdds || 2.0;
    const downOdds = this.lastPredictOdds?.downOdds || 2.0;
    const upPrice = 1 / upOdds;
    const downPrice = 1 / downOdds;
    
    // Compare edges for both directions to find the highest mispricing!
    const edgeUp = fairProbUp - upPrice;
    const edgeDown = fairProbDown - downPrice;
    
    // SPOT MOVEMENT CHECK
    // To execute a latency arbitrage, spot MUST have moved suddenly!
    const isRising = moveDetectPct >= this.cfg.minPriceMovePct;
    const isDropping = moveDetectPct <= -this.cfg.minPriceMovePct;
    
    if (!isRising && !isDropping) {
      return null; // Not a sudden latency movement
    }
    
    let direction: 'UP' | 'DOWN';
    if (edgeUp > edgeDown && edgeUp > 0 && isRising) {
      direction = 'UP';
    } else if (edgeDown > edgeUp && edgeDown > 0 && isDropping) {
      direction = 'DOWN';
    } else {
      return null; // Reject if no edge or momentum doesn't match the edge direction
    }


    
    const edge = direction === 'UP' ? edgeUp : edgeDown;
    const fairProb = direction === 'UP' ? fairProbUp : fairProbDown;
    const marketPrice = direction === 'UP' ? upPrice : downPrice;
    const marketOdds = direction === 'UP' ? upOdds : downOdds;
    
    // Prevent trading in extreme markets (prices under 30c or over 60c)
    if (marketPrice < 0.30 || marketPrice > 0.60) {
      return null;
    }
    
    // To be lightning fast (milliseconds) and avoid trading on noise,
    // we use purely instantaneous metrics. No historical delays.
    
    // Detect volume spike
    const ticks1000ms = this.ticks.filter(t => t.timestamp >= now - 1000);
    const recentVolume = ticks1000ms.reduce((sum, t) => sum + t.volume, 0);
    const avgRecentVolume = this.avgVolume * (ticks1000ms.length / 60); // normalize
    const volumeSpike = recentVolume > avgRecentVolume * this.cfg.volumeSpikeMultiplier;
    
    // Calculate confidence based on orderbook imbalance, volume spikes, and edge size
    let confidence = 0.50; // Start with base confidence
    
    // Add order book support if it aligns with the direction
    const isObAligned = (direction === 'UP' && orderBookImbalance > 0) || (direction === 'DOWN' && orderBookImbalance < 0);
    if (isObAligned) {
      confidence += Math.abs(orderBookImbalance) * 0.35;
    }
    
    if (volumeSpike) {
      confidence += 0.10;
    }
    
    // If the edge itself is massive, boost confidence as it is a prime sniper opportunity!
    if (edge >= 0.02) {
      confidence += (edge - 0.02) * 5.0; // increase confidence linearly for huge edges
    }
    
    confidence = Math.max(0.1, Math.min(1, confidence));
    
    // Latency
    const latencyMs = 0; // Pure instant

    // Build reason details for transparency
    const reasons: string[] = [
      `Z=${zScore.toFixed(2)}`,
      `fair=${(fairProb * 100).toFixed(0)}%`,
      `mkt=${(marketPrice * 100).toFixed(0)}%`,
      `delta=${(currentTick.price - startPrice).toFixed(1)}`,
      `edge=${(edge * 100).toFixed(1)}%`
    ];
    if (momentum > 0.1) reasons.push(`momentum=${(momentum * 100).toFixed(0)}%`);
    if (volumeSpike) reasons.push('volume_spike');
    if (Math.abs(orderBookImbalance) > 0.05) reasons.push(`orderbook_imb=${orderBookImbalance.toFixed(2)}`);
    
    // STRICT THRESHOLD COMPLIANCE:
    // No lowered thresholds or hyper-aggressive overrides. The standard minimum edge and confidence
    // configurations from user settings are strictly enforced to prevent excessive and low-quality trades.
    let effectiveMinEdge = this.cfg.minEdge;
    let effectiveMinConfidence = this.cfg.minConfidence;
    
    // POST-CANCEL RISK GATE: if our last order in this direction was cancelled (zero-fill) within
    // the last 4 seconds, the price may have already run further while that order was in flight.
    // Retrying blindly at that point means chasing a worse entry with a shrinking real edge.
    // We demand a slightly bigger edge/confidence to justify the chase.
    const msSinceCancel = Date.now() - (this.lastCancelTime[direction] || 0);
    const isPostCancelRetry = msSinceCancel < 4000;
    if (isPostCancelRetry) {
      effectiveMinEdge = Math.max(effectiveMinEdge * 1.2, 0.010);
      effectiveMinConfidence = Math.max(effectiveMinConfidence, this.cfg.minConfidence * 1.1);
    }
    
    if (edge >= effectiveMinEdge && confidence >= effectiveMinConfidence) {
      const fairOdds = 1 / Math.max(0.01, Math.min(0.99, fairProb));
      return {
        direction,
        edge,
        confidence,
        fairOdds,
        marketOdds,
        momentum,
        volumeSpike,
        orderBookImbalance,
        latencyMs,
        reason: reasons.join(', '),
        isFastSpike: false,
      };
    }
    
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ORDER BOOK IMBALANCE
  // ─────────────────────────────────────────────────────────────────────────
  private calcOrderBookImbalance(): number {
    const bidVol = this.orderBook.bids.reduce((a, b) => a + b, 0);
    const askVol = this.orderBook.asks.reduce((a, b) => a + b, 0);
    const total = bidVol + askVol;
    if (total === 0) return 0;
    return (bidVol - askVol) / total; // -1 to 1
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET CURRENT PREDICT.FUN ODDS
  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // EXECUTE TRADE
  // ─────────────────────────────────────────────────────────────────────────
  private async executeTrade(signal: ArbitrageSignal): Promise<void> {
    if (!this.storageHealthy || this.isExecutingTrade || !(this as any).isRunning || !this.cfg.enableAutoTrade) return;
    this.refreshRisk();
    const now = Date.now();
    const epoch = Math.floor(now / 300000) * 300;
    const details = this.predictMarketDetails;
    if (!details || details.epoch !== epoch || !this.lastPredictOdds || now - this.lastPredictOdds.timestamp > (this.cfg.maxQuoteAgeMs || 2500) || !this.currentStartPrice) return;
    if (now / 1000 - epoch < 2 || now / 1000 - epoch >= 230 || this.trades.some(t => t.mode !== 'unknown' && !t.resolved && !t.isSold)) return;
    if (this.tradesThisHour >= this.cfg.maxTradesPerHour || this.dailyPnl <= -this.cfg.maxDailyLoss || now - this.lastTradeTime < this.cfg.cooldownMs) return;
    const outcome = signal.direction === 'UP' ? details.upOutcome : details.downOutcome;
    const ask = Number(outcome.bestAsk?.price);
    if (!(ask >= 0.30 && ask <= 0.60)) return;
    const precision = details.market.decimalPrecision ?? 3;
    const tick = 10 ** -precision;
    const limitPrice = Math.min(0.65, Math.ceil((ask + Math.min(this.cfg.executionSlippage ?? 0.01, 0.03)) / tick) * tick);
    const feeRateBps = Number(details.market.feeRateBps);
    if (!Number.isFinite(feeRateBps) || feeRateBps < 0) return;
    const netEdge = expectedNetEdge(1 / signal.fairOdds, limitPrice, feeRateBps);
    if (netEdge < this.cfg.minEdge || signal.confidence < this.cfg.minConfidence) return;
    const tradeAmount = this.cfg.maxTradeAmount;
    if (!(tradeAmount > 0) || this.dailyPnl - tradeAmount < -this.cfg.maxDailyLoss) return;
    const levels = signal.direction === 'UP' ? details.book.asks : details.book.bids.map((level: any) => [Number((1 - Number(level[0])).toFixed(precision)), level[1]]);
    const available = levels.filter((level: any) => Number(level[0]) <= limitPrice).reduce((sum: number, level: any) => sum + Number(level[1]), 0);
    if (!Number.isFinite(available) || available < tradeAmount / ask) return;
    const isPaper = this.cfg.isPaperTrading;
    const credentials = getSystemConfig();
    const apiKey = this.cfg.predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
    if (!isPaper && (process.env.ENABLE_LIVE_TRADING !== 'true' || !credentials.walletPrivateKey || !apiKey || !(credentials.smartWalletAddress || credentials.walletAddress) || now - this.lastBalanceSyncTime > 45000 || this.walletBalanceUsdt < tradeAmount * 1.02)) return;
    this.isExecutingTrade = true;
    this.lastTradeTime = now; // Reserve before awaiting network I/O.
    const trade: ArbitrageTrade = {
      id: `${isPaper ? 'Paper' : 'Pending'}_${now}_${signal.direction}`,
      mode: isPaper ? 'paper' : 'live', timestamp: now, direction: signal.direction,
      amount: tradeAmount, submittedAmount: tradeAmount, entryOdds: 1 / limitPrice,
      fairOdds: signal.fairOdds, edge: netEdge, signal: { ...signal, edge: netEdge }, targetLockTime: epoch,
      feeRateBps, tokenId: String(outcome.onChainId), resolved: false, isSold: false,
      isFilled: isPaper, fillTimestamp: isPaper ? now : undefined,
      sharesQuantity: estimateBuyShares(tradeAmount, limitPrice, feeRateBps),
      entryBtcPrice: this.currentPrice,
      reconciliationRequired: !isPaper,
    };
    // Persist intent before submission; a process crash cannot silently erase an in-flight order.
    this.trades.push(trade);
    try {
      await this.saveTrades();
      if (!isPaper) {
        const result = await placePredictOrder(signal.direction === 'UP' ? 'BULL' : 'BEAR', tradeAmount, credentials.walletPrivateKey, credentials.smartWalletAddress || '', apiKey, limitPrice, epoch, 'BUY', details.market, outcome);
        trade.id = result.orderId;
        trade.orderId = result.orderId;
        trade.orderHash = result.hash;
        trade.orderExpiration = result.expiration;
        trade.entryOdds = 1 / result.limitPrice;
        trade.submittedShares = result.sharesQuantity;
        trade.submittedAmount = result.principalUsdt;
        trade.reconciliationRequired = false;
      }
      this.lastTradeTimeByDirection[signal.direction] = now;
      this.log(`${isPaper ? 'Paper fill at worst allowed limit' : 'Order accepted, awaiting fill'}: ${trade.id}; budget $${tradeAmount.toFixed(2)}, limit ${limitPrice.toFixed(3)}, net model edge ${(netEdge * 100).toFixed(2)}%.`);
    } catch (error: any) {
      if (error.uncertain) {
        trade.orderHash = error.orderHash;
        trade.orderId = error.orderId;
        trade.orderExpiration = error.expiration;
        trade.submissionUncertain = true;
        trade.reconciliationRequired = !error.orderHash;
        trade.submittedShares = error.sharesQuantity;
        trade.submittedAmount = error.principalUsdt || tradeAmount;
        this.log(`Order result uncertain for ${trade.id}; new entries blocked until venue reconciliation.`);
      } else {
        trade.isCancelled = trade.resolved = true;
        trade.resolvedAt = Date.now();
        trade.pnl = 0;
        trade.reconciliationRequired = false;
        this.log(`Order rejected for ${trade.id}: ${error.message}`);
      }
    } finally {
      this.isExecutingTrade = false;
      this.refreshRisk();
      await this.saveTrades();
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HEDGE IN BINANCE FUTURES (optional)
  // ─────────────────────────────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────────────────
  // UTILITIES
  // ─────────────────────────────────────────────────────────────────────────
  private updateVolumeAverage(): void {
    if (this.volumeHistory.length === 0) return;
    this.avgVolume = this.volumeHistory.reduce((a, b) => a + b, 0) / this.volumeHistory.length;
  }

  private async loadTrades(): Promise<void> {
    try {
      if (fs.existsSync(this.cfg.memoryFilePath)) {
        const raw = fs.readFileSync(this.cfg.memoryFilePath, 'utf-8');
        const parsedTrades = JSON.parse(raw);
        if (Array.isArray(parsedTrades)) {
          const seenIds = new Set<string>();
          this.trades = parsedTrades.filter(t => {
            if (!t || !t.id) return false;
            if (seenIds.has(t.id)) {
              return false;
            }
            seenIds.add(t.id);
            return true;
          });
        } else {
          throw new Error('Trade ledger must be an array');
        }
        
        for (const trade of this.trades) {
          trade.mode ??= trade.id.startsWith('Paper_') || trade.id.startsWith('PaperFallback_') ? 'paper' : 'unknown';
          trade.isCheckingFill = false;
          trade.isCheckingSellFill = false;
          if (trade.mode === 'live' && !trade.resolved && ((!trade.isFilled && (!trade.orderHash || !trade.orderExpiration)) || (trade.isSellOrderPlaced && (!trade.sellOrderHash || !trade.sellExpiration)))) trade.reconciliationRequired = true;
        }
        this.refreshRisk();
      }
    } catch (err) {
      this.storageHealthy = false;
      this.cfg.enableAutoTrade = false;
      this.log(`Trade ledger unreadable; entries disabled until the ledger is recovered: ${err}`);
      this.trades = [];
    }
  }

  private async saveTrades(): Promise<void> {
    if (!this.storageHealthy) throw new Error('Trade ledger requires recovery; refusing to overwrite');
    try {
      fs.mkdirSync(path.dirname(this.cfg.memoryFilePath), { recursive: true });
      const temp = `${this.cfg.memoryFilePath}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(this.trades, null, 2), { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(temp, this.cfg.memoryFilePath);
    } catch (err) {
      this.log(`Ledger write failed; trading paused: ${err}`);
      this.cfg.enableAutoTrade = false;
      this.storageHealthy = false;
      throw err;
    }
  }

  private log(msg: string): void {
    const timeStr = new Date().toLocaleTimeString();
    this.logs.push(`[${timeStr}] ${msg}`);
    console.log(`[ArbEngine] ${msg}`);
    if (this.logs.length >= 1000) {
      this.logs = this.logs.slice(-5); // Keep last 5 logs for context
      this.logs.push(`[${timeStr}] 🧹 Logs automatically cleared & rotated (limit of 1000 reached to keep system lightweight)`);
    }
  }

  public clearLogs(): void {
    this.logs = [`[${new Date().toLocaleTimeString()}] 🧹 Logs manually cleared by user`];
  }

  public setConfig(config: Partial<ArbitrageConfig>) {
    if (config.isPaperTrading === false && process.env.ENABLE_LIVE_TRADING !== 'true') throw new Error('Live trading requires ENABLE_LIVE_TRADING=true');
    const targetMode = config.isPaperTrading === false ? 'live' : 'paper';
    if (config.isPaperTrading !== undefined && this.trades.some(t => t.mode !== 'unknown' && !t.resolved && !t.isSold && t.mode !== targetMode)) throw new Error('Switching mode would leave open orders or positions unmanaged');
    this.cfg = { ...this.cfg, ...config };
    this.refreshRisk();
    if (this.latencyDetector) {
      this.latencyDetector.reconfigure({
        minPriceDeltaPct: this.cfg.minPriceMovePct,
        minConfidence: this.cfg.minConfidence,
      });
    }
    this.log(`⚙️ Config updated. Paper Trading: ${this.cfg.isPaperTrading}`);
  }

  private async syncWalletBalance(): Promise<void> {
    if (this.balanceSyncBusy || this.cfg.isPaperTrading) return;
    this.balanceSyncBusy = true;
    let provider: ethers.JsonRpcProvider | undefined;
    try {
      const config = getSystemConfig();
      const account = config?.smartWalletAddress || config?.walletAddress;
      if (!account) return;
      
      // Predict.fun operates on BNB Chain (BSC) with USDT in the backend
      provider = new ethers.JsonRpcProvider("https://bsc-dataseed1.binance.org", undefined, { staticNetwork: true });
      const usdtAddr = "0x55d398326f99059fF775485246999027B3197955";
      const usdtContract = new ethers.Contract(usdtAddr, [
        "function balanceOf(address account) view returns (uint256)",
        "function decimals() view returns (uint8)"
      ], provider);
      
      const bal = await usdtContract.balanceOf(account);
      const dec = await usdtContract.decimals();
      this.walletBalanceUsdt = parseFloat(ethers.formatUnits(bal, dec));
      this.lastBalanceSyncTime = Date.now();
      
      this.log(`🏦 [WALLET] Current USDT Balance: $${this.walletBalanceUsdt.toFixed(2)}`);
    } catch (err: any) {
      this.log(`Wallet balance unavailable: ${err.message || String(err)}`);
    } finally { provider?.destroy(); this.balanceSyncBusy = false; }
  }

  public getStats() {
    this.refreshRisk();
    const modeTrades = this.trades.filter(t => t.mode === (this.cfg.isPaperTrading ? 'paper' : 'live'));
    const totalTrades = modeTrades.length;
    const completedTrades = modeTrades.filter(t => t.resolved && t.outcome);
    const wins = completedTrades.filter(t => t.outcome === 'WIN').length;
    const losses = completedTrades.filter(t => t.outcome === 'LOSS').length;
    const winRate = completedTrades.length > 0 ? (wins / completedTrades.length * 100).toFixed(1) : '0.0';
    const totalPnl = completedTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
    
    return {
      tradesThisHour: this.tradesThisHour,
      dailyPnl: this.dailyPnl,
      avgVolume: this.avgVolume,
      ticksInBuffer: this.ticks.length,
      lastTradeTime: this.lastTradeTime,
      currentPrice: this.currentPrice,
      totalTrades,
      wins,
      losses,
      winRate,
      totalPnl,
      pnlIsEstimate: true,
      storageHealthy: this.storageHealthy,
      quoteAgeMs: this.lastPredictOdds ? Date.now() - this.lastPredictOdds.timestamp : null,
      unknownHistoryCount: this.trades.filter(t => t.mode === 'unknown').length,
      dataQuality: this.lastPredictOdds ? 'OBSERVED_ORDERBOOK' : 'UNAVAILABLE',
      quoteSource: this.quoteSource,
      reconciliationRequired: this.trades.some(t => t.mode === 'live' && !t.resolved && this.cfg.isPaperTrading) || modeTrades.some(t => !t.resolved && (t.submissionUncertain || t.reconciliationRequired)),
      isPaperTrading: this.cfg.isPaperTrading,
      logs: this.logs,
      lastPredictOdds: this.lastPredictOdds,
      walletBalanceUsdt: this.walletBalanceUsdt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────
export const arbitrageEngine = new PredictFunArbitrageEngine();

export async function startArbitrage(): Promise<void> {
  return arbitrageEngine.start();
}

export async function stopArbitrage(): Promise<void> {
  return arbitrageEngine.stop();
}

export function getArbitrageStats() {
  return arbitrageEngine.getStats();
}

export function updateArbitrageConfig(config: Partial<ArbitrageConfig>) {
  arbitrageEngine.setConfig(config);
}

export function clearArbitrageLogs(): void {
  arbitrageEngine.clearLogs();
}

// ─────────────────────────────────────────────────────────────────────────────
// ODDS MISPRICING SCANNER
// ─────────────────────────────────────────────────────────────────────────────
export function scanOddsMispricing(odds: PredictFunOdds, trueUpProb: number): {
  edge: number;
  direction: 'UP' | 'DOWN' | null;
  trueProbability: number;
} {
  const upProb = 1 / odds.upOdds;
  const downProb = 1 / odds.downOdds;
  
  // Calculate true probability using our model
  const trueDownProb = 1 - trueUpProb;
  
  // Calculate edge
  const upEdge = trueUpProb - upProb;
  const downEdge = trueDownProb - downProb;
  
  if (upEdge > 0.03 && upEdge > downEdge) {
    return { edge: upEdge, direction: 'UP', trueProbability: trueUpProb };
  } else if (downEdge > 0.03 && downEdge > upEdge) {
    return { edge: downEdge, direction: 'DOWN', trueProbability: trueDownProb };
  }
  
  return { edge: 0, direction: null, trueProbability: 0.5 };
}
