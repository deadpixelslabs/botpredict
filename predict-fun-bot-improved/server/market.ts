// ================================================================
// MARKET DATA v2 — Multi-timeframe + Extended Indicators
// Upgrades vs v1:
//   + getBTCData()         — BTC sebagai leading indicator BNB
//   + getAggTrades()       — Baca large trades / whale detection
//   + calcHeikinAshi()     — Candle smoother, lebih reliable
//   + calcDivergence()     — RSI/MACD divergence detection
//   + calcSupportResist()  — Dynamic S/R levels dari price structure
//   + calcMomentum()       — Rate of Change (ROC) multi-period
//   + detectMarketRegime() — Improved: pakai ADX + BB width + slope
//   + detectCandlePattern()— Improved: pin bar filter lebih ketat
// ================================================================
import axios from "axios";

const BINANCE = "https://api.binance.com/api/v3";

async function fetchWithRetry(url: string, params: any, retries = 3) {
  const domains = [
    "https://api-gcp.binance.com",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://data-api.binance.vision"
  ];
  const path = url.substring(url.indexOf("/api/v3"));
  for (let i = 0; i < retries; i++) {
    const domain = domains[i % domains.length];
    try {
      const { data } = await axios.get(`${domain}${path}`, { params, timeout: 8000 });
      return data;
    } catch (e) {
      if (i === retries - 1) {
        // Try one last lookup on GCP endpoint to be extra secure
        try {
          const { data } = await axios.get(`https://api-gcp.binance.com${path}`, { params, timeout: 8000 });
          return data;
        } catch {}
        throw e;
      }
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
}

export async function getKlines(symbol: string, interval: string, limit: number) {
  const data = await fetchWithRetry(`${BINANCE}/klines`, { symbol, interval, limit });
  return data.map((k: any) => ({
    time: k[0], open: +k[1], high: +k[2], low: +k[3],
    close: +k[4], volume: +k[5],
  }));
}

export async function getOrderBook(limit = 20) {
  const data = await fetchWithRetry(`${BINANCE}/depth`, { symbol: "BNBUSDT", limit });
  const bids = data.bids.map((p: string[]) => ({ price: +p[0], qty: +p[1] }));
  const asks = data.asks.map((p: string[]) => ({ price: +p[0], qty: +p[1] }));
  const totalBid = bids.reduce((s: number, b: any) => s + b.price * b.qty, 0);
  const totalAsk = asks.reduce((s: number, a: any) => s + a.price * a.qty, 0);
  // Imbalance di top 5 vs seluruh book — smart money biasanya top of book
  const top5Bid = bids.slice(0, 5).reduce((s: number, b: any) => s + b.price * b.qty, 0);
  const top5Ask = asks.slice(0, 5).reduce((s: number, a: any) => s + a.price * a.qty, 0);
  return {
    bids, asks,
    pressure: totalBid / (totalBid + totalAsk),
    top5Pressure: top5Bid / (top5Bid + top5Ask),
    spread: asks[0].price - bids[0].price,
    spreadPct: ((asks[0].price - bids[0].price) / bids[0].price) * 100,
    bidDepth: totalBid,
    askDepth: totalAsk,
  };
}

export async function getTradeFlow(limit = 500) {
  const data = await fetchWithRetry(`${BINANCE}/trades`, { symbol: "BNBUSDT", limit });
  const buys  = data.filter((t: any) => !t.isBuyerMaker);
  const sells = data.filter((t: any) =>  t.isBuyerMaker);
  const buyQty   = buys.reduce((s: number, t: any)  => s + +t.qty, 0);
  const sellQty  = sells.reduce((s: number, t: any) => s + +t.qty, 0);
  const buyVal   = buys.reduce((s: number, t: any)  => s + +t.qty * +t.price, 0);
  const sellVal  = sells.reduce((s: number, t: any) => s + +t.qty * +t.price, 0);

  // Large trade detection (whale): trades > 5x median size
  const allQtys = data.map((t: any) => +t.qty).sort((a: number, b: number) => a - b);
  const medianQty = allQtys[Math.floor(allQtys.length / 2)];
  const whaleThreshold = medianQty * 5;
  const whaleBuys  = buys.filter((t: any)  => +t.qty > whaleThreshold).reduce((s: number, t: any) => s + +t.qty, 0);
  const whaleSells = sells.filter((t: any) => +t.qty > whaleThreshold).reduce((s: number, t: any) => s + +t.qty, 0);

  const totalQty = buyQty + sellQty;
  const totalVal = buyVal + sellVal;
  return {
    buys: buyQty, sells: sellQty,
    ratio: totalQty > 0 ? buyQty / totalQty : 0.5,
    valueRatio: totalVal > 0 ? buyVal / totalVal : 0.5,
    whaleBuys, whaleSells,
    whaleRatio: (whaleBuys + whaleSells) > 0 ? whaleBuys / (whaleBuys + whaleSells) : 0.5,
    hasWhaleBuy:  whaleBuys  > whaleSells * 2,
    hasWhaleSell: whaleSells > whaleBuys  * 2,
  };
}

export async function get24hStats() {
  const data = await fetchWithRetry(`${BINANCE}/ticker/24hr`, { symbol: "BNBUSDT" });
  return {
    priceChange: +data.priceChange,
    priceChangePct: +data.priceChangePercent,
    volume: +data.volume,
    high: +data.highPrice,
    low: +data.lowPrice,
    weightedAvgPrice: +data.weightedAvgPrice,
  };
}

export async function getBTCData() {
  const [k1m, k5m] = await Promise.all([
    getKlines("BTCUSDT", "1m", 30),
    getKlines("BTCUSDT", "5m", 20),
  ]);
  const c1m = k1m.map((c: any) => c.close);
  const c5m = k5m.map((c: any) => c.close);
  const btcPrice = c1m[c1m.length - 1];
  const btcMom1m = (c1m[c1m.length - 1] - c1m[c1m.length - 5]) / c1m[c1m.length - 5] * 100;
  const btcMom5m = (c5m[c5m.length - 1] - c5m[c5m.length - 3]) / c5m[c5m.length - 3] * 100;
  const btcRsi   = calcRSI(c1m, 14);
  const last10 = c1m.slice(-10);
  const up = last10.filter((v: number, i: number) => i > 0 && v > last10[i-1]).length;
  const btcTrend = up >= 7 ? "BULL" : up <= 3 ? "BEAR" : "NEUTRAL";
  return { btcPrice, btcMom1m, btcMom5m, btcRsi, btcTrend,
    btcPumping: btcMom1m > 0.15,
    btcDumping: btcMom1m < -0.15 };
}

// ── INDICATORS ─────────────────────────────────────────────────

export function calcEMA(prices: number[], period: number) {
  if (prices.length < period) return null;
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}

export function calcRSI(prices: number[], period = 14) {
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

export function calcMACD(prices: number[]) {
  if (prices.length < 35) return null;
  const macdSeries = [];
  for (let i = 26; i <= prices.length; i++) {
    const e12 = calcEMA(prices.slice(0, i), 12);
    const e26 = calcEMA(prices.slice(0, i), 26);
    if (e12 && e26) macdSeries.push(e12 - e26);
  }
  const macdLine    = macdSeries[macdSeries.length - 1];
  const signal      = calcEMA(macdSeries, 9);
  const histogram   = macdLine - (signal || macdLine);
  const prevSignal  = calcEMA(macdSeries.slice(0, -1), 9);
  const prevHist    = macdSeries.length > 1
    ? macdSeries[macdSeries.length - 2] - (prevSignal || 0)
    : histogram;
  const prevMacd = macdSeries[macdSeries.length - 2] || macdLine;
  return {
    macd: macdLine, signal: signal || macdLine, histogram, prevHistogram: prevHist,
    zeroCrossBull: prevMacd < 0 && macdLine >= 0,
    zeroCrossBear: prevMacd > 0 && macdLine <= 0,
    signalCrossBull: prevHist < 0 && histogram >= 0,
    signalCrossBear: prevHist > 0 && histogram <= 0,
  };
}

export function calcBollingerBands(prices: number[], period = 20) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean  = slice.reduce((a, b) => a + b, 0) / period;
  const std   = Math.sqrt(slice.reduce((s, p) => s + (p - mean) ** 2, 0) / period);
  const cur   = prices[prices.length - 1];
  return {
    upper: mean + 2 * std, middle: mean, lower: mean - 2 * std,
    std, width: (4 * std) / mean,
    position: (cur - (mean - 2 * std)) / (4 * std),
    percentB: std > 0 ? (cur - (mean - 2 * std)) / (4 * std) : 0.5,
  };
}

export function calcATR(candles: any[], period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    trs.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prev),
      Math.abs(candles[i].low  - prev),
    ));
  }
  return trs.slice(-period).reduce((a: number, b: number) => a + b, 0) / period;
}

