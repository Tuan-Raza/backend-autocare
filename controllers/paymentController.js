const { db } = require("../config/database");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const midtransClient = require("midtrans-client");

// =====================================================
// MIDTRANS SNAP CONFIG
// =====================================================
const snap = new midtransClient.Snap({
    isProduction: process.env.MIDTRANS_IS_PRODUCTION === "true",
    serverKey: process.env.MIDTRANS_SERVER_KEY || "",
    clientKey: process.env.MIDTRANS_CLIENT_KEY || "",
});

// Helper untuk sync status transaksi Midtrans langsung ke DB
async function syncMidtransTransactionStatus(orderId, currentPaymentId, bookingId) {
    if (!orderId || !process.env.MIDTRANS_SERVER_KEY) return null;
    try {
        const statusResponse = await snap.transaction.status(orderId);
        if (!statusResponse || !statusResponse.transaction_status) return null;

        const {
            transaction_status,
            fraud_status,
            payment_type,
            transaction_id,
            transaction_time,
            settlement_time,
        } = statusResponse;

        let newTransactionStatus = transaction_status;
        let newStatusVerifikasi = "menunggu_verifikasi";
        let shouldConfirmBooking = false;
        let shouldCancelBooking = false;

        if (transaction_status === "capture") {
            if (fraud_status === "accept") {
                newTransactionStatus = "settlement";
                newStatusVerifikasi = "diterima";
                shouldConfirmBooking = true;
            } else if (fraud_status === "challenge") {
                newTransactionStatus = "challenge";
                newStatusVerifikasi = "menunggu_verifikasi";
            }
        } else if (transaction_status === "settlement") {
            newTransactionStatus = "settlement";
            newStatusVerifikasi = "diterima";
            shouldConfirmBooking = true;
        } else if (transaction_status === "pending") {
            newTransactionStatus = "pending";
            newStatusVerifikasi = "menunggu_verifikasi";
        } else if (
            transaction_status === "deny" ||
            transaction_status === "cancel" ||
            transaction_status === "expire"
        ) {
            newTransactionStatus = transaction_status;
            newStatusVerifikasi = "ditolak";
            shouldCancelBooking = true;
        }

        await db.query(
            `UPDATE payments
             SET transaction_status = ?,
                 status_verifikasi = ?,
                 payment_type = COALESCE(?, payment_type),
                 transaction_id = COALESCE(?, transaction_id),
                 transaction_time = COALESCE(?, transaction_time),
                 settlement_time = COALESCE(?, settlement_time),
                 updated_at = NOW()
             WHERE id = ?`,
            [
                newTransactionStatus,
                newStatusVerifikasi,
                payment_type || null,
                transaction_id || null,
                transaction_time || null,
                settlement_time || (newTransactionStatus === "settlement" ? new Date() : null),
                currentPaymentId,
            ]
        );

        if (shouldConfirmBooking && bookingId) {
            await db.query(
                "UPDATE booking SET status = 'dikonfirmasi', updated_at = NOW() WHERE id = ?",
                [bookingId]
            );
        } else if (shouldCancelBooking && bookingId) {
            await db.query(
                "UPDATE booking SET status = 'dibatalkan', updated_at = NOW() WHERE id = ? AND status = 'menunggu'",
                [bookingId]
            );
        }

        return {
            transaction_status: newTransactionStatus,
            status_verifikasi: newStatusVerifikasi,
            payment_type,
            transaction_id,
        };
    } catch (err) {
        // Jika 404 dari Midtrans (transaksi belum pernah dibuat di Midtrans), abaikan
        return null;
    }
}

