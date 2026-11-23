const { db } = require("../config/database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/authMiddleware");

// ==========================================
// 1. ADMIN AUTHENTICATION
// ==========================================

/**
 * POST /api/admin/login
 * Body: { email, password }
 */
const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Email dan password wajib diisi",
            });
        }

        const emailClean = email.trim().toLowerCase();

        const [users] = await db.query(
            "SELECT id, nama, email, password, role, status FROM users WHERE LOWER(email) = ?",
            [emailClean]
        );

        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Email atau password salah",
            });
        }

        const user = users[0];

        // Check if role is admin
        if (user.role !== "admin") {
            return res.status(403).json({
                success: false,
                message: "Akses ditolak: Akun Anda bukan administrator",
            });
        }

        // Check status
        if (user.status === "nonaktif") {
            return res.status(403).json({
                success: false,
                message: "Akun administrator telah dinonaktifkan",
            });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: "Email atau password salah",
            });
        }

        // Sign JWT token
        const token = jwt.sign(
            {
                id: user.id,
                email: user.email,
                nama: user.nama,
                role: user.role,
            },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        return res.json({
            success: true,
            message: "Login admin berhasil",
            token,
            admin: {
                id: user.id,
                nama: user.nama,
                email: user.email,
                role: user.role,
            },
        });
    } catch (err) {
        console.error("Admin login error:", err);
        return res.status(500).json({
            success: false,
            message: "Terjadi kesalahan pada server saat login admin",
            error: err.message,
        });
    }
};

/**
 * GET /api/admin/me
 * Returns current admin profile from token
 */
const getMe = async (req, res) => {
    try {
        const [users] = await db.query(
            "SELECT id, nama, email, no_hp, role, status, created_at FROM users WHERE id = ?",
            [req.user.id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Akun admin tidak ditemukan",
            });
        }

        return res.json({
            success: true,
            admin: users[0],
        });
    } catch (err) {
        console.error("getMe error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal memuat profil admin",
            error: err.message,
        });
    }
};

// ==========================================
// 2. DASHBOARD OVERVIEW & STATS
// ==========================================

/**
 * GET /api/admin/dashboard
 * Aggregated live metrics from database
 */
