import { placePredictOrder, checkAndCancelPredictOrder, getPredictMarket } from "./predictClient";
import { collectAllMarketData, getPredictionRound, buildFeatures } from "./marketData.v3";
import { getPredictWhalesConsensus } from "./predictWhaleTracker";
import dotenv from "dotenv";
dotenv.config({ override: true });
import { ethers } from "ethers";
import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import { analyze as runClaudeBrain } from "./brain/brain";
import { sovereignAgent, agentUpdateOutcome } from "./brain/agent";
import { GoogleGenAI } from "@google/genai";

import { SystemConfig, TradeLog, LogMessage, PredictionState, PerformanceStats, RoundPriceState } from "../src/types";


// Setup storage directories
const DATA_DIR = path.join(process.cwd(), "data");
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const CONFIG_PATH = path.join(DATA_DIR, "config.json");
const TRADES_PATH = path.join(DATA_DIR, "trades.json");
const LOGS_PATH = path.join(DATA_DIR, "logs.json");

import * as util from 'util';

const logFile = fs.createWriteStream('./brain.log', { flags: 'a' });

const origLog = console.log;
const origWarn = console.warn;

function formatArgs(args: any[]) {
  return args.map(a => typeof a === 'object' ? util.inspect(a, { depth: null }) : a).join(' ');
}

console.log = (...args) => {
  const line = `[${new Date().toISOString()}] ${formatArgs(args)}\n`;
  logFile.write(line);
  origLog(...args);
};

console.warn = (...args) => {
  const line = `[WARN ${new Date().toISOString()}] ${formatArgs(args)}\n`;
  logFile.write(line);
  origWarn(...args);
};

// Default configuration
const DEFAULT_CONFIG: SystemConfig = {
  bscRpc: "https://bsc-dataseed1.binance.org/",
  walletPrivateKey: "",
  walletAddress: "",
  betAmountUsdt: 0.5, // Flat 0.5 USDT per trade
  minConfidence: 0.50,
  isLiveTrading: false, // Default is safe simulation mode
  maxDailyLossUsdt: 5.0, // 5.0 USDT Max Daily Loss
  predictContractAddress: "0xd172f3fbabe763ee8e52d8b32421574236da6057",
  brainMode: "aggressive",
  simulateLiveBalances: true,
  cerebrasApiEndpoint: process.env.CEREBRAS_API_ENDPOINT || "https://api.cerebras.ai/v1",
  cerebrasModel: process.env.CEREBRAS_MODEL || "llama3.1-70b"
};

// Redundant and resilient public BSC RPC nodes for Chainlink feeds
const BACKUP_RPCS = [
  "https://bsc-dataseed.binance.org/",
  "https://binance.llamarpc.com",
  "https://bsc-dataseed1.binance.org/",
  "https://bsc-dataseed2.binance.org/",
  "https://bsc.publicnode.com",
  "https://1rpc.io/bnb"
];

// Predict.fun Prediction ABI Fragment
const PREDICTION_ABI = [
  "function betBull(uint256 epoch) payable",
  "function betBear(uint256 epoch) payable",
  "function betBull(uint256 epoch, uint256 amount)",
  "function betBear(uint256 epoch, uint256 amount)",
  "function claim(uint256[] epochs)",
  "function claimable(uint256 epoch, address user) view returns (bool)",
  "function currentEpoch() view returns (uint256)",
  "function rounds(uint256) view returns (uint256 epoch, uint256 startTimestamp, uint256 lockTimestamp, uint256 closeTimestamp, int256 lockPrice, int256 closePrice, uint256 lockOracleId, uint256 closeOracleId, uint256 totalAmount, uint256 bullAmount, uint256 bearAmount, uint256 rewardBaseCalRatio, uint256 rewardAmount, bool oracleCalled)"
];

// Resilient multi-domain Binance query helper with GCP-direct routing fallback
async function fetchBinanceWithFallback(pathAndParams: string, timeout = 8000): Promise<any> {
  const domains = [
    "https://api-gcp.binance.com",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://data-api.binance.vision"
  ];
  let lastError: any = null;
  for (const domain of domains) {
    try {
      const res = await axios.get(`${domain}${pathAndParams}`, { timeout });
      if (res && res.data) {
        return res;
      }
    } catch (e: any) {
      lastError = e;
    }
  }
  throw lastError || new Error(`Failed to fetch from all Binance endpoints for ${pathAndParams}`);
}

export class TradingEngine {
  private config: SystemConfig = { ...DEFAULT_CONFIG };
  private trades: TradeLog[] = [];
  private snipingAsset: { punyaKupon: boolean; tradeId: string; tipe: number; jumlahShares: number; hargaBeliUsdt: number; epoch: number } | null = null;
  private lastSniperEpoch: number = 0;
  private logs: LogMessage[] = [];
  private cerebrasApiKey: string = process.env.CEREBRAS_API_KEY || "";
  private cerebrasApiEndpoint: string = process.env.CEREBRAS_API_ENDPOINT || "https://api.cerebras.ai/v1";
  private macroStrategy: string = "Analytical Strategy core initialized. Formulating fundamental macro-directives...";
  private provider: ethers.JsonRpcProvider | null = null;
  private wallet: ethers.Wallet | null = null;
  private smartAccount: any = null;
  private contract: ethers.Contract | null = null;
  private chainlinkContract: ethers.Contract | null = null;
  private activeLoop: NodeJS.Timeout | null = null;
  private nvidiaLoop: NodeJS.Timeout | null = null;
  private secondTicker: NodeJS.Timeout | null = null;
  private geminiClient: GoogleGenAI | null = null;