// =====================================================
// GET PAYMENT BY BOOKING ID
// GET /api/payment/booking/:bookingId
// =====================================================
const getPaymentByBookingId = async (req, res) => {
    try {
        const { bookingId } = req.params;

        if (!bookingId) {
            return res.status(400).json({
                success: false,
                message: "Booking ID wajib disertakan",
            });
        }

        const [bookingRows] = await db.query(
            `SELECT
                b.*,
                u.nama AS user_nama,
                u.email AS user_email,
                u.no_hp AS user_no_hp,
                CONCAT(COALESCE(k.merek, ''), ' ', COALESCE(k.model, '')) AS nama_kendaraan,
                k.merek,
                k.model,
                k.nomor_polisi,
                w.nama_bengkel,
                w.alamat AS alamat_bengkel,
                w.no_hp AS telp_bengkel
             FROM booking b
             LEFT JOIN users u ON b.user_id = u.id
             LEFT JOIN kendaraan k ON b.kendaraan_id = k.id
             LEFT JOIN bengkel w ON b.bengkel_id = w.id
             WHERE b.id = ?
             LIMIT 1`,
            [bookingId]
        );

        if (bookingRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data booking tidak ditemukan",
            });
        }

        const booking = bookingRows[0];

        // Ambil item layanan
        const [detailRows] = await db.query(
            `SELECT
                bd.*,
                l.nama_layanan
             FROM booking_detail bd
             LEFT JOIN layanan l ON bd.layanan_id = l.id
             WHERE bd.booking_id = ?`,
            [bookingId]
        );

        // Ambil payment terbaru
        let [paymentRows] = await db.query(
            `SELECT *
             FROM payments
             WHERE booking_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [bookingId]
        );

        // Jika ada pembayaran pending via Midtrans, sinkronkan status terbaru dengan Midtrans
        if (
            paymentRows.length > 0 &&
            paymentRows[0].transaction_status === "pending" &&
            paymentRows[0].order_id
        ) {
            await syncMidtransTransactionStatus(
                paymentRows[0].order_id,
                paymentRows[0].id,
                bookingId
            );

            // Muat ulang setelah sinkronisasi
            const [refreshedRows] = await db.query(
                `SELECT * FROM payments WHERE id = ? LIMIT 1`,
                [paymentRows[0].id]
            );
            if (refreshedRows.length > 0) {
                paymentRows = refreshedRows;
            }
        }

        return res.json({
            success: true,
            data: {
                booking: {
                    ...booking,
                    layanan: detailRows,
                },
                payment: paymentRows.length > 0 ? paymentRows[0] : null,
            },
        });
    } catch (error) {
        console.error("Get Payment By Booking Error:", error);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil data booking",
            error: error.message,
        });
    }
};

// =====================================================
// SUBMIT MANUAL PAYMENT (QRIS, DANA, SeaBank, Bayar di Tempat)
// POST /api/payment/manual
// =====================================================
const submitManualPayment = async (req, res) => {
    try {
        const {
            bookingId,
            userId,
            metodePembayaran,
            buktiTransfer,
            catatan,
        } = req.body;

        if (!bookingId || !userId || !metodePembayaran) {
            return res.status(400).json({
                success: false,
                message: "Booking ID, User ID, dan Metode Pembayaran wajib diisi",
            });
        }

        const [bookingRows] = await db.query(
            `SELECT b.id, b.kode_booking, b.total_harga, b.status
             FROM booking b
             WHERE b.id = ? AND b.user_id = ?
             LIMIT 1`,
            [bookingId, userId]
        );

        if (bookingRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan atau bukan milik akun Anda",
            });
        }

        const booking = bookingRows[0];
        const grossAmount = Number(booking.total_harga) || 0;
        const orderId = `AC-PAY-${booking.id}-${Date.now()}`;

        let savedBuktiUrl = null;

        // Simpan gambar bukti transfer jika dikirim dalam Base64
        if (buktiTransfer && typeof buktiTransfer === "string") {
            if (buktiTransfer.startsWith("data:image/")) {
                const uploadDir = path.join(__dirname, "../uploads/payments");
                if (!fs.existsSync(uploadDir)) {
                    fs.mkdirSync(uploadDir, { recursive: true });
                }

                const matches = buktiTransfer.match(/^data:image\/([a-zA-Z0-9.+]+);base64,(.+)$/);
                let ext = "jpg";
                let base64Data = buktiTransfer;

                if (matches && matches.length === 3) {
                    ext = matches[1] === "jpeg" ? "jpg" : matches[1];
                    base64Data = matches[2];
                } else {
                    base64Data = buktiTransfer.replace(/^data:image\/\w+;base64,/, "");
                }

                const filename = `bukti-${bookingId}-${Date.now()}.${ext}`;
                const filePath = path.join(uploadDir, filename);

                fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));
                savedBuktiUrl = `/uploads/payments/${filename}`;
            } else {
                savedBuktiUrl = buktiTransfer;
            }
        }

        // Tentukan status verifikasi
        let statusVerifikasi = "menunggu_verifikasi";
        let transactionStatus = "pending";

        if (metodePembayaran.toLowerCase() === "cod" || metodePembayaran.toLowerCase() === "bayar_di_tempat") {
            statusVerifikasi = "diterima";
            transactionStatus = "pending";
            // Update status booking langsung menjadi dikonfirmasi
            await db.query("UPDATE booking SET status = 'dikonfirmasi' WHERE id = ?", [bookingId]);
        }

        // Simpan record pembayaran
        const [insertResult] = await db.query(
            `INSERT INTO payments
            (
                booking_id,
                order_id,
                gross_amount,
                transaction_status,
                payment_type,
                metode_pembayaran,
                bukti_transfer,
                status_verifikasi,
                catatan
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                bookingId,
                orderId,
                grossAmount,
                transactionStatus,
                metodePembayaran,
                metodePembayaran,
                savedBuktiUrl,
                statusVerifikasi,
                catatan || null,
            ]
        );

        return res.status(201).json({
            success: true,
            message: (metodePembayaran.toLowerCase() === "cod" || metodePembayaran.toLowerCase() === "bayar_di_tempat")
                ? "Metode pembayaran Bayar di Tempat berhasil dipilih! Booking Anda telah dikonfirmasi."
                : "Bukti transfer berhasil dikirim! Menunggu verifikasi admin.",
            data: {
                paymentId: insertResult.insertId,
                orderId,
                bookingId,
                grossAmount,
                metodePembayaran,
                statusVerifikasi,
                transactionStatus,
                buktiTransfer: savedBuktiUrl,
            },
        });
    } catch (error) {
        console.error("Submit Manual Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: "Gagal memproses pembayaran",
            error: error.message,
        });
    }
};

