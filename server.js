// Server Aktivasi — aplikasi "Correction Task" (developer: Ardico Rianto)
// Desain: QR SEPENUHNYA OTOMATIS lewat payment gateway RESMI Midtrans
// (Core API QRIS). TIDAK memakai API tidak resmi GoBiz, TIDAK ada
// pending/notify manual lagi — kontrak lama diganti seluruhnya.
//
// Node.js murni, TANPA dependensi eksternal (fetch bawaan Node).
// Data disimpan di server-data.json di folder yang sama (tahan restart).
//
// Kontrak API:
//   POST /api/subscribe {deviceId, package:"standard"|"pro"}
//        -> {orderId, qrUrl, amount, expiry} (+ testMode:true bila kunci belum diset)
//   POST /api/midtrans-webhook — notifikasi Midtrans, verifikasi signature
//        SHA512 dengan server key; hanya settlement/capture yang mengaktifkan
//        paket (30 hari). Signature tidak valid -> ditolak.
//   GET  /api/status?deviceId=XXX -> {plan, activeUntil, lastPayment}
//   GET  /api/activations -> {ok:true, activations:[...]}
//   GET  / -> health server
//
// Env:
//   MIDTRANS_SERVER_KEY    Server Key Midtrans (Sandbox / Production)
//   MIDTRANS_IS_PRODUCTION "true" untuk production, selain itu sandbox
//   PORT                   default 3000
//
// Jalankan:  node server.js
// Tanpa MIDTRANS_SERVER_KEY -> MODE TES: subscribe mengembalikan QR contoh
// yang JELAS berlabel mode tes, supaya alur aplikasi tetap bisa diuji
// end-to-end TANPA uang sungguhan.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");

const PORT = parseInt(process.env.PORT || "3000", 10);
const DATA_FILE = path.join(__dirname, "server-data.json");

const SERVER_KEY = process.env.MIDTRANS_SERVER_KEY || "";
const IS_PRODUCTION = ["true", "1", "yes"].includes(
  (process.env.MIDTRANS_IS_PRODUCTION || "").toLowerCase()
);
// Kunci penanda tangan KHUSUS MODE TES — hanya dipakai bila tidak ada
// Server Key Midtrans sama sekali. Jangan pernah dipakai di production.
const TEST_SIGNING_KEY = "TEST-MODE-KEY-DO-NOT-USE-IN-PRODUCTION";
const SIGNING_KEY = SERVER_KEY || TEST_SIGNING_KEY;
const TEST_MODE = !SERVER_KEY;

const MIDTRANS_BASE = IS_PRODUCTION
  ? "https://api.midtrans.com"
  : "https://api.sandbox.midtrans.com";

const PRICE = { standard: 25000, pro: 50000 };
const PLAN_DAYS = 30; // paket aktif 30 hari sejak lunas
const QR_EXPIRY_MINUTES = 15; // QR berlaku 15 menit

// ---------- Penyimpanan (file JSON) ----------
let db = { orders: {}, activations: [], subscriptions: {} };

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
      if (raw.orders && typeof raw.orders === "object") db.orders = raw.orders;
      if (Array.isArray(raw.activations)) db.activations = raw.activations;
      if (raw.subscriptions && typeof raw.subscriptions === "object") {
        db.subscriptions = raw.subscriptions;
      }
      console.log("[server] Data dimuat dari", DATA_FILE);
    }
  } catch (err) {
    console.error("[server] Gagal memuat data, mulai dengan data kosong:", err.message);
  }
}

function save() {
  try {
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), "utf8");
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error("[server] Gagal menyimpan data:", err.message);
  }
}

// ---------- Helper ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Body bukan JSON yang valid"));
      }
    });
    req.on("error", reject);
  });
}

// order_id unik, maks 50 karakter (batas Midtrans), berisi deviceId+package+waktu.
function makeOrderId(deviceId, pkg) {
  const clean = String(deviceId).replace(/[^A-Za-z0-9]/g, "").slice(0, 20);
  const now = new Date();
  const stamp =
    String(now.getFullYear()).slice(2) +
    String(now.getMonth() + 1).padStart(2, "0") +
    String(now.getDate()).padStart(2, "0") +
    String(now.getHours()).padStart(2, "0") +
    String(now.getMinutes()).padStart(2, "0");
  const rand = crypto.randomBytes(2).toString("hex");
  return `CT-${clean}-${pkg}-${stamp}-${rand}`;
}