export function calcStochastic(candles: any[], period = 14) {
  if (candles.length < period) return 50;
  const slice = candles.slice(-period);
  const high  = Math.max(...slice.map((c: any) => c.high));
  const low   = Math.min(...slice.map((c: any) => c.low));
  if (high === low) return 50;
  return ((candles[candles.length - 1].close - low) / (high - low)) * 100;
}

export function calcVWAP(candles: any[]) {
  let tpv = 0, vol = 0;
  candles.forEach((c: any) => { const tp = (c.high + c.low + c.close) / 3; tpv += tp * c.volume; vol += c.volume; });
  return vol > 0 ? tpv / vol : null;
}

// NEW: Rate of Change (Momentum)
export function calcROC(prices: number[], period = 10) {
  if (prices.length < period + 1) return 0;
  const prev = prices[prices.length - 1 - period];
  if (prev === 0) return 0;
  return ((prices[prices.length - 1] - prev) / prev) * 100;
}

// NEW: ADX — trend strength (0-100, > 25 = trending)
export function calcADX(candles: any[], period = 14) {
  if (candles.length < period * 2) return null;
  const trueRanges = [], plusDMs = [], minusDMs = [];
  for (let i = 1; i < candles.length; i++) {
    const h  = candles[i].high,   l  = candles[i].low,   c  = candles[i-1].close;
    const ph = candles[i-1].high, pl = candles[i-1].low;
    trueRanges.push(Math.max(h - l, Math.abs(h - c), Math.abs(l - c)));
    const upMove   = h - ph;
    const downMove = pl - l;
    plusDMs.push(upMove   > downMove && upMove   > 0 ? upMove   : 0);
    minusDMs.push(downMove > upMove  && downMove > 0 ? downMove : 0);
  }
  const smoothTR  = trueRanges.slice(-period).reduce((a: number, b: number) => a + b, 0);
  const smoothPDM = plusDMs.slice(-period).reduce((a: number, b: number) => a + b, 0);
  const smoothMDM = minusDMs.slice(-period).reduce((a: number, b: number) => a + b, 0);
  if (smoothTR === 0) return null;
  const plusDI  = (smoothPDM / smoothTR) * 100;
  const minusDI = (smoothMDM / smoothTR) * 100;
  const dx = Math.abs(plusDI - minusDI) / (plusDI + minusDI) * 100;
  return { adx: dx, plusDI, minusDI, trending: dx > 20 };
}