const getDashboard = async (req, res) => {
    try {
        // Total Pelanggan (role = user)
        const [userCount] = await db.query(
            "SELECT COUNT(*) AS total FROM users WHERE role = 'user' OR role IS NULL"
        );

        // Total Kendaraan
        const [vehicleCount] = await db.query(
            "SELECT COUNT(*) AS total FROM kendaraan"
        );

        // Total Bookings & Counts per status
        const [bookingStats] = await db.query(`
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'menunggu' THEN 1 ELSE 0 END) AS menunggu,
                SUM(CASE WHEN status = 'dikonfirmasi' THEN 1 ELSE 0 END) AS dikonfirmasi,
                SUM(CASE WHEN status = 'diproses' THEN 1 ELSE 0 END) AS diproses,
                SUM(CASE WHEN status = 'selesai' THEN 1 ELSE 0 END) AS selesai,
                SUM(CASE WHEN status = 'dibatalkan' THEN 1 ELSE 0 END) AS dibatalkan,
                SUM(CASE WHEN status = 'selesai' THEN total_harga ELSE 0 END) AS total_pendapatan
            FROM booking
        `);

        // Total Pendapatan Bulan Ini
        const [currentMonthRev] = await db.query(`
            SELECT COALESCE(SUM(total_harga), 0) AS total_bulan_ini
            FROM booking
            WHERE status = 'selesai'
              AND MONTH(tanggal_booking) = MONTH(CURRENT_DATE())
              AND YEAR(tanggal_booking) = YEAR(CURRENT_DATE())
        `);

        // 10 Recent Bookings with details
        const [recentBookings] = await db.query(`
            SELECT
                b.id,
                b.kode_booking,
                b.tanggal_booking,
                b.jam_booking,
                b.keluhan,
                b.total_harga,
                b.status,
                b.catatan_admin,
                b.created_at,
                u.nama AS nama_pelanggan,
                u.email AS email_pelanggan,
                u.no_hp AS kontak_pelanggan,
                k.merek,
                k.model,
                k.nomor_polisi,
                bgk.nama_bengkel
            FROM booking b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN kendaraan k ON b.kendaraan_id = k.id
            LEFT JOIN bengkel bgk ON b.bengkel_id = bgk.id
            ORDER BY b.id DESC
            LIMIT 10
        `);

        // Monthly Revenue & Booking volume (last 6 months)
        const [monthlyStats] = await db.query(`
            SELECT
                DATE_FORMAT(tanggal_booking, '%Y-%m') AS bulan,
                COUNT(*) AS total_booking,
                SUM(CASE WHEN status = 'selesai' THEN total_harga ELSE 0 END) AS pendapatan
            FROM booking
            WHERE tanggal_booking >= DATE_SUB(CURRENT_DATE(), INTERVAL 6 MONTH)
            GROUP BY DATE_FORMAT(tanggal_booking, '%Y-%m')
            ORDER BY bulan ASC
        `);

        // Top 5 Popular Services
        const [topServices] = await db.query(`
            SELECT
                l.id,
                l.nama_layanan,
                l.harga,
                COUNT(bd.id) AS jumlah_dipesan,
                SUM(COALESCE(bd.subtotal, l.harga)) AS total_nominal
            FROM booking_detail bd
            JOIN layanan l ON bd.layanan_id = l.id
            GROUP BY l.id, l.nama_layanan, l.harga
            ORDER BY jumlah_dipesan DESC
            LIMIT 5
        `);

        const stats = bookingStats[0] || {};

        return res.json({
            success: true,
            data: {
                totalUsers: userCount[0]?.total || 0,
                totalVehicles: vehicleCount[0]?.total || 0,
                totalBookings: stats.total || 0,
                bookingStatus: {
                    menunggu: stats.menunggu || 0,
                    dikonfirmasi: stats.dikonfirmasi || 0,
                    diproses: stats.diproses || 0,
                    selesai: stats.selesai || 0,
                    dibatalkan: stats.dibatalkan || 0,
                },
                totalRevenue: Number(stats.total_pendapatan || 0),
                revenueThisMonth: Number(currentMonthRev[0]?.total_bulan_ini || 0),
                recentBookings,
                monthlyStats,
                topServices,
            },
        });
    } catch (err) {
        console.error("Dashboard error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal memuat statistik dashboard",
            error: err.message,
        });
    }
};

// ==========================================
// 3. USER MANAGEMENT
// ==========================================

/**
 * GET /api/admin/users
 * Query params: q (search string), role, status, page, limit
 */
const getUsers = async (req, res) => {
    try {
        const { q, role, status, page = 1, limit = 50 } = req.query;
        const offset = (Number(page) - 1) * Number(limit);

        let query = `
            SELECT
                u.id,
                u.nama,
                u.nama_lengkap,
                u.email,
                u.no_hp,
                u.kontak,
                COALESCE(u.role, 'user') AS role,
                COALESCE(u.status, 'aktif') AS status,
                u.foto,
                u.created_at,
                (SELECT COUNT(*) FROM kendaraan k WHERE k.user_id = u.id) AS total_kendaraan,
                (SELECT COUNT(*) FROM booking b WHERE b.user_id = u.id) AS total_booking
            FROM users u
            WHERE 1=1
        `;
        const params = [];

        if (q && q.trim()) {
            query += ` AND (u.nama LIKE ? OR u.email LIKE ? OR u.no_hp LIKE ?)`;
            const searchPattern = `%${q.trim()}%`;
            params.push(searchPattern, searchPattern, searchPattern);
        }

        if (role) {
            query += ` AND u.role = ?`;
            params.push(role);
        }

        if (status) {
            query += ` AND u.status = ?`;
            params.push(status);
        }

        query += ` ORDER BY u.id DESC LIMIT ? OFFSET ?`;
        params.push(Number(limit), Number(offset));

        const [users] = await db.query(query, params);

        // Get total count for pagination
        let countQuery = `SELECT COUNT(*) AS total FROM users u WHERE 1=1`;
        const countParams = [];
        if (q && q.trim()) {
            countQuery += ` AND (u.nama LIKE ? OR u.email LIKE ? OR u.no_hp LIKE ?)`;
            const searchPattern = `%${q.trim()}%`;
            countParams.push(searchPattern, searchPattern, searchPattern);
        }
        if (role) {
            countQuery += ` AND u.role = ?`;
            countParams.push(role);
        }
        if (status) {
            countQuery += ` AND u.status = ?`;
            countParams.push(status);
        }
        const [totalRows] = await db.query(countQuery, countParams);

        return res.json({
            success: true,
            data: users,
            pagination: {
                total: totalRows[0]?.total || 0,
                page: Number(page),
                limit: Number(limit),
                totalPages: Math.ceil((totalRows[0]?.total || 0) / Number(limit)),
            },
        });
    } catch (err) {
        console.error("getUsers error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil daftar pengguna",
            error: err.message,
        });
    }
};

