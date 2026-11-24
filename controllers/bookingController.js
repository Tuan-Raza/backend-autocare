const { db } = require("../config/database");

// =====================================================
// GET BENGKEL AKTIF
// GET /api/booking/bengkel
// =====================================================
const getBengkel = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT
                id,
                nama_bengkel,
                alamat,
                no_hp,
                jam_buka,
                jam_tutup,
                latitude,
                longitude,
                foto,
                status
             FROM bengkel
             WHERE status = 'aktif'
             ORDER BY nama_bengkel ASC`
        );

        res.json({
            success: true,
            data: rows,
        });
    } catch (error) {
        console.error("Get Bengkel Error:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil data bengkel",
        });
    }
};


// =====================================================
// GET KENDARAAN USER
// GET /api/booking/kendaraan/:userId
// =====================================================
const getKendaraanUser = async (req, res) => {
    try {
        const { userId } = req.params;

        const [rows] = await db.query(
            `SELECT
                id,
                user_id,
                merek,
                model,
                tahun,
                nomor_polisi,
                kilometer,
                created_at,
                updated_at
             FROM kendaraan
             WHERE user_id = ?
             ORDER BY id DESC`,
            [userId]
        );

        res.json({
            success: true,
            data: rows,
        });
    } catch (error) {
        console.error("Get Kendaraan Booking Error:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil kendaraan",
        });
    }
};


// =====================================================
// GET LAYANAN AKTIF
// GET /api/booking/layanan
// =====================================================
const getLayanan = async (req, res) => {
    try {
        const [rows] = await db.query(
            `SELECT
                id,
                nama_layanan,
                deskripsi,
                harga,
                estimasi_menit,
                foto,
                status
             FROM layanan
             WHERE status = 'aktif'
             ORDER BY id ASC`
        );

        res.json({
            success: true,
            data: rows,
        });
    } catch (error) {
        console.error("Get Layanan Error:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil data layanan",
        });
    }
};


// =====================================================
// GET JADWAL TERSEDIA
// GET /api/booking/jadwal/:bengkelId/:tanggal
// =====================================================
const getJadwal = async (req, res) => {
    try {
        const { bengkelId, tanggal } = req.params;

        if (!bengkelId || !tanggal) {
            return res.status(400).json({
                success: false,
                message: "Bengkel dan tanggal wajib diisi",
            });
        }

        let cleanTanggal = String(tanggal).trim();
        if (cleanTanggal.includes("T")) {
            cleanTanggal = cleanTanggal.split("T")[0];
        }

        let [rows] = await db.query(
            `SELECT
                id,
                bengkel_id,
                tanggal,
                jam,
                kapasitas,
                tersedia,
                status
             FROM jadwal
             WHERE bengkel_id = ?
               AND tanggal = ?
             ORDER BY jam ASC`,
            [bengkelId, cleanTanggal]
        );

        // Jika belum ada jadwal di DB untuk tanggal & bengkel ini, buat slot otomatis
        if (rows.length === 0) {
            const defaultHours = [
                "09:00:00",
                "10:00:00",
                "11:00:00",
                "13:00:00",
                "14:00:00",
                "15:00:00",
                "16:00:00",
                "17:00:00",
                "18:00:00",
                "19:00:00",
            ];

            for (const jam of defaultHours) {
                const [result] = await db.query(
                    `INSERT INTO jadwal (bengkel_id, tanggal, jam, kapasitas, tersedia, status)
                     VALUES (?, ?, ?, 2, 2, 'tersedia')`,
                    [bengkelId, cleanTanggal, jam]
                );
                rows.push({
                    id: result.insertId,
                    bengkel_id: Number(bengkelId),
                    tanggal: cleanTanggal,
                    jam,
                    kapasitas: 2,
                    tersedia: 2,
                    status: "tersedia",
                });
            }
        }

        const availableRows = rows.filter(
            (r) => r.status === "tersedia" && Number(r.tersedia) > 0
        );

        res.json({
            success: true,
            data: availableRows.length > 0 ? availableRows : rows,
        });
    } catch (error) {
        console.error("Get Jadwal Error:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil jadwal",
        });
    }
};


// =====================================================
// CREATE BOOKING
// POST /api/booking
// =====================================================
const createBooking = async (req, res) => {
    const connection = await db.getConnection();

    try {
        // Mendukung camelCase dan snake_case secara fleksibel
        const userId = Number(
            req.body.userId || req.body.user_id || req.user?.id
        );
        const kendaraanId = Number(
            req.body.kendaraanId || req.body.kendaraan_id || req.body.vehicleId || req.body.vehicle_id
        );
        const bengkelId = Number(
            req.body.bengkelId || req.body.bengkel_id || req.body.workshopId || req.body.workshop_id
        );
        let jadwalId =
            req.body.jadwalId || req.body.jadwal_id || req.body.scheduleId || req.body.schedule_id;
        jadwalId = jadwalId ? Number(jadwalId) : null;

        const tanggalBooking =
            req.body.tanggalBooking || req.body.tanggal_booking || req.body.tanggal || req.body.bookingDate || req.body.booking_date;
        const jamBooking =
            req.body.jamBooking || req.body.jam_booking || req.body.jam || req.body.bookingTime || req.body.booking_time;
        const layanan = req.body.layanan || req.body.services;
        const keluhan = req.body.keluhan || req.body.catatan || "";

        // -------------------------------------------------
        // VALIDASI DATA DASAR DENGAN PESAN SPESIFIK
        // -------------------------------------------------
        const missingFields = [];
        if (!userId || isNaN(userId)) missingFields.push("User ID (userId/user_id)");
        if (!kendaraanId || isNaN(kendaraanId)) missingFields.push("Kendaraan ID (kendaraanId/kendaraan_id)");
        if (!bengkelId || isNaN(bengkelId)) missingFields.push("Bengkel ID (bengkelId/bengkel_id)");
        if (!tanggalBooking) missingFields.push("Tanggal Booking (tanggalBooking/tanggal)");
        if (!jamBooking) missingFields.push("Jam Booking (jamBooking/jam)");
        if (!Array.isArray(layanan) || layanan.length === 0) missingFields.push("Daftar Layanan (layanan)");

        if (missingFields.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Data booking belum lengkap: ${missingFields.join(", ")}`,
                missingFields,
            });
        }

        await connection.beginTransaction();

        // -------------------------------------------------
        // CEK USER
        // -------------------------------------------------
        const [users] = await connection.query(
            `SELECT id
             FROM users
             WHERE id = ?
             LIMIT 1`,
            [userId]
        );

        if (users.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "User tidak ditemukan",
            });
        }

        // -------------------------------------------------
        // CEK KENDARAAN MILIK USER
        // -------------------------------------------------
        const [kendaraan] = await connection.query(
            `SELECT
                id,
                merek,
                model,
                nomor_polisi
             FROM kendaraan
             WHERE id = ?
               AND user_id = ?
             LIMIT 1`,
            [kendaraanId, userId]
        );

        if (kendaraan.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Kendaraan tidak ditemukan atau bukan milik akun Anda",
            });
        }

        // -------------------------------------------------
        // CEK BENGKEL
        // -------------------------------------------------
        const [bengkel] = await connection.query(
            `SELECT id
             FROM bengkel
             WHERE id = ?
               AND status = 'aktif'
             LIMIT 1`,
            [bengkelId]
        );

        if (bengkel.length === 0) {
            await connection.rollback();

            return res.status(404).json({
                success: false,
                message: "Bengkel tidak ditemukan atau tidak aktif",
            });
        }

        // -------------------------------------------------
        // FORMAT TANGGAL
        // -------------------------------------------------
        let cleanTanggal = String(tanggalBooking).trim();
        if (cleanTanggal.includes("T")) {
            cleanTanggal = cleanTanggal.split("T")[0];
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(cleanTanggal)) {
            const parsedDate = new Date(cleanTanggal);
            if (!isNaN(parsedDate.getTime())) {
                cleanTanggal = parsedDate.toISOString().split("T")[0];
            }
        }

        let cleanJam = String(jamBooking).trim();
        if (cleanJam.length === 5) {
            cleanJam = `${cleanJam}:00`;
        }

        // -------------------------------------------------
        // CEK JADWAL + LOCK ROW (ROBUST RESOLUTION)
        // -------------------------------------------------
        let jadwalRows = [];
        if (jadwalId && !isNaN(jadwalId) && jadwalId < 100000) {
            [jadwalRows] = await connection.query(
                `SELECT
                    id,
                    bengkel_id,
                    tanggal,
                    jam,
                    tersedia,
                    status
                 FROM jadwal
                 WHERE id = ?
                   AND bengkel_id = ?
                 FOR UPDATE`,
                [jadwalId, bengkelId]
            );
        }

        // Jika tidak ditemukan berdasarkan jadwalId, cari berdasarkan bengkel, tanggal, dan jam
        if (jadwalRows.length === 0) {
            [jadwalRows] = await connection.query(
                `SELECT
                    id,
                    bengkel_id,
                    tanggal,
                    jam,
                    tersedia,
                    status
                 FROM jadwal
                 WHERE bengkel_id = ?
                   AND tanggal = ?
                   AND jam LIKE ?
                 FOR UPDATE`,
                [bengkelId, cleanTanggal, `${cleanJam.substring(0, 5)}%`]
            );
        }

        // Jika belum ada di DB, buat slot jadwal baru secara dinamis
        if (jadwalRows.length === 0) {
            const [insertJadwal] = await connection.query(
                `INSERT INTO jadwal (bengkel_id, tanggal, jam, kapasitas, tersedia, status)
                 VALUES (?, ?, ?, 2, 2, 'tersedia')`,
                [bengkelId, cleanTanggal, cleanJam]
            );
            jadwalId = insertJadwal.insertId;
            jadwalRows = [
                {
                    id: jadwalId,
                    bengkel_id: bengkelId,
                    tanggal: cleanTanggal,
                    jam: cleanJam,
                    tersedia: 2,
                    status: "tersedia",
                },
            ];
        } else {
            jadwalId = jadwalRows[0].id;
        }

        // Format tanggal dari jadwal database
        const finalTanggal = jadwalRows[0].tanggal
            ? jadwalRows[0].tanggal instanceof Date
                ? jadwalRows[0].tanggal.toISOString().split("T")[0]
                : String(jadwalRows[0].tanggal).split("T")[0]
            : cleanTanggal;

        const finalJam = jadwalRows[0].jam || cleanJam;

        // Cek ketersediaan slot
        if (Number(jadwalRows[0].tersedia) <= 0) {
            await connection.rollback();

            return res.status(400).json({
                success: false,
                message: "Jadwal pada jam tersebut sudah penuh. Silakan pilih jam lain.",
            });
        }

        // -------------------------------------------------
        // VALIDASI LAYANAN + HITUNG TOTAL
        // -------------------------------------------------
        let totalHarga = 0;
        const detailLayanan = [];

        for (const item of layanan) {
    // Frontend mengirim ID layanan dengan nama "id"
    // Tetap dukung "layananId" jika nanti ada request dari sumber lain
    const layananId = Number(
        item.id ?? item.layananId
    );

    const qty = Number(item.qty || 1);

    if (!layananId || !Number.isInteger(layananId) || qty < 1) {
        await connection.rollback();

        return res.status(400).json({
            success: false,
            message: "Data layanan tidak valid",
        });
    }

    const [layananRows] = await connection.query(
        `SELECT
            id,
            nama_layanan,
            harga
         FROM layanan
         WHERE id = ?
           AND status = 'aktif'
         LIMIT 1`,
        [layananId]
    );

    if (layananRows.length === 0) {
        await connection.rollback();

        return res.status(404).json({
            success: false,
            message: `Layanan dengan ID ${layananId} tidak ditemukan`,
        });
    }

    const layananData = layananRows[0];

    const harga = Number(layananData.harga);
    const subtotal = harga * qty;

    totalHarga += subtotal;

    detailLayanan.push({
        layananId,
        harga,
        qty,
        subtotal,
    });
}

        // -------------------------------------------------
        // GENERATE KODE BOOKING
        // -------------------------------------------------
        const now = new Date();

        const tahun = now.getFullYear();
        const bulan = String(now.getMonth() + 1).padStart(2, "0");
        const tanggal = String(now.getDate()).padStart(2, "0");

        const randomNumber = Math.floor(
            1000 + Math.random() * 9000
        );

        const kodeBooking =
            `AC-${tahun}${bulan}${tanggal}-${randomNumber}`;

        // -------------------------------------------------
        // INSERT BOOKING
        // -------------------------------------------------
        const [bookingResult] = await connection.query(
            `INSERT INTO booking
            (
                kode_booking,
                user_id,
                kendaraan_id,
                bengkel_id,
                jadwal_id,
                tanggal_booking,
                jam_booking,
                keluhan,
                total_harga,
                status
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'menunggu')`,
            [
                kodeBooking,
                userId,
                kendaraanId,
                bengkelId,
                jadwalId,
                finalTanggal,
                finalJam,
                keluhan || null,
                totalHarga,
            ]
        );

        const bookingId = bookingResult.insertId;

        // -------------------------------------------------
        // INSERT BOOKING DETAIL
        // -------------------------------------------------
        for (const item of detailLayanan) {
            await connection.query(
                `INSERT INTO booking_detail
                (
                    booking_id,
                    layanan_id,
                    harga,
                    qty,
                    subtotal
                )
                VALUES (?, ?, ?, ?, ?)`,
                [
                    bookingId,
                    item.layananId,
                    item.harga,
                    item.qty,
                    item.subtotal,
                ]
            );
        }

        // -------------------------------------------------
        // KURANGI KETERSEDIAAN JADWAL
        // -------------------------------------------------
        await connection.query(
            `UPDATE jadwal
             SET
                tersedia = tersedia - 1,
                status = CASE
                    WHEN tersedia - 1 <= 0
                    THEN 'penuh'
                    ELSE 'tersedia'
                END
             WHERE id = ?
               AND tersedia > 0`,
            [jadwalId]
        );

        // -------------------------------------------------
        // COMMIT
        // -------------------------------------------------
        await connection.commit();

        res.status(201).json({
            success: true,
            message: "Booking berhasil dibuat",
            data: {
                bookingId,
                kodeBooking,
                totalHarga,
                status: "menunggu",
            },
        });

    } catch (error) {
        await connection.rollback();

        console.error("Create Booking Error:", error);

        res.status(500).json({
            success: false,
            message: "Gagal membuat booking",
            error: error.message,
        });
    } finally {
        connection.release();
    }
};