// NEW: Heikin-Ashi candles — smoother, lebih mudah detect trend
export function calcHeikinAshi(candles: any[]) {
  const ha = [];
  for (let i = 0; i < candles.length; i++) {
    const c   = candles[i];
    const haC = (c.open + c.high + c.low + c.close) / 4;
    const haO = i === 0
      ? (c.open + c.close) / 2
      : (ha[i-1].open + ha[i-1].close) / 2;
    const haH = Math.max(c.high, haO, haC);
    const haL = Math.min(c.low,  haO, haC);
    ha.push({ open: haO, high: haH, low: haL, close: haC, volume: c.volume });
  }
  // Trend summary dari 5 HA candles terakhir
  const last5 = ha.slice(-5);
  const bullCount = last5.filter(c => c.close > c.open).length;
  return {
    candles: ha,
    trend:    bullCount >= 4 ? "BULL" : bullCount <= 1 ? "BEAR" : "NEUTRAL",
    strength: Math.abs(bullCount - 2.5) / 2.5, // 0-1
  };
}

// NEW: RSI Divergence detection
export function calcDivergence(candles: any[], rsiPeriod = 14) {
  if (candles.length < 30) return { bull: false, bear: false };
  const prices = candles.map((c: any) => c.close);
  // Build RSI series untuk last 30 candles
  const rsiSeries = [];
  for (let i = rsiPeriod; i < prices.length; i++) {
    rsiSeries.push(calcRSI(prices.slice(0, i + 1), rsiPeriod));
  }
  if (rsiSeries.length < 10) return { bull: false, bear: false };

  const recentPrices = prices.slice(-10);
  const recentRSI    = rsiSeries.slice(-10);

  // Bearish divergence: price higher high, RSI lower high
  const priceHigh1 = Math.max(...recentPrices.slice(0, 5));
  const priceHigh2 = Math.max(...recentPrices.slice(5));
  const rsiHigh1   = Math.max(...recentRSI.slice(0, 5));
  const rsiHigh2   = Math.max(...recentRSI.slice(5));
  const bearDiv    = priceHigh2 > priceHigh1 && rsiHigh2 < rsiHigh1 - 3;

  // Bullish divergence: price lower low, RSI higher low
  const priceLow1 = Math.min(...recentPrices.slice(0, 5));
  const priceLow2 = Math.min(...recentPrices.slice(5));
  const rsiLow1   = Math.min(...recentRSI.slice(0, 5));
  const rsiLow2   = Math.min(...recentRSI.slice(5));
  const bullDiv   = priceLow2 < priceLow1 && rsiLow2 > rsiLow1 + 3;

  return { bull: bullDiv, bear: bearDiv };
}