/**
 * GET /api/admin/users/:id
 * Get full profile with vehicles and bookings
 */
const getUserDetail = async (req, res) => {
    try {
        const { id } = req.params;

        const [users] = await db.query(
            `SELECT id, nama, nama_lengkap, email, no_hp, kontak, COALESCE(role, 'user') AS role, COALESCE(status, 'aktif') AS status, foto, created_at, updated_at
             FROM users WHERE id = ?`,
            [id]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Pengguna tidak ditemukan",
            });
        }

        const user = users[0];

        // Fetch their vehicles
        const [vehicles] = await db.query(
            `SELECT * FROM kendaraan WHERE user_id = ? ORDER BY id DESC`,
            [id]
        );

        // Fetch their bookings
        const [bookings] = await db.query(
            `SELECT b.*, bgk.nama_bengkel
             FROM booking b
             LEFT JOIN bengkel bgk ON b.bengkel_id = bgk.id
             WHERE b.user_id = ?
             ORDER BY b.id DESC`,
            [id]
        );

        return res.json({
            success: true,
            data: {
                ...user,
                kendaraan: vehicles,
                booking: bookings,
            },
        });
    } catch (err) {
        console.error("getUserDetail error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal memuat detail pengguna",
            error: err.message,
        });
    }
};

/**
 * PUT /api/admin/users/:id
 * Update user details
 */
const updateUser = async (req, res) => {
    try {
        const { id } = req.params;
        const { nama, email, no_hp, role, status } = req.body;

        const [existing] = await db.query("SELECT * FROM users WHERE id = ?", [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Pengguna tidak ditemukan",
            });
        }

        const updates = [];
        const params = [];

        if (nama !== undefined) {
            updates.push("nama = ?", "nama_lengkap = ?");
            params.push(nama.trim(), nama.trim());
        }
        if (email !== undefined) {
            updates.push("email = ?");
            params.push(email.trim().toLowerCase());
        }
        if (no_hp !== undefined) {
            updates.push("no_hp = ?", "kontak = ?");
            params.push(no_hp.trim(), no_hp.trim());
        }
        if (role !== undefined) {
            updates.push("role = ?");
            params.push(role);
        }
        if (status !== undefined) {
            updates.push("status = ?");
            params.push(status);
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Tidak ada data yang diperbarui",
            });
        }

        params.push(id);
        await db.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, params);

        return res.json({
            success: true,
            message: "Data pengguna berhasil diperbarui",
        });
    } catch (err) {
        console.error("updateUser error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal memperbarui pengguna",
            error: err.message,
        });
    }
};

/**
 * DELETE /api/admin/users/:id
 * Toggle status or delete user
 */
const deleteUser = async (req, res) => {
    try {
        const { id } = req.params;
        // Don't allow admin to delete themselves
        if (Number(id) === Number(req.user.id)) {
            return res.status(400).json({
                success: false,
                message: "Anda tidak dapat menghapus akun Anda sendiri.",
            });
        }

        // Check if user has active bookings
        const [activeBookings] = await db.query(
            "SELECT id FROM booking WHERE user_id = ? AND status IN ('menunggu', 'dikonfirmasi', 'diproses')",
            [id]
        );

        if (activeBookings.length > 0) {
            // Just deactivate the user instead of deleting
            await db.query("UPDATE users SET status = 'nonaktif' WHERE id = ?", [id]);
            return res.json({
                success: true,
                message: "Pengguna memiliki booking aktif sehingga statusnya diubah menjadi nonaktif.",
            });
        }

        // Toggle or delete
        await db.query("UPDATE users SET status = 'nonaktif' WHERE id = ?", [id]);
        return res.json({
            success: true,
            message: "Pengguna berhasil dinonaktifkan.",
        });
    } catch (err) {
        console.error("deleteUser error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal menghapus pengguna",
            error: err.message,
        });
    }
};

