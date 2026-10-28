const fs = require('fs');
let code = fs.readFileSync('server/arbitrage-engine.ts', 'utf8');

// 1. Add imports
code = code.replace(
  "import { placePredictOrder",
  "import { LatencyDetector } from './LatencyDetector';\nimport { placePredictOrder"
);

// 2. Add LatencyDetector to class properties
code = code.replace(
  "private ws: WebSocket | null = null;",
  "private ws: WebSocket | null = null;\n  private latencyDetector: LatencyDetector;"
);

// 3. Initialize LatencyDetector in constructor
code = code.replace(
  "this.cfg = { ...DEFAULT_ARB_CONFIG, ...config };",
  "this.cfg = { ...DEFAULT_ARB_CONFIG, ...config };\n    this.latencyDetector = new LatencyDetector();\n    this.latencyDetector.on('signal', (signal) => this.handleLatencySignal(signal));\n    this.latencyDetector.on('status', (status) => this.log(`[LatencyDetector] Status: ${JSON.stringify(status)}`));"
);

// 4. Start/stop LatencyDetector
code = code.replace(
  "this.connectBinanceWs();",
  "// this.connectBinanceWs();\n    this.latencyDetector.start();"
);

code = code.replace(
  "if (this.ws) {",
  "this.latencyDetector.stop();\n    if (this.ws) {"
);

// 5. Provide missing handleLatencySignal method & inversePhi
const handleMethod = `
  // ─────────────────────────────────────────────────────────────────────────
  // LATENCY SIGNAL HANDLER
  // ─────────────────────────────────────────────────────────────────────────
  private handleLatencySignal(latencySignal: any): void {
    // Check rate limits
    if (this.tradesThisHour >= this.cfg.maxTradesPerHour) return;
    if (this.dailyPnl <= -this.cfg.maxDailyLoss) return;
    if (Date.now() - this.lastTradeTime < this.cfg.cooldownMs) return;
    
    // Prevent entering new trades in the last part of the active trading window
    const nowSec = Math.floor(Date.now() / 1000);
    const secondsIntoEpoch = nowSec % 300;
    if (secondsIntoEpoch >= 160) return;
    
    const hasAnyActiveTrade = this.trades.some(t => !t.resolved && !t.isSold);
    if (hasAnyActiveTrade || this.isExecutingTrade) return;
    
    const lastDirTradeTime = this.lastTradeTimeByDirection[latencySignal.direction] || 0;
    if (Date.now() - lastDirTradeTime < 15000) return;
    
    // Convert to ArbitrageSignal format for executeTrade
    const marketOdds = latencySignal.direction === 'UP' 
      ? (this.lastPredictOdds?.upOdds || 2.0)
      : (this.lastPredictOdds?.downOdds || 2.0);
      
    const fairOdds = latencySignal.binancePrice; // Using price as placeholder
    
    const signal: ArbitrageSignal = {
      direction: latencySignal.direction,
      edge: latencySignal.priceDeltaPct / 100,
      confidence: latencySignal.confidence,
      fairOdds,
      marketOdds,
      momentum: latencySignal.velocity,
      volumeSpike: latencySignal.tradeFlowScore > 0.5,
      orderBookImbalance: latencySignal.obImbalance,
      latencyMs: 50,
      reason: latencySignal.reason
    };
    
    this.log(\`🎯 LATENCY SIGNAL: \${signal.direction} | Edge: \${(signal.edge * 100).toFixed(1)}% | Conf: \${(signal.confidence * 100).toFixed(0)}%\`);
    this.log(\`   Reason: \${signal.reason}\`);
    
    if (this.cfg.enableAutoTrade) {
      this.executeTrade(signal);
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
`;

code = code.replace(
  "private phi(z: number): number {",
  handleMethod + "\n\n  private phi(z: number): number {"
);

// 6. Hook up implied BTC price calculation in syncPredictOdds
const syncReplacement = `        this.lastPredictOdds = {
          upOdds,
          downOdds,
          timestamp: Date.now()
        };

        // Pass the implied BTC price to LatencyDetector
        try {
          const probUp = 1 / upOdds;
          const zScore = this.inversePhi(probUp);
          const nowSec = Math.floor(Date.now() / 1000);
          const secondsIntoEpoch = nowSec % 300;
          const remainingSec = Math.max(30, 300 - secondsIntoEpoch);
          
          const currentPrice = this.latencyDetector.getLatestBinancePrice() || this.currentPrice || 65000;
          this.currentPrice = currentPrice; // Update internal price
          const baseStdDev = currentPrice * 0.0022;
          const stdDev = Math.max(15, baseStdDev * Math.sqrt(remainingSec / 300));
          const startPrice = this.currentStartPrice || currentPrice;
          
          const impliedBtcPrice = startPrice + zScore * stdDev;
          this.latencyDetector.updatePredictFunPrice(impliedBtcPrice);
        } catch (e) {
          // ignore
        }`;

code = code.replace(
  /this\.lastPredictOdds = \{\s*upOdds,\s*downOdds,\s*timestamp: Date\.now\(\)\s*\};/m,
  syncReplacement
);

fs.writeFileSync('server/arbitrage-engine.ts', code);
console.log('patched');
