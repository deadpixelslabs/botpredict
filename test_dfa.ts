import { hybridBrain } from "./server/brain/genius";

async function run() {
  hybridBrain['lastProcessedEpochTimestamp'] = null;

  const prices = [];
  let val = 64000;
  for (let i = 0; i < 30; i++) {
    val += (Math.random() - 0.5) * 50; // Random walk
    prices.push(val);
  }
  const candles = prices.map((p, i) => ({
    open: p - 5, high: p + 10, low: p - 10, close: p, volume: 1000, timestamp: Date.now() - (30 - i) * 300000
  }));
  const instruction = await hybridBrain.analyzeNewEpoch(candles.slice(0, 29), candles[29]);
  console.log("Random walk H:", instruction.meta?.hurst);

  hybridBrain['lastProcessedEpochTimestamp'] = null;

  const trendPrices = [];
  for (let i = 0; i < 30; i++) {
    trendPrices.push(64000 + i * 10);
  }
  const trendCandles = trendPrices.map((p, i) => ({
    open: p - 5, high: p + 10, low: p - 10, close: p, volume: 1000, timestamp: Date.now() - (30 - i) * 300000
  }));
  const trendInstruction = await hybridBrain.analyzeNewEpoch(trendCandles.slice(0, 29), trendCandles[29]);
  console.log("Trend H:", trendInstruction.meta?.hurst);
}

run().catch(console.error);