// =====================================================
// GET BOOKING USER
// GET /api/booking/user/:userId
// =====================================================
const getBookingUser = async (req, res) => {
    try {
        const { userId } = req.params;

        const [rows] = await db.query(
            `SELECT
                b.id,
                b.kode_booking,
                b.tanggal_booking,
                b.jam_booking,
                b.keluhan,
                b.total_harga,
                b.status,
                b.created_at,

                k.merek,
                k.model,
                k.tahun,
                k.nomor_polisi,

                bg.nama_bengkel,
                bg.alamat

             FROM booking b

             INNER JOIN kendaraan k
                ON b.kendaraan_id = k.id

             INNER JOIN bengkel bg
                ON b.bengkel_id = bg.id

             WHERE b.user_id = ?

             ORDER BY b.created_at DESC`,
            [userId]
        );

        res.json({
            success: true,
            data: rows,
        });

    } catch (error) {
        console.error("Get Booking User Error:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil data booking",
        });
    }
};


// =====================================================
// GET DETAIL BOOKING
// GET /api/booking/:id
// =====================================================
const getBookingDetail = async (req, res) => {
    try {
        const { id } = req.params;

        const [bookingRows] = await db.query(
            `SELECT
                b.id,
                b.kode_booking,
                b.user_id,
                b.tanggal_booking,
                b.jam_booking,
                b.keluhan,
                b.total_harga,
                b.status,
                b.created_at,

                k.merek,
                k.model,
                k.tahun,
                k.nomor_polisi,
                k.kilometer,

                bg.id AS bengkel_id,
                bg.nama_bengkel,
                bg.alamat,
                bg.no_hp,
                bg.jam_buka,
                bg.jam_tutup

             FROM booking b

             INNER JOIN kendaraan k
                ON b.kendaraan_id = k.id

             INNER JOIN bengkel bg
                ON b.bengkel_id = bg.id

             WHERE b.id = ?

             LIMIT 1`,
            [id]
        );

        if (bookingRows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan",
            });
        }

        const [detailRows] = await db.query(
            `SELECT
                bd.id,
                bd.layanan_id,
                bd.harga,
                bd.qty,
                bd.subtotal,
                l.nama_layanan,
                l.deskripsi,
                l.estimasi_menit,
                l.foto

             FROM booking_detail bd

             INNER JOIN layanan l
                ON bd.layanan_id = l.id

             WHERE bd.booking_id = ?

             ORDER BY bd.id ASC`,
            [id]
        );

        res.json({
            success: true,
            data: {
                booking: bookingRows[0],
                layanan: detailRows,
            },
        });

    } catch (error) {
        console.error("Get Booking Detail Error:", error);

        res.status(500).json({
            success: false,
            message: "Gagal mengambil detail booking",
        });
    }
};