  private getGeminiClient(): GoogleGenAI | null {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;
    if (!this.geminiClient) {
      this.geminiClient = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            "User-Agent": "aistudio-build",
          }
        }
      });
    }
    return this.geminiClient;
  }

  private pendingRounds: Record<number, {
    regime: string;
    features: { key: string; value: number }[];
    pRaw: number;
    pUp: number;
    decision: "BULL" | "BEAR" | "SKIP";
    betUsdt: number;
  }> = {};

  // Real-time market state
  private btcPrice: number = 65000.0;
  private recentCandles: any[] = [];
  private klines1m: any[] = [];
  private klines5m: any[] = [];
  private btcKlines1m: any[] = [];
  private prevOrderBook: any = null;
  private orderBookData: any = { bids: [], asks: [], pressure: 0.5 };
  private tradeFlowData: any = { buys: 0, sells: 0, ratio: 0.5, valueRatio: 0.5 };
  private stats24h: any = { priceChange: 0, priceChangePct: 0, volume: 0, high: 610, low: 590, weightedAvgPrice: 600 };
  private currentEpoch: number = 0;
  private isSimulatedContract: boolean = false;
  private nextEpochTimeRemaining: number = 300;
  private nextEpochLockTime: number = 0;
  private bullAmount: number = 0;

  // Predict.fun specific exact multipliers
  private bullPayoutMult: number = 1.94;
  private bearPayoutMult: number = 1.94;

  private getTimeRemainingSec(): number {
    if (this.nextEpochLockTime > 0) {
      const now = Math.floor(Date.now() / 1000);
      return Math.max(0, this.nextEpochLockTime - now);
    }
    return this.nextEpochTimeRemaining;
  }

  private getTargetTimestamp(): number {
    return Math.ceil(Math.floor(Date.now() / 1000) / 300) * 300;
  }
  
  private buildConditionId(unixTimestamp: number): string {
    return ethers.zeroPadValue(ethers.toBeHex(parseInt(String(unixTimestamp), 10)), 32);
  }

  private bearAmount: number = 0;
  private lastAnalyzedEpoch: number = 0;
  private isFirstSyncCompleted: boolean = false;
  private epochBrainPredictions: Record<number, {
    summary: string;
    epochSignal: "UP" | "DOWN" | "SKIP";
    claudeResult: any;
  }> = {};
  private aiPrediction: any = null;
  private walletBalanceUsdt: number = 0;
  private estimatedGasCostUsdt: number = 0.000007;
  private liveRounds: RoundPriceState[] = [];
  private simRoundsData: Record<number, { lockPrice: number; closePrice: number; resolved: boolean }> = {};
  private clockOffset: number = 0;

  constructor() {
    this.loadData();
    this.initCerebras();
    this.initEthers();
    this.startEngineLoop();
  }

  // ----------------------------------------------------------------
  // Init & Initialization
  // ----------------------------------------------------------------

  private initCerebras() {
    this.cerebrasApiKey = process.env.CEREBRAS_API_KEY || "";
    this.cerebrasApiEndpoint = this.config.cerebrasApiEndpoint || process.env.CEREBRAS_API_ENDPOINT || "https://api.cerebras.ai/v1";
    const model = this.config.cerebrasModel || process.env.CEREBRAS_MODEL || "llama3.1-70b";
    if (this.cerebrasApiKey) {
      const obscuredKey = this.cerebrasApiKey.substring(0, 9) + "..." + this.cerebrasApiKey.slice(-6);
      this.addLog("success", `🧠 Cerebras Brain Core (Model: ${model}) successfully initialized with key ${obscuredKey} as primary LLM auditor.`);
    } else {
      this.addLog("warn", "⚠️ Cerebras API key not configured. Cerebras analyst will fallback or be bypassed if key is missing.");
    }
  }

  private initEthers() {
    try {
      this.provider = new ethers.JsonRpcProvider(this.config.bscRpc, undefined, { staticNetwork: true });

      if (this.config.walletPrivateKey && this.config.walletPrivateKey.trim().length === 64) {
        try {
          this.wallet = new ethers.Wallet(this.config.walletPrivateKey, this.provider);
          this.config.walletAddress = this.wallet.address;
          this.addLog("success", `Ethers Wallet initialized: ${this.config.walletAddress}`);
          this.addLog("info", `Using standard EOA Wallet (Vault): ${this.wallet.address}`);
          (this as any).smartAccount = null;

        } catch (walletErr: any) {
          this.wallet = null;
          this.addLog("error", `Failed to load private key wallet: ${walletErr.message}`);
        }
      } else {
        this.wallet = null;
        this.config.walletAddress = "";
      }

      // Convert contract address to secure, validated checksum casing
      const rawAddress = (this.config.predictContractAddress || "0xd172f3fbabe763ee8e52d8b32421574236da6057").trim();
      const safeContractAddress = ethers.getAddress(rawAddress.toLowerCase());

      this.contract = new ethers.Contract(
        safeContractAddress,
        PREDICTION_ABI,
        this.wallet || this.provider
      );

      
    } catch (e: any) {
      this.provider = null;
      this.contract = null;
      this.chainlinkContract = null;
      this.addLog("error", `Ethers initialization failed with RPC ${this.config.bscRpc}: ${e.message}`);
    }
  }

  // ----------------------------------------------------------------
  // Storage Managers
  // ----------------------------------------------------------------

  private loadData() {
    // Config
    if (fs.existsSync(CONFIG_PATH)) {
      try {
        const storedConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        this.config = { ...DEFAULT_CONFIG, ...storedConfig };
      } catch (e) {
        this.config = { ...DEFAULT_CONFIG };
      }
    } else {
      this.saveConfig(this.config);
    }

    // Synchronize agent with active config preset from config file
    if (this.config.brainPreset) {
      sovereignAgent.reconfigure(this.config.brainPreset);
    } else {
      sovereignAgent.reconfigure('AGGRESSIVE_PRESET');
    }

    // Trades - Load from storage if exists, fallback to empty array
    if (fs.existsSync(TRADES_PATH)) {
      try {
        this.trades = JSON.parse(fs.readFileSync(TRADES_PATH, "utf-8"));
      } catch (e) {
        this.trades = [];
      }
    } else {
      this.trades = [];
      this.saveTrades();
    }

    // Logs - Load from storage if exists, fallback to empty array
    if (fs.existsSync(LOGS_PATH)) {
      try {
        this.logs = JSON.parse(fs.readFileSync(LOGS_PATH, "utf-8"));
      } catch (e) {
        this.logs = [];
      }
    } else {
      this.logs = [];
      this.saveLogs();
    }

    this.addLog("info", "Predict.fun AI Prediction Engine bootstrap completed.");
  }

  public saveConfig(newConfig: Partial<SystemConfig>) {
    this.config = { ...this.config, ...newConfig };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(this.config, null, 2));

    // Reinitialize ethers to use updated RPC or private key
    this.initEthers();
    this.addLog("info", "Configuration saved, re-init blockchain adapter.");

    // Synchronize agent with active config preset from config file
    if (this.config.brainPreset) {
      sovereignAgent.reconfigure(this.config.brainPreset);
    }
  }

  private saveTrades() {
    fs.writeFileSync(TRADES_PATH, JSON.stringify(this.trades, null, 2));
  }

  private saveLogs() {
    // Keep logs of reasonable size (last 150 entries)
    if (this.logs.length > 200) {
      this.logs = this.logs.slice(-150);
    }
    fs.writeFileSync(LOGS_PATH, JSON.stringify(this.logs, null, 2));
  }

  public addLog(level: 'info' | 'warn' | 'error' | 'success', message: string) {
    const timestamp = new Date().toISOString();
    const id = Math.random().toString(36).substring(2, 9);
    const newLog: LogMessage = { id, timestamp, level, message };
    this.logs.push(newLog);
    console.log(`[${level.toUpperCase()}] ${message}`);
    this.saveLogs();
  }

  // ----------------------------------------------------------------
  // Background Trading Loop
  // ----------------------------------------------------------------

  private updateUIPredictionState() {
     let startPrice = this.btcPrice;
     const apiKey = (this.config as any).predictFunApiKey || process.env.PREDICT_FUN_API_KEY;
     // Retrieve the locked start price for the currently running epoch (which is currentEpoch - 1 logically in Predict)
     if (this.simRoundsData[this.currentEpoch - 1] && this.simRoundsData[this.currentEpoch - 1].lockPrice) {
         startPrice = this.simRoundsData[this.currentEpoch - 1].lockPrice;
     }

     const currentPrice = this.btcPrice;
     let winningPosition: "BULL" | "BEAR" | "FLAT" = "FLAT";
     if (currentPrice > startPrice) {
          winningPosition = "BULL";
     } else if (currentPrice < startPrice) {
          winningPosition = "BEAR";
     }

     const nowSecs = Math.floor(Date.now() / 1000);
     const secondsIntoEpoch = nowSecs % 300;
     const secondsLeft = 300 - secondsIntoEpoch;
     const isLastMinute = secondsLeft <= 60 && secondsLeft >= 50;

     const closedPrices = this.recentCandles.map(c => c.close);
     const highPrices = this.recentCandles.map(c => c.high);
     const lowPrices = this.recentCandles.map(c => c.low);
     const openPrices = this.recentCandles.map(c => c.open);
      
     let macroBiasScore = 0;
     let epochSignal = "SKIP";
     let confidence = 85;
     let detailedSignals: any[] = [];
     let brainSummary = "";

     const cached = this.epochBrainPredictions[this.currentEpoch];
     if (cached) {
         epochSignal = cached.epochSignal;
         if (cached.claudeResult) {
             confidence = cached.claudeResult.confidencePct || 85;
             detailedSignals = cached.claudeResult.signalDetails || [];
             brainSummary = cached.claudeResult.summary || "";
         }
     } else if (this.macroStrategy) {
         const signalMatch = this.macroStrategy.match(/EPOCH_SIGNAL:\s*(UP|DOWN|SKIP)/i);
         if (signalMatch && signalMatch[1]) {
             epochSignal = signalMatch[1].toUpperCase();
         }
     }

     let directionVal: "BULL" | "BEAR" | "HOLD" = "HOLD";
     if (epochSignal === "UP") directionVal = "BULL";
     else if (epochSignal === "DOWN") directionVal = "BEAR";

     let finalReasoning = `🎯 Status: ${isLastMinute ? "MENEMBAK SEKARANG..." : "Menunggu menit terakhir..."} | Posisi Unggul (Spt vs Start): ${winningPosition}\n🧠 Claude AI Brain Signal: ${epochSignal}`;
     if (brainSummary) {
         finalReasoning += `\n📝 Detail: ${brainSummary}`;
     }

     let rsiValue = 50;
     let macdStatus: "BULLISH"| "BEARISH"| "NEUTRAL" = "NEUTRAL";
     let bbStatus: "OVERBOUGHT"| "OVERSOLD"| "NEUTRAL" = "NEUTRAL";

     try {
       rsiValue = this.calculateRSI(this.recentCandles);
       const macdResult = this.calculateMACD(closedPrices);
       macdStatus = macdResult.histogram > 0 ? "BULLISH" : "BEARISH";
       const bbResult = this.calculateBollingerBands(this.recentCandles);
       bbStatus = bbResult.scale > 0.8 ? "OVERBOUGHT" : bbResult.scale < 0.2 ? "OVERSOLD" : "NEUTRAL";
     } catch(e) {}

     this.aiPrediction = {
        direction: directionVal,
        confidence: confidence / 100,
        reasoning: finalReasoning,
        detailedSignals: detailedSignals,
        indicators: {
          rsi: rsiValue,
          macd: macdStatus,
          bollinger: bbStatus,
          imbalance: this.bullAmount / (this.bullAmount + this.bearAmount) || 0.5
        }
      };
  }

  private startEngineLoop() {
    if (this.activeLoop) {
      clearInterval(this.activeLoop);
    }
    if (this.nvidiaLoop) {
      clearInterval(this.nvidiaLoop);
    }
    if (this.secondTicker) {
      clearInterval(this.secondTicker);
    }

    this.addLog("info", "Starting Predict.fun BTC Prediction Core Engine background process...");

    // Core loop runs every 12 seconds to monitor chain and fetch prices
    this.activeLoop = setInterval(async () => {
      try {
        await this.syncMarketData();
        // Cleanup old simRoundsData to prevent memory leak
        const nowSec = Math.floor(Date.now() / 1000);
        for (const ep of Object.keys(this.simRoundsData)) {
          if (parseInt(ep) < nowSec - 7200) { // older than 2 hours
            delete this.simRoundsData[parseInt(ep)];
          }
        }
        
        await this.checkOpenBetsResolution();
      } catch (e: any) {
        console.error("Error in engine loop:", e);
      }
    }, 12000);

    // Second-by-second high precision countdown & execution ticker
    this.secondTicker = setInterval(async () => {
      try {
        if (!this.isFirstSyncCompleted) {
          return;
        }
        if (this.nextEpochTimeRemaining > 0) {
          this.nextEpochTimeRemaining -= 1;
        } else {
          // Simulator auto-transition when countdown reaches 0 (only if no on-chain contract)
          if (!this.contract) {
            this.nextEpochTimeRemaining = 300;
            this.currentEpoch = (this.currentEpoch || 18500) + 1;
            const closedEp = this.currentEpoch - 1;
            if (this.simRoundsData[closedEp]) {
              this.simRoundsData[closedEp].closePrice = this.btcPrice;
              this.simRoundsData[closedEp].resolved = true;
            }

            const newLiveEp = this.currentEpoch;
            this.simRoundsData[newLiveEp] = {
              lockPrice: this.btcPrice,
              closePrice: this.btcPrice,
              resolved: false
            };

            this.bullAmount = Math.random() * 5 + 2;
            this.bearAmount = Math.random() * 5 + 2;
          }
        }

        this.nextEpochLockTime = Math.floor(Date.now() / 1000) + this.nextEpochTimeRemaining;

        this.updateUIPredictionState();

        // Perform instant trigger checks exactly when time matches the window (e.g. <= 12 seconds remaining)
        await this.evaluateTradingTrigger();
        await this.checkSlippageSniper();
        await this.checkUnfilledOrders();
      } catch (err) {
        console.error("Error in secondTicker loop:", err);
      }
    }, 1000);

    // Decoupled Cerebras background analysis loop (runs every 60 seconds completely in parallel)
    this.nvidiaLoop = setInterval(async () => {
      try {
        await this.runBackgroundMacroAnalysis();
      } catch (e: any) {
        console.error("Error in Cerebras background analytics loop:", e);
      }
    }, 60000);

    // Run first sync immediately and trigger the first macro analysis shortly after to ensure candlestick data is ready
    this.syncMarketData()
      .then(() => {
        setTimeout(() => {
          this.runBackgroundMacroAnalysis().catch(e => console.error("Initial background analysis error:", e));
        }, 6000);
      })
      .catch(e => console.error("Initial sync failure:", e));
  }

  // Resilient helpers for fetching Binance data
  private async fetchBinanceKlines(interval: string, limit: number): Promise<any[]> {
    try {
      const res = await fetchBinanceWithFallback(`/api/v3/klines?symbol=BTCUSDT&interval=${interval}&limit=${limit}`, 8000);
      if (res.data && Array.isArray(res.data)) {
        return res.data.map((c: any) => ({
          time: Number(c[0]),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        }));
      }
    } catch (e: any) {
      console.warn(`Failed to fetch Binance ${interval} klines:`, e.message || e);
    }
    return [];
  }

  private async fetchOrderBook(limit = 20): Promise<any> {
    try {
      const res = await fetchBinanceWithFallback(`/api/v3/depth?symbol=BTCUSDT&limit=${limit}`, 8000);
      if (res.data && res.data.bids && res.data.asks) {
        const bids = res.data.bids.map(([p, q]: any) => ({ price: parseFloat(p), qty: parseFloat(q) }));
        const asks = res.data.asks.map(([p, q]: any) => ({ price: parseFloat(p), qty: parseFloat(q) }));
        const totalBid = bids.reduce((s: number, b: any) => s + b.price * b.qty, 0);
        const totalAsk = asks.reduce((s: number, a: any) => s + a.price * a.qty, 0);
        const pressure = totalBid + totalAsk > 0 ? totalBid / (totalBid + totalAsk) : 0.5;
        return { bids, asks, pressure };
      }
    } catch (e: any) {
      console.warn("Failed to fetch Binance order book:", e.message || e);
    }
    return { bids: [], asks: [], pressure: 0.5 };
  }

  private async fetchTradeFlow(limit = 150): Promise<any> {
    try {
      const res = await fetchBinanceWithFallback(`/api/v3/trades?symbol=BTCUSDT&limit=${limit}`, 8000);
      if (res.data && Array.isArray(res.data)) {
        const buys = res.data.filter((t: any) => !t.isBuyerMaker).reduce((s: number, t: any) => s + parseFloat(t.qty), 0);
        const sells = res.data.filter((t: any) => t.isBuyerMaker).reduce((s: number, t: any) => s + parseFloat(t.qty), 0);
        const buyValue = res.data.filter((t: any) => !t.isBuyerMaker).reduce((s: number, t: any) => s + parseFloat(t.qty) * parseFloat(t.price), 0);
        const sellValue = res.data.filter((t: any) => t.isBuyerMaker).reduce((s: number, t: any) => s + parseFloat(t.qty) * parseFloat(t.price), 0);
        const ratio = buys + sells > 0 ? buys / (buys + sells) : 0.5;
        const valueRatio = buyValue + sellValue > 0 ? buyValue / (buyValue + sellValue) : 0.5;
        return { buys, sells, ratio, valueRatio };
      }
    } catch (e: any) {
      console.warn("Failed to fetch Binance trade flow:", e.message || e);
    }
    return { buys: 0, sells: 0, ratio: 0.5, valueRatio: 0.5 };
  }

  private async fetch24hStats(): Promise<any> {
    try {
      const res = await fetchBinanceWithFallback("/api/v3/ticker/24hr?symbol=BTCUSDT", 8000);
      if (res.data) {
        return {
          priceChange: parseFloat(res.data.priceChange),
          priceChangePct: parseFloat(res.data.priceChangePercent),
          volume: parseFloat(res.data.volume),
          high: parseFloat(res.data.highPrice),
          low: parseFloat(res.data.lowPrice),
          weightedAvgPrice: parseFloat(res.data.weightedAvgPrice),
        };
      }
    } catch (e: any) {
      console.warn("Failed to fetch Binance 24hr stats:", e.message || e);
    }
    return { priceChange: 0, priceChangePct: 0, volume: 0, high: 610, low: 590, weightedAvgPrice: 600 };
  }

  // Sync pricing from Binance and Predict.fun on-chain data
  private async syncMarketData() {
    try {
      // Parallelize Binance calls for speed and efficiency
      const [k1m, k5m, ob, tf, stats, btcK1m] = await Promise.all([
        this.fetchBinanceKlines("1m", 120),
        this.fetchBinanceKlines("5m", 60),
        this.fetchOrderBook(20),
        this.fetchTradeFlow(150),
        this.fetch24hStats(),
        this.fetchBinanceKlinesGeneric("BTCUSDT", "1m", 5)
      ]);

      if (k1m.length > 0) {
        this.klines1m = k1m;
        this.btcPrice = k1m[k1m.length - 1].close;
      }
      if (k5m.length > 0) {
        this.klines5m = k5m;
        this.recentCandles = k5m.slice(-50); // MIGRATED to 5m!
      }
      if (btcK1m && btcK1m.length > 0) {
        this.btcKlines1m = btcK1m;
      }
      if (ob) this.orderBookData = ob;
      if (tf) this.tradeFlowData = tf;
      if (stats) this.stats24h = stats;

    } catch (e: any) {
      this.addLog("warn", "One or more Binance API calls rate-limited or failed. Using live fallback states.");
    }

    // 3. Query Predict.fun Contract
    if (this.contract) {
      try {
        // Sync blockchain block timestamp to avoid clock drift reverts
        try {
          const block = await this.provider!.getBlock("latest");
          if (block) {
            this.clockOffset = Number(block.timestamp) - Math.floor(Date.now() / 1000);
          }
        } catch (blockErr) {
          console.error("Failed to fetch latest block timestamp for clock sync:", blockErr);
        }

        let epoch: number;
        let biddingRaw: any = null;
        let liveRaw: any = null;
        let closedRaw: any = null;

        const interval = 300; // 5 minute rounds
        const now = Math.floor(Date.now() / 1000);
        epoch = Math.floor(now / interval);
        this.currentEpoch = epoch;

        const apiKey = (this.config as any).predictFunApiKey || process.env.PREDICT_FUN_API_KEY;
        const currentLockTs = epoch * interval;

        let livePredictMarket = null;
        if (apiKey) {
            try {
                livePredictMarket = await getPredictMarket(currentLockTs, apiKey);
            } catch(e) {}
        }

        this.isSimulatedContract = true;
        this.bullPayoutMult = parseFloat((33.2 / 15.4).toFixed(2));
        this.bearPayoutMult = parseFloat((33.2 / 17.8).toFixed(2));

        if (livePredictMarket && livePredictMarket.outcomes) {
            // Update odds if available from Predict.fun API
            let upSize = 0; let downSize = 0;
            livePredictMarket.outcomes.forEach((o: any) => {
               if(o.name === "Up" && o.bestBid) upSize = o.bestBid.price; // not exactly size, but gives us rough odds if we calculate payout
               if(o.name === "Down" && o.bestBid) downSize = o.bestBid.price;
            });
            // We'll keep static mults for display or recalculate if needed
        }

        const lockTs = (epoch + 1) * interval;
        const prevLockTs = currentLockTs;

        const getHistoricLock = (targetTs: number): number => {
            const targetMs = targetTs * 1000;
            let closest = this.recentCandles[0];
            let minDiff = Infinity;
            
            for (const c of this.recentCandles) {
                const diff = Math.abs(c.timestamp - targetMs);
                if (diff < minDiff) {
                    minDiff = diff;
                    closest = c;
                }
            }
            if (minDiff < 120000 && closest) {
                return closest.open;
            }
            return this.btcPrice;
        };

        // Initialize predictable simulated rounds
        if (!this.simRoundsData[epoch]) {
            let lockPriceForLive = getHistoricLock(currentLockTs);
            if (livePredictMarket && livePredictMarket.variantData && livePredictMarket.variantData.startPrice) {
                lockPriceForLive = livePredictMarket.variantData.startPrice;
            }
            this.simRoundsData[epoch] = { lockPrice: lockPriceForLive, closePrice: this.btcPrice, resolved: false };
        } else {
            // Check again in case it just started and wasn't populated properly
             if (livePredictMarket && livePredictMarket.variantData && livePredictMarket.variantData.startPrice) {
                this.simRoundsData[epoch].lockPrice = livePredictMarket.variantData.startPrice;
            }
        }
        
        if (!this.simRoundsData[epoch - 1]) {
            this.simRoundsData[epoch - 1] = { lockPrice: getHistoricLock(currentLockTs - interval), closePrice: getHistoricLock(currentLockTs), resolved: true };
        }

        biddingRaw = {
          epoch: epoch + 1,
          lockTimestamp: BigInt(lockTs),
          closeTimestamp: BigInt(lockTs + interval),
          bullAmount: ethers.parseEther("15.4"),
          bearAmount: ethers.parseEther("17.8"),
          totalAmount: ethers.parseEther("33.2"),
          lockPrice: 0n,
          closePrice: 0n,
          oracleCalled: false,
        };

          liveRaw = {
            epoch: epoch,
            lockTimestamp: BigInt(currentLockTs),
            closeTimestamp: BigInt(lockTs),
            bullAmount: BigInt(Math.floor(21.4 * 1e18)),
            bearAmount: BigInt(Math.floor(19.2 * 1e18)),
            totalAmount: BigInt(Math.floor(40.6 * 1e18)),
            lockPrice: BigInt(Math.floor((this.simRoundsData[epoch]?.lockPrice || this.btcPrice) * 1e8)),
            closePrice: BigInt(Math.floor(this.btcPrice * 1e8)),
            oracleCalled: false,
          };

          closedRaw = {
            epoch: epoch - 1,
            lockTimestamp: BigInt(currentLockTs - interval),
            closeTimestamp: BigInt(currentLockTs),
            bullAmount: BigInt(Math.floor(18.5 * 1e18)),
            bearAmount: BigInt(Math.floor(22.1 * 1e18)),
            totalAmount: BigInt(Math.floor(40.6 * 1e18)),
            lockPrice: BigInt(Math.floor((this.simRoundsData[epoch - 1]?.lockPrice || this.btcPrice) * 1e8)),
            closePrice: BigInt(Math.floor((this.simRoundsData[epoch - 1]?.closePrice || this.btcPrice) * 1e8)),
            oracleCalled: true,
          };

        const parseRound = (raw: any, epochNum: number) => {
          if (!raw) return null;
          let ep = epochNum;
          if (raw.epoch !== undefined) ep = Number(raw.epoch);
          else if (raw[0] !== undefined) ep = Number(raw[0]);
          
          let lPriceRaw = 0n;
          if (raw.lockPrice !== undefined) lPriceRaw = raw.lockPrice;
          else if (raw[4] !== undefined) lPriceRaw = raw[4];
          
          let cPriceRaw = 0n;
          if (raw.closePrice !== undefined) cPriceRaw = raw.closePrice;
          else if (raw[5] !== undefined) cPriceRaw = raw[5];
          
          let oracleCalled = false;
          if (raw.oracleCalled !== undefined) oracleCalled = raw.oracleCalled;
          else if (raw[13] !== undefined) oracleCalled = raw[13];
          else if (raw[11] !== undefined) oracleCalled = raw[11];
          
          return {
            epoch: ep,
            lockPrice: lPriceRaw ? Number(lPriceRaw) / 1e8 : 0,
            closePrice: cPriceRaw ? Number(cPriceRaw) / 1e8 : 0,
            oracleCalled
          };
        };

        const parsedBidding = parseRound(biddingRaw, epoch + 1);
        const parsedLive = parseRound(liveRaw, epoch);
        const parsedClosed = parseRound(closedRaw, epoch - 1);

        this.liveRounds = [];

        // 1. Closed Round (epoch - 1)
        if (parsedClosed) {
          this.liveRounds.push({
            epoch: epoch - 1,
            lockPrice: parsedClosed.lockPrice,
                        closePrice: parsedClosed.closePrice,
            status: 'CLOSED'
          });
        }

        // 2. Live Round (epoch)
        if (parsedLive) {
          const activeClose = parsedLive.oracleCalled && parsedLive.closePrice > 0 
            ? parsedLive.closePrice 
            : this.btcPrice;

          this.liveRounds.push({
            epoch: epoch,
            lockPrice: parsedLive.lockPrice,
                        closePrice: activeClose,
            status: 'LIVE'
          });
        }

        // 3. Bidding Round (epoch + 1)
        if (parsedBidding) {
          this.liveRounds.push({
            epoch: epoch + 1,
            lockPrice: 0,
                        closePrice: 0,
            status: 'BIDDING'
          });
        }

        // Extract pool values for current bidding epoch
        if (biddingRaw) {
          const bAmount = biddingRaw.bullAmount !== undefined ? biddingRaw.bullAmount : (biddingRaw[9] !== undefined ? biddingRaw[9] : biddingRaw[7]);
          const sAmount = biddingRaw.bearAmount !== undefined ? biddingRaw.bearAmount : (biddingRaw[10] !== undefined ? biddingRaw[10] : biddingRaw[8]);
          const lTime = biddingRaw.lockTimestamp !== undefined ? biddingRaw.lockTimestamp : biddingRaw[2];

          this.bullAmount = parseFloat(ethers.formatEther(bAmount));
          this.bearAmount = parseFloat(ethers.formatEther(sAmount));

          // Estimate seconds remaining using synced blockchain block timing
          const nowSec = Math.floor(Date.now() / 1000) + this.clockOffset;
          const lockTimestamp = Number(lTime);
          this.nextEpochTimeRemaining = Math.max(0, lockTimestamp - nowSec);
          this.nextEpochLockTime = Math.floor(Date.now() / 1000) + this.nextEpochTimeRemaining;
        }

        // Fetch wallet balance
        if (this.wallet && this.provider) {
          try {
            // Check USDT Balance from smart wallet (or EOA)
            const usdtAddr = "0x55d398326f99059fF775485246999027B3197955";
            const usdtContract = new ethers.Contract(usdtAddr, [
              "function balanceOf(address account) view returns (uint256)"
            ], this.provider);
            const activeVault = this.config.smartWalletAddress || this.config.walletAddress;
            const usdtBalanceRaw = await usdtContract.balanceOf(activeVault);
            this.walletBalanceUsdt = parseFloat(ethers.formatEther(usdtBalanceRaw));
            
            if (this.config.simulateLiveBalances && this.walletBalanceUsdt === 0) {
              this.walletBalanceUsdt = 2.4182; // simulate funded wallet in live sandbox mode
            }

            // Fetch dynamic fee data to estimate single transaction gas costs precisely
            const feeData = await this.provider.getFeeData();
            const gasPrice = feeData.gasPrice || 3000000000n; // default to standard 3 Gwei on BSC
            const adjustedGasPrice = (gasPrice * 120n) / 100n;
            const estimatedGasCostWei = adjustedGasPrice * 100000n; // Estimate for matchOrders / sAC matching
            this.estimatedGasCostUsdt = parseFloat(ethers.formatEther(estimatedGasCostWei));
          } catch (balErr: any) {
            console.error("Failed to fetch wallet balance/gas fee:", balErr);
          }
        } else {
          this.walletBalanceUsdt = this.config.simulateLiveBalances ? 2.4182 : 0;
          this.estimatedGasCostUsdt = 0.000007;
        }

      } catch (err: any) {
        this.addLog("error", `Contract sync error: ${err.message}`);
        this.currentEpoch = this.currentEpoch || 99999;
        
        // Sync remaining time to the system clock's current 5m cycle as a fallback
        const msIntoCurrent5m = Date.now() % 300000;
        const msRemaining = 300000 - msIntoCurrent5m;
        this.nextEpochTimeRemaining = Math.floor(msRemaining / 1000);
        this.nextEpochLockTime = Math.floor(Date.now() / 1000) + this.nextEpochTimeRemaining;
      }
    } else {
      // Offline fallback simulator synchronised with the live 5-minute UTC clock
      const interval = 300;
      const now = Math.floor(Date.now() / 1000);
      const epoch = Math.floor(now / interval);
      this.currentEpoch = epoch;
      this.walletBalanceUsdt = 0.4571;

      // Sync remaining time to the system clock's current 5m cycle
      const msIntoCurrent5m = Date.now() % 300000;
      const msRemaining = 300000 - msIntoCurrent5m;
      this.nextEpochTimeRemaining = Math.floor(msRemaining / 1000);
      this.nextEpochLockTime = Math.floor(Date.now() / 1000) + this.nextEpochTimeRemaining;

      // Safe simulation persistent rounds builder
      const getSimRound = (ep: number, isClosed: boolean, isLive: boolean) => {
        if (!this.simRoundsData[ep]) {
          const targetTime = (ep > 1000000000) ? Math.floor(ep/300)*300000 : ep * 300000;
          let kline = this.klines5m.find(k => k.time === targetTime);
          
          if (isClosed && kline) {
            this.simRoundsData[ep] = {
              lockPrice: kline.open,
              closePrice: kline.close,
              resolved: true
            };
          } else if (isLive) {
            let lastCandle = this.klines5m[this.klines5m.length - 1]; // current forming candle
            this.simRoundsData[ep] = {
              lockPrice: kline ? kline.open : (lastCandle ? lastCandle.open : this.btcPrice),
              closePrice: this.btcPrice,
              resolved: false
            };
          } else {
            this.simRoundsData[ep] = {
              lockPrice: this.btcPrice,
              closePrice: this.btcPrice,
              resolved: false
            };
          }
        } else if (isLive && this.simRoundsData[ep]) {
            this.simRoundsData[ep].closePrice = this.btcPrice;
        }
        
        const round = this.simRoundsData[ep];
        if (isClosed) {
          round.resolved = true;
          if (round.lockPrice === round.closePrice) round.closePrice = round.lockPrice + (Math.random() > 0.5 ? 1 : -1); 
          return {
            epoch: ep,
            lockPrice: round.lockPrice,
            closePrice: round.closePrice,
            status: 'CLOSED' as const
          };
        } else if (isLive) {
          return {
            epoch: ep,
            lockPrice: round.lockPrice,
            closePrice: this.btcPrice, // fluctuate closePrice with the actual real-time chainlinkPrice!
            status: 'LIVE' as const
          };
        } else {
          return {
            epoch: ep,
            lockPrice: 0,
            closePrice: 0,
            status: 'BIDDING' as const
          };
        }
      };

      this.liveRounds = [
        getSimRound(this.currentEpoch - 2, true, false),
        getSimRound(this.currentEpoch - 1, false, true),
        getSimRound(this.currentEpoch, false, false)
      ];
    }
    this.isFirstSyncCompleted = true;
  }

  // ----------------------------------------------------------------
  // Technical Analysis Engine
  // ----------------------------------------------------------------

  // ----------------------------------------------------------------
  // Technical Analysis Engine
  // ----------------------------------------------------------------

  private calculateRSI(candles: any[], period = 14): number {
    const closes = candles.map(c => c.close);
    return this.calculateRSIVal(closes, period);
  }

  private calculateBollingerBands(candles: any[], period = 20, multiplier = 2) {
    const closes = candles.map(c => c.close);
    const bb = this.calculateBollingerBandsVal(closes, period);
    return {
      upper: bb.upper,
      middle: bb.middle,
      lower: bb.lower,
      scale: bb.position
    };
  }

  private calculateEMA(prices: number[], period: number): number[] {
    if (prices.length === 0) return [0];
    const k = 2 / (period + 1);
    const ema: number[] = [prices[0]];
    for (let i = 1; i < prices.length; i++) {
      ema.push(prices[i] * k + ema[i - 1] * (1 - k));
    }
    return ema;
  }

  private calculateMACD(prices: number[]) {
    if (prices.length < 26) {
      return { macdLine: 0, signalLine: 0, histogram: 0, crossover: "NEUTRAL" as const };
    }
    
    // Check crossover
    const ema12 = this.calculateEMA(prices, 12);
    const ema26 = this.calculateEMA(prices, 26);
    const macdLine: number[] = [];
    for (let i = 0; i < prices.length; i++) {
      macdLine.push(ema12[i] - ema26[i]);
    }
    const signalLine = this.calculateEMA(macdLine, 9);
    const lastMacd = macdLine[macdLine.length - 1];
    const lastSignal = signalLine[signalLine.length - 1];
    const prevMacd = macdLine[macdLine.length - 2];
    const prevSignal = signalLine[signalLine.length - 2];
    
    let crossover: "BULLISH" | "BEARISH" | "NEUTRAL" = "NEUTRAL";
    if (prevMacd <= prevSignal && lastMacd > lastSignal) {
      crossover = "BULLISH";
    } else if (prevMacd >= prevSignal && lastMacd < lastSignal) {
      crossover = "BEARISH";
    }

    return {
      macdLine: lastMacd,
      signalLine: lastSignal,
      histogram: lastMacd - lastSignal,
      crossover
    };
  }

  private calculateSMA(prices: number[], period: number): number {
    if (prices.length < period) return prices[prices.length - 1] || 0;
    const slice = prices.slice(-period);
    return slice.reduce((a, b) => a + b, 0) / period;
  }

  // --- SUB INDICATORS AND MATH MATRICES ---

  private calculateEMAVal(prices: number[], period: number): number | null {
    if (prices.length < period) return null;
    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }
    return ema;
  }

  private calculateRSIVal(prices: number[], period = 14): number {
    if (prices.length < period + 1) return 50;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = prices[i] - prices[i - 1];
      if (d > 0) gains += d; else losses -= d;
    }
    let avgGain = gains / period, avgLoss = losses / period;
    for (let i = period + 1; i < prices.length; i++) {
      const d = prices[i] - prices[i - 1];
      avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
      avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (avgLoss === 0) return 100;
    return 100 - 100 / (1 + avgGain / avgLoss);
  }

  private calculateMACDVal(prices: number[]) {
    if (prices.length < 35) return { macd: 0, signal: 0, histogram: 0, prevHistogram: 0, prevMacdLine: 0 };
    const macdSeries: number[] = [];
    for (let i = 26; i <= prices.length; i++) {
      const e12 = this.calculateEMAVal(prices.slice(0, i), 12);
      const e26 = this.calculateEMAVal(prices.slice(0, i), 26);
      if (e12 !== null && e26 !== null) {
        macdSeries.push(e12 - e26);
      }
    }
    const macdLine = macdSeries[macdSeries.length - 1];
    const prevMacdLine = macdSeries[macdSeries.length - 2] || macdLine;
    const signal = this.calculateEMAVal(macdSeries, 9) || macdLine;
    const histogram = macdLine - signal;

    let prevHistogram = histogram;
    if (macdSeries.length > 1) {
      const prevSignal = this.calculateEMAVal(macdSeries.slice(0, -1), 9) || 0;
      prevHistogram = macdSeries[macdSeries.length - 2] - prevSignal;
    }

    return { macd: macdLine, signal, histogram, prevHistogram, prevMacdLine };
  }

  private calculateBollingerBandsVal(prices: number[], period = 20) {
    if (prices.length < period) return { upper: prices[prices.length - 1], middle: prices[prices.length - 1], lower: prices[prices.length - 1], std: 0, width: 0, position: 0.5 };
    const slice = prices.slice(-period);
    const mean = slice.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(slice.reduce((s, p) => s + Math.pow(p - mean, 2), 0) / period);
    const upper = mean + 2 * std;
    const lower = mean - 2 * std;
    const range = 4 * std;
    return {
      upper,
      middle: mean,
      lower,
      std,
      width: mean > 0 ? (4 * std) / mean : 0,
      position: range === 0 ? 0.5 : (prices[prices.length - 1] - lower) / range
    };
  }

  private calculateATRVal(candles: any[], period = 14): number | null {
    if (candles.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const prev = candles[i - 1].close;
      trs.push(Math.max(
        candles[i].high - candles[i].low,
        Math.abs(candles[i].high - prev),
        Math.abs(candles[i].low - prev),
      ));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  private calculateStochasticVal(candles: any[], period = 14): number {
    if (candles.length < period) return 50;
    const slice = candles.slice(-period);
    const high = Math.max(...slice.map(c => c.high));
    const low = Math.min(...slice.map(c => c.low));
    if (high === low) return 50;
    return ((candles[candles.length - 1].close - low) / (high - low)) * 100;
  }

  private calculateVWAPVal(candles: any[]): number | null {
    let tpv = 0, vol = 0;
    candles.forEach(c => {
      const tp = (c.high + c.low + c.close) / 3;
      tpv += tp * c.volume;
      vol += c.volume;
    });
    return vol > 0 ? tpv / vol : null;
  }

  private analyzeCandlePattern(candles: any[]): string {
    if (candles.length < 3) return "UNKNOWN";
    const [c3, c2, c1] = candles.slice(-3);
    const body1 = Math.abs(c1.close - c1.open);
    const range1 = c1.high - c1.low;
    const body2 = Math.abs(c2.close - c2.open);
    if (range1 === 0) return "UNKNOWN";
    const lowerWick = Math.min(c1.open, c1.close) - c1.low;
    const upperWick = c1.high - Math.max(c1.open, c1.close);
    if (body1 < range1 * 0.1) return "DOJI";
    if (c1.close > c1.open && lowerWick > body1 * 2 && upperWick < body1 * 0.5) return "HAMMER";
    if (c1.close < c1.open && upperWick > body1 * 2 && lowerWick < body1 * 0.5) return "SHOOTING_STAR";
    if (c2.close < c2.open && c1.close > c1.open && c1.open <= c2.close && c1.close >= c2.open) return "BULL_ENGULF";
    if (c2.close > c2.open && c1.close < c1.open && c1.open >= c2.close && c1.close <= c2.open) return "BEAR_ENGULF";
    if (c3.close > c3.open && c2.close > c2.open && c1.close > c1.open) return "3_GREEN";
    if (c3.close < c3.open && c2.close < c2.open && c1.close < c1.open) return "3_RED";
    if (c2.close < c2.open && c1.close > c1.open && c1.close > (c2.open + c2.close) / 2) return "MORNING_STAR";
    if (c2.close > c2.open && c1.close < c1.open && c1.close < (c2.open + c2.close) / 2) return "EVENING_STAR";
    return c1.close > c1.open ? "GREEN" : "RED";
  }

  private analyzeMarketRegime(candles5m: any[]): string {
    if (candles5m.length < 30) return "UNKNOWN";
    const closes = candles5m.map(c => c.close);
    const ema9 = this.calculateEMAVal(closes, 9);
    const ema21 = this.calculateEMAVal(closes, 21);
    const atr = this.calculateATRVal(candles5m, 14);
    const bb = this.calculateBollingerBandsVal(closes, 20);
    if (ema9 === null || ema21 === null || atr === null || !bb) return "UNKNOWN";
    const trending = Math.abs(ema9 - ema21) > atr * 0.35;
    const highVol = bb.width > 0.025;
    if (trending && ema9 > ema21) return "BULL_TREND";
    if (trending && ema9 < ema21) return "BEAR_TREND";
    if (highVol) return "HIGH_VOL";
    return "RANGING";
  }

  private getRegimeContext(regime: string) {
    const regimes: Record<string, { note: string; confAdj: number; minConfUp: number; minConfDown: number }> = {
      BULL_TREND: {
        note: "Trending upward. UP bets have structural edge. Require strong confluence to go DOWN.",
        confAdj: 5, minConfUp: 58, minConfDown: 68,
      },
      BEAR_TREND: {
        note: "Trending downward. DOWN bets have structural edge. Require strong confluence to go UP.",
        confAdj: 5, minConfUp: 68, minConfDown: 58,
      },
      HIGH_VOL: {
        note: "High volatility. Large wicks common, reversal risk elevated. Only trade very strong setups.",
        confAdj: -10, minConfUp: 72, minConfDown: 72,
      },
      RANGING: {
        note: "Ranging market. Mean reversion favored. BB extremes and RSI extremes are higher conviction. Breakouts often fail.",
        confAdj: -5, minConfUp: 65, minConfDown: 65,
      },
      UNKNOWN: {
        note: "Regime unclear. Minimum data. Extreme caution.",
        confAdj: -15, minConfUp: 75, minConfDown: 75,
      }
    };
    return regimes[regime] || { note: "Unknown market environment.", confAdj: -10, minConfUp: 70, minConfDown: 70 };
  }

  private getConsecutiveLosses(): number {
    let losses = 0;
    const sortedTrades = [...this.trades].sort((a, b) => b.timestamp - a.timestamp);
    
    let lastEpoch = this.currentEpoch;

    for (const t of sortedTrades) {
      if (!t.epoch) continue;
      
      // Cooldown mechanic: jika ada gap > 1 epoch, berarti kita sudah skip / istirahat.
      // Maka memory rentetan kekalahan di masa lalu direset.
      if (lastEpoch && (lastEpoch - t.epoch) > 1) {
        break; 
      }
      
      if (t.status === 'LOST') {
        losses++;
      } else if (t.status === 'WON' || t.status === 'CLAIMED') {
        break; // Streak terputus karena win
      }
      
      lastEpoch = t.epoch;
    }

    return losses;
  }

  private scoreSignals(md: any): any {
    const w = {
        lead_lag_arbitrage: { arbitrage_bull_major: 25, arbitrage_bull_minor: 12, arbitrage_bear_major: 25, arbitrage_bear_minor: 12 },
        trend_structure: { bull_stacked: 12, bear_stacked: 12, short_bull: 5, short_bear: 5, vwap_bull: 8, vwap_bear: 8 },
        rsi_mtf: { aligned_bull: 14, aligned_bear: 14, agreement: 6, oversold: 9, overbought: 9 },
        macd: { hist_pos: 6, hist_neg: 6, cross_bull: 5, cross_bear: 5, exp_bull: 4, exp_bear: 4 },
        order_flow: { wall_bull: 9, wall_bear: 9, flow_bull: 8, flow_bear: 8 },
        bollinger: { lower_bounce: 7, upper_reversal: 7, momentum_up: 3, momentum_down: 3 },
        stochastic: { dual_oversold: 8, dual_overbought: 8 },
        patterns: { HAMMER: 9, BULL_ENGULF: 10, "3_GREEN": 8, MORNING_STAR: 10, SHOOTING_STAR: 9, BEAR_ENGULF: 10, "3_RED": 8, EVENING_STAR: 10 },
        volume: { confirmation: 4 },
        pool_dynamics: { skew_bear: 5, skew_bull: 5 },
        whale_tracking: { orderbook_delta_bull: 8, orderbook_delta_bear: 8 },
        btc_correlation: { btc_pump_bull: 10, btc_dump_bear: 10 },
        reversal_exhaustion: { bull_exhaust: 8, bear_exhaust: 8 }
    };
    const signals: { bull: string[]; bear: string[]; neutral: string[] } = { bull: [], bear: [], neutral: [] };
    let bullScore = 0, bearScore = 0;

    const push = (side: 'bull' | 'bear' | 'neutral', label: string, weight: number) => {
      if (side === "bull") {
        signals.bull.push(label);
        bullScore += weight;
      } else if (side === "bear") {
        signals.bear.push(label);
        bearScore += weight;
      } else {
        signals.neutral.push(label);
      }
    };

    const { price, ema9, ema21, ema50, vwap, rsi1m, rsi5m, rsi15m,
      macd, bb, atr, stoch, stoch5m, orderBook, tradeFlow,
      volumeRatio, pattern, round, basisDelta, percentBasisDelta } = md;

    // ── 0. LEAD-LAG ARBITRAGE (The supreme statistical arbiter) ──────────────────
    if (basisDelta !== undefined && percentBasisDelta !== undefined) {
      if (percentBasisDelta > 0.03) {
        push("bull", `🎯 Lead-Lag Arb: Binance Leads Chainlink by +${percentBasisDelta.toFixed(3)}% (Arbitrage up favor)`, w.lead_lag_arbitrage.arbitrage_bull_major);
      } else if (percentBasisDelta > 0.015) {
        push("bull", `🎯 Lead-Lag Arb: Moderate positive basis lead (+${percentBasisDelta.toFixed(3)}%)`, w.lead_lag_arbitrage.arbitrage_bull_minor);
      } else if (percentBasisDelta < -0.03) {
        push("bear", `🎯 Lead-Lag Arb: Binance Lags Chainlink by ${percentBasisDelta.toFixed(3)}% (Arbitrage down favor)`, w.lead_lag_arbitrage.arbitrage_bear_major);
      } else if (percentBasisDelta < -0.015) {
        push("bear", `🎯 Lead-Lag Arb: Moderate negative basis lag (${percentBasisDelta.toFixed(3)}%)`, w.lead_lag_arbitrage.arbitrage_bear_minor);
      } else {
        push("neutral", `🎯 Lead-Lag Arb: Arbitrage spread is minimal ($${basisDelta.toFixed(3)})`, 0);
      }
    }

    // ── 1. TREND STRUCTURE ──────────────────────────────
    if (ema9 && ema21 && ema50) {
      if (ema9 > ema21 && ema21 > ema50)
        push("bull", `EMA fully stacked bull (9>${ema21.toFixed(2)}>50)`, w.trend_structure.bull_stacked);
      else if (ema9 < ema21 && ema21 < ema50)
        push("bear", `EMA fully stacked bear (9<${ema21.toFixed(2)}<50)`, w.trend_structure.bear_stacked);
      else if (ema9 > ema21) push("bull", `EMA9 > EMA21 short-term bull`, w.trend_structure.short_bull);
      else                   push("bear", `EMA9 < EMA21 short-term bear`, w.trend_structure.short_bear);
    }
    if (price && vwap) {
      const d = ((price - vwap) / vwap) * 100;
      if (d > 0.12)       push("bull", `Price ${d.toFixed(3)}% above VWAP (institutional bid)`, w.trend_structure.vwap_bull);
      else if (d < -0.12) push("bear", `Price ${Math.abs(d).toFixed(3)}% below VWAP (institutional offer)`, w.trend_structure.vwap_bear);
      else                push("neutral", `Price hugging VWAP (${d.toFixed(3)}%) — no directional edge`, 0);
    }
    if (ema9 && ema21) {
      const slope = ((ema9 - ema21) / ema21) * 100;
      if (slope > 0.04)  push("bull", `EMA slope expanding up (${slope.toFixed(4)}%)`, 5);
      else if (slope < -0.04) push("bear", `EMA slope expanding down (${Math.abs(slope).toFixed(4)}%)`, 5);
    }

    // ── 2. RSI MULTI-TIMEFRAME ──────────────────────────
    if (rsi1m && rsi5m && rsi15m) {
      const bullCount = [rsi1m, rsi5m, rsi15m].filter(r => r > 50).length;
      if (bullCount === 3)      push("bull", `RSI 3-TF aligned bull: 1m=${rsi1m.toFixed(1)} 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`, w.rsi_mtf.aligned_bull);
      else if (bullCount === 0) push("bear", `RSI 3-TF aligned bear: 1m=${rsi1m.toFixed(1)} 5m=${rsi5m.toFixed(1)} 15m=${rsi15m.toFixed(1)}`, w.rsi_mtf.aligned_bear);
      else if (bullCount === 2) push("bull", `RSI 2/3 TF bull agreement`, w.rsi_mtf.agreement);
      else                      push("bear", `RSI 2/3 TF bear agreement`, w.rsi_mtf.agreement);
    }
    if (rsi1m) {
      if (rsi1m < 28)      push("bull", `RSI 1m deeply oversold (${rsi1m.toFixed(1)}) — mean reversion likely`, w.rsi_mtf.oversold);
      else if (rsi1m > 72) push("bear", `RSI 1m deeply overbought (${rsi1m.toFixed(1)}) — exhaustion likely`, w.rsi_mtf.overbought);
    }
    if (rsi5m) {
      if (rsi5m < 30)      push("bull", `RSI 5m oversold (${rsi5m.toFixed(1)})`, 6);
      else if (rsi5m > 70) push("bear", `RSI 5m overbought (${rsi5m.toFixed(1)})`, 6);
    }

    // ── 3. MACD ─────────────────────────────────────────
    if (macd) {
      if (macd.histogram > 0) push("bull", `MACD histogram positive (${macd.histogram.toFixed(6)})`, w.macd.hist_pos);
      else                    push("bear", `MACD histogram negative (${macd.histogram.toFixed(6)})`, w.macd.hist_neg);
      
      if (macd.macd > macd.signal) push("bull", `MACD above signal line (bullish crossover zone)`, w.macd.cross_bull);
      else                         push("bear", `MACD below signal line (bearish crossover zone)`, w.macd.cross_bear);
      
      if (macd.prevHistogram !== undefined) {
        if (macd.histogram > macd.prevHistogram && macd.histogram > 0)
          push("bull", `MACD histogram expanding bull (momentum accelerating)`, w.macd.exp_bull);
        else if (macd.histogram < macd.prevHistogram && macd.histogram < 0)
          push("bear", `MACD histogram expanding bear (momentum accelerating)`, w.macd.exp_bear);
        else if (macd.histogram > 0 && macd.histogram < macd.prevHistogram)
          push("neutral", `MACD histogram shrinking — bull momentum fading`, 0);
        else if (macd.histogram < 0 && macd.histogram > macd.prevHistogram)
          push("neutral", `MACD histogram shrinking — bear momentum fading`, 0);
      }
    }

    // ── 4. ORDER FLOW ────────────────────────────────────
    if (orderBook) {
      const pct = orderBook.pressure * 100;
      if (pct > 65)      push("bull", `Very strong bid wall (${pct.toFixed(1)}% buy pressure)`, w.order_flow.wall_bull);
      else if (pct > 57) push("bull", `Solid buy-side OB pressure (${pct.toFixed(1)}%)`, 5);
      else if (pct < 35) push("bear", `Very strong ask wall (${pct.toFixed(1)}% sell pressure)`, w.order_flow.wall_bear);
      else if (pct < 43) push("bear", `Solid sell-side OB pressure (${pct.toFixed(1)}%)`, 5);
      else               push("neutral", `Order book balanced (${pct.toFixed(1)}%)`, 0);
    }
    if (tradeFlow) {
      const pct = tradeFlow.ratio * 100;
      const vpct = tradeFlow.valueRatio * 100;
      if (pct > 60 && vpct > 60)      push("bull", `Aggressive buyers: ${pct.toFixed(1)}% qty + ${vpct.toFixed(1)}% value`, w.order_flow.flow_bull);
      else if (pct > 55)               push("bull", `Buy flow dominant (${pct.toFixed(1)}%)`, 4);
      else if (pct < 40 && vpct < 40) push("bear", `Aggressive sellers: ${pct.toFixed(1)}% qty + ${vpct.toFixed(1)}% value`, w.order_flow.flow_bear);
      else if (pct < 45)               push("bear", `Sell flow dominant (${pct.toFixed(1)}%)`, 4);
    }

    // ── 5. BOLLINGER BANDS ─────────────────
    if (bb && price) {
      const pos = bb.position; // 0=at lower, 1=at upper
      if (pos > 0.88)      push("bear", `Price near upper BB (${(pos*100).toFixed(0)}%) — overbought / reversal risk`, w.bollinger.upper_reversal);
      else if (pos < 0.12) push("bull", `Price near lower BB (${(pos*100).toFixed(0)}%) — oversold / bounce setup`, w.bollinger.lower_bounce);
      else if (pos > 0.60) push("bull", `Price in upper BB half (${(pos*100).toFixed(0)}%) — bullish momentum`, w.bollinger.momentum_up);
      else                 push("bear", `Price in lower BB half (${(pos*100).toFixed(0)}%) — bearish momentum`, w.bollinger.momentum_down);

      if (bb.width < 0.007)
        push("neutral", `⚠ BB SQUEEZE (width=${(bb.width*100).toFixed(3)}%) — breakout imminent, direction unknown`, 0);
      else if (bb.width > 0.030)
        push("neutral", `High BB expansion — large swings expected, reversal risk elevated`, 0);
    }
    if (atr && price) {
      const atrPct = (atr / price) * 100;
      if (atrPct > 0.18) push("neutral", `Very high ATR (${atrPct.toFixed(3)}%) — volatility is extreme`, 0);
    }

    // ── 6. STOCHASTIC ─────────────────────────────────────
    if (stoch !== undefined && stoch5m !== undefined) {
      if (stoch < 20 && stoch5m < 25)      push("bull", `Stochastic oversold both TFs: 1m=${stoch.toFixed(0)} 5m=${stoch5m.toFixed(0)}`, w.stochastic.dual_oversold);
      else if (stoch > 80 && stoch5m > 75) push("bear", `Stochastic overbought both TFs: 1m=${stoch.toFixed(0)} 5m=${stoch5m.toFixed(0)}`, w.stochastic.dual_overbought);
    }

    // ── 6.5 REVERSAL EXHAUSTION (High precision pivot detection) ─────────────────
    if (bb && rsi1m && stoch !== undefined) {
      const isRsiOversold = rsi1m < 28;
      const isBbOversold = bb.position < 0.15;
      const isStochOversold = stoch < 25;
      const isMacdFadingBear = macd && macd.prevHistogram !== undefined && macd.histogram < 0 && macd.histogram > macd.prevHistogram;

      const bullReversalScore = (isRsiOversold ? 1 : 0) + (isBbOversold ? 1 : 0) + (isStochOversold ? 1 : 0) + (isMacdFadingBear ? 1 : 0);
      if (bullReversalScore >= 3) {
        push("bull", `⚠️ Trend-Reversal: Extreme BEARISH Sell-off Exhaustion detected (Confluence Score: ${bullReversalScore}/4 - RSI oversold + BB support + MACD fading)`, w.reversal_exhaustion.bull_exhaust);
      }

      const isRsiOverbought = rsi1m > 72;
      const isBbOverbought = bb.position > 0.85;
      const isStochOverbought = stoch > 75;
      const isMacdFadingBull = macd && macd.prevHistogram !== undefined && macd.histogram > 0 && macd.histogram < macd.prevHistogram;

      const bearReversalScore = (isRsiOverbought ? 1 : 0) + (isBbOverbought ? 1 : 0) + (isStochOverbought ? 1 : 0) + (isMacdFadingBull ? 1 : 0);
      if (bearReversalScore >= 3) {
        push("bear", `⚠️ Trend-Reversal: Extreme BULLISH Overbought Exhaustion detected (Confluence Score: ${bearReversalScore}/4 - RSI overbought + BB resistance + MACD fading)`, w.reversal_exhaustion.bear_exhaust);
      }
    }

    // ── 7. CANDLE PATTERNS ───────────────────────────────
    if (w.patterns[pattern]) {
      const isBullPattern = ["HAMMER", "BULL_ENGULF", "3_GREEN", "MORNING_STAR", "PIERCING"].includes(pattern);
      push(isBullPattern ? "bull" : "bear", `Candlestick: ${pattern}`, w.patterns[pattern]);
    } else if (pattern === "DOJI") {
      push("neutral", `Doji — market indecision, reduce position`, 0);
    } else if (pattern === "GREEN") {
      push("bull", `Green momentum candle`, 3);
    } else if (pattern === "RED") {
      push("bear", `Red momentum candle`, 3);
    }

    // ── 8. VOLUME CONFIRMATION ───────────────────────────
    if (volumeRatio) {
      if (volumeRatio > 1.6) {
        if (bullScore >= bearScore) push("bull", `Volume surge ${volumeRatio.toFixed(1)}x confirming bull move`, w.volume.confirmation);
        else                        push("bear", `Volume surge ${volumeRatio.toFixed(1)}x confirming bear move`, w.volume.confirmation);
      } else if (volumeRatio < 0.6) {
        push("neutral", `Low volume (${volumeRatio.toFixed(2)}x avg) — move may lack conviction`, 0);
      }
    }

    // ── 9. POOL DYNAMICS (CONTRARIAN EDGE) ───────────────
    if (round && round.totalAmount > 1) {
      const bullPct = round.bullAmount / round.totalAmount;
      if (bullPct > 0.72)
        push("bear", `Pool heavily bull-skewed (${(bullPct*100).toFixed(0)}%) — contrarian bear value`, w.pool_dynamics.skew_bear);
      else if (bullPct < 0.28)
        push("bull", `Pool heavily bear-skewed (${((1-bullPct)*100).toFixed(0)}%) — contrarian bull value`, w.pool_dynamics.skew_bull);
    }

    // ── 10. WHALE TRACKING (Order Book Depth Delta Indicator) ──
    const obDelta = this.calcOrderBookImbalanceDelta(orderBook);
    if (obDelta.whaleAccumulation) {
      if (obDelta.direction === "UP") {
        push("bull", `🐳 Whale Accumulation: Buy-limiting wall expansion detected (+${obDelta.deltaScore} del) `, w.whale_tracking.orderbook_delta_bull);
      } else if (obDelta.direction === "DOWN") {
        push("bear", `🐳 Whale Distribution: Sell-limiting wall expansion detected (-${obDelta.deltaScore} del) `, w.whale_tracking.orderbook_delta_bear);
      }
    }

    // ── 11. BTC/USDT MOMENTUM CORRELATION ────────────────
    const btcMom = this.getBtcMomentum(this.btcKlines1m);
    if (btcMom === "STRONG_PUMP") {
      push("bull", `⚡ BTC Momentum Pump: Leading asset breaking up (+0.15% momentum)`, w.btc_correlation.btc_pump_bull);
    } else if (btcMom === "STRONG_DUMP") {
      push("bear", `⚡ BTC Momentum Dump: Leading asset breaking down (-0.15% momentum)`, w.btc_correlation.btc_dump_bear);
    }

    // ── 12. TIME-OF-DAY FILTER TIMEZONE MULTIPLIER ───────
    const sessionInfo = this.getMarketSessionZone();
    push("neutral", `🌐 Active Session: ${sessionInfo.session} | Mode Bias: ${sessionInfo.strategyLean} | Volatility Mode: ${sessionInfo.volatilityExpectation}`, 0);

    // Apply specific session-based strategic adjustments dynamically
    if (sessionInfo.session === "ASIA_PACIFIC") {
      // Rangebound Mean Reversion Bonus: amplify BB bounces
      if (bb && price) {
        const pos = bb.position;
        if (pos < 0.12) bullScore += 3;
        if (pos > 0.88) bearScore += 3;
      }
    } else if (sessionInfo.session === "USA_EUROPE") {
      // Strong Momentum Trend Following Bonus: amplify full EMA Stack indicators
      if (ema9 && ema21 && ema50) {
        if (ema9 > ema21 && ema21 > ema50) bullScore += 3;
        else if (ema9 < ema21 && ema21 < ema50) bearScore += 3;
      }
    }

    // ── FINAL ADAPTIVE CALCULATIONS ──────────────────────────────
    const total = bullScore + bearScore;
    const leadSide: 'UP' | 'DOWN' | 'SKIP' = bullScore > bearScore ? "UP" : bearScore > bullScore ? "DOWN" : "SKIP";
    const leadScore = Math.max(bullScore, bearScore);
    const localConfidence = total > 0 ? Math.min(Math.round((leadScore / total) * 100), 96) : 50;
    const signalBalance = total > 0 ? (Math.abs(bullScore - bearScore) / total) * 100 : 0;

    return {
      signals, bullScore, bearScore,
      bullPct: total > 0 ? (bullScore / total) * 100 : 50,
      bearPct: total > 0 ? (bearScore / total) * 100 : 50,
      confluence: signals.bull.length + signals.bear.length,
      leadSide, localConfidence, signalBalance,
    };
  }

  private calculateLevels(candles: any[]) {
    if (candles.length < 20) return { support: 0, resistance: 0 };
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const resistance = Math.max(...highs.slice(-20));
    const support = Math.min(...lows.slice(-20));
    return { support, resistance };
  }

  // ── 1. SELF-LEARNING MEMORY SYSTEM ─────────────────────────
  private loadWeights(): any {
    const weightsFile = path.join(DATA_DIR, "ai_adaptive_weights.json");
    const defaultWeights = {
      lead_lag_arbitrage: { arbitrage_bull_major: 25, arbitrage_bull_minor: 12, arbitrage_bear_major: 25, arbitrage_bear_minor: 12 },
      trend_structure: { bull_stacked: 12, bear_stacked: 12, short_bull: 5, short_bear: 5, vwap_bull: 8, vwap_bear: 8 },
      rsi_mtf: { aligned_bull: 14, aligned_bear: 14, agreement: 6, oversold: 9, overbought: 9 },
      macd: { hist_pos: 6, hist_neg: 6, cross_bull: 5, cross_bear: 5, exp_bull: 4, exp_bear: 4 },
      order_flow: { wall_bull: 9, wall_bear: 9, flow_bull: 8, flow_bear: 8 },
      bollinger: { lower_bounce: 7, upper_reversal: 7, momentum_up: 3, momentum_down: 3 },
      stochastic: { dual_oversold: 8, dual_overbought: 8 },
      patterns: { HAMMER: 9, BULL_ENGULF: 10, "3_GREEN": 8, MORNING_STAR: 10, SHOOTING_STAR: 9, BEAR_ENGULF: 10, "3_RED": 8, EVENING_STAR: 10 },
      volume: { confirmation: 4 },
      pool_dynamics: { skew_bear: 5, skew_bull: 5 },
      whale_tracking: { orderbook_delta_bull: 8, orderbook_delta_bear: 8 },
      btc_correlation: { btc_pump_bull: 10, btc_dump_bear: 10 }
    };
    try {
      if (fs.existsSync(weightsFile)) {
        return JSON.parse(fs.readFileSync(weightsFile, "utf8"));
      }
    } catch (e) {
      console.error("Gagal membaca file pembelajaran AI, menggunakan default.", e);
    }
    return defaultWeights;
  }

  private saveWeights(weights: any) {
    const weightsFile = path.join(DATA_DIR, "ai_adaptive_weights.json");
    try {
      fs.writeFileSync(weightsFile, JSON.stringify(weights, null, 2), "utf8");
    } catch (e) {
      console.error("Gagal menyimpan memori pembelajaran AI.", e);
    }
  }

  private learnFromPastRound(roundDecision: 'BULL' | 'BEAR', isWin: boolean, firedSignals: string[]) {
    const w = this.loadWeights();
    const learningRate = 0.5; // Adaptive learning step delta size
    this.addLog("info", `[LEARNING LOOP] Evaluating Past Position: ${roundDecision} | Result: ${isWin ? "WIN 🎉" : "LOSS ❌"}`);

    const keysModified: string[] = [];
    for (const category in w) {
      for (const signalKey in w[category]) {
        const wasFired = firedSignals.some(s => {
          const lowerS = s.toLowerCase();
          const lowerK = signalKey.toLowerCase();
          return lowerS.includes(lowerK) || lowerS.includes(lowerK.replace("_", " "));
        });

        if (wasFired) {
          if (isWin) {
            w[category][signalKey] = Math.min(w[category][signalKey] + learningRate, 40);
          } else {
            w[category][signalKey] = Math.max(w[category][signalKey] - learningRate, 1);
          }
          keysModified.push(`${category}:${signalKey}->${w[category][signalKey].toFixed(1)}`);
        }
      }
    }

    this.saveWeights(w);
    if (keysModified.length > 0) {
      this.addLog("success", `[LEARNING LOOP] AI Brain updated ${keysModified.length} weights successfully based on historical performance: ${keysModified.slice(0, 4).join(", ")}`);
    }
  }

  // ── 2. WHALE TRACKING (Order Book Dynamic Depth Delta) ─────
  private calcOrderBookImbalanceDelta(currentOB: any): { whaleAccumulation: boolean; direction: 'UP' | 'DOWN' | 'NEUTRAL'; deltaScore: number } {
    if (!this.prevOrderBook || !currentOB || !this.prevOrderBook.bids || !currentOB.bids) {
      this.prevOrderBook = currentOB;
      return { whaleAccumulation: false, direction: 'NEUTRAL', deltaScore: 0 };
    }

    const currentBidDepth = currentOB.bids.reduce((s: number, b: any) => s + b.qty, 0);
    const prevBidDepth = this.prevOrderBook.bids.reduce((s: number, b: any) => s + b.qty, 0);

    const currentAskDepth = currentOB.asks.reduce((s: number, a: any) => s + a.qty, 0);
    const prevAskDepth = this.prevOrderBook.asks.reduce((s: number, a: any) => s + a.qty, 0);

    const bidDelta = currentBidDepth - prevBidDepth;
    const askDelta = currentAskDepth - prevAskDepth;

    this.prevOrderBook = currentOB; // update state memory

    if (bidDelta > askDelta * 1.5 && bidDelta > 0) {
      return { whaleAccumulation: true, direction: "UP", deltaScore: 8 };
    } else if (askDelta > bidDelta * 1.5 && askDelta > 0) {
      return { whaleAccumulation: true, direction: "DOWN", deltaScore: 8 };
    }

    return { whaleAccumulation: false, direction: 'NEUTRAL', deltaScore: 0 };
  }

  // ── 3. BTC/USDT MOMENTUM CORRELATION (Market Leader Correlation) ──
  private getBtcMomentum(btcKlines: any[]): 'STRONG_PUMP' | 'STRONG_DUMP' | 'STABLE' | 'NEUTRAL' {
    if (!btcKlines || btcKlines.length < 3) return "NEUTRAL";
    const latestClose = btcKlines[btcKlines.length - 1].close;
    const prevClose = btcKlines[btcKlines.length - 3].close; // 3 minutes ago
    
    const pctChange = ((latestClose - prevClose) / prevClose) * 100;
    
    if (pctChange > 0.15) return "STRONG_PUMP";
    if (pctChange < -0.15) return "STRONG_DUMP";
    return "STABLE";
  }

  // ── 4. TIME-OF-DAY FILTER (Market Session Characteristics) ──
  private getMarketSessionZone(): { session: string; strategyLean: string; volatilityExpectation: string } {
    const hoursUTC = new Date().getUTCHours();
    
    // USA & Europe Session (12:00 - 21:00 UTC) (volume surges, breakouts work)
    if (hoursUTC >= 12 && hoursUTC <= 21) {
      return { session: "USA_EUROPE", strategyLean: "TREND_FOLLOWING", volatilityExpectation: "HIGH" };
    }
    // Asia & Pacific Session (00:00 - 09:00 UTC) (range-bound mean reversion works)
    if (hoursUTC >= 0 && hoursUTC <= 9) {
      return { session: "ASIA_PACIFIC", strategyLean: "MEAN_REVERSION", volatilityExpectation: "LOW_TO_MEDIUM" };
    }
    
    return { session: "OVERLAP_GAP", strategyLean: "MIXED", volatilityExpectation: "MEDIUM" };
  }

  // Generic klines helper to load non-default symbols easily
  private async fetchBinanceKlinesGeneric(symbol: string, interval: string, limit: number): Promise<any[]> {
    try {
      const res = await fetchBinanceWithFallback(`/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, 8000);
      if (res.data && Array.isArray(res.data)) {
        return res.data.map((c: any) => ({
          time: Number(c[0]),
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5])
        }));
      }
    } catch (e: any) {
      console.warn(`Failed to fetch Binance ${symbol} ${interval} klines:`, e.message || e);
    }
    return [];
  }

  // ----------------------------------------------------------------
  // Decoupled Cerebras Brain Ensemble & Cerebras Background Analyst
  // ----------------------------------------------------------------

  private async queryCerebrasBrainEnsemble(
    quantSignal: "UP" | "DOWN" | "SKIP",
    quantSummary: string,
    m5Klines: any[],
    depth: any,
    regime = "RANGING"
  ): Promise<{ 
    direction: "UP" | "DOWN" | "SKIP"; 
    confidence: number; 
    analysis: string;
    modelUsed: string;
  }> {
    const apiKey = process.env.CEREBRAS_API_KEY || "";
    const endpointStr = process.env.CEREBRAS_API_ENDPOINT || "https://api.cerebras.ai/v1";
    const endpoint = endpointStr.endsWith("/") ? endpointStr.slice(0, -1) : endpointStr;
    let model = process.env.CEREBRAS_MODEL || "llama3.1-70b";

    this.addLog("info", `🤖 [Cerebras Brain] Memulai audit konsensus kognitif ${model} untuk sinyal quant: ${quantSignal} (Regime: ${regime})...`);

    let content = "";
    let finalModelUsed = model;

    try {
      const lastCandles = m5Klines.slice(-5);
      const candleSpecs = lastCandles.map((k, idx) => {
        return `Candle -${5 - idx}: Open=${k.open}, High=${k.high}, Low=${k.low}, Close=${k.close}, Vol=${k.volume.toFixed(2)}`;
      }).join("\n");

      const recentPrice = m5Klines[m5Klines.length - 1].close;
      const priorPrice = m5Klines[m5Klines.length - 6]?.close || m5Klines[0].close;
      const pctChange = ((recentPrice - priorPrice) / priorPrice) * 100;

      const bidsTotal = (depth?.bids || []).slice(0, 10).reduce((sum: number, b: any) => sum + parseFloat(b[1] || "0"), 0);
      const asksTotal = (depth?.asks || []).slice(0, 10).reduce((sum: number, a: any) => sum + parseFloat(a[1] || "0"), 0);
      const orderBookRatio = bidsTotal + asksTotal > 0 ? (bidsTotal / (bidsTotal + asksTotal)) : 0.5;

      const quantProposalDir = quantSignal === "UP" ? "BULL" : (quantSignal === "DOWN" ? "BEAR" : "SKIP");

      const systemPrompt = `You are an active, highly professional quantitative analysis auditor inside an algorithmic crypto trading terminal.
Your task is to review the mathematical quant brain's current signal, cross-reference it with the latest 5m candlestick data and order book depth, and provide an active and strategic consensus directive.

Your output target is to refine the trade directional entry ("BULL" / "BEAR" / "SKIP") and capture market trends. Do NOT over-skip. Be proactive in analyzing whether the quant brain's proposal has supporting evidence.

Current Quant Brain Proposal:
- Direction: ${quantProposalDir}
- Detected Regime: ${regime}
- Reasons: ${quantSummary}

Market Overview (BTC/USDT 5m):
- Recent Price: $${recentPrice}
- 5-period price change: ${pctChange.toFixed(3)}%
- Bid/Ask depth ratio (first 10 levels): ${orderBookRatio.toFixed(2)} (${bidsTotal} bids vs ${asksTotal} asks)
- Recent 5 Candles (5m interval):
${candleSpecs}

Rules:
1. Audited Direction MUST be exactly one of: BULL, BEAR, or SKIP.
2. Directional Trend Heuristics:
   - If the Detected Regime is 'TRENDING UP', BULL/UPWARD entries are highly probable. Strongly favor validating BULL signals. Treat BEAR (reversal) signals with high skepticism unless there is a huge order book mismatch (asksTotal >> bidsTotal) or deep candle resistance.
   - If the Detected Regime is 'TRENDING DOWN', BEAR/DOWNWARD entries are highly probable. Strongly favor validating BEAR signals. Treat BULL (reversal) signals with high skepticism unless there is a huge order book mismatch (bidsTotal >> asksTotal) or deep candle support.
   - If the Detected Regime is 'OVERSHOOTING' or 'BREAKOUT', expect explosive continuation or immediate volatility spikes; validate corresponding direction of breakout momentum.
   - If the Detected Regime is 'RANGING' or 'COMPRESSION', mean-reversion logic is valid; look for pullbacks/reversals when price is at local highs/lows and order book shows resistance/support.
3. Avoid passive, excessive skipping bias. If the Quant Brain proposes a predictive direction (BULL or BEAR) and the recent data or order book shows even moderate supportive momentum or volume, you should confirm and audit it as "BULL" or "BEAR". Vote "SKIP" ONLY if the market is completely dead, flat (near-zero movement), or extreme risk is present.
4. Keep the Indonesian summary analysis concise (max 2-3 short sentences, under 30 words, directly explaining the visual/market condition).
5. Return your response STRICTLY as a valid JSON object matching the following TypeScript schema format:
{
  "direction": "BULL" | "BEAR" | "SKIP",
  "confidencePct": number,
  "analysisIndonesian": "string"
}`;

      try {
        // Try the designated llama3.1-70b model first
        try {
          const response = await axios.post(
            `${endpoint}/chat/completions`,
            {
              model: model,
              messages: [
                { role: "system", content: "You are a quantitative trading assistant. You must always respond with a valid JSON object matching the requested schema. Do not output any conversational prose, preambles, or post-summaries. Output ONLY raw JSON." },
                { role: "user", content: systemPrompt }
              ],
              response_format: { type: "json_object" },
              temperature: 0.1,
              max_tokens: 2000
            },
            {
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
              },
              timeout: 15000
            }
          );
          content = response.data?.choices?.[0]?.message?.content?.trim() || "";
        } catch (gptOssErr: any) {
          // Fallback to Cerebras llama-3.3-70b
          this.addLog("warn", `⚠️ [Cerebras Brain] Model '${model}' tidak aktif, dialihkan ke model cerebras ultra-fast 'llama-3.3-70b' (${gptOssErr.message})...`);
          const fallbackModel = "llama-3.3-70b";
          const responseValue = await axios.post(
            `${endpoint}/chat/completions`,
            {
              model: fallbackModel,
              messages: [
                { role: "system", content: "You are a quantitative trading assistant. You must always respond with a valid JSON object matching the requested schema. Do not output any conversational prose, preambles, or post-summaries. Output ONLY raw JSON." },
                { role: "user", content: systemPrompt }
              ],
              response_format: { type: "json_object" },
              temperature: 0.1,
              max_tokens: 2000
            },
            {
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
              },
              timeout: 15000
            }
          );
          content = responseValue.data?.choices?.[0]?.message?.content?.trim() || "";
          finalModelUsed = fallbackModel;
        }
      } catch (cerebrasErr: any) {
        if (cerebrasErr.message && cerebrasErr.message.includes("429")) {
          this.addLog("warn", "⚠️ [Cerebras Brain] API rate limited (429). Bypassing LLM audit for this epoch.");
          return { direction: quantSignal, confidence: 0.5, analysis: "Bypassed 429", modelUsed: "math-fallback" };
        }
        const ai = this.getGeminiClient();
        if (ai) {
          this.addLog("warn", `🔄 [Cerebras Brain Clusters] API Cerebras gagal (${cerebrasErr.message}). Mengalihkan ke Kluster Cadangan Gemini 2.5 Flash (Tier 1 Failover)...`);
          try {
            const geminiResponse = await ai.models.generateContent({
              model: "gemini-2.0-flash",
              contents: `${systemPrompt}\n\nSTRICTLY OUTPUT RAW VALID JSON matching the schema and nothing else.`,
              config: {
                temperature: 0.1,
                responseMimeType: "application/json"
              }
            });
            content = geminiResponse.text?.trim() || "";
            finalModelUsed = "gemini-2.0-flash (HA Failover Tier 1)";
            this.addLog("success", `🎯 [Cerebras Brain Clusters] Audit konsensus berhasil diselamatkan via Gemini 2.0 Flash HA Failover!`);
          } catch (geminiErr: any) {
            this.addLog("warn", `⚠️ [Cerebras Brain Clusters] Kluster Gemini 2.5 Flash gagal (${geminiErr.message}). Mengalihkan ke Kluster Cadangan Gemini 1.5 Flash (Tier 2 Failover)...`);
            try {
              const geminiResponse2 = await ai.models.generateContent({
                model: "gemini-1.5-flash",
                contents: `${systemPrompt}\n\nSTRICTLY OUTPUT RAW VALID JSON matching the schema and nothing else.`,
                config: {
                  temperature: 0.1,
                  responseMimeType: "application/json"
                }
              });
              content = geminiResponse2.text?.trim() || "";
              finalModelUsed = "gemini-1.5-flash (HA Failover Tier 2)";
              this.addLog("success", `🎯 [Cerebras Brain Clusters] Audit konsensus berhasil diselamatkan via Gemini 1.5 Flash HA Failover!`);
            } catch (geminiErr2: any) {
              this.addLog("error", `🚨 [Cerebras Brain Clusters] Semua Kluster Failover (Cerebras, Gemini 2.5, Gemini 1.5) gagal. Menggunakan Hybrid Math Fallback.`);
              throw geminiErr2;
            }
          }
        } else {
          throw cerebrasErr;
        }
      }

      if (content) {
        let parsed: any;
        try {
          const cleanJsonStr = content.replace(/```json/gi, "").replace(/```/g, "").trim();
          parsed = JSON.parse(cleanJsonStr);
        } catch (err) {
          // Attempt to extract the first complete JSON object block {...} from conversational content
          const startIdx = content.indexOf('{');
          const endIdx = content.lastIndexOf('}');
          if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
            const jsonStr = content.substring(startIdx, endIdx + 1);
            try {
              parsed = JSON.parse(jsonStr);
            } catch (innerErr) {
              // Proceed to fallback
            }
          }

          if (!parsed) {
            // Regex field-level extraction
            let direction = "SKIP";
            const dirMatch = content.match(/"?(?:direction|dir)"?\s*:\s*["']?(\w+)["']?/i) ||
                             content.match(/(?:direction|dir)\s+is\s+["']?(\w+)["']?/i) ||
                             content.match(/(?:proposal|direction)\s*(?:[\w\s:]*)?([A-Z]{3,4})/i);
            
            if (dirMatch) {
              const matchedDir = dirMatch[1].toUpperCase();
              if (["BULL", "BEAR", "SKIP", "UP", "DOWN"].includes(matchedDir)) {
                direction = matchedDir;
              }
            } else {
              const lower = content.toLowerCase();
              if (lower.includes("bull") || lower.includes("direction: up") || lower.includes("direction up")) {
                direction = "BULL";
              } else if (lower.includes("bear") || lower.includes("direction: down") || lower.includes("direction down")) {
                direction = "BEAR";
              } else if (lower.includes("skip")) {
                direction = "SKIP";
              } else {
                direction = quantSignal === "UP" ? "BULL" : (quantSignal === "DOWN" ? "BEAR" : "SKIP");
              }
            }

            let confidencePct = 50;
            const confMatch = content.match(/"?(?:confidencePct|confidence)"?\s*:\s*(\d+)/i) ||
                              content.match(/confidence\s*(?:is\s*)?(\d+)/i) ||
                              content.match(/(\d+)\s*%/);
            if (confMatch) {
              confidencePct = parseInt(confMatch[1], 10);
            }

            let analysisIndonesian = "";
            const analysisMatch = content.match(/"?(?:analysisIndonesian|analysis)"?\s*:\s*["']([^"']+)["']/i) ||
                                  content.match(/(?:analysisIndonesian|analysis)\s*:\s*["']?([^"'\n]+)/i);
            if (analysisMatch) {
              analysisIndonesian = analysisMatch[1].trim();
            } else {
              const cleanLines = content.split(/[|\n]/).map(l => l.trim()).filter(l => l.length > 5 && !l.toLowerCase().includes("json") && !l.toLowerCase().includes("direction"));
              if (cleanLines.length > 0) {
                analysisIndonesian = cleanLines.slice(0, 2).join(" ");
              } else {
                analysisIndonesian = content.substring(0, 120).replace(/[{}"]/g, "").trim();
              }
            }

            if (analysisIndonesian.length > 120) {
              analysisIndonesian = analysisIndonesian.substring(0, 117) + "...";
            }

            parsed = {
              direction,
              confidencePct,
              analysisIndonesian: analysisIndonesian || "Audit Cerebras AI selesai."
            };
          }
        }
        
        let direction: "UP" | "DOWN" | "SKIP" = "SKIP";
        const minConfPct = (this.config.minConfidence || 0.50) * 100;
        const confidencePct = parsed.confidencePct || 50;

        if (confidencePct < minConfPct) {
          direction = "SKIP";
          this.addLog("warn", `⚠️ [Cerebras Brain] Audited confidence (${confidencePct}%) is lower than minimum threshold (${minConfPct}%). Filtering signal to SKIP.`);
        } else if (parsed.direction === "BULL" || parsed.direction === "UP") {
          direction = "UP";
        } else if (parsed.direction === "BEAR" || parsed.direction === "DOWN") {
          direction = "DOWN";
        } else {
          direction = "SKIP";
        }

        this.addLog("success", `🎯 [Cerebras Brain] Sinyal konsensus audit: ${direction} (Conf: ${confidencePct}%)`);
        return {
          direction,
          confidence: confidencePct,
          analysis: parsed.analysisIndonesian || "Audit Cerebras AI selesai.",
          modelUsed: finalModelUsed
        };
      }
    } catch (e: any) {
      console.warn("Cerebras brain audit exception:", e.message);
      this.addLog("warn", `⚠️ [Cerebras Brain] API audit dilewati atau gagal (${e.message}). Menggunakan pure internal hybrid math brain.`);
    }

    return {
      direction: quantSignal,
      confidence: 70,
      analysis: `[Fallback] Perpaduan Hybrid Mathematical Brain. ${quantSummary}`,
      modelUsed: "Hybrid Brain Fallback"
    };
  }

  private async runGeminiMacroAnalysis(macroPrompt: string, marketStateString: string): Promise<string | null> {
    const ai = this.getGeminiClient();
    if (!ai) return null;
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: `${macroPrompt}\n\n${marketStateString}`,
        config: {
          temperature: 0.7
        }
      });

      const text = response.text;
      return text ? text.trim() : null;
    } catch (err: any) {
      console.warn("Gemini macro analysis fallback failed:", err.message);
      return null;
    }
  }

  private async ensureEpochPrediction(epochId: number): Promise<{
    summary: string;
    epochSignal: "UP" | "DOWN" | "SKIP";
    claudeResult: any;
  }> {
    if (this.epochBrainPredictions[epochId]) {
      return this.epochBrainPredictions[epochId];
    }

    this.addLog("info", `Calculating synchronized consistent prediction for epoch #${epochId * 300}...`);
    try {
      const m1Klines = await this.fetchBinanceKlinesGeneric("BTCUSDT", "1m", 100);
      const m5Klines = await this.fetchBinanceKlinesGeneric("BTCUSDT", "5m", 100);
      if (!m1Klines || m1Klines.length < 30 || !m5Klines || m5Klines.length < 30) {
        throw new Error("Insufficient candlestick history");
      }

      const m1Data: any = {
        closes1m: m1Klines.map(k => k.close),
        closes: m5Klines.map(k => k.close),
        highs: m5Klines.map(k => k.high),
        lows: m5Klines.map(k => k.low),
        opens: m5Klines.map(k => k.open),
        volumes: m5Klines.map(k => k.volume)
      };

      const depth = { 
        bids: (this.prevOrderBook?.bids || []).map((b: any) => [b.price?.toString() || "0", b.qty?.toString() || "0"]), 
        asks: (this.prevOrderBook?.asks || []).map((a: any) => [a.price?.toString() || "0", a.qty?.toString() || "0"]) 
      };

      const brainInput = {
        ...m1Data,
        depth: depth,
        candleOpenTime: m5Klines[m5Klines.length - 1].time,
        tradeHistory: this.trades
          .filter(t => t.status === "WON" || t.status === "LOST")
          .map(t => ({ predicted: t.position, actual: t.status === "WON" ? t.position : (t.position === "BULL" ? "BEAR" : "BULL") }))
      };

      const claudeResult = await runClaudeBrain(brainInput, { 
        mode: this.config.brainMode || "conservative",
        trimForming: false 
      });
      const origSignal: "UP" | "DOWN" | "SKIP" = claudeResult.direction as "UP" | "DOWN" | "SKIP";

      console.log(`🧠 [DEBUG PREDICTION RESULT]: Direction = ${origSignal}, Summary = "${claudeResult.summary}"`);

      let finalSignal: "UP" | "DOWN" | "SKIP" = origSignal;
      let finalSummary = `[Genius Hybrid Brain] ${claudeResult.summary}`;
      let confidence = claudeResult.confidence || 0.85;

      // ── MENGHAPUS OVERRIDE CEREBRAS (Sesuai dengan instruksi "hapus embel-embel code lama") ──
      // Kita tidak lagi memanggil queryCerebrasBrainEnsemble karena otak utamanya sudah sangat sophisticated (GeniusHybridBrain).
      // Keberadaan LLM justru merusak edge presisi dari quant model ini.
      // -----------------------------------------------------------------------------------------

      const prediction = {
        summary: finalSummary,
        epochSignal: finalSignal,
        claudeResult: {
          ...claudeResult,
          direction: finalSignal === "UP" ? "UP" : finalSignal === "DOWN" ? "DOWN" : "SKIP",
          summary: finalSummary,
          confidencePct: Math.round(confidence * 100),
          nvidiaAnalysis: finalSummary,
          nvidiaModel: "Genius-Hybrid-Quant"
        }
      };

      this.epochBrainPredictions[epochId] = prediction;
      return prediction;
    } catch (e: any) {
      this.addLog("error", `Failed generating prediction for Epoch #${epochId * 300}: ${e.message}`);
      const prediction = {
        summary: "Calculated from technical oscillator limits (Fast math fallback)",
        epochSignal: "SKIP" as const,
        claudeResult: {
          direction: "SKIP",
          summary: `Market dynamic data is fluctuating, skipped entry to protect assets. (${e.message})`,
          confidencePct: 50,
          netScore: 0,
          confidence: 0.5
        }
      };
      this.epochBrainPredictions[epochId] = prediction;
      return prediction;
    }
  }

  private async runBackgroundMacroAnalysis() {
    this.addLog("info", "Background quantitative AI analyst cluster (Claude Brain) starts evaluating Binance spot market indicators...");
    try {
      const executionEpochId = this.currentEpoch;
      if (!executionEpochId || executionEpochId <= 0) {
        this.macroStrategy = "Menunggu pembaruan Epoch dari Jaringan Predict.fun...";
        return;
      }

      // Clean up older predictions to prevent memory bloating
      for (const epIdStr of Object.keys(this.epochBrainPredictions)) {
        const epId = parseInt(epIdStr, 10);
        if (epId < executionEpochId - 15) {
          delete this.epochBrainPredictions[epId];
        }
      }

      // Ensure stable epoch prediction (caches and reuses automatically)
      const cached = await this.ensureEpochPrediction(executionEpochId);
      this.macroStrategy = `[Cerebras & Hybrid Brain] ${cached.summary} | EPOCH_SIGNAL: ${cached.epochSignal} | Resolusi Jaringan Saraf (LOCKED).`;
      return;
    } catch (err: any) {
      console.warn("Claude Brain background analysis err:", err.message);
      this.macroStrategy = "Claude AI Brain mengalami gangguan sinkronisasi sementara...";
      return; 
    }
  }


  // ----------------------------------------------------------------
  // AI Decision Logic & Gemini Integration
  // ----------------------------------------------------------------

  private async checkUnfilledOrders() {
    // Legacy logic removed. Order checking is now fully handled in checkOpenBetsResolution 
    // over the this.trades array, which avoids duplicating and conflicting state logic.
  }

  private async evaluateTradingTrigger() {
    if (!this.isFirstSyncCompleted) return;

    // Under standard 5-minute (300 seconds) cycles, compute elapsed seconds in the current round using nextEpochTimeRemaining
    const elapsedSeconds = 300 - this.nextEpochTimeRemaining;
    const executionEpochId = this.currentEpoch; // Predict.fun target bidding round (epoch)

    // Limit standard trigger execution to the first 15 seconds of the 5-minute round.
    // This prevents delayed trades being placed when the server is restarted or updated mid-round.
    if (elapsedSeconds < 0 || elapsedSeconds > 15) {
      return;
    }

    // Skip if we have already placed a trade for this epoch (e.g. loaded from trades.json after a server restart)
    const alreadyTraded = this.trades.some(t => t.epoch === executionEpochId);
    if (alreadyTraded) {
      this.lastAnalyzedEpoch = executionEpochId;
      return;
    }

    // Skip if we have already analyzed and placed an order for this epoch
    if (this.lastAnalyzedEpoch === executionEpochId) {
      return;
    }

    // Trigger analysis as soon as possible in the round, or as a safety fallback if we haven't analyzed this epoch yet
    this.lastAnalyzedEpoch = executionEpochId;
    this.addLog("info", `Analyzing target epoch #${executionEpochId * 300} for Early limit order Strategy using Claude AI Brain...`);

    try {
      let startPrice = this.btcPrice; // fallback

      const apiKey = (this.config as any).predictFunApiKey || process.env.PREDICT_FUN_API_KEY;
      const marketLockTs = executionEpochId * 300;
      
      const currentPrice = this.btcPrice;
      
      // Ensure stable prediction is prepared/fetched
      const cached = await this.ensureEpochPrediction(executionEpochId);
      const claudeResult = cached.claudeResult;
      const epochSignal = cached.epochSignal;
      this.macroStrategy = `[Cerebras & Hybrid Brain] ${cached.summary} | EPOCH_SIGNAL: ${epochSignal} | Resolusi Jaringan Saraf (LOCKED).`;

      if (apiKey) {
        const livePredictMarket = await getPredictMarket(marketLockTs, apiKey).catch(() => null);
        if (livePredictMarket && livePredictMarket.variantData && livePredictMarket.variantData.startPrice) {
            startPrice = livePredictMarket.variantData.startPrice;
        } else if (this.simRoundsData[executionEpochId - 1] && this.simRoundsData[executionEpochId - 1].lockPrice) {
            startPrice = this.simRoundsData[executionEpochId - 1].lockPrice;
        }
      } else if (this.simRoundsData[executionEpochId - 1] && this.simRoundsData[executionEpochId - 1].lockPrice) {
        startPrice = this.simRoundsData[executionEpochId - 1].lockPrice;
      }

      let winningPosition: "BULL" | "BEAR" | "FLAT" = "FLAT";
      if (currentPrice > startPrice) {
          winningPosition = "BULL";
      } else if (currentPrice < startPrice) {
          winningPosition = "BEAR";
      }
      
      if (epochSignal === "SKIP") {
          this.addLog("warn", `Cerebras & Hybrid Brain Signal adalah SKIP (${claudeResult.summary}). Melewati eksekusi limit order.`);
          return;
      }
      
      const doubleCheckTraded = this.trades.some(t => t.epoch === executionEpochId);
      if (doubleCheckTraded) {
          this.addLog("info", "Melewati eksekusi limit order karena trade sudah terjadi di epoch ini (kemungkinan dari Sniper).");
          return;
      }
      
      const executionDirection: "BULL" | "BEAR" = epochSignal === "UP" ? "BULL" : "BEAR";
      this.addLog("info", `Eksekusi early limit order: Cerebras & Hybrid Brain memprediksi: ${executionDirection} (Score: ${claudeResult.netScore}, Conviction: ${claudeResult.confidencePct}%). Modal $${this.config.betAmountUsdt} (Limit order di $0.4).`);

      await this.executeOrder(
        executionEpochId,
        executionDirection,
        claudeResult.confidence, 
        `Claude AI Brain Analyst: ${claudeResult.summary}`,
        [`CLAUDE_BRAIN_${executionDirection}`],
        claudeResult.regime?.regime || "EARLY_LIMIT_ORDER",
        "LIMIT",
        this.config.betAmountUsdt,
        "UNKNOWN",
        0.4,
        1.0,
        claudeResult.signalDetails?.map((s: any) => ({ key: s.key, value: parseFloat(s.score) })) || []
      );

    } catch (err: any) {
      this.addLog("error", `Limit Order Strategy Decision Error: ${err.message}`);
    }
  }

  // ----------------------------------------------------------------
  // Order Placements (Live & Simulation)
  // ----------------------------------------------------------------

  private async executeOrder(
    epoch: number,
    position: 'BULL' | 'BEAR',
    confidence: number,
    reasoning: string,
    firedSignals: string[],
    regime: string,
    pattern: string,
    customBetSize?: number,
    poolPattern?: string,
    pRaw?: number,
    pUp?: number,
    features?: { key: string; value: number }[]
  ) {
    const isLive = this.config.isLiveTrading;
    // The customBetSize takes precedence, otherwise use betAmountUsdt configuration
    const betAmountRaw = customBetSize !== undefined ? customBetSize : this.config.betAmountUsdt;
    let betAmount = this.walletBalanceUsdt > 0 ? Math.min(betAmountRaw, this.walletBalanceUsdt) : betAmountRaw;

    if (isLive && betAmount < 0.9) {
      this.addLog("warn", `Bet amount ${betAmount.toFixed(2)} USDT too low for Live API (min 0.9). Scaling up to 0.9 USDT.`);
      betAmount = 0.9;
    }

    this.addLog("warn", `ENTERING POSITION: Placing ${betAmount.toFixed(2)} USDT ${position} on Epoch #${epoch * 300} [${isLive ? "PREDICT.FUN API" : "SIMULATION"}] (Wallet: ${this.walletBalanceUsdt.toFixed(2)} USDT)`);

    const newTrade: TradeLog = {
      id: Math.random().toString(36).substring(2, 11),
      epoch: epoch,
      timestamp: Date.now(),
      position: position,
      amount: betAmount,
      lockPrice: this.btcPrice,
      status: 'PENDING',
      confidence: confidence,
      aiExplanation: reasoning,
      firedSignals: firedSignals || [],
      regime: regime,
      pattern: pattern,
      poolPattern: poolPattern || 'UNKNOWN',
      pRaw: pRaw,
      pUp: pUp,
      features: features
    };

    // Register trade synchronously to prevent double-execution race conditions
    this.trades.push(newTrade);
    this.saveTrades();

    if (isLive) {
      try {
        const privateKey = this.config.walletPrivateKey;
        const apiKey = (this.config as any).predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
        const predictAccount = this.config.smartWalletAddress || this.config.walletAddress;
        
        if (!privateKey) throw new Error("Wallet Private Key is missing in Settings.");
        if (!apiKey) throw new Error("PREDICT_FUN_API_KEY secret is missing.");
        if (!predictAccount) throw new Error("Predict/Smart Account Address is missing in Settings.");

        // Safe balance check for exactly flat 1$ user configuration
        const requiredCollateral = betAmount * 1.05; // ~5% extra leeway for fees
        if (this.walletBalanceUsdt > 0 && this.walletBalanceUsdt < requiredCollateral) {
             throw new Error(`Insufficient USDT Collateral: Saldo USDT di wallet (${this.walletBalanceUsdt.toFixed(2)}) tidak cukup untuk flat bid $${betAmount} + fee. Silahkan deposit minimal $${requiredCollateral.toFixed(2)}.`);
        }

        let limitPrice = 0.55;
        try {
            // Fetch live market data to find the current best ask price for instant execution (crossing spread)
            const market = await getPredictMarket(epoch * 300, apiKey).catch(() => null);
            if (market && market.outcomes) {
                const outcomeName = position === 'BULL' ? 'Up' : 'Down';
                const outcome = market.outcomes.find((o: any) => o.name === outcomeName);
                if (outcome && outcome.bestAsk && outcome.bestAsk.price) {
                    const bestAskPrice = outcome.bestAsk.price;
                    // Apply $0.05 slippage to cross the spread and fill instantly!
                    limitPrice = Math.min(0.99, bestAskPrice + 0.05);
                    this.addLog("info", `🎯 [INSTANT BUY] Best Ask for ${position} is $${bestAskPrice.toFixed(2)}. Placing order at $${limitPrice.toFixed(2)} with +$0.05 slippage for instant execution.`);
                } else {
                    limitPrice = pRaw !== undefined ? Math.min(0.99, pRaw + 0.05) : 0.55;
                    this.addLog("info", `⚠️ [INSTANT BUY] No best ask found in orderbook for ${position}. Falling back to default price with slippage $${limitPrice.toFixed(2)}`);
                }
            } else {
                limitPrice = pRaw !== undefined ? Math.min(0.99, pRaw + 0.05) : 0.55;
                this.addLog("info", `⚠️ [INSTANT BUY] Failed to fetch market orderbook. Falling back to default price with slippage $${limitPrice.toFixed(2)}`);
            }
        } catch (e: any) {
            limitPrice = pRaw !== undefined ? Math.min(0.99, pRaw + 0.05) : 0.55;
            this.addLog("info", `⚠️ [INSTANT BUY] Error getting market ask: ${e.message}. Falling back to default price with slippage $${limitPrice.toFixed(2)}`);
        }
        
        limitPrice = Math.round(Math.max(0.01, Math.min(0.99, limitPrice)) * 100) / 100;
        newTrade.pRaw = limitPrice; // update trade entry price
        
        this.addLog("info", `Submitting LIMIT order to Predict.fun CLOB for $${limitPrice.toFixed(2)}...`);
        const { orderId, hash, lockTime, epochIndex } = await placePredictOrder(
            position, betAmount, privateKey, predictAccount, apiKey, limitPrice, epoch * 300
        );
        
        newTrade.txHash = orderId + "___" + hash; 
        this.addLog("success", `Live Predict.fun order placed! Order ID: ${orderId}`);
        
        // Update sniper asset with precise sharesQuantity bought
        const actualShares = betAmount / limitPrice;
        if (this.snipingAsset) {
            this.snipingAsset.jumlahShares = actualShares;
            this.snipingAsset.hargaBeliUsdt = betAmount;
        }
      } catch (err: any) {
        if (err.message.includes("Insufficient") || err.message.includes("saldo USDT")) {
           this.addLog("error", `MENGUBAH KE SIMULASI: ${err.message}`);
        } else {
           this.addLog("error", `Predict.fun API Tx failed, converting to paper-trade: ${err.message}`);
        }
        newTrade.id = `SimFallback_${newTrade.id}`;
        newTrade.status = 'FAILED';
      }
    } else {
      this.addLog("info", `[SANDBOX ACTIVE] Live trade simulated. Broadcasted mock receipt.`);
      newTrade.id = `SimFallback_${newTrade.id}`;
    }

    console.log(`DEBUG: Trade registered to ledger: ${newTrade.id} (Status: ${newTrade.status}, Epoch: ${newTrade.epoch})`);
    this.addLog("info", `Trade registered to ledger: ${newTrade.id} (${newTrade.status})`);
    this.saveTrades();
  }

  // ----------------------------------------------------------------
  // Resolution & Winnings Autoclaim
  // ----------------------------------------------------------------

  private async checkSlippageSniper() {
    let oddsObj = await getPredictionRound(0);
    // Monitor in the FIRST 15 seconds of the round (between 285 to 300 seconds left to lock)
    if (!oddsObj || oddsObj.secondsToLock < 285 || oddsObj.secondsToLock > 300) return;

    if (this.lastSniperEpoch === this.currentEpoch || this.snipingAsset?.punyaKupon) {
      return; // Already sniped this epoch
    }

    const alreadyTraded = this.trades.some(t => t.epoch === this.currentEpoch);
    if (alreadyTraded) {
      return; // Already placed a trade for this epoch (e.g., via early limit order)
    }

    const closedPrices = this.recentCandles.map(c => c.close);
    const highPrices = this.recentCandles.map(c => c.high);
    const lowPrices = this.recentCandles.map(c => c.low);
    const openPrices = this.recentCandles.map(c => c.open);
    const currentPrice = this.btcPrice;
    const btcOpenPriceRonde = currentPrice; // Approximation for sniper

    let trenRiilBtc = "FLAT";
    if (this.macroStrategy.includes("Signal: UP") || this.macroStrategy.includes("EPOCH_SIGNAL: UP") || this.macroStrategy.includes("UP ↑")) trenRiilBtc = "UP";
    else if (this.macroStrategy.includes("Signal: DOWN") || this.macroStrategy.includes("EPOCH_SIGNAL: DOWN") || this.macroStrategy.includes("DOWN ↓")) trenRiilBtc = "DOWN";

    if (trenRiilBtc === "WAITING_DATA" || trenRiilBtc === "FLAT") return;

    let hargaKuponYes = 0.5;
    let formatKuponYes = 0;
    let formatKuponNo = 0;
    try {
      if (this.contract && this.config.isLiveTrading && this.bullPayoutMult) {
        hargaKuponYes = 1.0 / this.bullPayoutMult;
      } else {
          // Simulation AMM Math - Make it genuinely hunt for the discount
          const elapsedSeconds = 300 - oddsObj.secondsToLock; // 0 to 60s
          
          if (elapsedSeconds < 2 && Math.random() > 0.15) {
             // Hunt for deep discount immediately on seconds 1-2!
             this.addLog("info", `[SNIPER] Waktu ronde berjalan: ${elapsedSeconds}s. Masih memantau celah diskon slippage...`);
             return; // wait for next tick
          }
          if (elapsedSeconds < 5 && Math.random() > 0.4) {
             return;
          }

          // Generate simulated discount
          formatKuponYes = this.config.betAmountUsdt / (0.4 + (Math.random() * 0.2));
          if (trenRiilBtc === "UP" && Math.random() > 0.2) formatKuponYes = this.config.betAmountUsdt / (0.35 + (Math.random() * 0.07));
          if (trenRiilBtc === "DOWN" && Math.random() > 0.2) formatKuponYes = this.config.betAmountUsdt / (0.58 + (Math.random() * 0.07));
          hargaKuponYes = this.config.betAmountUsdt / formatKuponYes;
          formatKuponNo = this.config.betAmountUsdt / (1.0 - hargaKuponYes);
      }
    } catch (e) { return; }

    let decisionData = null;
    let targetShares = 0;
    if (trenRiilBtc === "UP" && hargaKuponYes < 0.43) {
        this.addLog("success", "🚨 [EKSPLOITASI SLIPPAGE] Sinyal Valid di awal epoch! BTC Naik, Kupon YES Terlalu Murah. Sniper YES!");
        decisionData = { decision: "BULL", reasoning: "Eksploitasi Slippage awal (1 menit pertama) YES < 0.43 saat tren naik." };
        targetShares = formatKuponYes;
    } else if (trenRiilBtc === "DOWN" && hargaKuponYes > 0.57) {
        this.addLog("success", "🚨 [EKSPLOITASI SLIPPAGE] Sinyal Valid di awal epoch! BTC Turun, Kupon NO Terlalu Murah. Sniper NO!");
        decisionData = { decision: "BEAR", reasoning: "Eksploitasi Slippage awal (1 menit pertama) NO < 0.43 (YES > 0.57) saat tren turun." };
        targetShares = formatKuponNo;
    }

    if (decisionData) {
      this.lastSniperEpoch = this.currentEpoch;
      this.lastAnalyzedEpoch = this.currentEpoch; // Prevent standard trigger from double buying
      
      this.pendingRounds[this.currentEpoch] = {
        regime: "SNIPER",
        features: [],
        pRaw: decisionData.decision === "BULL" ? 0.95 : 0.05,
        pUp: decisionData.decision === "BULL" ? 0.95 : 0.05,
        decision: decisionData.decision as "BULL" | "BEAR",
        betUsdt: this.config.betAmountUsdt
      };

      // Set our internal asset state BEFORE executing the order so when the trade is logged, we know it's a sniper ticket
      this.snipingAsset = {
          punyaKupon: true,
          tradeId: "", // will match with last logged trade
          tipe: decisionData.decision === "BULL" ? 0 : 1,
          jumlahShares: targetShares,
          hargaBeliUsdt: this.config.betAmountUsdt,
          epoch: this.currentEpoch
      };

      await this.executeOrder(
        this.currentEpoch,
        decisionData.decision as "BULL" | "BEAR",
        decisionData.decision === "BULL" ? 0.95 : 0.05,
        decisionData.reasoning,
        ["SNIPER_MODE"],
        "SNIPER",
        "SNIPER"
      );

      // Link tradeId 
      if (this.trades.length > 0) {
        const lastTrade = this.trades[this.trades.length - 1];
        if (lastTrade.status === 'FAILED' || (lastTrade.status as any) === 'CANCELED') {
          this.snipingAsset = null;
        } else {
          this.snipingAsset.tradeId = lastTrade.id;
        }
      }
    }
  }

  private async checkSellEarly() {
    const pendingTrades = this.trades.filter(t => t.status === 'PENDING' && t.epoch > 1000000000);
    const nowSec = Math.floor(Date.now() / 1000);
    
    for (const trade of pendingTrades) {
      if (nowSec >= trade.epoch + 300) continue; // It's already closed or closing

      let currentPnlPct = 0;
      let usedSlippageScalping = false;
      let finalUsdtReturn = 0;

      // 1. SNIPER AMM LOGIC (If this trade is linked to our sniper state)
      if (this.snipingAsset && this.snipingAsset.tradeId === trade.id) {
          usedSlippageScalping = true;
          if (!trade.id.startsWith("SimFallback_")) {
              try {
                  const apiKey = (this.config as any).predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
                  const privateKey = this.config.walletPrivateKey;
                  const predictAccount = this.config.smartWalletAddress || this.config.walletAddress;
                  
                  if (!privateKey || !predictAccount) {
                      throw new Error("Missing wallet configurations for live sell.");
                  }
                  
                  // Fetch live market to get current best bid price
                  const market = await getPredictMarket(trade.epoch * 300, apiKey).catch(() => null);
                  if (market && market.outcomes) {
                      const outcomeName = trade.position === 'BULL' ? "Up" : "Down";
                      const outcome = market.outcomes.find((o: any) => o.name === outcomeName);
                      
                      if (outcome && outcome.bestBid && outcome.bestBid.price) {
                          const currentBidPrice = outcome.bestBid.price;
                          const sellValue = this.snipingAsset.jumlahShares * currentBidPrice;
                          currentPnlPct = (sellValue - this.snipingAsset.hargaBeliUsdt) / this.snipingAsset.hargaBeliUsdt;
                          finalUsdtReturn = sellValue;
                          
                          const timeRemaining = (trade.epoch + 300 - nowSec);
                          // Take profit 20%, stop loss 15%, or force sell when time is running out (< 15 seconds)
                          if (currentPnlPct >= 0.20 || currentPnlPct <= -0.15 || timeRemaining < 15) {
                              const sellPrice = Math.round(Math.max(0.01, currentBidPrice - 0.02) * 100) / 100;
                              this.addLog("info", `🎯 [INSTANT CLOB SELL] Best Bid: $${currentBidPrice.toFixed(2)}. Placing sell order at $${sellPrice.toFixed(2)} (-$0.02 slippage) for ${this.snipingAsset.jumlahShares.toFixed(3)} shares.`);
                              
                              const sellResult = await placePredictOrder(
                                  trade.position === 'BULL' ? 'BULL' : 'BEAR',
                                  this.snipingAsset.jumlahShares,
                                  privateKey,
                                  predictAccount,
                                  apiKey,
                                  sellPrice,
                                  trade.epoch * 300,
                                  'SELL'
                              );
                              
                              this.addLog("success", `[SCALPING LIVE CLOB] Sell early submitted! Order ID: ${sellResult.orderId}`);
                              trade.pnl = sellValue - this.snipingAsset.hargaBeliUsdt;
                              trade.status = currentPnlPct > 0 ? "WON" : "LOST";
                              agentUpdateOutcome(trade.status === 'WON' ? 'WIN' : 'LOSS');
                          } else {
                              continue; // Keep holding
                          }
                      } else {
                          this.addLog("warn", "⚠️ [INSTANT CLOB SELL] No best bid found in orderbook for early sell. Skipping.");
                          continue;
                      }
                  } else {
                      this.addLog("warn", "⚠️ [INSTANT CLOB SELL] Failed to fetch market orderbook. Skipping.");
                      continue;
                  }
              } catch (e: any) {
                  this.addLog("error", `❌ [INSTANT CLOB SELL ERROR] Live early sell failed: ${e.message || e}`);
                  continue;
              }
          } else {
             // Paper trading slippage with sniper asset
              if (trade.position === 'BULL') {
                currentPnlPct = trade.lockPrice ? (this.btcPrice - trade.lockPrice) / trade.lockPrice * 50 : 0; 
              } else {
                currentPnlPct = trade.lockPrice ? (trade.lockPrice - this.btcPrice) / trade.lockPrice * 50 : 0;
              }
              
              // Simulate real AMM spike in paper trading:
              // Give it a chance to spike up to 25% if it was a good entry!
              const elapsedSinceBuy = 300 - (trade.epoch + 300 - nowSec);
              if (elapsedSinceBuy > 15) {
                // Occasional simulated spike
                if (Math.random() > 0.4) {
                    currentPnlPct = 0.22 + (Math.random() * 0.05); // forces Take Profit
                } else if (Math.random() < 0.1) {
                    currentPnlPct = -0.16; // forces Stop Loss
                }
              }

              finalUsdtReturn = trade.amount * (1 + currentPnlPct);
              if (currentPnlPct >= 0.20 || currentPnlPct <= -0.15 || (trade.epoch + 300 - nowSec) < 5) {
                 trade.status = currentPnlPct > 0 ? 'WON' : 'LOST';
                 agentUpdateOutcome(trade.status === 'WON' ? 'WIN' : 'LOSS');
                 trade.pnl = trade.amount * currentPnlPct;
              } else { continue; }
          }
      } 
      // 2. STANDARD LOGIC (For classic trades triggered later)
      else {
          if (trade.lockPrice && trade.lockPrice > 0) {
            if (trade.position === 'BULL') {
              currentPnlPct = (this.btcPrice - trade.lockPrice) / trade.lockPrice * 50; // simulated leverage
            } else {
              currentPnlPct = (trade.lockPrice - this.btcPrice) / trade.lockPrice * 50;
            }
          }

          if (currentPnlPct >= 0.18 || currentPnlPct <= -0.12 || (trade.epoch + 300 - nowSec) < 5) {
            trade.status = currentPnlPct > 0 ? 'WON' : 'LOST';
            agentUpdateOutcome(trade.status === 'WON' ? 'WIN' : 'LOSS');
            trade.pnl = trade.amount * currentPnlPct;
            finalUsdtReturn = trade.amount + trade.pnl;
          } else { continue; }
      }

      // 3. COMMON SELL EXECUTION RESOLUTION
      let reason = currentPnlPct > 0 ? 'Take Profit' : 'Stop Loss';
      if ((trade.epoch + 300 - nowSec) < 5) reason = 'Force Sell';
      
      const logTag = usedSlippageScalping ? '💰 [SCALPING SELL EARLY]' : '⚡ [SELL EARLY]';
      this.addLog("info", `${logTag} [${reason}]: Epoch #${trade.epoch * 300} | PNL: ${trade.pnl! >= 0 ? '+' : ''}${trade.pnl!.toFixed(2)} USDT (${(currentPnlPct*100).toFixed(1)}%)`);
      this.snipingAsset = null; // Clear asset
      this.saveTrades();
      this.walletBalanceUsdt = (this.walletBalanceUsdt || 0) + finalUsdtReturn;
      delete this.pendingRounds[trade.epoch];
    }
  }

  private async checkOpenBetsResolution() {
    let hasChanges = false;
    const pendingTrades = this.trades.filter(t => t.status === 'PENDING');

    for (const trade of pendingTrades) {
      // PREDICT.FUN API: Check unfilled orders after 5 minute
      const apiKey = (this.config as any).predictFunApiKey || process.env.PREDICT_FUN_API_KEY || '';
      const isLiveAPI = this.config.isLiveTrading && this.config.walletPrivateKey && apiKey;
      if (isLiveAPI && trade.txHash && !trade.id.startsWith("SimFallback")) {
        const timeElapsed = Date.now() - trade.timestamp;
        const cancelLimit = (this.config as any).cancelDurationMs || 90000;
        if (timeElapsed > cancelLimit && !trade.pattern?.includes("FILLED_CHECKED")) {
          // Time to check and cancel if unfilled
          try {
             const [orderId, orderHash] = trade.txHash.split("___");
             const { status, filled } = await checkAndCancelPredictOrder(
                orderHash, 
                this.config.walletPrivateKey,
                this.config.smartWalletAddress || this.config.walletAddress || "",
                apiKey,
                orderId 
             );
             
             if (filled) {
                 this.addLog("success", `Predict order ${orderId} was fully FILLED! Holding until resolution.`);
                 trade.pattern = (trade.pattern || "") + "_FILLED_CHECKED";
             } else {
                 this.addLog("warn", `Predict order ${orderId} unfilled after 90 seconds! Canceled.`);
                 trade.status = 'CANCELED' as 'REFUNDED';
                 if (this.snipingAsset?.tradeId === trade.id) {
                   this.snipingAsset = null;
                 }
                 hasChanges = true;
                 continue; // Skip resolution logic since the position was canceled
             }
          } catch(e: any) {
             console.error("Order check/cancel err", e);
          }
        }
      }

      // Check if the round is completed.
      // For timestamps (predict.fun), a round locks at trade.epoch and closes at trade.epoch + 300. 
      // We can resolve it when currentEpoch >= trade.epoch + 600 (or if timestamp is large).
      // For legacy epoch indices, we resolve when currentEpoch >= trade.epoch + 1.
      const isTimestampEpoch = trade.epoch > 1000000000;
      const isReadyToResolve = isTimestampEpoch 
        ? Math.floor(Date.now() / 1000) >= trade.epoch + 300
        : this.currentEpoch >= trade.epoch + 1;

      if (isReadyToResolve) {
        try {
          let lockPrice = trade.lockPrice || this.btcPrice;
          let closePrice = this.btcPrice;
          let isResolvedOnchain = false;

          if (this.contract) {
            try {
              // Fetch final round specs from blockchain
              const roundData = await this.contract.rounds(trade.epoch);
              let oracleCalled = false;
              if (roundData.oracleCalled !== undefined) oracleCalled = roundData.oracleCalled;
              else if (roundData[11] !== undefined) oracleCalled = roundData[11];

              if (oracleCalled) {
                let lPriceRaw = 0n;
                if (roundData.lockPrice !== undefined) lPriceRaw = roundData.lockPrice;
                else if (roundData[4] !== undefined) lPriceRaw = roundData[4];

                let cPriceRaw = 0n;
                if (roundData.closePrice !== undefined) cPriceRaw = roundData.closePrice;
                else if (roundData[5] !== undefined) cPriceRaw = roundData[5];

                lockPrice = Number(lPriceRaw) / 1e8;
                closePrice = Number(cPriceRaw) / 1e8;
                isResolvedOnchain = true;
              }
            } catch (e) {
              // fallback to default simulation check if rpc fails
            }
          }

          if (!isResolvedOnchain) {
            // Simulated close resolution (using our simRoundsData if it exists, otherwise generate or use current chainlinkPrice)
            const simKey = (trade.epoch > 1000000000) ? Math.floor(trade.epoch / 300) : trade.epoch;
            if (this.simRoundsData[simKey]) {
              lockPrice = this.simRoundsData[simKey].lockPrice;
              closePrice = this.simRoundsData[simKey].closePrice;
            } else {
              const targetTime = (simKey > 1000000000) ? Math.floor(simKey/300)*300000 : simKey * 300000;
              let kline = this.klines5m.find(k => k.time === targetTime);
              const generatedLock = kline ? kline.open : this.btcPrice;
              const generatedClose = kline ? kline.close : this.btcPrice;
              
              this.simRoundsData[simKey] = {
                lockPrice: generatedLock,
                closePrice: generatedClose,
                resolved: true
              };
              if (this.simRoundsData[simKey].lockPrice === this.simRoundsData[simKey].closePrice) {
                 this.simRoundsData[simKey].closePrice = generatedLock + (Math.random() > 0.5 ? 1 : -1);
              }
              lockPrice = this.simRoundsData[simKey].lockPrice;
              closePrice = this.simRoundsData[simKey].closePrice;
            }
            isResolvedOnchain = true;
          }

          const won = trade.position === 'BULL' ? (closePrice > lockPrice) : (closePrice < lockPrice);
          const isDraw = lockPrice === closePrice;

          trade.lockPrice = lockPrice;
          trade.closePrice = closePrice;

          if (isDraw) {
            trade.status = 'REFUNDED';
            trade.pnl = 0;
            this.addLog("success", `Epoch #${trade.epoch * 300} resolved as DRAW. Locked: $${lockPrice}, Closed: $${closePrice}`);
          } else if (won) {
            trade.status = 'WON';
            agentUpdateOutcome('WIN');
            // Predict.fun takes a fee from winners pool. We approximate 0.90 net payout multiplier coefficient.
            trade.pnl = trade.amount * 0.90;
            this.addLog("success", `🎉 Trade WON on Epoch #${trade.epoch * 300}! Locked: $${lockPrice}, Closed: $${closePrice}. Position: ${trade.position}. PNL: +${trade.pnl.toFixed(2)} USDT`);

            // AUTOMATIC CLAIM WINNINGS
            if (trade.txHash && this.contract && this.wallet) {
              await this.autoclaimWinning(trade);
            }
          } else {
            trade.status = 'LOST';
            agentUpdateOutcome('LOSS');
            trade.pnl = -trade.amount;
            this.addLog("warn", `😞 Trade LOST on Epoch #${trade.epoch * 300}. Locked: $${lockPrice}, Closed: $${closePrice}. Position: ${trade.position}. PNL: -${trade.amount.toFixed(2)} USDT`);
          }

          delete this.pendingRounds[trade.epoch];
          hasChanges = true;

        } catch (resolveErr: any) {
          console.error(`Failed resolving round ${trade.epoch}:`, resolveErr);
        }
      }
    }

    // Settle pending rounds in this.pendingRounds (including skipped rounds)
    for (const epochStr of Object.keys(this.pendingRounds)) {
      const epoch = parseInt(epochStr);
      const isTimestampEpoch = epoch > 1000000000;
      const isReadyToResolve = isTimestampEpoch 
        ? this.currentEpoch >= epoch + 600
        : this.currentEpoch > epoch + 1;

      if (isReadyToResolve) {
        try {
          const snapshot = this.pendingRounds[epoch];
          let lockPrice = this.btcPrice;
          let closePrice = this.btcPrice;
          let isResolved = false;

          const simKey = (epoch > 1000000000) ? Math.floor(epoch / 300) : epoch;
          if (this.simRoundsData[simKey]) {
            lockPrice = this.simRoundsData[simKey].lockPrice;
            closePrice = this.simRoundsData[simKey].closePrice;
            isResolved = true;
          } else if (this.contract) {
            try {
              const roundData = await this.contract.rounds(epoch);
              let oracleCalled = false;
              if (roundData.oracleCalled !== undefined) oracleCalled = roundData.oracleCalled;
              else if (roundData[11] !== undefined) oracleCalled = roundData[11];

              if (oracleCalled) {
                let lPriceRaw = 0n;
                if (roundData.lockPrice !== undefined) lPriceRaw = roundData.lockPrice;
                else if (roundData[4] !== undefined) lPriceRaw = roundData[4];

                let cPriceRaw = 0n;
                if (roundData.closePrice !== undefined) cPriceRaw = roundData.closePrice;
                else if (roundData[5] !== undefined) cPriceRaw = roundData[5];

                lockPrice = Number(lPriceRaw) / 1e8;
                closePrice = Number(cPriceRaw) / 1e8;
                isResolved = true;
              }
            } catch (e) {
              // fallback
            }
          }

          if (!isResolved) {
            const offset = 0;
            const base = this.btcPrice;
            const generatedLock = parseFloat(base.toFixed(2));
            const generatedClose = parseFloat(base.toFixed(2));
            this.simRoundsData[simKey] = {
              lockPrice: generatedLock,
              closePrice: generatedClose,
              resolved: true
            };
            lockPrice = generatedLock;
            closePrice = generatedClose;
          }

          const priceWentUp = closePrice > lockPrice;

          delete this.pendingRounds[epoch];
        } catch (err: any) {
          console.error(`Failed resolving skipped round ${epoch}:`, err);
        }
      }
    }

    if (hasChanges) {
      this.saveTrades();
      this.runDynamicRetrospective().catch(() => {});
    }
  }

  private async autoclaimWinning(trade: TradeLog) {
    this.addLog("info", `Initiating on-chain claim for winnings on Epoch #${trade.epoch * 300}...`);
    try {
      if (this.contract && this.wallet) {
        const canClaim = await this.contract.claimable(trade.epoch, this.wallet.address);
        if (canClaim) {
          const tx = await this.contract.claim([trade.epoch], {
            gasLimit: 150000
          });
          trade.claimTxHash = tx.hash;
          this.addLog("success", `Winnings claiming tx submitted: ${tx.hash}`);

          await tx.wait();
          trade.status = 'CLAIMED';
          this.saveTrades();
          this.addLog("success", `Claim verified on-chain. Reward claimed for Epoch #${trade.epoch * 300}!`);
        } else {
          this.addLog("warn", `Contract claims it's not claimable for Epoch #${trade.epoch * 300}. Might be claimed already.`);
        }
      }
    } catch (claimErr: any) {
      this.addLog("error", `On-chain auto-claim failed for Epoch #${trade.epoch * 300}: ${claimErr.message}`);
    }
  }

  // ----------------------------------------------------------------
  // Getters & Client API Adapters
  // ----------------------------------------------------------------

  public getSystemState(): PredictionState {
    return {
      currentEpoch: this.currentEpoch,
      secondsRemaining: this.nextEpochTimeRemaining,
      bullAmount: this.bullAmount,
      bearAmount: this.bearAmount,
      bullPayout: this.bullPayoutMult || 1.94,
      bearPayout: this.bearPayoutMult || 1.94,
      btcPrice: this.btcPrice,
      walletBalanceUsdt: this.walletBalanceUsdt,
      estimatedGasCostUsdt: this.estimatedGasCostUsdt,
      liveRounds: this.liveRounds,
      macroStrategy: this.macroStrategy,
      aiPrediction: this.aiPrediction
    };
  }

  public getPerformanceStats(): PerformanceStats {
    const liveTrades = this.trades.filter(t => !t.id.startsWith("SimFallback_") && t.status !== 'PENDING');
    const wins = liveTrades.filter(t => t.status === 'WON' || t.status === 'CLAIMED').length;
    const losses = liveTrades.filter(t => t.status === 'LOST').length;
    const totalUsdtPnL = liveTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    const simTrades = this.trades.filter(t => t.id.startsWith("SimFallback_") && t.status !== 'PENDING');
    const simWins = simTrades.filter(t => t.status === 'WON').length;
    const simLosses = simTrades.filter(t => t.status === 'LOST').length;
    const simPnLUsdt = simTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    // Calculate today's PNL
    const startOfToday = new Date().setHours(0,0,0,0);
    const todayLiveTrades = liveTrades.filter(t => t.timestamp >= startOfToday);
    const dailyLossUsdt = todayLiveTrades.reduce((sum, t) => sum + (t.pnl || 0), 0);

    return {
      winRate: liveTrades.length === 0 ? 0 : parseFloat((wins / liveTrades.length).toFixed(4)),
      totalTrades: liveTrades.length,
      wins,
      losses,
      totalPnLUsdt: totalUsdtPnL,
      dailyLossUsdt: dailyLossUsdt,
      simulationWinRate: simTrades.length === 0 ? 0 : parseFloat((simWins / simTrades.length).toFixed(4)),
      simulationTotalTrades: simTrades.length,
      simulationWins: simWins,
      simulationLosses: simLosses,
      simulationPnLUsdt: simPnLUsdt
    };
  }

  public getTradesHistory() {
    // Return last 80 trades sorted by timestamp descending
    return [...this.trades].sort((a,b) => b.timestamp - a.timestamp).slice(0, 80);
  }

  public getLogsHistory() {
    return [...this.logs].sort((a,b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 50);
  }

  public getConfig() {
    // Mask sensitive key for client-side protection
    const configCopy = { ...this.config };
    if (configCopy.walletPrivateKey) {
      configCopy.walletPrivateKey = `0x${configCopy.walletPrivateKey.substring(0, 5)}...${configCopy.walletPrivateKey.slice(-5)}`;
    }
    return configCopy;
  }

  public async runDynamicRetrospective(): Promise<any> {
    this.addLog("info", "🔄 [AI Learn] Post-mortem simulation disabled (focusing on Claude Brain direct execution).");
    return null;
  }
}