// ==========================================
// 4. VEHICLE MANAGEMENT
// ==========================================

/**
 * GET /api/admin/vehicles
 * Query params: q (merek, model, nomor_polisi, nama pemilik)
 */
const getVehicles = async (req, res) => {
    try {
        const { q, merek } = req.query;

        let query = `
            SELECT
                k.id,
                k.user_id,
                k.merek,
                k.model,
                k.tahun,
                k.nomor_polisi,
                k.kilometer,
                k.created_at,
                k.updated_at,
                u.nama AS nama_pemilik,
                u.email AS email_pemilik,
                u.no_hp AS kontak_pemilik,
                (SELECT COUNT(*) FROM booking b WHERE b.kendaraan_id = k.id) AS total_servis
            FROM kendaraan k
            LEFT JOIN users u ON k.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (q && q.trim()) {
            query += ` AND (k.merek LIKE ? OR k.model LIKE ? OR k.nomor_polisi LIKE ? OR u.nama LIKE ?)`;
            const search = `%${q.trim()}%`;
            params.push(search, search, search, search);
        }

        if (merek && merek.trim()) {
            query += ` AND LOWER(k.merek) = ?`;
            params.push(merek.trim().toLowerCase());
        }

        query += ` ORDER BY k.id DESC`;

        const [vehicles] = await db.query(query, params);

        return res.json({
            success: true,
            data: vehicles,
        });
    } catch (err) {
        console.error("getVehicles error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil data kendaraan",
            error: err.message,
        });
    }
};

// ==========================================
// 5. BOOKING MANAGEMENT
// ==========================================

/**
 * GET /api/admin/bookings
 * Query params: status, startDate, endDate, q
 */
const getBookings = async (req, res) => {
    try {
        const { status, startDate, endDate, q } = req.query;

        let query = `
            SELECT
                b.id,
                b.kode_booking,
                b.user_id,
                b.kendaraan_id,
                b.bengkel_id,
                b.tanggal_booking,
                b.jam_booking,
                b.keluhan,
                b.total_harga,
                b.status,
                b.catatan_admin,
                b.created_at,
                b.updated_at,
                u.nama AS nama_pelanggan,
                u.email AS email_pelanggan,
                u.no_hp AS no_hp_pelanggan,
                k.merek,
                k.model,
                k.tahun,
                k.nomor_polisi,
                bgk.nama_bengkel,
                bgk.alamat AS alamat_bengkel,
                p.transaction_status AS status_pembayaran,
                p.metode_pembayaran,
                p.status_verifikasi
            FROM booking b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN kendaraan k ON b.kendaraan_id = k.id
            LEFT JOIN bengkel bgk ON b.bengkel_id = bgk.id
            LEFT JOIN payments p ON b.id = p.booking_id
            WHERE 1=1
        `;
        const params = [];

        if (status && status !== "semua") {
            query += ` AND b.status = ?`;
            params.push(status);
        }

        if (startDate) {
            query += ` AND b.tanggal_booking >= ?`;
            params.push(startDate);
        }

        if (endDate) {
            query += ` AND b.tanggal_booking <= ?`;
            params.push(endDate);
        }

        if (q && q.trim()) {
            query += ` AND (b.kode_booking LIKE ? OR u.nama LIKE ? OR k.nomor_polisi LIKE ?)`;
            const search = `%${q.trim()}%`;
            params.push(search, search, search);
        }

        query += ` ORDER BY b.id DESC`;

        const [bookings] = await db.query(query, params);

        // Fetch detail layanan for each booking
        const bookingIds = bookings.map((b) => b.id);
        let detailsMap = {};

        if (bookingIds.length > 0) {
            const [details] = await db.query(
                `SELECT bd.booking_id, bd.layanan_id, bd.harga, bd.qty, bd.subtotal, l.nama_layanan
                 FROM booking_detail bd
                 LEFT JOIN layanan l ON bd.layanan_id = l.id
                 WHERE bd.booking_id IN (${bookingIds.map(() => "?").join(",")})`,
                bookingIds
            );

            details.forEach((d) => {
                if (!detailsMap[d.booking_id]) {
                    detailsMap[d.booking_id] = [];
                }
                detailsMap[d.booking_id].push(d);
            });
        }

        const enriched = bookings.map((b) => ({
            ...b,
            layanan_list: detailsMap[b.id] || [],
        }));

        return res.json({
            success: true,
            data: enriched,
        });
    } catch (err) {
        console.error("getBookings error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil daftar booking",
            error: err.message,
        });
    }
};

/**
 * PUT /api/admin/bookings/:id/status
 * Body: { status, catatan_admin }
 * Transitions allowed:
 * menunggu -> dikonfirmasi
 * dikonfirmasi -> diproses
 * diproses -> selesai
 * any -> dibatalkan (with reason)
 */
const updateBookingStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, catatan_admin } = req.body;

        const allowedStatuses = ["menunggu", "dikonfirmasi", "diproses", "selesai", "dibatalkan"];
        if (!allowedStatuses.includes(status)) {
            return res.status(400).json({
                success: false,
                message: "Status tidak valid. Pilihan: " + allowedStatuses.join(", "),
            });
        }

        const [rows] = await db.query("SELECT * FROM booking WHERE id = ?", [id]);
        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Booking tidak ditemukan",
            });
        }

        const currentBooking = rows[0];

        // Validasi pembatalan harus ada alasan jika status dibatalkan
        let note = catatan_admin !== undefined ? catatan_admin : currentBooking.catatan_admin;

        await db.query(
            "UPDATE booking SET status = ?, catatan_admin = ?, updated_at = NOW() WHERE id = ?",
            [status, note, id]
        );

        // Jika selesai, jika ada payment manual, update status settlement
        if (status === "selesai") {
            await db.query(
                "UPDATE payments SET transaction_status = 'settlement', status_verifikasi = 'terverifikasi', settlement_time = NOW() WHERE booking_id = ? AND transaction_status != 'settlement'",
                [id]
            );
        }

        return res.json({
            success: true,
            message: `Status booking #${currentBooking.kode_booking} berhasil diubah menjadi ${status}`,
            data: {
                id,
                kode_booking: currentBooking.kode_booking,
                status,
                catatan_admin: note,
            },
        });
    } catch (err) {
        console.error("updateBookingStatus error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengubah status booking",
            error: err.message,
        });
    }
};