function expiryIso(minutes) {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

// Verifikasi signature Midtrans:
// signature_key = SHA512(order_id + status_code + gross_amount + ServerKey)
function verifySignature(body) {
  const { order_id, status_code, gross_amount, signature_key } = body;
  if (!order_id || !status_code || gross_amount === undefined || !signature_key) {
    return false;
  }
  const expected = crypto
    .createHash("sha512")
    .update(`${order_id}${status_code}${String(gross_amount)}${SIGNING_KEY}`)
    .digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature_key));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Midtrans Core API (QRIS) ----------
async function createMidtransQris(orderId, amount) {
  const payload = {
    payment_type: "qris",
    transaction_details: { order_id: orderId, gross_amount: amount },
    qris: { acquirer: "gopay" },
    expiry: { unit: "minute", duration: QR_EXPIRY_MINUTES },
  };
  const res = await fetch(`${MIDTRANS_BASE}/v2/charge`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization:
        "Basic " + Buffer.from(SERVER_KEY + ":").toString("base64"),
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data || data.status_code === "400" || data.status_code === "401") {
    const msg =
      (data && (data.status_message || data.error_message)) ||
      `Midtrans mengembalikan HTTP ${res.status}`;
    throw new Error(msg);
  }
  const actions = Array.isArray(data.actions) ? data.actions : [];
  const qrAction =
    actions.find((a) => a.name === "generate-qr-code") ||
    actions.find((a) => a.name === "deeplink-qr-code");
  return {
    qrUrl: qrAction ? qrAction.url : null,
    expiry: data.expiry_time
      ? new Date(data.expiry_time).toISOString()
      : expiryIso(QR_EXPIRY_MINUTES),
    midtransTransactionId: data.transaction_id || null,
  };
}

