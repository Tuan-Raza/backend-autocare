const bcrypt = require("bcryptjs");
const { db } = require("../config/database");
const mailer = require("../utils/mailer");

// =====================================================
// REQUEST UBAH EMAIL
// =====================================================
const requestEmailChange = async (req, res) => {
    try {
        const { userId, newEmail, password } = req.body;

        if (!userId || !newEmail || !password) {
            return res.status(400).json({
                success: false,
                message: "Semua data wajib diisi",
            });
        }

        const email = newEmail.trim().toLowerCase();

        // Validasi format email
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: "Format email tidak valid",
            });
        }

        // Ambil data user
        const [users] = await db.query(
            `
            SELECT id, nama, email, password
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [userId]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User tidak ditemukan",
            });
        }

        const user = users[0];

        // Email baru sama dengan email lama
        if (email.toLowerCase() === user.email.toLowerCase()) {
            return res.status(400).json({
                success: false,
                message: "Email baru sama dengan email saat ini",
            });
        }

        // Cek password saat ini
        const passwordValid = await bcrypt.compare(
            password,
            user.password
        );

        if (!passwordValid) {
            return res.status(401).json({
                success: false,
                message: "Password saat ini salah",
            });
        }

        // Cek apakah email sudah digunakan user lain
        const [existingEmail] = await db.query(
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = LOWER(?)
            AND id != ?
            LIMIT 1
            `,
            [email, userId]
        );

        if (existingEmail.length > 0) {
            return res.status(409).json({
                success: false,
                message: "Email tersebut sudah digunakan akun lain",
            });
        }

        // Cek cooldown 60 detik jika sebelumnya sudah meminta OTP
        const [existingChange] = await db.query(
            `SELECT (UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(created_at)) AS elapsed_seconds
             FROM email_changes
             WHERE user_id = ?
             ORDER BY id DESC
             LIMIT 1`,
            [userId]
        );

        if (
            existingChange.length > 0 &&
            existingChange[0].elapsed_seconds !== null &&
            existingChange[0].elapsed_seconds < 60
        ) {
            const remaining = 60 - Math.floor(existingChange[0].elapsed_seconds);
            return res.status(429).json({
                success: false,
                message: `Harap tunggu ${remaining} detik sebelum meminta kode OTP baru.`,
                retryAfter: remaining,
            });
        }

        // Generate OTP 6 digit
        const kode = Math.floor(100000 + Math.random() * 900000).toString();

        // Berlaku maksimal 5 menit
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // Hash OTP sebelum disimpan di database
        const hashedKode = await bcrypt.hash(kode, 10);

        // Hapus request OTP lama milik user
        await db.query(
            `
            DELETE FROM email_changes
            WHERE user_id = ?
            `,
            [userId]
        );

        // Simpan request perubahan email dengan hashed kode dan attempts counter
        await db.query(
            `
            INSERT INTO email_changes
            (
                user_id,
                old_email,
                new_email,
                kode,
                expires_at,
                attempts
            )
            VALUES (?, ?, ?, ?, ?, 0)
            `,
            [
                user.id,
                user.email,
                email,
                hashedKode,
                expiresAt,
            ]
        );

        // Kirim OTP ke EMAIL BARU dengan handling aman
        let mailSent = false;
        try {
            const mailRes = await mailer.sendVerificationEmail(
                email,
                kode,
                user.nama
            );
            if (mailRes && mailRes.sent) mailSent = true;
        } catch (err) {
            console.error("Gagal mengirim email ubah email:", err.message);
        }

        if (!mailSent) {
            await db.query(
                `DELETE FROM email_changes WHERE user_id = ?`,
                [user.id]
            );
            return res.status(500).json({
                success: false,
                message: "Gagal mengirim kode verifikasi ke email baru. Silakan coba beberapa saat lagi.",
            });
        }

        // Log aman tanpa membocorkan kode OTP
        console.log(`[UBAH EMAIL OTP] New Email: ${email}`);

        // Response aman tanpa kode OTP
        return res.json({
            success: true,
            message: "Kode OTP verifikasi berhasil dikirim ke email baru. Silakan periksa folder kotak masuk atau spam.",
        });
    } catch (error) {
        console.error("Request Email Change Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Gagal mengirim kode OTP",
            error: error.message,
        });
    }
};

