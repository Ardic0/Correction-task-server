# Server Aktivasi — Correction Task

Server kecil Node.js (tanpa dependensi eksternal, hanya modul bawaan Node)
untuk aktivasi paket berbayar aplikasi **Correction Task** (developer: Ardico Rianto)
secara otomatis lewat payment gateway **resmi Midtrans (Core API QRIS)**.

> **Desain baru (24 Nov 2026):** dua QR manual ditiadakan. Tidak ada lagi
> cara pending/notify dan tidak memakai API tidak resmi GoBiz. Satu-satunya
> jalur pembayaran adalah QRIS Midtrans — guru scan QR, bayar, Midtrans
> mengirim webhook, server mengaktifkan paket otomatis.

## Cara kerja

1. Guru memilih paket di aplikasi → aplikasi kirim `POST /api/subscribe`
   `{deviceId, package}`.
2. Server membuat transaksi QRIS ke Midtrans (Standard Rp25.000, Pro Rp50.000)
   dan mengembalikan `{orderId, qrUrl, amount, expiry}`. Aplikasi menampilkan
   QR-nya; QR berlaku 15 menit.
3. Guru membayar lewat QRIS (GoPay, OVO, DANA, m-banking, dll).
4. Midtrans mengirim notifikasi ke `POST /api/midtrans-webhook`. Server
   memverifikasi **signature SHA512** dengan Server Key; hanya status
   `settlement` / `capture` yang mengaktifkan paket **30 hari** untuk deviceId
   itu, lalu mencatat aktivasi.
5. Aplikasi guru polling `GET /api/status?deviceId=XXX` sampai paket aktif.

**Tanpa Server Key Midtrans → MODE TES:** subscribe mengembalikan QR contoh
yang jelas berlabel mode tes (bukan pembayaran sungguhan), supaya alur
aplikasi tetap bisa diuji end-to-end tanpa uang sungguhan.

## Menjalankan lokal

```bash
cd server
node server.js
# Server jalan di http://localhost:3000 (atau port dari env PORT)
```

Tidak perlu `npm install` — tidak ada dependensi. Butuh Node.js 18+.

Mode tes (tanpa kunci):

```bash
node server.js
```

Mode sandbox Midtrans (dengan kunci sandbox):

```bash
MIDTRANS_SERVER_KEY=SB-Mid-server-xxxx node server.js
```

Mode production:

```bash
MIDTRANS_IS_PRODUCTION=true MIDTRANS_SERVER_KEY=Mid-server-xxxx node server.js
```

Data disimpan di `server-data.json` di folder ini (tahan restart; file ini
tidak ikut ke repo — lihat `.gitignore`).

## Endpoint

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/` | Health server: mode (test/sandbox/production), jumlah order & aktivasi |
| POST | `/api/subscribe` | Body: `{deviceId, package: "standard"\|"pro"}` → `{orderId, qrUrl, amount, expiry}` (+ `testMode:true` + `note` bila mode tes). `orderId` unik, berisi deviceId + package + waktu. |
| POST | `/api/midtrans-webhook` | Notifikasi Midtrans. Verifikasi signature SHA512 (`order_id + status_code + gross_amount + ServerKey`). Hanya `settlement`/`capture` yang mengaktifkan paket 30 hari. Signature salah → HTTP 401. |
| GET | `/api/status?deviceId=XXX` | → `{plan: "free"\|"standard"\|"pro", activeUntil: ISO\|null, lastPayment: {amount, ts, orderId}\|null}` |
| GET | `/api/activations` | Daftar aktivasi untuk Bos: `{ok:true, activations:[{deviceId, package, amount, orderId, ts, activeUntil}]}` |

Contoh uji mode tes (simulasi, tanpa uang sungguhan):

```bash
# 1. Guru subscribe Pro
curl -s -X POST http://localhost:3000/api/subscribe \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"guru-001","package":"pro"}'

# 2. Simulasikan webhook lunas (signature = SHA512(order_id + status_code
#    + gross_amount + kunci). Di mode tes kuncinya TEST-MODE-KEY-DO-NOT-USE-IN-PRODUCTION.
#    Hitung dengan node:
SIG=$(node -e "const c=require('crypto');console.log(c.createHash('sha512').update(process.argv[1]+'200'+'50000.00'+'TEST-MODE-KEY-DO-NOT-USE-IN-PRODUCTION').digest('hex'))" 'CT-guru-001-pro-2611241605-ab12')
curl -s -X POST http://localhost:3000/api/midtrans-webhook \
  -H 'Content-Type: application/json' \
  -d "{\"order_id\":\"CT-guru-001-pro-2611241605-ab12\",\"status_code\":\"200\",\"gross_amount\":\"50000.00\",\"signature_key\":\"$SIG\",\"transaction_status\":\"settlement\",\"payment_type\":\"qris\",\"transaction_time\":\"2026-11-24 16:05:00\"}"