// ==========================================
// 6. SERVICE HISTORY
// ==========================================

/**
 * GET /api/admin/service-history
 * Returns completed bookings with service details, cost, dates
 */
const getServiceHistory = async (req, res) => {
    try {
        const { startDate, endDate, q } = req.query;

        let query = `
            SELECT
                b.id,
                b.kode_booking,
                b.tanggal_booking,
                b.jam_booking,
                b.keluhan,
                b.total_harga,
                b.status,
                b.catatan_admin,
                b.created_at,
                u.nama AS nama_pelanggan,
                u.email AS email_pelanggan,
                u.no_hp AS no_hp_pelanggan,
                k.merek,
                k.model,
                k.nomor_polisi,
                bgk.nama_bengkel,
                p.transaction_status AS status_pembayaran,
                p.metode_pembayaran
            FROM booking b
            LEFT JOIN users u ON b.user_id = u.id
            LEFT JOIN kendaraan k ON b.kendaraan_id = k.id
            LEFT JOIN bengkel bgk ON b.bengkel_id = bgk.id
            LEFT JOIN payments p ON b.id = p.booking_id
            WHERE b.status = 'selesai'
        `;
        const params = [];

        if (startDate) {
            query += ` AND b.tanggal_booking >= ?`;
            params.push(startDate);
        }

        if (endDate) {
            query += ` AND b.tanggal_booking <= ?`;
            params.push(endDate);
        }

        if (q && q.trim()) {
            query += ` AND (b.kode_booking LIKE ? OR u.nama LIKE ? OR k.nomor_polisi LIKE ?)`;
            const search = `%${q.trim()}%`;
            params.push(search, search, search);
        }

        query += ` ORDER BY b.tanggal_booking DESC, b.id DESC`;

        const [history] = await db.query(query, params);

        return res.json({
            success: true,
            data: history,
        });
    } catch (err) {
        console.error("getServiceHistory error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil riwayat servis",
            error: err.message,
        });
    }
};