// =====================================================
// CANCEL BOOKING
// PUT /api/booking/:id/cancel
// =====================================================
const cancelBooking = async (req, res) => {
    const connection = await db.getConnection();

    try {
        const { id } = req.params;

        const [bookingRows] = await connection.query(
            "SELECT id, status, jadwal_id FROM booking WHERE id = ?",
            [id]
        );

        if (bookingRows.length === 0) {
            connection.release();
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan",
            });
        }

        const booking = bookingRows[0];

        if (booking.status === "dibatalkan") {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "Booking ini sudah dibatalkan sebelumnya",
            });
        }

        if (booking.status === "selesai") {
            connection.release();
            return res.status(400).json({
                success: false,
                message: "Booking yang sudah selesai tidak dapat dibatalkan",
            });
        }

        await connection.beginTransaction();

        await connection.query(
            "UPDATE booking SET status = 'dibatalkan', updated_at = NOW() WHERE id = ?",
            [id]
        );

        // Kembalikan slot jadwal jika ada
        if (booking.jadwal_id) {
            await connection.query(
                `UPDATE jadwal 
                 SET tersedia = LEAST(kapasitas, tersedia + 1),
                     status = 'tersedia'
                 WHERE id = ?`,
                [booking.jadwal_id]
            );
        }

        await connection.commit();
        connection.release();

        res.json({
            success: true,
            message: "Booking berhasil dibatalkan",
        });

    } catch (error) {
        await connection.rollback();
        connection.release();

        console.error("Cancel Booking Error:", error);
        res.status(500).json({
            success: false,
            message: "Gagal membatalkan booking",
            error: error.message,
        });
    }
};