// NEW: Dynamic Support & Resistance dari pivot points
export function calcSupportResist(candles: any[], lookback = 20) {
  if (candles.length < lookback * 2) return { support: null, resistance: null };
  const slice = candles.slice(-lookback * 2);
  // Pivot high: candle whose high > all neighbors in window 3
  const pivotHighs = [], pivotLows = [];
  for (let i = 3; i < slice.length - 3; i++) {
    const isHigh = slice.slice(i-3, i).every((c: any) => c.high <= slice[i].high)
                && slice.slice(i+1, i+4).every((c: any) => c.high <= slice[i].high);
    const isLow  = slice.slice(i-3, i).every((c: any) => c.low  >= slice[i].low)
                && slice.slice(i+1, i+4).every((c: any) => c.low  >= slice[i].low);
    if (isHigh) pivotHighs.push(slice[i].high);
    if (isLow)  pivotLows.push(slice[i].low);
  }
  const price = candles[candles.length - 1].close;
  const support    = pivotLows.filter(l  => l  < price).sort((a,b) => b - a)[0] || null;
  const resistance = pivotHighs.filter(h => h  > price).sort((a,b) => a - b)[0] || null;
  return {
    support, resistance,
    nearSupport:    support    ? (price - support)    / price < 0.003 : false,
    nearResistance: resistance ? (resistance - price) / price < 0.003 : false,
    distToSupport:    support    ? ((price - support)    / price * 100).toFixed(3) : null,
    distToResistance: resistance ? ((resistance - price) / price * 100).toFixed(3) : null,
  };
}

// IMPROVED: Market regime pakai ADX + multiple filters
export function detectMarketRegime(candles5m: any[]) {
  if (candles5m.length < 30) return "UNKNOWN";
  const closes = candles5m.map((c: any) => c.close);
  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const ema50  = calcEMA(closes, 50);
  const atr    = calcATR(candles5m, 14);
  const bb     = calcBollingerBands(closes, 20);
  const adx    = calcADX(candles5m, 14);
  if (!ema9 || !ema21 || !atr || !bb) return "UNKNOWN";

  const emaSeparation = Math.abs(ema9 - ema21) / atr;
  const adxVal        = adx?.adx || 0;
  const highVol       = bb.width > 0.022;
  const isTrending    = emaSeparation > 0.30 || adxVal > 22;

  if (isTrending && ema9 > ema21 && (!ema50 || ema21 > ema50)) return "BULL_TREND";
  if (isTrending && ema9 < ema21 && (!ema50 || ema21 < ema50)) return "BEAR_TREND";
  if (highVol) return "HIGH_VOL";
  return "RANGING";
}

// IMPROVED: Candle pattern dengan filter ketat + pin bar
export function detectCandlePattern(candles: any[]) {
  if (candles.length < 3) return "UNKNOWN";
  const [c3, c2, c1] = candles.slice(-3);
  const body1  = Math.abs(c1.close - c1.open);
  const range1 = c1.high - c1.low;
  const body2  = Math.abs(c2.close - c2.open);
  if (range1 === 0) return "UNKNOWN";
  const lowerWick = Math.min(c1.open, c1.close) - c1.low;
  const upperWick = c1.high - Math.max(c1.open, c1.close);

  // Doji: body sangat kecil
  if (body1 < range1 * 0.08) return "DOJI";
  // Pin bar bull (Hammer): lower wick > 2.5x body, upper wick tiny
  if (c1.close > c1.open && lowerWick > body1 * 2.5 && upperWick < body1 * 0.4 && body1 > range1 * 0.1)
    return "HAMMER";
  // Pin bar bear (Shooting Star)
  if (c1.close < c1.open && upperWick > body1 * 2.5 && lowerWick < body1 * 0.4 && body1 > range1 * 0.1)
    return "SHOOTING_STAR";
  // Engulfing — require proper sizing
  if (c2.close < c2.open && c1.close > c1.open
      && c1.open  <= c2.close && c1.close >= c2.open
      && body1 > body2 * 1.1)
    return "BULL_ENGULF";
  if (c2.close > c2.open && c1.close < c1.open
      && c1.open  >= c2.close && c1.close <= c2.open
      && body1 > body2 * 1.1)
    return "BEAR_ENGULF";
  // Three soldiers / crows
  if (c3.close > c3.open && c2.close > c2.open && c1.close > c1.open
      && c2.close > c3.close && c1.close > c2.close)
    return "3_GREEN";
  if (c3.close < c3.open && c2.close < c2.open && c1.close < c1.open
      && c2.close < c3.close && c1.close < c2.close)
    return "3_RED";
  // Morning / Evening Star
  if (c3.close < c3.open && Math.abs(c2.close - c2.open) < Math.abs(c3.close - c3.open) * 0.4
      && c1.close > c1.open && c1.close > (c3.open + c3.close) / 2)
    return "MORNING_STAR";
  if (c3.close > c3.open && Math.abs(c2.close - c2.open) < Math.abs(c3.close - c3.open) * 0.4
      && c1.close < c1.open && c1.close < (c3.open + c3.close) / 2)
    return "EVENING_STAR";
  return c1.close > c1.open ? "GREEN" : "RED";
}

