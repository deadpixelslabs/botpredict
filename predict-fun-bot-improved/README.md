# PredictFun Quant — eksekusi dan validasi

Bot BTC Up/Down 5 menit. Runtime aktif: `server.ts` → `server/arbitrage-engine.ts` → `LatencyDetector` / `BinanceFeed` / `predictClient`. Modul brain lama tetap disertakan untuk referensi.

**Mulai dengan paper trading.** Perubahan memperbaiki data, eksekusi, dan akuntansi; profitabilitas strategi belum terbukti. Confidence adalah skor kualitas heuristik, bukan probabilitas menang terkalibrasi. Model fair price memakai asumsi volatilitas tetap; harga Binance dapat berbeda dari oracle Predict.

## Kredensial

ZIP asli mengandung private key dan API key. Ganti semua kredensial tersebut dan pindahkan dana dari wallet yang private key-nya pernah dibagikan. Paket ini tidak memakai kredensial lama. Isi kredensial baru hanya pada `.env` mesin sendiri; jangan membagikannya.

## Menjalankan

Gunakan Node.js 22 atau lebih baru:

```bash
npm ci
cp .env.example .env
npm run dev
```

Windows PowerShell: `Copy-Item .env.example .env`. Buka `http://127.0.0.1:3000`. Isi `PREDICT_FUN_API_KEY` baru untuk data Predict, termasuk dalam mode paper. Tanpa data valid bot melewatkan entry. Private key tidak dibutuhkan untuk paper.

Produksi: `npm run build`, lalu `npm start` dari direktori proyek. Folder `public` dan `data` harus tersedia; simpan `data` pada disk persisten. HOST bawaan localhost. Untuk binding eksternal, set `HOST=0.0.0.0` dan `BOT_CONTROL_TOKEN` acak minimal 24 karakter. Dashboard meminta token untuk perubahan mode. Gunakan HTTPS dan kontrol akses hosting untuk akses jaringan.

## Perbaikan

- Quote kedaluwarsa, malformed, crossed, replayed, atau market tertutup tidak dipakai untuk entry. Kegagalan API tidak menghasilkan harga buatan.
- Confidence paksa 99% dan bypass edge saat spike dihapus. Entry memeriksa biaya, slippage, depth, batas harga, kualitas sinyal, umur quote, dan anggaran rugi.
- Orderbook Predict diproses lewat WebSocket dengan heartbeat, reconnect, dan invalidasi market; REST menjadi fallback. Set `PREDICT_STREAMING=false` untuk REST saja.
- Koneksi HTTP dipakai ulang, metadata dicache, loop tidak tumpang tindih, momentum memakai binary search dan memori terbatas. Feed pembanding hanya Binance Spot.
- Ukuran order dan tick harga memakai integer 18 desimal. Order kecil tidak dibesarkan otomatis. Salt kriptografis dan expiry pendek membatasi signature lama.
- Accepted belum berarti filled. Timeout tidak dikirim ulang secara buta. Status tidak pasti tetap memblokir entry sampai rekonsiliasi.
- Partial sale mempertahankan cost basis dan hasil penjualan. Dust disimpan sampai settlement; posisi wallet di luar bot tidak dijual otomatis.
- Paper/live melekat pada tiap trade. Ledger baru: `data/verified_arbitrage_trades.json`. Risiko dibangun ulang dari ledger saat restart; file rusak/gagal disimpan menghentikan entry.
- Hasil ronde memakai resolusi Predict, bukan tebakan Binance. PnL tetap estimasi sampai cocok dengan eksekusi, biaya, dan receipt sebenarnya.
- Konfigurasi divalidasi, kredensial hanya di environment, dan API publik tidak mengembalikan key. Token dan pemeriksaan origin melindungi kontrol bot.

## Setelan awal untuk evaluasi

| Parameter | Nilai |
| --- | --- |
| Mode | Paper |
| Batas per entry | 1 USDT |
| Anggaran rugi harian | 5 USDT |
| Minimum model edge setelah estimasi biaya | 0,03 |
| Minimum skor kualitas | 0,65 |
| Maksimum percobaan order | 30/jam |
| Cooldown | 1.000 ms |
| Slippage limit | 0,01 USDT/share |
| REST refresh cadangan | minimal 1.000 ms |
| Maksimum umur quote | 2.500 ms |

Parameter ini belum dioptimasi terhadap data masa depan. Edge adalah margin probabilitas, bukan janji return. Slippage maksimum melalui API adalah 0,02 USDT/share. Risiko harian memakai tanggal UTC (reset 07.00 WIB). Stop-loss tidak menjamin exit saat tidak ada pembeli.

## Tes dan laporan paper

```bash
npm run check
npm run paper:report
```

Laporan membaca ledger tanpa jaringan dan menampilkan mode, fill/cancel/pending, PnL estimasi, profit factor, serta realized drawdown. Path opsional: `npm run paper:report -- data/verified_arbitrage_trades.json`.

Paper memakai limit terburuk yang diizinkan dan depth yang terlihat; antrean, adverse selection, dan matching latency belum disimulasikan lengkap. Sampel beberapa kondisi pasar dan bandingkan dengan settlement sebenarnya. Profit paper belum membuktikan profit live.

Arsip `arbitrage_trades.json` berisi 500 record tanpa mode eksplisit dan tidak menjadi bukti performa live. File eksperimen root `test-*.ts` tidak termasuk `npm test`; beberapa memanggil API bila dijalankan manual. Tes otomatis baru memakai data sintetis/mock. Tidak ada transaksi sungguhan selama pengujian ini. Smoke test tanpa pasar: set `BOT_OFFLINE=true` sebelum menjalankan server.

## Live dan pemulihan

Live memerlukan `ENABLE_LIVE_TRADING=true`, `BOT_CONTROL_TOKEN` minimal 24 karakter, private key baru, API key baru, dan `PREDICT_ACCOUNT_ADDRESS` untuk smart account atau `WALLET_ADDRESS` untuk EOA. Approvals exchange harus sudah tersedia. Bot tidak membuat approvals atau redeem otomatis. Pergantian mode ditolak bila meninggalkan posisi pada mode lain.

Jika muncul `RECONCILE`, periksa hash order di Predict serta saldo/receipt wallet. Jangan menghapus ledger atau menganggap timeout zero fill. Proses mati sebelum hash tersimpan memerlukan rekonsiliasi manual; entry baru ditahan. Backup ledger sebelum koreksi manual.

`/orders/remove` menghapus dari orderbook, tetapi tidak membatalkan signature on-chain. Konfirmasi status dan expiry tetap diperlukan. Fill, fee, dan PnL masih dapat berupa estimasi konservatif; gas, settlement receipt, serta redeem belum direkonsiliasi otomatis. Tidak ada jaminan waktu cancel/sell.

## Rujukan

- [Predict API](https://dev.predict.fun/)
- [Orderbook dan sisi NO](https://dev.predict.fun/doc-685654)
- [Predict SDK](https://github.com/PredictDotFun/sdk)
- [Predict WebSocket](https://dev.predict.fun/general-information-1915499m0)

Tidak ada benchmark latensi jaringan atau backtest out-of-sample pada tick asli dalam paket ini. Peningkatan efisiensi lokal tidak membuktikan keunggulan terhadap market maker.