// =====================================================
// UPDATE BOOKING (Catatan / Keluhan)
// PUT /api/booking/:id
// =====================================================
const updateBooking = async (req, res) => {
    try {
        const { id } = req.params;
        const { keluhan } = req.body;

        const [result] = await db.query(
            "UPDATE booking SET keluhan = ?, updated_at = NOW() WHERE id = ?",
            [keluhan || null, id]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan",
            });
        }

        res.json({
            success: true,
            message: "Catatan keluhan booking berhasil diperbarui",
        });

    } catch (error) {
        console.error("Update Booking Error:", error);
        res.status(500).json({
            success: false,
            message: "Gagal memperbarui data booking",
            error: error.message,
        });
    }
};


// =====================================================
// DELETE BOOKING
// DELETE /api/booking/:id
// =====================================================
const deleteBooking = async (req, res) => {
    const connection = await db.getConnection();

    try {
        const { id } = req.params;

        const [bookingRows] = await connection.query(
            "SELECT id, status, jadwal_id FROM booking WHERE id = ?",
            [id]
        );

        if (bookingRows.length === 0) {
            connection.release();
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan",
            });
        }

        const booking = bookingRows[0];

        await connection.beginTransaction();

        // Kembalikan slot jika booking belum dibatalkan atau selesai
        if (booking.jadwal_id && booking.status !== "dibatalkan" && booking.status !== "selesai") {
            await connection.query(
                `UPDATE jadwal 
                 SET tersedia = LEAST(kapasitas, tersedia + 1),
                     status = 'tersedia'
                 WHERE id = ?`,
                [booking.jadwal_id]
            );
        }

        // Hapus pembayaran terkait jika ada
        await connection.query(
            "DELETE FROM payments WHERE booking_id = ?",
            [id]
        );

        // Hapus detail booking
        await connection.query(
            "DELETE FROM booking_detail WHERE booking_id = ?",
            [id]
        );

        // Hapus booking utama
        await connection.query(
            "DELETE FROM booking WHERE id = ?",
            [id]
        );

        await connection.commit();
        connection.release();

        res.json({
            success: true,
            message: "Booking dan riwayatnya berhasil dihapus",
        });

    } catch (error) {
        await connection.rollback();
        connection.release();

        console.error("Delete Booking Error:", error);
        res.status(500).json({
            success: false,
            message: "Gagal menghapus booking",
            error: error.message,
        });
    }
};


module.exports = {
    getBengkel,
    getKendaraanUser,
    getLayanan,
    getJadwal,
    createBooking,
    getBookingUser,
    getBookingDetail,
    cancelBooking,
    updateBooking,
    deleteBooking,
};