// ================================================================
// ORACLE-SPOT BASIS v3 — EDGE STRUKTURAL SEJATI
// ----------------------------------------------------------------
// Kenapa ini edge terkuat di Predict.fun prediction:
//   • Ronde di-settle pakai harga ORACLE Chainlink (lock & close),
//     BUKAN harga Binance spot.
//   • Chainlink update dengan JEDA (deviation threshold / heartbeat),
//     jadi harga oracle sering "tertinggal" dari Binance spot real-time.
//   • Kalau saat ini spot Binance sudah di ATAS harga oracle, oracle
//     hampir pasti akan "mengejar" naik di update berikutnya → close
//     cenderung > lock → BULL. Begitu pula sebaliknya.
//   • Ini bukan tebakan arah — ini melihat pergerakan oracle yang sudah
//     "dalam perjalanan". Inilah yang dieksploitasi bot-bot profitable.
//
// Output dipakai sebagai fitur numerik di brain.v3.ts (bukan narasi LLM!).
// Tanda: + = bullish (oracle akan naik), − = bearish.
// ================================================================
import axios from "axios";
import { ethers } from "ethers";

const BSC_RPC_URLS = [
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed1.defibit.io",
  "https://bsc-dataseed1.binance.org",
  "https://bsc-dataseed2.defibit.io",
];
// Samakan dengan PREDICTION_ADDR di marketData.v3.ts
const PREDICTION_ADDR = "0xd172f3fbabe763ee8e52d8b32421574236da6057";
const BINANCE = "https://api.binance.com/api/v3";

const PRED_ABI = ["function oracle() view returns (address)"];
const AGG_ABI = [
  "function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)",
  "function decimals() view returns (uint8)" 
];

let _provider: ethers.JsonRpcProvider | null = null;
let _oracleAddr: string | null = null;
let _decimals: number | undefined;

export interface OracleBasis {
  oraclePrice: number;
  spotPrice: number;
  basisPct: number;     // (spot − oracle) / oracle × 100
  oracleAgeSec: number; // detik sejak update terakhir oracle (makin tua, basis makin "belum dicerna")
  value: number;        // fitur ber-sign [-1,1]; + = oracle akan naik (bullish)
}

/**
 * Baca harga oracle Chainlink yang dipakai kontrak prediksi, bandingkan
 * dengan Binance spot real-time. Panggil MEPET lock bersama getPredictionRound().
 * Aman: error → null (fitur tidak di-add, model jalan tanpa basis).
 */
export async function getOracleSpotBasis(): Promise<OracleBasis | null> {
  let lastErr = null;
  for (const rpc of BSC_RPC_URLS) {
    try {
      if (!_provider || lastErr) { // Recreate provider if there was an error
        _provider = new ethers.JsonRpcProvider(rpc, undefined, { staticNetwork: true, batchMaxCount: 1 });
      }

      // Cache alamat oracle & decimals (jarang berubah).
      if (!_oracleAddr) {
        // Chainlink BTC/USD on BSC
        _oracleAddr = "0x264990fbd0A4796A3E3d8E37C4d5F87a3aCa5Ebf";
      }
      const agg = new ethers.Contract(_oracleAddr!, AGG_ABI, _provider);
      if (_decimals === undefined) _decimals = Number(await agg.decimals());

      const [rd, spotRes] = await Promise.all([
        agg.latestRoundData(),
        axios.get(`${BINANCE}/ticker/price`, { params: { symbol: "BTCUSDT" }, timeout: 5000 }),
      ]);

      const oraclePrice = Number(rd.answer) / 10 ** _decimals;
      const updatedAt = Number(rd.updatedAt);
      const oracleAgeSec = Math.floor(Date.now() / 1000) - updatedAt;
      const spotPrice = Number(spotRes.data.price);

      if (!(oraclePrice > 0) || !(spotPrice > 0)) return null;

      const basisPct = ((spotPrice - oraclePrice) / oraclePrice) * 100;
      // 0.4% basis is near the 0.5% deviation threshold, which guarantees update pressure
      const value = Math.max(-1, Math.min(1, basisPct / 0.4));
      
      lastErr = null; // reset if successful
      return { oraclePrice, spotPrice, basisPct, oracleAgeSec, value };
    } catch (e) {
      lastErr = e;
      continue;
    }
  }
  console.error("[oracleBasis] failed across all RPCs:", (lastErr as Error)?.message);
  return null;
}