// =====================================================
// VERIFY MANUAL PAYMENT (ACC / Tolak)
// POST /api/payment/:orderId/verify or POST /api/payment/verify
// =====================================================
const verifyManualPayment = async (req, res) => {
    try {
        const orderId = req.params.orderId || req.body.orderId;
        const { status, alasan } = req.body; // status: 'diterima' | 'ditolak'

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: "Order ID wajib disertakan",
            });
        }

        if (!status || !["diterima", "ditolak"].includes(status.toLowerCase())) {
            return res.status(400).json({
                success: false,
                message: "Status verifikasi harus 'diterima' atau 'ditolak'",
            });
        }

        const [paymentRows] = await db.query(
            "SELECT * FROM payments WHERE order_id = ? LIMIT 1",
            [orderId]
        );

        if (paymentRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data pembayaran tidak ditemukan",
            });
        }

        const payment = paymentRows[0];
        const statusClean = status.toLowerCase();
        const newTransactionStatus = statusClean === "diterima" ? "settlement" : "cancel";
        const settlementTime = statusClean === "diterima" ? new Date() : null;

        const updatedCatatan = alasan
            ? (payment.catatan ? `${payment.catatan} | Catatan Admin: ${alasan}` : `Catatan Admin: ${alasan}`)
            : payment.catatan;

        await db.query(
            `UPDATE payments
             SET
                status_verifikasi = ?,
                transaction_status = ?,
                settlement_time = ?,
                catatan = ?
             WHERE id = ?`,
            [
                statusClean,
                newTransactionStatus,
                settlementTime,
                updatedCatatan,
                payment.id,
            ]
        );

        // Jika diterima (ACC), ubah status booking menjadi 'dikonfirmasi'
        if (statusClean === "diterima") {
            await db.query(
                "UPDATE booking SET status = 'dikonfirmasi' WHERE id = ?",
                [payment.booking_id]
            );
        } else if (statusClean === "ditolak") {
            // Biarkan booking 'menunggu' agar pengguna bisa upload bukti ulang
        }

        return res.json({
            success: true,
            message: statusClean === "diterima"
                ? "Pembayaran berhasil di-ACC (Diterima)!"
                : "Pembayaran telah Ditolak.",
            data: {
                orderId,
                statusVerifikasi: statusClean,
                transactionStatus: newTransactionStatus,
                settlementTime,
            },
        });
    } catch (error) {
        console.error("Verify Manual Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: "Gagal memverifikasi pembayaran",
            error: error.message,
        });
    }
};