// =====================================================
// VERIFIKASI OTP & UPDATE EMAIL
// =====================================================
const verifyEmailChange = async (req, res) => {
    try {
        const { userId, kode } = req.body;

        if (!userId || !kode) {
            return res.status(400).json({
                success: false,
                message: "User ID dan kode OTP wajib diisi",
            });
        }

        const kodeClean = String(kode).trim();

        const [rows] = await db.query(
            `
            SELECT *
            FROM email_changes
            WHERE user_id = ?
            ORDER BY id DESC
            LIMIT 1
            `,
            [userId]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Permintaan perubahan email tidak ditemukan atau sudah diproses",
            });
        }

        const change = rows[0];

        // Cek batas percobaan
        if (change.attempts >= 5) {
            await db.query("DELETE FROM email_changes WHERE id = ?", [change.id]);
            return res.status(400).json({
                success: false,
                message: "Batas percobaan verifikasi telah habis (maksimal 5 kali). Silakan minta kode baru.",
            });
        }

        // Cek expired (maksimal 5 menit)
        if (new Date(change.expires_at).getTime() < Date.now()) {
            await db.query(
                `
                DELETE FROM email_changes
                WHERE id = ?
                `,
                [change.id]
            );

            return res.status(400).json({
                success: false,
                message: "Kode OTP sudah kedaluwarsa. Silakan minta kode baru.",
            });
        }

        // Cek kecocokan OTP (support bcrypt hash atau plain text)
        const isOtpValid = change.kode.startsWith("$2")
            ? await bcrypt.compare(kodeClean, change.kode)
            : String(change.kode) === kodeClean;

        if (!isOtpValid) {
            const nextAttempts = (change.attempts || 0) + 1;
            await db.query(
                "UPDATE email_changes SET attempts = attempts + 1 WHERE id = ?",
                [change.id]
            );

            const remainingAttempts = Math.max(0, 5 - nextAttempts);

            if (remainingAttempts === 0) {
                await db.query("DELETE FROM email_changes WHERE id = ?", [change.id]);
                return res.status(400).json({
                    success: false,
                    message: "Kode OTP salah. Batas percobaan habis. Silakan minta kode baru.",
                });
            }

            return res.status(400).json({
                success: false,
                message: `Kode OTP salah. Sisa percobaan: ${remainingAttempts} kali.`,
            });
        }

        // Cek lagi apakah email masih tersedia
        const [existingEmail] = await db.query(
            `
            SELECT id
            FROM users
            WHERE LOWER(email) = LOWER(?)
            AND id != ?
            LIMIT 1
            `,
            [change.new_email, userId]
        );

        if (existingEmail.length > 0) {
            await db.query(
                `
                DELETE FROM email_changes
                WHERE id = ?
                `,
                [change.id]
            );

            return res.status(409).json({
                success: false,
                message: "Email tersebut sudah digunakan akun lain",
            });
        }

        // Update email user
        await db.query(
            `
            UPDATE users
            SET email = ?
            WHERE id = ?
            `,
            [change.new_email, userId]
        );

        // Hapus OTP setelah berhasil agar tidak bisa digunakan kembali
        await db.query(
            `
            DELETE FROM email_changes
            WHERE id = ?
            `,
            [change.id]
        );

        // Ambil data user terbaru
        const [updatedUsers] = await db.query(
            `
            SELECT id, nama, email, no_hp
            FROM users
            WHERE id = ?
            LIMIT 1
            `,
            [userId]
        );

        return res.json({
            success: true,
            message: "Email berhasil diubah",
            data: updatedUsers[0],
        });
    } catch (error) {
        console.error("Verify Email Change Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Gagal memverifikasi email",
            error: error.message,
        });
    }
};

module.exports = {
    requestEmailChange,
    verifyEmailChange,
};