# 3. Cek status guru
curl -s 'http://localhost:3000/api/status?deviceId=guru-001'
```

## Daftar akun Midtrans

### 1. Sandbox (gratis, untuk uji)

1. Buka https://dashboard.midtrans.com/register — daftar dengan email Bos.
2. Setelah login, dashboard langsung dalam **mode Sandbox** (ada tulisan
   Sandbox di pojok). Tidak perlu verifikasi usaha untuk sandbox.
3. Ambil **Server Key (Sandbox)**: menu **Settings → Access Keys** →
   salin `Server Key` yang diawali `SB-Mid-server-...`.
4. Isi `MIDTRANS_SERVER_KEY` dengan kunci itu (lihat bagian env di atas),
   lalu uji subscribe — QR yang kembali adalah QRIS Midtrans sandbox.
   Pembayaran sandbox bisa disimulasikan dari dashboard Midtrans.
5. **Notification URL (webhook):** di dashboard, menu **Settings →
   Configuration**, isi **Payment Notification URL** dengan URL publik
   server + `/api/midtrans-webhook`, contoh:
   `https://correction-task-server.onrender.com/api/midtrans-webhook`
   (isi setelah server ter-deploy; di sandbox ini wajib agar Midtrans
   mengirim notifikasi).

### 2. Production (uang sungguhan)

1. Di dashboard yang sama, ajukan **Go Live / aktivasi production**.
   Midtrans meminta verifikasi usaha, antara lain:
   - Identitas pemilik usaha (KTP Bos).
   - Dokumen usaha (NPWP / NIB / SIUP, sesuai jenis usaha — perorangan
     bisa dengan KTP + NPWP).
   - **Rekening pencairan (settlement) atas nama Bos** — uang hasil
     penjualan ditransfer Midtrans ke rekening ini.
   - Website/aplikasi yang sudah berjalan (aplikasi Correction Task).
2. Setelah disetujui, ambil **Server Key (Production)** di
   **Settings → Access Keys** (diawali `Mid-server-...`, tanpa `SB-`),
   lalu set `MIDTRANS_IS_PRODUCTION=true` + `MIDTRANS_SERVER_KEY` tersebut
   di hosting. Jangan pernah membagikan Server Key ke siapa pun dan jangan
   menaruhnya di kode/repo — hanya di environment variable hosting.
3. Biaya Midtrans: ada potongan (MDR) per transaksi QRIS — besaran pastinya
   mengikuti penawaran di dashboard/kontrak Bos (cek di
   https://midtrans.com/id/pricing saat daftar). Server ini sendiri Rp0.

> **Jujur:** saya (Kirana) tidak bisa membuat akun Midtrans untuk Bos.
> Bos yang daftar sendiri; tanpa akun Midtrans + rekening pencairan,
> hanya **mode tes** yang jalan (QR contoh, tanpa uang sungguhan).

## Deploy ke hosting gratis (Render.com, free tier)

1. Buat akun di https://render.com (bisa daftar pakai GitHub/Google).
2. Unggah isi folder `server/` ini ke repo GitHub baru (misalnya
   `correction-task-server`): `server.js`, `package.json`, `README.md`,
   `.gitignore`. (`server-data.json` tidak perlu diunggah.)
3. Di dashboard Render: **New + → Web Service** → pilih repo tadi.
4. Isi: **Name** `correction-task-server`, **Runtime** `Node`,
   **Build Command** kosongkan (tidak ada dependensi),
   **Start Command** `node server.js`, **Instance Type: Free**.
5. **Environment Variables** (menu Environment di service Render):
   - `MIDTRANS_SERVER_KEY` = Server Key sandbox (nanti ganti ke production).
   - `MIDTRANS_IS_PRODUCTION` = `false` dulu (sandbox); `true` bila sudah Go Live.
   - `PORT` tidak perlu diset — Render mengisinya otomatis.
6. Klik **Create Web Service**, tunggu status "Live". URL publiknya seperti
   `https://correction-task-server.onrender.com` — URL inilah yang dipakai
   aplikasi guru (ganti `http://localhost:3000`), dan URL webhook-nya
   `https://correction-task-server.onrender.com/api/midtrans-webhook`
   dimasukkan ke Settings → Configuration di dashboard Midtrans.
7. Uji: `curl https://correction-task-server.onrender.com/`

Catatan free tier Render:
- **Gratis $0/bulan**, tapi service "tidur" setelah ~15 menit tanpa traffic;
  request pertama setelah tidur bisa lambat (~30–60 detik) lalu normal.
- Data `server-data.json` **tidak permanen** di Render free: kalau service
  restart/deploy ulang, file bisa hilang. Untuk produksi, nanti perlu
  database persisten (misalnya Render Postgres free tier). Untuk uji awal,
  file JSON sudah cukup.

Alternatif: **Railway** (railway.app, ada kredit gratis awal lalu berbayar
per pemakaian) atau **Fly.io** (perlu `flyctl` + kartu kredit untuk
verifikasi). Render paling sederhana untuk Bos.

## Biaya

- Server ini: **Rp0** (tanpa dependensi berbayar).
- Render free tier: **$0/bulan** (dengan catatan tidur & data tidak permanen).
- Midtrans sandbox: **gratis**. Production: potongan per transaksi QRIS
  sesuai pricing Midtrans saat Bos daftar; tidak ada biaya bulanan server
  dari Midtrans.

## Yang masih butuh Bos

- Daftar akun Midtrans (sandbox dulu, gratis) dan kirim **Server Key
  sandbox** kalau mau Kirana yang menguji QRIS asli; atau Bos yang isi
  sendiri di Render.
- Untuk production: verifikasi usaha + **rekening pencairan atas nama Bos**.
  Tanpa itu, hanya mode tes yang jalan.
- URL publik server setelah deploy → dimasukkan ke aplikasi guru dan ke
  Notification URL di dashboard Midtrans.
- Aplikasi pendamping pembaca notifikasi GoPay **tidak lagi diperlukan** —
  desain baru ini menggantikannya sepenuhnya.