// ==========================================
// 7. PAYMENTS MANAGEMENT
// ==========================================

/**
 * GET /api/admin/payments
 * Query params: status, q
 */
const getPayments = async (req, res) => {
    try {
        const { status, q } = req.query;

        let query = `
            SELECT
                p.id,
                p.booking_id,
                p.order_id,
                p.gross_amount,
                p.transaction_status,
                p.payment_type,
                p.metode_pembayaran,
                p.status_verifikasi,
                p.bukti_transfer,
                p.catatan,
                p.transaction_time,
                p.settlement_time,
                p.created_at,
                b.kode_booking,
                b.status AS status_booking,
                u.nama AS nama_pelanggan,
                u.email AS email_pelanggan,
                u.no_hp AS no_hp_pelanggan
            FROM payments p
            LEFT JOIN booking b ON p.booking_id = b.id
            LEFT JOIN users u ON b.user_id = u.id
            WHERE 1=1
        `;
        const params = [];

        if (status && status !== "semua") {
            query += ` AND (p.transaction_status = ? OR p.status_verifikasi = ?)`;
            params.push(status, status);
        }

        if (q && q.trim()) {
            query += ` AND (p.order_id LIKE ? OR b.kode_booking LIKE ? OR u.nama LIKE ?)`;
            const search = `%${q.trim()}%`;
            params.push(search, search, search);
        }

        query += ` ORDER BY p.id DESC`;

        const [payments] = await db.query(query, params);

        return res.json({
            success: true,
            data: payments,
        });
    } catch (err) {
        console.error("getPayments error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil daftar pembayaran",
            error: err.message,
        });
    }
};

/**
 * PUT /api/admin/payments/:id/verify
 * Body: { status_verifikasi: 'terverifikasi' | 'ditolak', catatan }
 */
const verifyPayment = async (req, res) => {
    try {
        const { id } = req.params;
        const { status_verifikasi, catatan } = req.body;

        if (!["terverifikasi", "ditolak"].includes(status_verifikasi)) {
            return res.status(400).json({
                success: false,
                message: "Status verifikasi harus 'terverifikasi' atau 'ditolak'",
            });
        }

        const [payments] = await db.query("SELECT * FROM payments WHERE id = ?", [id]);
        if (payments.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data pembayaran tidak ditemukan",
            });
        }

        const payment = payments[0];
        const newTxStatus = status_verifikasi === "terverifikasi" ? "settlement" : "deny";

        await db.query(
            `UPDATE payments
             SET status_verifikasi = ?,
                 transaction_status = ?,
                 catatan = COALESCE(?, catatan),
                 settlement_time = ${status_verifikasi === "terverifikasi" ? "NOW()" : "NULL"},
                 updated_at = NOW()
             WHERE id = ?`,
            [status_verifikasi, newTxStatus, catatan || null, id]
        );

        // Jika diverifikasi, konfirmasi booking secara otomatis jika statusnya 'menunggu'
        if (status_verifikasi === "terverifikasi" && payment.booking_id) {
            await db.query(
                "UPDATE booking SET status = 'dikonfirmasi' WHERE id = ? AND status = 'menunggu'",
                [payment.booking_id]
            );
        }

        return res.json({
            success: true,
            message: `Pembayaran berhasil ${status_verifikasi === "terverifikasi" ? "diverifikasi" : "ditolak"}`,
        });
    } catch (err) {
        console.error("verifyPayment error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal memverifikasi pembayaran",
            error: err.message,
        });
    }
};

// ==========================================
// 8. SERVICES (LAYANAN) CRUD
// ==========================================

/**
 * GET /api/admin/services
 */
const getServices = async (req, res) => {
    try {
        const [services] = await db.query(
            `SELECT
                l.*,
                (SELECT COUNT(*) FROM booking_detail bd WHERE bd.layanan_id = l.id) AS total_dipakai
             FROM layanan l
             ORDER BY l.id ASC`
        );

        return res.json({
            success: true,
            data: services,
        });
    } catch (err) {
        console.error("getServices error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil daftar layanan",
            error: err.message,
        });
    }
};