// =====================================================
// CREATE MIDTRANS PAYMENT (SNAP TRANSACTION)
// POST /api/payment/create
// =====================================================
const createPayment = async (req, res) => {
    try {
        const bookingId = Number(req.body.bookingId || req.body.booking_id);
        const userId = Number(req.body.userId || req.body.user_id || req.user?.id);

        if (!bookingId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Booking ID dan User ID wajib disertakan",
            });
        }

        // Ambil data booking dan user
        const [bookingRows] = await db.query(
            `SELECT
                b.id,
                b.kode_booking,
                b.user_id,
                b.total_harga,
                b.status,
                u.nama,
                u.email,
                u.no_hp
             FROM booking b
             INNER JOIN users u ON b.user_id = u.id
             WHERE b.id = ? AND b.user_id = ?
             LIMIT 1`,
            [bookingId, userId]
        );

        if (bookingRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan atau bukan milik akun Anda",
            });
        }

        const booking = bookingRows[0];
        const grossAmount = Math.round(Number(booking.total_harga));

        if (!grossAmount || grossAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Total pembayaran tidak valid atau bernilai 0",
            });
        }

        // Ambil rincian layanan untuk item_details
        const [detailRows] = await db.query(
            `SELECT
                bd.layanan_id,
                bd.harga,
                bd.qty,
                bd.subtotal,
                l.nama_layanan
             FROM booking_detail bd
             LEFT JOIN layanan l ON bd.layanan_id = l.id
             WHERE bd.booking_id = ?`,
            [bookingId]
        );

        // Susun item_details
        let itemDetails = [];
        if (detailRows.length > 0) {
            itemDetails = detailRows.map((item) => ({
                id: `SRV-${item.layanan_id}`,
                price: Math.round(Number(item.harga)),
                quantity: Number(item.qty || 1),
                name: String(item.nama_layanan || "Layanan Servis").substring(0, 50),
            }));
        } else {
            itemDetails = [
                {
                    id: `BOOK-${booking.id}`,
                    price: grossAmount,
                    quantity: 1,
                    name: `Servis AutoCare #${booking.kode_booking}`.substring(0, 50),
                },
            ];
        }

        // Pastikan total item_details sama persis dengan grossAmount
        const itemsTotal = itemDetails.reduce(
            (sum, item) => sum + item.price * item.quantity,
            0
        );

        if (itemsTotal !== grossAmount) {
            const diff = grossAmount - itemsTotal;
            itemDetails.push({
                id: "ADJ-FEE",
                price: diff,
                quantity: 1,
                name: diff > 0 ? "Biaya Penyesuaian" : "Potongan Diskon",
            });
        }

        // Buat Order ID yang unik untuk transaksi ini
        const orderId = `AC-PAY-${booking.id}-${Date.now()}`;

        // Parse nama depan dan belakang
        const nameParts = (booking.nama || "Pelanggan AutoCare").trim().split(" ");
        const firstName = nameParts[0] || "Pelanggan";
        const lastName = nameParts.slice(1).join(" ") || "AutoCare";

        const parameter = {
            transaction_details: {
                order_id: orderId,
                gross_amount: grossAmount,
            },
            customer_details: {
                first_name: firstName,
                last_name: lastName,
                email: booking.email || "customer@autocare.com",
                phone: booking.no_hp || "08123456789",
            },
            item_details: itemDetails,
        };

        // Buat transaksi Snap di Midtrans
        const transaction = await snap.createTransaction(parameter);

        if (!transaction || !transaction.token) {
            throw new Error("Gagal mendapatkan Snap Token dari Midtrans");
        }

        // Simpan / update data pembayaran di database
        await db.query(
            `INSERT INTO payments
            (
                booking_id,
                order_id,
                snap_token,
                gross_amount,
                transaction_status,
                payment_type,
                metode_pembayaran,
                status_verifikasi,
                catatan
            )
            VALUES (?, ?, ?, ?, 'pending', 'midtrans', 'midtrans', 'menunggu_verifikasi', ?)`,
            [
                booking.id,
                orderId,
                transaction.token,
                grossAmount,
                `Midtrans Snap Token: ${transaction.token}`,
            ]
        );

        return res.status(201).json({
            success: true,
            message: "Transaksi Midtrans berhasil disiapkan",
            data: {
                bookingId: booking.id,
                kodeBooking: booking.kode_booking,
                orderId,
                grossAmount,
                snapToken: transaction.token,
                redirectUrl: transaction.redirect_url,
                status: "pending",
            },
        });
    } catch (error) {
        console.error("Create Midtrans Payment Error:", error);
        return res.status(500).json({
            success: false,
            message: error.message || "Gagal membuat transaksi Midtrans",
            error: error.message,
        });
    }
};

