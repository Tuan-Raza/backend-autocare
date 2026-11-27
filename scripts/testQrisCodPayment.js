const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const http = require("http");
const { db } = require("../config/database");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/authMiddleware");

// Helper untuk HTTP request lokal ke backend server
function request(method, path, body = null, headers = {}) {
    return new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const options = {
            hostname: "localhost",
            port: process.env.PORT || 5000,
            path,
            method,
            headers: {
                "Content-Type": "application/json",
                ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
                ...headers,
            },
        };

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = data;
                }
                resolve({ statusCode: res.statusCode, body: parsed });
            });
        });

        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function runTestSuite() {
    console.log("==========================================================");
    console.log("   AUTOCARE QRIS & COD PAYMENT INTEGRATION TEST SUITE     ");
    console.log("==========================================================");

    try {
        // [1] Persiapan Data Pengujian di Database
        console.log("\n[1] Mempersiapkan data user, kendaraan, bengkel, jadwal...");

        // Cari atau buat user test
        let [users] = await db.query("SELECT id, nama, email FROM users WHERE role = 'user' LIMIT 1");
        if (users.length === 0) {
            const [insUser] = await db.query(
                "INSERT INTO users (nama, email, password, no_hp, role, status) VALUES ('Customer Test', 'customer.test@autocare.com', 'hashedpass', '08123456789', 'user', 'aktif')"
            );
            users = [{ id: insUser.insertId, nama: "Customer Test", email: "customer.test@autocare.com" }];
        }
        const user = users[0];

        // Cari atau buat admin test
        let [admins] = await db.query("SELECT id, nama, email FROM users WHERE role = 'admin' LIMIT 1");
        if (admins.length === 0) {
            const [insAdmin] = await db.query(
                "INSERT INTO users (nama, email, password, no_hp, role, status) VALUES ('Admin Test', 'admin.test@autocare.com', 'hashedpass', '08123456780', 'admin', 'aktif')"
            );
            admins = [{ id: insAdmin.insertId, nama: "Admin Test", email: "admin.test@autocare.com" }];
        }
        const admin = admins[0];
        const adminToken = jwt.sign(
            { id: admin.id, email: admin.email, nama: admin.nama, role: "admin" },
            JWT_SECRET,
            { expiresIn: "1h" }
        );

        // Cari kendaraan
        let [vehicles] = await db.query("SELECT id FROM kendaraan WHERE user_id = ? LIMIT 1", [user.id]);
        if (vehicles.length === 0) {
            const [insVeh] = await db.query(
                "INSERT INTO kendaraan (user_id, merek, model, nomor_polisi, tahun, kilometer) VALUES (?, 'Toyota', 'Avanza', 'B 1234 XYZ', 2022, 15000)",
                [user.id]
            );
            vehicles = [{ id: insVeh.insertId }];
        }
        const kendaraanId = vehicles[0].id;

        // Cari bengkel
        const [bengkels] = await db.query("SELECT id FROM bengkel WHERE status = 'aktif' LIMIT 1");
        if (bengkels.length === 0) {
            throw new Error("Tidak ada bengkel aktif di database");
        }
        const bengkelId = bengkels[0].id;

        // Cari layanan
        const [layanans] = await db.query("SELECT id, harga FROM layanan WHERE status = 'aktif' LIMIT 2");
        if (layanans.length === 0) {
            throw new Error("Tidak ada layanan aktif di database");
        }

        // [2] Buat Booking 1 untuk Test QRIS
        console.log("\n[2] Membuat booking untuk pengujian QRIS...");
        const createBookingRes1 = await request("POST", "/api/booking", {
            userId: user.id,
            kendaraanId,
            bengkelId,
            tanggalBooking: "2026-11-28",
            jamBooking: "09:00:00",
            layanan: layanans.map((l) => ({ id: l.id, qty: 1 })),
        });

        if (createBookingRes1.statusCode !== 201 || !createBookingRes1.body.success) {
            throw new Error("Gagal membuat booking 1: " + JSON.stringify(createBookingRes1.body));
        }
        const bookingId1 = createBookingRes1.body.data.bookingId;
        console.log(`✓ Booking QRIS dibuat: ID #${bookingId1}`);

        // [3] Submit Bukti QRIS (Upload Base64 Dummy Image)
        console.log("\n[3] Mengunggah bukti pembayaran QRIS (POST /api/payment/manual)...");
        const dummyBase64 = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=";

        const qrisPaymentRes = await request("POST", "/api/payment/manual", {
            bookingId: bookingId1,
            userId: user.id,
            metodePembayaran: "qris",
            buktiTransfer: dummyBase64,
            catatan: "Transfer QRIS dari BCA atas nama Customer Test",
        });

        console.log("Respon Submit QRIS:", qrisPaymentRes.statusCode, qrisPaymentRes.body);
        if (qrisPaymentRes.statusCode !== 201 || !qrisPaymentRes.body.success) {
            throw new Error("Gagal submit bukti QRIS: " + JSON.stringify(qrisPaymentRes.body));
        }

        if (qrisPaymentRes.body.data.statusVerifikasi !== "menunggu_verifikasi") {
            throw new Error("Status verifikasi harus 'menunggu_verifikasi', didapat: " + qrisPaymentRes.body.data.statusVerifikasi);
        }
        if (qrisPaymentRes.body.data.transactionStatus !== "pending") {
            throw new Error("Status transaksi harus 'pending'");
        }
        console.log("✓ Pembayaran QRIS berhasil disimpan dengan status 'menunggu_verifikasi' (PENDING_VERIFICATION)!");
        const orderId1 = qrisPaymentRes.body.data.orderId;
        const paymentId1 = qrisPaymentRes.body.data.paymentId;

        // [4] Pengujian Admin Verifikasi / Setujui QRIS
        console.log("\n[4] Pengujian Admin Menyetujui Pembayaran QRIS (PUT /api/admin/payments/:id/verify)...");
        const adminApproveRes = await request(
            "PUT",
            `/api/admin/payments/${paymentId1}/verify`,
            {
                status_verifikasi: "terverifikasi",
                catatan: "Bukti transfer QRIS valid dan nominal sesuai",
            },
            { Authorization: `Bearer ${adminToken}` }
        );

        console.log("Respon Admin Approve:", adminApproveRes.statusCode, adminApproveRes.body);
        if (adminApproveRes.statusCode !== 200 || !adminApproveRes.body.success) {
            throw new Error("Admin gagal memverifikasi QRIS: " + JSON.stringify(adminApproveRes.body));
        }

        // Cek database setelah approve
        const [checkPayment1] = await db.query("SELECT * FROM payments WHERE id = ?", [paymentId1]);
        if (checkPayment1[0].status_verifikasi !== "terverifikasi" || checkPayment1[0].transaction_status !== "settlement") {
            throw new Error("Database status verifikasi atau transaksi tidak sinkron setelah approve");
        }
        if (!checkPayment1[0].verified_by || !checkPayment1[0].verified_at) {
            throw new Error("Kolom verified_by atau verified_at tidak tercatat");
        }
        const [checkBooking1] = await db.query("SELECT status FROM booking WHERE id = ?", [bookingId1]);
        if (checkBooking1[0].status !== "dikonfirmasi") {
            throw new Error("Status booking harus otomatis berubah jadi 'dikonfirmasi'");
        }
        console.log("✓ Pembayaran QRIS berhasil disetujui (LUNAS/SETTLEMENT), verified_by & verified_at tercatat, status booking menjadi 'dikonfirmasi'!");

        // [5] Buat Booking 2 untuk Test Penolakan QRIS
        console.log("\n[5] Membuat booking 2 untuk pengujian penolakan QRIS...");
        const createBookingRes2 = await request("POST", "/api/booking", {
            userId: user.id,
            kendaraanId,
            bengkelId,
            tanggalBooking: "2026-11-28",
            jamBooking: "10:00:00",
            layanan: [layanans[0]],
        });
        const bookingId2 = createBookingRes2.body.data.bookingId;

        const qrisPaymentRes2 = await request("POST", "/api/payment/manual", {
            bookingId: bookingId2,
            userId: user.id,
            metodePembayaran: "qris",
            buktiTransfer: dummyBase64,
            catatan: "Transfer QRIS",
        });
        const paymentId2 = qrisPaymentRes2.body.data.paymentId;

        // Admin tolak pembayaran QRIS
        console.log("Admin menolak pembayaran QRIS 2...");
        const adminRejectRes = await request(
            "PUT",
            `/api/admin/payments/${paymentId2}/verify`,
            {
                status_verifikasi: "ditolak",
                catatan: "Foto struk buram dan tidak terbaca jelas",
            },
            { Authorization: `Bearer ${adminToken}` }
        );

        if (adminRejectRes.statusCode !== 200 || !adminRejectRes.body.success) {
            throw new Error("Admin gagal menolak pembayaran QRIS 2");
        }

        const [checkPayment2] = await db.query("SELECT * FROM payments WHERE id = ?", [paymentId2]);
        if (checkPayment2[0].status_verifikasi !== "ditolak" || checkPayment2[0].transaction_status !== "deny") {
            throw new Error("Status verifikasi pembayaran harus 'ditolak' dan transaction_status 'deny'");
        }
        if (!checkPayment2[0].catatan_penolakan) {
            throw new Error("Alasan penolakan harus tersimpan di catatan_penolakan");
        }
        console.log("✓ Pembayaran QRIS 2 berhasil ditolak, catatan penolakan tersimpan!");

        // [6] Buat Booking 3 untuk Test COD (Bayar di Tempat)
        console.log("\n[6] Membuat booking 3 untuk pengujian COD (Bayar Langsung di Bengkel)...");
        const createBookingRes3 = await request("POST", "/api/booking", {
            userId: user.id,
            kendaraanId,
            bengkelId,
            tanggalBooking: "2026-11-28",
            jamBooking: "11:00:00",
            layanan: [layanans[0]],
        });
        const bookingId3 = createBookingRes3.body.data.bookingId;

        // Submit COD tanpa bukti pembayaran
        console.log("Memilih metode COD (POST /api/payment/manual)...");
        const codRes = await request("POST", "/api/payment/manual", {
            bookingId: bookingId3,
            userId: user.id,
            metodePembayaran: "cod",
            catatan: "Bayar tunai di tempat saat servis",
        });

        console.log("Respon Submit COD:", codRes.statusCode, codRes.body);
        if (codRes.statusCode !== 201 || !codRes.body.success) {
            throw new Error("Gagal memilih metode COD: " + JSON.stringify(codRes.body));
        }

        if (codRes.body.data.statusVerifikasi !== "belum_dibayar") {
            throw new Error("Status verifikasi COD awal harus 'belum_dibayar' (UNPAID), didapat: " + codRes.body.data.statusVerifikasi);
        }
        console.log("✓ Metode COD berhasil dipilih dengan status 'belum_dibayar' (UNPAID) tanpa bukti transfer!");
        const paymentId3 = codRes.body.data.paymentId;

        // [7] Admin konfirmasi pembayaran COD di bengkel
        console.log("\n[7] Admin mengonfirmasi pembayaran COD saat pelanggan membayar di bengkel...");
        const adminConfirmCodRes = await request(
            "PUT",
            `/api/admin/payments/${paymentId3}/verify`,
            {
                status_verifikasi: "terverifikasi",
                catatan: "Pelanggan telah membayar tunai Rp" + codRes.body.data.grossAmount + " di kasir bengkel",
            },
            { Authorization: `Bearer ${adminToken}` }
        );

        if (adminConfirmCodRes.statusCode !== 200 || !adminConfirmCodRes.body.success) {
            throw new Error("Admin gagal mengonfirmasi COD");
        }

        const [checkPayment3] = await db.query("SELECT * FROM payments WHERE id = ?", [paymentId3]);
        if (checkPayment3[0].status_verifikasi !== "terverifikasi" || checkPayment3[0].transaction_status !== "settlement") {
            throw new Error("Status verifikasi COD setelah bayar harus 'terverifikasi'");
        }
        console.log("✓ Pembayaran COD berhasil dikonfirmasi lunas oleh admin!");

        // [8] Pengujian Filter Tab Admin Payments
        console.log("\n[8] Menguji filter tabs di endpoint Admin Payments (GET /api/admin/payments)...");
        const tabs = ["semua", "menunggu_verifikasi", "belum_dibayar", "terverifikasi", "ditolak"];
        for (const tab of tabs) {
            const tabRes = await request(
                "GET",
                `/api/admin/payments?status=${tab}`,
                null,
                { Authorization: `Bearer ${adminToken}` }
            );
            if (tabRes.statusCode !== 200 || !tabRes.body.success) {
                throw new Error(`Filter tab '${tab}' gagal merespon 200`);
            }
            console.log(`✓ Tab '${tab}': ${tabRes.body.data.length} transaksi`);
        }

        // [9] Pengujian Keamanan (Security Checks)
        console.log("\n[9] Menguji proteksi keamanan...");
        // User biasa tidak boleh akses admin endpoint
        const unauthAdminRes = await request("GET", "/api/admin/payments");
        if (unauthAdminRes.statusCode !== 401 && unauthAdminRes.statusCode !== 403) {
            throw new Error("Endpoint admin harus menolak request tanpa token!");
        }
        console.log("✓ Endpoint admin terlindungi dari akses tanpa autentikasi (401/403)");

        // Deprecated Midtrans endpoint
        const midtransRes = await request("POST", "/api/payment/create", { bookingId: bookingId1, userId: user.id });
        if (midtransRes.statusCode !== 400) {
            throw new Error("Endpoint Midtrans harus menolak request pembuatan snap transaksi!");
        }
        console.log("✓ Endpoint Midtrans dinonaktifkan dengan aman:", midtransRes.body.message);

        console.log("\n==========================================================");
        console.log("🎉 SELURUH PENGUJIAN QRIS & COD PAYMENT SUKSES 100%!");
        console.log("==========================================================");
        process.exit(0);
    } catch (err) {
        console.error("\n❌ TEST SUITE GAGAL:", err);
        process.exit(1);
    }
}

runTestSuite();
