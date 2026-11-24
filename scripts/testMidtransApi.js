require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { db } = require("../config/database");
const crypto = require("crypto");
const bookingController = require("../controllers/bookingController");
const paymentController = require("../controllers/paymentController");

function createMockRes() {
    return {
        statusCode: 200,
        jsonBody: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.jsonBody = data;
            return this;
        },
    };
}

async function runMidtransTests() {
    console.log("=================================================");
    console.log("AUTOCARE MIDTRANS PAYMENT GATEWAY - E2E TEST SUITE");
    console.log("=================================================");

    try {
        // [1] Load Test User, Vehicle, Bengkel, Layanan
        console.log("\n[1] Memuat data uji dari database MySQL...");
        const [users] = await db.query("SELECT id, nama, email, no_hp FROM users WHERE role = 'user' LIMIT 1");
        const [vehicles] = await db.query("SELECT id, merek, model, nomor_polisi FROM kendaraan LIMIT 1");
        const [workshops] = await db.query("SELECT id, nama_bengkel FROM bengkel LIMIT 1");
        const [services] = await db.query("SELECT id, nama_layanan, harga FROM layanan LIMIT 2");

        if (users.length === 0 || vehicles.length === 0 || workshops.length === 0 || services.length === 0) {
            throw new Error("Data uji belum lengkap di database (user/kendaraan/bengkel/layanan)");
        }

        const user = users[0];
        const vehicle = vehicles[0];
        const workshop = workshops[0];

        console.log(`✓ Data uji siap:`);
        console.log(`  - Pelanggan : ${user.nama} (ID: ${user.id}, ${user.email})`);
        console.log(`  - Kendaraan : ${vehicle.merek} ${vehicle.model} (${vehicle.nomor_polisi})`);
        console.log(`  - Bengkel   : ${workshop.nama_bengkel} (ID: ${workshop.id})`);
        console.log(`  - Layanan   : ${services.map(s => `${s.nama_layanan} (Rp ${Number(s.harga).toLocaleString('id-ID')})`).join(', ')}`);

        // [2] Test Create Booking
        console.log("\n[2] Menguji Pembuatan Booking (POST /api/booking)...");
        const todayStr = new Date().toISOString().split("T")[0];
        const bookingReq = {
            body: {
                userId: user.id,
                kendaraanId: vehicle.id,
                bengkelId: workshop.id,
                tanggalBooking: todayStr,
                jamBooking: "10:00",
                layanan: services.map(s => ({ id: s.id, qty: 1 })),
                keluhan: "Uji coba transaksi Midtrans Snap",
            },
            user: { id: user.id },
        };
        const bookingRes = createMockRes();
        await bookingController.createBooking(bookingReq, bookingRes);

        if (!bookingRes.jsonBody?.success) {
            throw new Error("Gagal membuat booking: " + JSON.stringify(bookingRes.jsonBody));
        }

        const bookingData = bookingRes.jsonBody.data;
        const bookingId = bookingData.bookingId;
        const kodeBooking = bookingData.kodeBooking;
        const totalHarga = bookingData.totalHarga;
        console.log(`✓ Booking berhasil disimpan di MySQL!`);
        console.log(`  - Booking ID   : ${bookingId}`);
        console.log(`  - Kode Booking : ${kodeBooking}`);
        console.log(`  - Total Harga  : Rp ${Number(totalHarga).toLocaleString('id-ID')}`);

        // [3] Test Create Midtrans Snap Transaction
        console.log("\n[3] Menguji Pembuatan Transaksi Midtrans Snap (POST /api/payment/create)...");
        const paymentReq = {
            body: {
                bookingId: bookingId,
                userId: user.id,
            },
            user: { id: user.id },
        };
        const paymentRes = createMockRes();
        await paymentController.createPayment(paymentReq, paymentRes);

        if (!paymentRes.jsonBody?.success) {
            throw new Error("Gagal membuat transaksi Midtrans Snap: " + JSON.stringify(paymentRes.jsonBody));
        }

        const snapData = paymentRes.jsonBody.data;
        const orderId = snapData.orderId;
        const snapToken = snapData.snapToken;
        const redirectUrl = snapData.redirectUrl;

        console.log(`✓ Transaksi Midtrans Snap berhasil dibuat melalui Midtrans Sandbox API!`);
        console.log(`  - Order ID     : ${orderId}`);
        console.log(`  - Snap Token   : ${snapToken}`);
        console.log(`  - Redirect URL : ${redirectUrl}`);
        console.log(`  - Gross Amount : Rp ${Number(snapData.grossAmount).toLocaleString('id-ID')}`);

        // Verifikasi tabel payments di database
        const [payRows] = await db.query("SELECT * FROM payments WHERE order_id = ?", [orderId]);
        if (payRows.length === 0) {
            throw new Error("Data pembayaran belum tercatat di tabel payments!");
        }
        console.log(`✓ Record database tersimpan dengan status '${payRows[0].transaction_status}' & verifikasi '${payRows[0].status_verifikasi}'.`);

        // [4] Test Midtrans Webhook Notification with SHA-512 Signature
        console.log("\n[4] Menguji Webhook Notification Midtrans dengan Enkripsi SHA-512...");
        const serverKey = process.env.MIDTRANS_SERVER_KEY;
        const statusCode = "200";
        const grossAmountStr = `${snapData.grossAmount}.00`;
        const signatureKey = crypto
            .createHash("sha512")
            .update(orderId + statusCode + grossAmountStr + serverKey)
            .digest("hex");

        const notificationReq = {
            body: {
                order_id: orderId,
                status_code: statusCode,
                gross_amount: grossAmountStr,
                signature_key: signatureKey,
                transaction_status: "settlement",
                payment_type: "bank_transfer",
                transaction_id: `tx-midtrans-${Date.now()}`,
                transaction_time: new Date().toISOString(),
                settlement_time: new Date().toISOString(),
            },
        };
        const notifRes = createMockRes();
        await paymentController.paymentNotification(notificationReq, notifRes);

        if (!notifRes.jsonBody?.success) {
            throw new Error("Gagal memproses notifikasi webhook: " + JSON.stringify(notifRes.jsonBody));
        }
        console.log(`✓ Signature SHA-512 terverifikasi aman & valid!`);
        console.log(`✓ Notifikasi Webhook settlement berhasil diproses: "${notifRes.jsonBody.message}"`);

        // [5] Verifikasi Database Pasca Settlement
        console.log("\n[5] Memverifikasi Sinkronisasi Database Pasca Pembayaran...");
        const [updatedPayRows] = await db.query("SELECT * FROM payments WHERE order_id = ?", [orderId]);
        const [updatedBookRows] = await db.query("SELECT * FROM booking WHERE id = ?", [bookingId]);

        const payStatus = updatedPayRows[0].transaction_status;
        const payVerif = updatedPayRows[0].status_verifikasi;
        const bookStatus = updatedBookRows[0].status;

        console.log(`  - Status Pembayaran : ${payStatus} (Target: settlement)`);
        console.log(`  - Status Verifikasi : ${payVerif} (Target: terverifikasi)`);
        console.log(`  - Status Booking    : ${bookStatus} (Target: dikonfirmasi)`);

        if (payStatus !== "settlement" || bookStatus !== "dikonfirmasi") {
            throw new Error("Sinkronisasi status database tidak sesuai target!");
        }
        console.log(`✓ Database AutoCare telah terupdate: PEMBAYARAN LUNAS & BOOKING TERKONFIRMASI!`);

        // [6] Test GET /api/payment/booking/:bookingId
        console.log("\n[6] Menguji Endpoint Status Pembayaran (GET /api/payment/booking/:bookingId)...");
        const getPayReq = {
            params: { bookingId },
            user: { id: user.id },
        };
        const getPayRes = createMockRes();
        await paymentController.getPaymentByBookingId(getPayReq, getPayRes);

        if (!getPayRes.jsonBody?.success) {
            throw new Error("Gagal mengambil data pembayaran booking: " + JSON.stringify(getPayRes.jsonBody));
        }

        const resData = getPayRes.jsonBody.data;
        console.log(`✓ Endpoint pembayaran mengembalikan data real-time:`);
        console.log(`  - Kode Booking     : ${resData.booking?.kode_booking}`);
        console.log(`  - Bengkel          : ${resData.booking?.nama_bengkel}`);
        console.log(`  - Total Tagihan    : Rp ${Number(resData.booking?.total_harga).toLocaleString('id-ID')}`);
        console.log(`  - Status Transaksi : ${resData.payment?.transaction_status}`);
        console.log(`  - Status Verifikasi: ${resData.payment?.status_verifikasi}`);

        console.log("\n=================================================");
        console.log("🎉 SELURUH PENGUJIAN INTEGRASI MIDTRANS BERHASIL 100%!");
        console.log("=================================================\n");
        process.exit(0);
    } catch (err) {
        console.error("\n❌ PENGUJIAN GAGAL:", err);
        process.exit(1);
    }
}

runMidtransTests();