// =====================================================
// GET PAYMENT STATUS
// GET /api/payment/:orderId/status
// =====================================================
const getPaymentStatus = async (req, res) => {
    try {
        const { orderId } = req.params;

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: "Order ID wajib disertakan",
            });
        }

        let [rows] = await db.query(
            `SELECT
                p.*,
                b.kode_booking,
                b.status AS booking_status
             FROM payments p
             INNER JOIN booking b ON p.booking_id = b.id
             WHERE p.order_id = ?
             LIMIT 1`,
            [orderId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data pembayaran tidak ditemukan",
            });
        }

        // Jika status transaksi masih pending, sinkronkan langsung dengan Midtrans
        if (rows[0].transaction_status === "pending") {
            await syncMidtransTransactionStatus(
                orderId,
                rows[0].id,
                rows[0].booking_id
            );

            // Muat ulang data terbaru setelah sinkronisasi
            const [refreshedRows] = await db.query(
                `SELECT
                    p.*,
                    b.kode_booking,
                    b.status AS booking_status
                 FROM payments p
                 INNER JOIN booking b ON p.booking_id = b.id
                 WHERE p.order_id = ?
                 LIMIT 1`,
                [orderId]
            );

            if (refreshedRows.length > 0) {
                rows = refreshedRows;
            }
        }

        return res.json({
            success: true,
            data: rows[0],
        });
    } catch (error) {
        console.error("Get Payment Status Error:", error);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil status pembayaran",
            error: error.message,
        });
    }
};