// ── MASTER DATA COLLECTOR ─────────────────────────────────────
export async function collectAllMarketData() {
  // Fetch semua data paralel — BTC sekarang ikut
  const [k1m, k5m, k15m, k1h, ob, tf, stats, btc] = await Promise.all([
    getKlines("BNBUSDT", "1m",  120),
    getKlines("BNBUSDT", "5m",  80),
    getKlines("BNBUSDT", "15m", 50),
    getKlines("BNBUSDT", "1h",  24),
    getOrderBook(20),
    getTradeFlow(500),
    get24hStats(),
    getBTCData(),
  ]);

  const c1m  = k1m.map((c: any)  => c.close);
  const c5m  = k5m.map((c: any)  => c.close);
  const c15m = k15m.map((c: any) => c.close);
  const c1h  = k1h.map((c: any)  => c.close);
  const price = c1m[c1m.length - 1];

  const macd  = calcMACD(c1m);
  const bb    = calcBollingerBands(c1m, 20);
  const bb5m  = calcBollingerBands(c5m, 20);
  const adx   = calcADX(k5m, 14);
  const ha    = calcHeikinAshi(k5m.slice(-20));
  const divg  = calcDivergence(k5m.slice(-30));
  const sr    = calcSupportResist(k5m, 20);

  // Volume
  const recentVol = k1m.slice(-5).reduce((s: number, c: any)  => s + c.volume, 0) / 5;
  const avgVol20  = k1m.slice(-20).reduce((s: number, c: any) => s + c.volume, 0) / 20;
  const volumeRatio = avgVol20 > 0 ? recentVol / avgVol20 : 1;

  // Momentum
  const roc5  = calcROC(c1m, 5);
  const roc10 = calcROC(c1m, 10);
  const roc5m = calcROC(c5m, 5);

  // EMA stack 1h untuk macro bias
  const ema9_1h  = calcEMA(c1h, 9);
  const ema21_1h = calcEMA(c1h, 21);
  const macroBias = ema9_1h && ema21_1h
    ? (ema9_1h > ema21_1h ? "BULL" : "BEAR")
    : "NEUTRAL";

  return {
    price,
    // RSI multi-TF
    rsi1m:  calcRSI(c1m,  14),
    rsi5m:  calcRSI(c5m,  14),
    rsi15m: calcRSI(c15m, 14),
    rsi1h:  calcRSI(c1h,  14),
    // MACD
    macd,
    // EMA 1m
    ema9:   calcEMA(c1m, 9),
    ema21:  calcEMA(c1m, 21),
    ema50:  calcEMA(c1m, 50),
    // EMA 5m
    ema9_5m:  calcEMA(c5m, 9),
    ema21_5m: calcEMA(c5m, 21),
    ema50_5m: calcEMA(c5m, 50),
    // EMA 1h (macro)
    ema9_1h, ema21_1h, macroBias,
    // Bands
    bb, bb5m,
    // ATR
    atr:   calcATR(k1m, 14),
    atr5m: calcATR(k5m, 14),
    // Oscillators
    stoch:   calcStochastic(k1m, 14),
    stoch5m: calcStochastic(k5m, 14),
    // VWAP
    vwap: calcVWAP(k1m.slice(-60)),
    // Advanced
    adx, ha, divg, sr,
    roc5, roc10, roc5m,
    // Regime & pattern
    regime:  detectMarketRegime(k5m),
    pattern: detectCandlePattern(k1m),
    // Order flow
    orderBook: ob,
    tradeFlow: tf,
    volumeRatio,
    // BTC
    btc,
    // Stats & raw candles
    stats,
    k1m, k5m, k15m, k1h,
  };
}
