const { db } = require("../config/database");
const fs = require("fs");
const path = require("path");

// =====================================================
// GET PAYMENT BY BOOKING ID
// GET /api/payment/booking/:bookingId
// =====================================================
const getPaymentByBookingId = async (req, res) => {
    try {
        const { bookingId } = req.params;
        const requestedUserId = req.query.userId || req.user?.id;

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

        // Validasi kepemilikan booking jika userId disertakan (dan bukan admin)
        if (requestedUserId && req.user?.role !== "admin") {
            if (Number(booking.user_id) !== Number(requestedUserId)) {
                return res.status(403).json({
                    success: false,
                    message: "Akses ditolak: Anda tidak memiliki akses ke data booking ini",
                });
            }
        }

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
        const [paymentRows] = await db.query(
            `SELECT *
             FROM payments
             WHERE booking_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [bookingId]
        );

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
// SUBMIT PAYMENT (QRIS / COD)
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

        if (!grossAmount || grossAmount <= 0) {
            return res.status(400).json({
                success: false,
                message: "Total tagihan booking tidak valid atau bernilai 0",
            });
        }

        const metodeClean = String(metodePembayaran).toLowerCase().trim();
        const isCod = metodeClean === "cod" || metodeClean === "bayar_di_tempat";

        // Cek apakah sudah pernah ada record payment untuk booking ini
        const [existingPayments] = await db.query(
            "SELECT id, order_id, status_verifikasi, transaction_status FROM payments WHERE booking_id = ? ORDER BY id DESC LIMIT 1",
            [bookingId]
        );

        // Pencegahan pembayaran ganda: jika sudah lunas/terverifikasi, tolak request pembayaran baru
        if (existingPayments.length > 0) {
            const prev = existingPayments[0];
            if (
                prev.status_verifikasi === "terverifikasi" ||
                prev.status_verifikasi === "diterima" ||
                prev.transaction_status === "settlement"
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Pembayaran untuk booking ini sudah diverifikasi dan berstatus LUNAS",
                });
            }
        }

        let savedBuktiUrl = null;

        // Validasi bukti transfer untuk QRIS
        if (!isCod) {
            if (!buktiTransfer) {
                return res.status(400).json({
                    success: false,
                    message: "Foto bukti pembayaran wajib diunggah untuk metode QRIS",
                });
            }

            // Validasi ukuran string Base64 (maksimal ~10MB)
            if (typeof buktiTransfer === "string") {
                if (buktiTransfer.length > 14 * 1024 * 1024) {
                    return res.status(400).json({
                        success: false,
                        message: "Ukuran file bukti pembayaran terlalu besar (maksimal 10MB)",
                    });
                }

                if (buktiTransfer.startsWith("data:image/")) {
                    const matches = buktiTransfer.match(/^data:image\/([a-zA-Z0-9.+]+);base64,(.+)$/);
                    if (!matches || matches.length !== 3) {
                        return res.status(400).json({
                            success: false,
                            message: "Format gambar bukti transfer tidak valid",
                        });
                    }

                    let ext = matches[1].toLowerCase();
                    if (ext === "jpeg") ext = "jpg";
                    const allowedExts = ["jpg", "png", "webp", "heic"];
                    if (!allowedExts.includes(ext)) {
                        return res.status(400).json({
                            success: false,
                            message: "Tipe file tidak didukung. Harap gunakan format JPG, PNG, atau WEBP",
                        });
                    }

                    const uploadDir = path.join(__dirname, "../uploads/payments");
                    if (!fs.existsSync(uploadDir)) {
                        fs.mkdirSync(uploadDir, { recursive: true });
                    }

                    const filename = `bukti-${metodeClean}-${bookingId}-${Date.now()}.${ext}`;
                    const filePath = path.join(uploadDir, filename);

                    fs.writeFileSync(filePath, Buffer.from(matches[2], "base64"));
                    savedBuktiUrl = `/uploads/payments/${filename}`;
                } else {
                    savedBuktiUrl = buktiTransfer;
                }
            }
        }

        // Tentukan status verifikasi & transaksi
        // QRIS: status_verifikasi = 'menunggu_verifikasi' (PENDING_VERIFICATION), transaction_status = 'pending'
        // COD:  status_verifikasi = 'belum_dibayar' (UNPAID), transaction_status = 'pending'
        let statusVerifikasi = "menunggu_verifikasi";
        let transactionStatus = "pending";

        if (isCod) {
            statusVerifikasi = "belum_dibayar";
            transactionStatus = "pending";
        }

        let paymentId;
        let orderId;

        if (existingPayments.length > 0) {
            paymentId = existingPayments[0].id;
            orderId = existingPayments[0].order_id || `AC-PAY-${booking.id}-${Date.now()}`;

            await db.query(
                `UPDATE payments
                 SET order_id = ?,
                     gross_amount = ?,
                     transaction_status = ?,
                     payment_type = ?,
                     metode_pembayaran = ?,
                     bukti_transfer = COALESCE(?, bukti_transfer),
                     status_verifikasi = ?,
                     catatan = ?,
                     catatan_penolakan = NULL,
                     updated_at = NOW()
                 WHERE id = ?`,
                [
                    orderId,
                    grossAmount,
                    transactionStatus,
                    metodeClean,
                    metodeClean,
                    savedBuktiUrl,
                    statusVerifikasi,
                    catatan || null,
                    paymentId,
                ]
            );
        } else {
            orderId = `AC-PAY-${booking.id}-${Date.now()}`;

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
                    metodeClean,
                    metodeClean,
                    savedBuktiUrl,
                    statusVerifikasi,
                    catatan || null,
                ]
            );

            paymentId = insertResult.insertId;
        }

        const message = isCod
            ? "Metode Bayar di Tempat (COD) berhasil dipilih! Silakan lakukan pembayaran tunai di bengkel saat servis kendaraan."
            : "Bukti transfer QRIS berhasil dikirim! Menunggu verifikasi admin.";

        return res.status(201).json({
            success: true,
            message,
            data: {
                paymentId,
                orderId,
                bookingId,
                grossAmount,
                metodePembayaran: metodeClean,
                statusVerifikasi,
                transactionStatus,
                buktiTransfer: savedBuktiUrl,
            },
        });
    } catch (error) {
        console.error("Submit Payment Error:", error);
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
        const { status, alasan } = req.body; // status: 'diterima' | 'terverifikasi' | 'ditolak' | 'lunas'

        if (!orderId) {
            return res.status(400).json({
                success: false,
                message: "Order ID wajib disertakan",
            });
        }

        const statusRaw = String(status || "").toLowerCase().trim();
        const isApprove = ["diterima", "terverifikasi", "lunas"].includes(statusRaw);
        const isReject = ["ditolak", "deny", "tolak"].includes(statusRaw);

        if (!isApprove && !isReject) {
            return res.status(400).json({
                success: false,
                message: "Status verifikasi harus 'terverifikasi' (diterima) atau 'ditolak'",
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
        const newStatusVerifikasi = isApprove ? "terverifikasi" : "ditolak";
        const newTransactionStatus = isApprove ? "settlement" : "deny";
        const settlementTime = isApprove ? new Date() : null;
        const verifiedBy = req.user?.id || null;

        const updatedCatatan = alasan
            ? (payment.catatan ? `${payment.catatan} | Catatan Admin: ${alasan}` : `Catatan Admin: ${alasan}`)
            : payment.catatan;

        const catatanPenolakan = isReject ? (alasan || "Bukti pembayaran tidak sesuai atau belum masuk") : null;

        await db.query(
            `UPDATE payments
             SET
                status_verifikasi = ?,
                transaction_status = ?,
                settlement_time = ?,
                catatan = ?,
                catatan_penolakan = ?,
                verified_by = ?,
                verified_at = NOW(),
                updated_at = NOW()
             WHERE id = ?`,
            [
                newStatusVerifikasi,
                newTransactionStatus,
                settlementTime,
                updatedCatatan,
                catatanPenolakan,
                verifiedBy,
                payment.id,
            ]
        );

        // Jika diverifikasi / lunas, konfirmasi booking secara otomatis jika statusnya 'menunggu'
        if (isApprove && payment.booking_id) {
            await db.query(
                "UPDATE booking SET status = 'dikonfirmasi', updated_at = NOW() WHERE id = ? AND status = 'menunggu'",
                [payment.booking_id]
            );
        }

        return res.json({
            success: true,
            message: isApprove
                ? "Pembayaran berhasil diverifikasi dan disetujui (Lunas)!"
                : "Pembayaran telah ditolak.",
            data: {
                orderId,
                statusVerifikasi: newStatusVerifikasi,
                transactionStatus: newTransactionStatus,
                settlementTime,
                catatanPenolakan,
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

        const [rows] = await db.query(
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

// Backward-compatibility stubs for deprecated Midtrans endpoints
const createPayment = async (req, res) => {
    return res.status(400).json({
        success: false,
        message: "Metode pembayaran Midtrans telah digantikan oleh QRIS dan COD. Silakan gunakan endpoint /api/payment/manual.",
    });
};

const paymentNotification = async (req, res) => {
    return res.status(200).json({
        success: true,
        message: "Midtrans webhook dinonaktifkan.",
    });
};

module.exports = {
    getPaymentByBookingId,
    submitManualPayment,
    verifyManualPayment,
    getPaymentStatus,
    createPayment,
    paymentNotification,
};