/**
 * POST /api/admin/services
 * Body: { nama_layanan, deskripsi, harga, estimasi_menit, foto, status }
 */
const createService = async (req, res) => {
    try {
        const { nama_layanan, deskripsi, harga, estimasi_menit, foto, status } = req.body;

        if (!nama_layanan || !harga) {
            return res.status(400).json({
                success: false,
                message: "Nama layanan dan harga wajib diisi",
            });
        }

        const [result] = await db.query(
            `INSERT INTO layanan (nama_layanan, deskripsi, harga, estimasi_menit, foto, status)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                nama_layanan.trim(),
                deskripsi || "",
                Number(harga),
                Number(estimasi_menit) || 60,
                foto || "",
                status || "aktif",
            ]
        );

        return res.status(201).json({
            success: true,
            message: "Layanan baru berhasil ditambahkan",
            data: {
                id: result.insertId,
                nama_layanan,
                harga: Number(harga),
                status: status || "aktif",
            },
        });
    } catch (err) {
        console.error("createService error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal membuat layanan",
            error: err.message,
        });
    }
};

/**
 * PUT /api/admin/services/:id
 */
const updateService = async (req, res) => {
    try {
        const { id } = req.params;
        const { nama_layanan, deskripsi, harga, estimasi_menit, foto, status } = req.body;

        const [existing] = await db.query("SELECT * FROM layanan WHERE id = ?", [id]);
        if (existing.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Layanan tidak ditemukan",
            });
        }

        await db.query(
            `UPDATE layanan
             SET nama_layanan = COALESCE(?, nama_layanan),
                 deskripsi = COALESCE(?, deskripsi),
                 harga = COALESCE(?, harga),
                 estimasi_menit = COALESCE(?, estimasi_menit),
                 foto = COALESCE(?, foto),
                 status = COALESCE(?, status)
             WHERE id = ?`,
            [
                nama_layanan !== undefined ? nama_layanan.trim() : null,
                deskripsi !== undefined ? deskripsi : null,
                harga !== undefined ? Number(harga) : null,
                estimasi_menit !== undefined ? Number(estimasi_menit) : null,
                foto !== undefined ? foto : null,
                status !== undefined ? status : null,
                id,
            ]
        );

        return res.json({
            success: true,
            message: "Layanan berhasil diperbarui",
        });
    } catch (err) {
        console.error("updateService error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal memperbarui layanan",
            error: err.message,
        });
    }
};

/**
 * DELETE /api/admin/services/:id
 * Toggle status or remove
 */
const deleteService = async (req, res) => {
    try {
        const { id } = req.params;

        // Check if referenced in booking_detail
        const [refs] = await db.query(
            "SELECT COUNT(*) AS total FROM booking_detail WHERE layanan_id = ?",
            [id]
        );

        if (refs[0]?.total > 0) {
            // Soft delete by setting status nonaktif
            await db.query("UPDATE layanan SET status = 'nonaktif' WHERE id = ?", [id]);
            return res.json({
                success: true,
                message: "Layanan pernah digunakan pada booking servis, status diubah menjadi 'nonaktif'.",
            });
        }

        await db.query("DELETE FROM layanan WHERE id = ?", [id]);
        return res.json({
            success: true,
            message: "Layanan berhasil dihapus",
        });
    } catch (err) {
        console.error("deleteService error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal menghapus layanan",
            error: err.message,
        });
    }
};

// ==========================================
// 9. REPORTS & ANALYTICS
// ==========================================

/**
 * GET /api/admin/reports
 * Aggregated analytics for revenue, bookings, status breakdown
 */
const getReports = async (req, res) => {
    try {
        const { year = new Date().getFullYear() } = req.query;

        // Revenue per month in chosen year
        const [monthly] = await db.query(
            `SELECT
                MONTH(tanggal_booking) AS bulan,
                COUNT(*) AS total_booking,
                SUM(CASE WHEN status = 'selesai' THEN 1 ELSE 0 END) AS booking_selesai,
                SUM(CASE WHEN status = 'dibatalkan' THEN 1 ELSE 0 END) AS booking_batal,
                COALESCE(SUM(CASE WHEN status = 'selesai' THEN total_harga ELSE 0 END), 0) AS total_pendapatan
             FROM booking
             WHERE YEAR(tanggal_booking) = ?
             GROUP BY MONTH(tanggal_booking)
             ORDER BY bulan ASC`,
            [Number(year)]
        );

        // Overall stats
        const [overall] = await db.query(`
            SELECT
                COUNT(*) AS grand_total_booking,
                SUM(CASE WHEN status = 'selesai' THEN 1 ELSE 0 END) AS grand_total_selesai,
                SUM(CASE WHEN status = 'dibatalkan' THEN 1 ELSE 0 END) AS grand_total_batal,
                COALESCE(SUM(CASE WHEN status = 'selesai' THEN total_harga ELSE 0 END), 0) AS grand_total_pendapatan,
                COALESCE(AVG(CASE WHEN status = 'selesai' THEN total_harga ELSE NULL END), 0) AS rata_rata_booking
            FROM booking
        `);

        // Service performance breakdown
        const [servicesSummary] = await db.query(`
            SELECT
                l.id,
                l.nama_layanan,
                COUNT(bd.id) AS total_order,
                COALESCE(SUM(bd.subtotal), 0) AS total_omset
            FROM layanan l
            LEFT JOIN booking_detail bd ON l.id = bd.layanan_id
            GROUP BY l.id, l.nama_layanan
            ORDER BY total_omset DESC
        `);

        return res.json({
            success: true,
            data: {
                year: Number(year),
                monthly,
                overall: overall[0] || {},
                servicesSummary,
            },
        });
    } catch (err) {
        console.error("getReports error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal membuat laporan analitik",
            error: err.message,
        });
    }
};

// ==========================================
// 10. SETTINGS
// ==========================================

/**
 * GET /api/admin/settings
 */
const getSettings = async (req, res) => {
    try {
        const [rows] = await db.query("SELECT * FROM admin_settings ORDER BY id ASC LIMIT 1");
        const settings = rows.length > 0 ? rows[0] : {};

        return res.json({
            success: true,
            data: settings,
        });
    } catch (err) {
        console.error("getSettings error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal mengambil pengaturan admin",
            error: err.message,
        });
    }
};

/**
 * PUT /api/admin/settings
 * Body: { nama_admin, kontak_admin, nama_autocare, alamat_autocare }
 */
const updateSettings = async (req, res) => {
    try {
        const { nama_admin, kontak_admin, nama_autocare, alamat_autocare } = req.body;

        const [rows] = await db.query("SELECT id FROM admin_settings LIMIT 1");

        if (rows.length === 0) {
            await db.query(
                `INSERT INTO admin_settings (nama_admin, kontak_admin, nama_autocare, alamat_autocare)
                 VALUES (?, ?, ?, ?)`,
                [nama_admin || "", kontak_admin || "", nama_autocare || "", alamat_autocare || ""]
            );
        } else {
            await db.query(
                `UPDATE admin_settings
                 SET nama_admin = COALESCE(?, nama_admin),
                     kontak_admin = COALESCE(?, kontak_admin),
                     nama_autocare = COALESCE(?, nama_autocare),
                     alamat_autocare = COALESCE(?, alamat_autocare),
                     updated_at = NOW()
                 WHERE id = ?`,
                [nama_admin, kontak_admin, nama_autocare, alamat_autocare, rows[0].id]
            );
        }

        return res.json({
            success: true,
            message: "Pengaturan berhasil disimpan",
        });
    } catch (err) {
        console.error("updateSettings error:", err);
        return res.status(500).json({
            success: false,
            message: "Gagal menyimpan pengaturan",
            error: err.message,
        });
    }
};

module.exports = {
    login,
    getMe,
    getDashboard,
    getUsers,
    getUserDetail,
    updateUser,
    deleteUser,
    getVehicles,
    getBookings,
    updateBookingStatus,
    getServiceHistory,
    getPayments,
    verifyPayment,
    getServices,
    createService,
    updateService,
    deleteService,
    getReports,
    getSettings,
    updateSettings,
};