// =====================================================
// MIDTRANS NOTIFICATION (WEBHOOK)
// POST /api/payment/notification
// =====================================================
const paymentNotification = async (req, res) => {
    try {
        const notification = req.body;
        console.log("MIDTRANS NOTIFICATION RECEIVED:", JSON.stringify(notification));

        const {
            order_id,
            status_code,
            gross_amount,
            signature_key,
            transaction_status,
            fraud_status,
            payment_type,
            transaction_id,
            transaction_time,
            settlement_time,
        } = notification;

        if (!order_id || !status_code || !gross_amount || !signature_key) {
            return res.status(400).json({
                success: false,
                message: "Format notifikasi tidak lengkap",
            });
        }

        // Verifikasi Signature Key resmi Midtrans: SHA512(order_id + status_code + gross_amount + ServerKey)
        const serverKey = process.env.MIDTRANS_SERVER_KEY || "";
        const rawString = `${order_id}${status_code}${gross_amount}${serverKey}`;
        const expectedSignature = crypto
            .createHash("sha512")
            .update(rawString)
            .digest("hex");

        if (signature_key !== expectedSignature) {
            console.error("MIDTRANS SIGNATURE MISMATCH!");
            return res.status(403).json({
                success: false,
                message: "Signature key tidak valid",
            });
        }

        // Cari record pembayaran di database
        const [payments] = await db.query(
            `SELECT * FROM payments WHERE order_id = ? LIMIT 1`,
            [order_id]
        );

        if (payments.length === 0) {
            console.warn("Payment order_id not found in DB:", order_id);
            return res.status(404).json({
                success: false,
                message: "Order ID tidak ditemukan di sistem AutoCare",
            });
        }

        const payment = payments[0];

        // Tentukan status pembayaran baru berdasarkan spesifikasi Midtrans
        let newTransactionStatus = transaction_status;
        let newStatusVerifikasi = payment.status_verifikasi;
        let shouldConfirmBooking = false;
        let shouldCancelBooking = false;

        if (transaction_status === "capture") {
            if (fraud_status === "challenge") {
                newTransactionStatus = "challenge";
                newStatusVerifikasi = "menunggu_verifikasi";
            } else if (fraud_status === "accept") {
                newTransactionStatus = "settlement";
                newStatusVerifikasi = "diterima";
                shouldConfirmBooking = true;
            }
        } else if (transaction_status === "settlement") {
            newTransactionStatus = "settlement";
            newStatusVerifikasi = "diterima";
            shouldConfirmBooking = true;
        } else if (transaction_status === "pending") {
            newTransactionStatus = "pending";
            newStatusVerifikasi = "menunggu_verifikasi";
        } else if (
            transaction_status === "deny" ||
            transaction_status === "cancel" ||
            transaction_status === "expire"
        ) {
            newTransactionStatus = transaction_status;
            newStatusVerifikasi = "ditolak";
            shouldCancelBooking = true;
        } else if (transaction_status === "refund") {
            newTransactionStatus = "refund";
            newStatusVerifikasi = "ditolak";
        }

        // Update tabel payments
        await db.query(
            `UPDATE payments
             SET transaction_status = ?,
                 status_verifikasi = ?,
                 payment_type = COALESCE(?, payment_type),
                 transaction_id = COALESCE(?, transaction_id),
                 transaction_time = COALESCE(?, transaction_time),
                 settlement_time = COALESCE(?, settlement_time),
                 updated_at = NOW()
             WHERE id = ?`,
            [
                newTransactionStatus,
                newStatusVerifikasi,
                payment_type || null,
                transaction_id || null,
                transaction_time || null,
                settlement_time || (newTransactionStatus === "settlement" ? new Date() : null),
                payment.id,
            ]
        );

        // Update status booking jika status berubah
        if (shouldConfirmBooking) {
            await db.query(
                `UPDATE booking SET status = 'dikonfirmasi', updated_at = NOW() WHERE id = ?`,
                [payment.booking_id]
            );
        } else if (shouldCancelBooking) {
            await db.query(
                `UPDATE booking SET status = 'dibatalkan', updated_at = NOW() WHERE id = ? AND status = 'menunggu'`,
                [payment.booking_id]
            );
        }

        return res.status(200).json({
            success: true,
            message: "Notifikasi Midtrans berhasil diproses",
            data: {
                orderId: order_id,
                transactionStatus: newTransactionStatus,
                statusVerifikasi: newStatusVerifikasi,
            },
        });
    } catch (error) {
        console.error("Payment Notification Error:", error);
        return res.status(500).json({
            success: false,
            message: "Gagal memproses notifikasi pembayaran",
            error: error.message,
        });
    }
};

module.exports = {
    getPaymentByBookingId,
    submitManualPayment,
    verifyManualPayment,
    createPayment,
    getPaymentStatus,
    paymentNotification,
};
