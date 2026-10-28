# Import dan mulai live

1. Buka https://vercel.com/drop dan unggah ZIP proyek ini. Pilih team dan nama project. Source mempunyai build/API/daemon sendiri; bukan sekadar dashboard statis.
2. Pada project Vercel, hubungkan **Blob private**. Pastikan `BLOB_STORE_ID` tersedia pada Production.
3. Tambahkan environment **Production**:
   - `BOT_CONTROL_TOKEN`: password operator acak minimal 24 karakter.
   - `ENABLE_LIVE_TRADING=true`: mengizinkan tombol Mulai Live. `false` menjadi kill switch server.
4. Redeploy **Production** setelah pengaturan berubah. Daemon tidak berjalan pada Preview. Jangan atur Root Directory ke subfolder.
5. Buka URL aplikasi dan login dengan password operator. Isi menu:
   - `PREDICT_FUN_API_KEY`
   - `WALLET_PRIVATE_KEY`
   - `PREDICT_ACCOUNT_ADDRESS`: deposit address smart account Predict; kosongkan bila memakai EOA.
6. Klik **Simpan & validasi**, tunggu worker membaca kredensial, lalu klik **Mulai Live**. Status key tersimpan tidak berarti order sudah berhasil.

`LIVE ONLINE` membutuhkan heartbeat, autentikasi untuk wallet/key yang sama, saldo dan quote segar, serta lease valid. Jika status belum siap, periksa indikator dan log. Wallet tetap memerlukan saldo dan approvals exchange yang benar. Bot tidak melakukan approval, redeem, atau test trade otomatis.

Key disimpan terenkripsi dan tidak dikembalikan API. Gunakan wallet/key baru; jangan pakai kredensial yang ada dalam ZIP awal. Jangan kirim private key melalui chat. Pergantian kredensial ditolak selama ada order/posisi live yang belum selesai.

Vercel Daemons masih Public Beta. Periksa Usage: Hobby dibatasi 5 Active CPU-hours/bulan; kuota/billing Blob terpisah. Data lama tanpa mode tidak dianggap bukti profit. Profitabilitas belum dibuktikan.

Setelah deploy, buka `/api/health` pada domain aplikasi: hasilnya harus JSON HTTP 200. Jika muncul `FUNCTION_INVOCATION_FAILED`, periksa deployment API sebelum mencoba token. Jika health berhasil tetapi daemon belum mempunyai heartbeat, bot belum berjalan. Status koneksi akun nyata dan transaksi mainnet harus diperiksa terpisah; lihat `VALIDATION.md`.