// ---------- Handler ----------
async function handle(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") return sendJson(res, 204, {});

  // GET / — health
  if (req.method === "GET" && pathname === "/") {
    return sendJson(res, 200, {
      ok: true,
      service: "correction-task-activation-server",
      version: "0.2.0",
      developer: "Ardico Rianto",
      gateway: "midtrans-qris",
      mode: TEST_MODE ? "test" : IS_PRODUCTION ? "production" : "sandbox",
      midtransConfigured: Boolean(SERVER_KEY),
      uptimeSec: Math.floor(process.uptime()),
      orderCount: Object.keys(db.orders).length,
      activationCount: db.activations.length,
    });
  }

  // POST /api/subscribe — guru memilih paket, server membuat transaksi QRIS
  if (req.method === "POST" && pathname === "/api/subscribe") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    const { deviceId, package: pkg } = body;
    if (!deviceId || typeof deviceId !== "string") {
      return sendJson(res, 400, { ok: false, error: "deviceId wajib diisi" });
    }
    if (pkg !== "standard" && pkg !== "pro") {
      return sendJson(res, 400, { ok: false, error: 'package harus "standard" atau "pro"' });
    }
    const amount = PRICE[pkg];
    const orderId = makeOrderId(deviceId, pkg);

    // Mode production tanpa Server Key = salah konfigurasi, jangan beri QR tes.
    if (IS_PRODUCTION && !SERVER_KEY) {
      return sendJson(res, 500, {
        ok: false,
        error: "MIDTRANS_SERVER_KEY belum diset untuk mode production",
      });
    }

    // MODE TES (tanpa Server Key): QR contoh berlabel jelas, tanpa uang sungguhan.
    if (TEST_MODE) {
      const expiry = expiryIso(QR_EXPIRY_MINUTES);
      db.orders[orderId] = {
        orderId,
        deviceId,
        package: pkg,
        amount,
        status: "pending",
        testMode: true,
        createdAt: new Date().toISOString(),
      };
      save();
      return sendJson(res, 200, {
        orderId,
        qrUrl:
          "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=" +
          encodeURIComponent(`TEST-MODE:${orderId}`),
        amount,
        expiry,
        testMode: true,
        note:
          "MODE TES — QR contoh, BUKAN pembayaran sungguhan. " +
          "Isi MIDTRANS_SERVER_KEY untuk QRIS Midtrans asli.",
        testSigningKey: TEST_SIGNING_KEY,
      });
    }

    // Mode live (sandbox / production): buat transaksi QRIS ke Midtrans.
    let result;
    try {
      result = await createMidtransQris(orderId, amount);
    } catch (err) {
      console.error("[server] Gagal membuat transaksi Midtrans:", err.message);
      return sendJson(res, 502, {
        ok: false,
        error: "Gagal membuat transaksi QRIS di Midtrans: " + err.message,
      });
    }
    if (!result.qrUrl) {
      return sendJson(res, 502, {
        ok: false,
        error: "Midtrans tidak mengembalikan URL QR",
      });
    }
    db.orders[orderId] = {
      orderId,
      deviceId,
      package: pkg,
      amount,
      status: "pending",
      testMode: false,
      midtransTransactionId: result.midtransTransactionId,
      createdAt: new Date().toISOString(),
    };
    save();
    return sendJson(res, 200, {
      orderId,
      qrUrl: result.qrUrl,
      amount,
      expiry: result.expiry,
      testMode: false,
    });
  }

  // POST /api/midtrans-webhook — notifikasi pembayaran dari Midtrans
  if (req.method === "POST" && pathname === "/api/midtrans-webhook") {
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
    // 1. Verifikasi signature — tolak bila tidak valid.
    if (!verifySignature(body)) {
      console.warn("[server] Webhook ditolak: signature tidak valid, order:", body.order_id);
      return sendJson(res, 401, { ok: false, error: "signature tidak valid" });
    }
    const { order_id, transaction_status, fraud_status, gross_amount } = body;
    const order = db.orders[order_id];
    if (!order) {
      return sendJson(res, 404, { ok: false, error: "order tidak dikenal" });
    }
    // 2. Jumlah harus cocok dengan order.
    if (parseFloat(gross_amount) !== order.amount) {
      return sendJson(res, 400, { ok: false, error: "gross_amount tidak cocok dengan order" });
    }
    // 3. Idempotensi: order yang sudah lunas tidak diproses ulang.
    if (order.status === "paid") {
      return sendJson(res, 200, { ok: true, activated: false, note: "order sudah diproses" });
    }
    // 4. Hanya settlement / capture (fraud accept) yang mengaktifkan paket.
    const isPaid =
      transaction_status === "settlement" ||
      (transaction_status === "capture" && fraud_status === "accept");
    if (!isPaid) {
      if (["expire", "cancel", "deny", "failure"].includes(transaction_status)) {
        order.status = transaction_status;
        save();
      }
      return sendJson(res, 200, {
        ok: true,
        activated: false,
        note: `status ${transaction_status} belum mengaktifkan paket`,
      });
    }
    const now = new Date();
    const activeUntil = new Date(
      now.getTime() + PLAN_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
    const tsIso = body.transaction_time
      ? new Date(body.transaction_time.replace(" ", "T")).toISOString()
      : now.toISOString();
    order.status = "paid";
    order.paidAt = tsIso;
    order.activeUntil = activeUntil;
    db.subscriptions[order.deviceId] = {
      plan: order.package,
      activeUntil,
      lastPayment: { amount: order.amount, ts: tsIso, orderId: order_id },
    };
    db.activations.push({
      deviceId: order.deviceId,
      package: order.package,
      amount: order.amount,
      orderId: order_id,
      ts: tsIso,
      activeUntil,
    });
    save();
    console.log(
      `[server] AKTIF: ${order.deviceId} -> ${order.package} sampai ${activeUntil} (order ${order_id})`
    );
    return sendJson(res, 200, {
      ok: true,
      activated: true,
      deviceId: order.deviceId,
      package: order.package,
      activeUntil,
    });
  }

  // GET /api/status?deviceId=XXX — aplikasi guru polling
  if (req.method === "GET" && pathname === "/api/status") {
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      return sendJson(res, 400, { ok: false, error: "deviceId wajib diisi (query ?deviceId=XXX)" });
    }
    const sub = db.subscriptions[deviceId];
    if (!sub || !sub.activeUntil || new Date(sub.activeUntil).getTime() <= Date.now()) {
      return sendJson(res, 200, {
        plan: "free",
        activeUntil: null,
        lastPayment: sub && sub.lastPayment ? sub.lastPayment : null,
      });
    }
    return sendJson(res, 200, {
      plan: sub.plan,
      activeUntil: sub.activeUntil,
      lastPayment: sub.lastPayment || null,
    });
  }

  // GET /api/activations — daftar aktivasi untuk Bos
  if (req.method === "GET" && pathname === "/api/activations") {
    return sendJson(res, 200, { ok: true, activations: db.activations });
  }

  return sendJson(res, 404, { ok: false, error: "Endpoint tidak ditemukan" });
}

// ---------- Start ----------
load();
const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error("[server] Error:", err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "Internal server error" });
  });
});
server.listen(PORT, () => {
  console.log(`[server] Correction Task activation server v0.2.0 jalan di port ${PORT}`);
  console.log(`[server] Gateway: Midtrans QRIS (${IS_PRODUCTION ? "production" : "sandbox"})`);
  console.log(
    `[server] Mode: ${TEST_MODE ? "TES (tanpa MIDTRANS_SERVER_KEY — QR contoh saja)" : "LIVE"}`
  );
  console.log(`[server] Data: ${DATA_FILE}`);
});
