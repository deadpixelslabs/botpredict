# Integrasi V3 — cara menyambung ketiga file

File baru (yang lama tidak saya hapus):
- `marketData.v3.ts` — data + odds live + `buildFeatures()`
- `decisionEngine.v3.ts` — ganti `aiDecision.ts`
- `brain.v3.ts` — ganti brain lama

## Dependency baru
```bash
npm i ethers@6
```

## Loop utama (pseudocode)
```ts
import { collectAllMarketData, getPredictionRound } from "./marketData.v3";
import { decide, computePUp } from "./decisionEngine.v3";
import { getOracleSpotBasis } from "./oracleBasis.v3";
import { getNewsSentiment } from "./sentiment.v3";
import { AdaptiveLearningBrain } from "./brain.v3";

const brain = new AdaptiveLearningBrain();
let bankroll = 1.0; // BNB
let consecutiveLosses = 0;

// PRINSIP: market data diambil LEBIH AWAL (fitur multi-menit, boleh agak lama),
// tapi ODDS di-fetch ULANG PALING AKHIR tepat sebelum decide + kirim tx
// (pool bergerak deras di detik terakhir → snapshot harus se-fresh mungkin).
async function tick() {
  // 1. Cek cepat: sudah masuk window? (read murah)
  let odds = await getPredictionRound(0);
  if (!odds || odds.secondsToLock < 0) return;
  if (odds.secondsToLock > 15) return;               // belum waktunya, tunggu tick berikut

  // 2. Bagian LAMBAT dulu (~1-2s): market data + sentimen + oracle basis.
  const senti = await getNewsSentiment({
    endpoint: process.env.CEREBRAS_API_ENDPOINT,
    model: process.env.CEREBRAS_MODEL,
    apiKey: process.env.CEREBRAS_API_KEY
  });
  
  const basis = await getOracleSpotBasis();
  const md = await collectAllMarketData({
    oracleBasis: basis?.value,
    newsSentiment: senti.sentiment,
  });

  // 3. RE-FETCH ODDS PALING AKHIR — tunggu sampai ~5 detik ke lock, baca sekali lagi.
  while (true) {
    let freshOdds = await getPredictionRound(0);
    if (!freshOdds || freshOdds.secondsToLock < 0) return;     // ketinggalan / cancel
    odds = freshOdds;
    if (odds.secondsToLock <= 5) break;              // masuk window kirim tx
    await new Promise(r => setTimeout(r, 500));
  }

  // 4. Decide pakai snapshot odds TER-FRESH ini (EV dihitung dari pool final).
  const d = decide(md, odds, { bankroll, consecutiveLosses }, brain, {
    flatBet: 0.001, gasCostBnb: 0.00002,
  });

  if (d.cooldownReset) { consecutiveLosses = 0; return; } // cooldown 1 epoch
  if (d.decision === "SKIP") { console.log("SKIP:", d.reasoning); return; }

  // 5. Kirim tx SEGERA — jangan ada await lambat antara decide & submit.
  //    betBull/betBear(odds.epoch, d.betAmount) ...
  pending[odds.epoch] = { features: md.features, regime: md.regime, pRaw: d.pRaw, pUp: d.pUp, decision: d.decision, betBnb: d.betAmount };
}

// Setelah ronde settle (baca lockPrice & closePrice dari kontrak):
function onSettle(epoch, lockPrice, closePrice, payoutTaken, pnl) {
  const s = pending[epoch];
  const priceWentUp = closePrice > lockPrice;
  const won = (s.decision === "BULL" && priceWentUp) || (s.decision === "BEAR" && !priceWentUp);
  consecutiveLosses = won ? 0 : consecutiveLosses + 1;
  bankroll += pnl;
  brain.recordRound({
    epoch, regime: s.regime, features: s.features,
    pRaw: s.pRaw, pUp: s.pUp, decision: s.decision,
    betBnb: s.betBnb, payoutTaken,
    priceWentUp, outcome: won ? "WON" : "LOST", pnl,
  });
}
```

## Catatan penting
- **`pRaw` dan `pUp` sudah direturn dari `decide`** — `decisionEngine.v3.ts` secara internal sudah memanggil `computePUp` dan menyisipkan `pRaw` dan `pUp` ke objek `Decision` balikan.
- **Urutan krusial**: Cek window dulu -> Ambil *market logic* & *sentiment* yang berat -> Poll update odds sampai tepat 5 detik sebelum lock -> Ambil *decision* pakai *odds* ini -> Eksekusi secepat mungkin.
