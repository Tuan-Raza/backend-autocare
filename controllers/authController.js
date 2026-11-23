const { db } = require("../config/database");
const bcrypt = require("bcryptjs");
const mailer = require("../utils/mailer");

// ===============================
// REGISTER
// ===============================
const register = async (req, res) => {
    try {
        const { nama, email, noHp, password } = req.body;

        if (!nama || !email || !password) {
            return res.status(400).json({
                success: false,
                message: "Nama, email, dan password wajib diisi",
            });
        }

        const emailClean = email.trim().toLowerCase();
        const namaClean = nama.trim();
        const noHpClean = noHp ? noHp.trim() : "";

        // Validasi format email dasar
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(emailClean)) {
            return res.status(400).json({
                success: false,
                message: "Format email tidak valid",
            });
        }

        // Cek apakah email sudah menjadi user
        const [existingUser] = await db.query(
            "SELECT id FROM users WHERE LOWER(email) = ?",
            [emailClean]
        );

        if (existingUser.length > 0) {
            return res.status(400).json({
                success: false,
                message: "Email sudah terdaftar. Silakan langsung login.",
            });
        }

        // Password di-hash sebelum disimpan sementara
        const hashedPassword = await bcrypt.hash(password, 10);

        // Generate OTP 6 digit
        const kode = Math.floor(100000 + Math.random() * 900000).toString();

        // OTP berlaku maksimal 5 menit
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // Hash OTP sebelum disimpan di database demi keamanan
        const hashedKode = await bcrypt.hash(kode, 10);

        // Hapus OTP lama untuk email tersebut
        await db.query(
            "DELETE FROM email_verifications WHERE LOWER(email) = ?",
            [emailClean]
        );

        // Simpan data sementara dengan hashed OTP dan attempts counter
        await db.query(
            `INSERT INTO email_verifications
            (
                nama,
                email,
                no_hp,
                password,
                kode,
                expires_at,
                attempts
            )
            VALUES (?, ?, ?, ?, ?, ?, 0)`,
            [
                namaClean,
                emailClean,
                noHpClean,
                hashedPassword,
                hashedKode,
                expiresAt,
            ]
        );

        // Kirim OTP HANYA melalui email menggunakan Nodemailer
        let mailSent = false;
        try {
            const mailRes = await mailer.sendVerificationEmail(
                emailClean,
                kode,
                namaClean
            );
            if (mailRes && mailRes.sent) {
                mailSent = true;
            }
        } catch (mailErr) {
            console.error("Gagal mengirim email pendaftaran:", mailErr.message);
        }

        // Jika email gagal dikirim, hapus data verifikasi dan kirim response error aman
        if (!mailSent) {
            await db.query(
                "DELETE FROM email_verifications WHERE LOWER(email) = ?",
                [emailClean]
            );
            return res.status(500).json({
                success: false,
                message: "Gagal mengirim email verifikasi. Pastikan alamat email aktif atau coba beberapa saat lagi.",
            });
        }

        // Log aman tanpa membocorkan kode OTP
        console.log(`[PENDAFTARAN SUKSES] Email: ${emailClean}`);

        // Response aman tanpa kode OTP di JSON maupun pesan
        return res.status(201).json({
            success: true,
            message: "Kode verifikasi telah dikirim ke email Anda. Silakan periksa kotak masuk atau spam email Anda.",
        });
    } catch (error) {
        console.error("Register Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Gagal melakukan registrasi",
            error: error.message,
        });
    }
};

// ===============================
// VERIFY EMAIL
// ===============================
const verifyEmail = async (req, res) => {
    try {
        const { email, kode } = req.body;

        if (!email || !kode) {
            return res.status(400).json({
                success: false,
                message: "Email dan kode verifikasi wajib diisi",
            });
        }

        const emailClean = email.trim().toLowerCase();
        const kodeClean = String(kode).trim();

        // Ambil data verifikasi terbaru
        const [verification] = await db.query(
            `SELECT *
             FROM email_verifications
             WHERE LOWER(email) = ?
             ORDER BY id DESC
             LIMIT 1`,
            [emailClean]
        );

        if (verification.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data verifikasi tidak ditemukan atau akun sudah diverifikasi. Silakan login atau daftar ulang.",
            });
        }

        const data = verification[0];

        // Cek batas percobaan verifikasi (maksimal 5 kali)
        if (data.attempts >= 5) {
            await db.query(
                "DELETE FROM email_verifications WHERE id = ?",
                [data.id]
            );
            return res.status(400).json({
                success: false,
                message: "Batas percobaan verifikasi telah habis (maksimal 5 kali). Silakan minta kode verifikasi baru.",
            });
        }

        // Cek expired (maksimal 5 menit)
        if (new Date(data.expires_at).getTime() < Date.now()) {
            await db.query(
                "DELETE FROM email_verifications WHERE id = ?",
                [data.id]
            );
            return res.status(400).json({
                success: false,
                message: "Kode verifikasi sudah kedaluwarsa. Silakan minta kode baru.",
            });
        }

        // Verifikasi kecocokan OTP (support bcrypt hash dan legacy plain text)
        const isOtpValid = data.kode.startsWith("$2")
            ? await bcrypt.compare(kodeClean, data.kode)
            : String(data.kode) === kodeClean;

        if (!isOtpValid) {
            const nextAttempts = (data.attempts || 0) + 1;
            await db.query(
                "UPDATE email_verifications SET attempts = attempts + 1 WHERE id = ?",
                [data.id]
            );

            const remainingAttempts = Math.max(0, 5 - nextAttempts);

            if (remainingAttempts === 0) {
                await db.query(
                    "DELETE FROM email_verifications WHERE id = ?",
                    [data.id]
                );
                return res.status(400).json({
                    success: false,
                    message: "Kode verifikasi salah. Batas percobaan habis. Silakan kirim ulang kode baru.",
                });
            }

            return res.status(400).json({
                success: false,
                message: `Kode verifikasi salah. Sisa percobaan: ${remainingAttempts} kali.`,
            });
        }

        // Cek lagi apakah email sudah terdaftar
        const [existingUser] = await db.query(
            "SELECT id FROM users WHERE LOWER(email) = ?",
            [emailClean]
        );

        if (existingUser.length > 0) {
            await db.query(
                "DELETE FROM email_verifications WHERE LOWER(email) = ?",
                [emailClean]
            );

            return res.status(400).json({
                success: false,
                message: "Email sudah terdaftar. Silakan langsung login.",
            });
        }

        // Masukkan user yang sudah terverifikasi
        const [result] = await db.query(
            `INSERT INTO users
            (
                nama,
                email,
                no_hp,
                password,
                nama_lengkap,
                kontak
            )
            VALUES (?, ?, ?, ?, ?, ?)`,
            [
                data.nama,
                data.email,
                data.no_hp || "",
                data.password,
                data.nama,
                data.no_hp || "",
            ]
        );

        // Hapus data OTP pendaftaran agar tidak dapat digunakan kembali (One-Time Use)
        await db.query(
            "DELETE FROM email_verifications WHERE LOWER(email) = ?",
            [emailClean]
        );

        return res.json({
            success: true,
            message: "Email berhasil diverifikasi! Pendaftaran Anda selesai.",
            user: {
                id: result.insertId,
                nama: data.nama,
                email: data.email,
                noHp: data.no_hp,
            },
        });
    } catch (error) {
        console.error("Verify Email Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Gagal melakukan verifikasi email",
            error: error.message,
        });
    }
};

// ===============================
// RESEND VERIFICATION CODE
// ===============================
const resendVerification = async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email wajib diisi",
            });
        }

        const emailClean = email.trim().toLowerCase();

        // Ambil data verifikasi dan hitung selisih detik sejak permintaan terakhir
        const [rows] = await db.query(
            "SELECT *, (UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(created_at)) AS elapsed_seconds FROM email_verifications WHERE LOWER(email) = ? ORDER BY id DESC LIMIT 1",
            [emailClean]
        );

        if (rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Data pendaftaran tidak ditemukan. Silakan lakukan pendaftaran terlebih dahulu.",
            });
        }

        const data = rows[0];

        // Terapkan cooldown 60 detik sebelum dapat mengirim ulang OTP
        if (data.elapsed_seconds !== null && data.elapsed_seconds < 60) {
            const remaining = 60 - Math.floor(data.elapsed_seconds);
            return res.status(429).json({
                success: false,
                message: `Harap tunggu ${remaining} detik sebelum meminta kode verifikasi baru.`,
                retryAfter: remaining,
            });
        }

        const newKode = Math.floor(100000 + Math.random() * 900000).toString();

        // OTP baru berlaku 5 menit
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // Hash OTP baru sebelum disimpan
        const hashedKode = await bcrypt.hash(newKode, 10);

        // Update database: perbarui kode, masa berlaku, reset percobaan, dan perbarui created_at untuk cooldown
        await db.query(
            "UPDATE email_verifications SET kode = ?, expires_at = ?, attempts = 0, created_at = NOW() WHERE id = ?",
            [hashedKode, expiresAt, data.id]
        );

        // Kirim OTP baru melalui email
        let mailSent = false;
        try {
            const mailRes = await mailer.sendVerificationEmail(emailClean, newKode, data.nama);
            if (mailRes && mailRes.sent) mailSent = true;
        } catch (err) {
            console.error("Gagal kirim ulang email verifikasi:", err.message);
        }

        if (!mailSent) {
            return res.status(500).json({
                success: false,
                message: "Gagal mengirim ulang email verifikasi. Silakan coba beberapa saat lagi.",
            });
        }

        // Log aman tanpa kode OTP
        console.log(`[KIRIM ULANG OTP] Email: ${emailClean}`);

        // Response aman tanpa kode OTP
        return res.json({
            success: true,
            message: "Kode verifikasi baru telah dikirim ke email Anda. Silakan periksa folder kotak masuk atau spam.",
        });
    } catch (error) {
        console.error("Resend Verification Error:", error.message);
        return res.status(500).json({
            success: false,
            message: "Gagal mengirim ulang kode verifikasi",
            error: error.message,
        });
    }
};

// ===============================
// LOGIN
// ===============================
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
            "SELECT * FROM users WHERE email = ?",
            [emailClean]
        );

        if (users.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Email atau password salah",
            });
        }

        const user = users[0];

        const passwordMatch = await bcrypt.compare(
            password,
            user.password
        );

        if (!passwordMatch) {
            return res.status(401).json({
                success: false,
                message: "Email atau password salah",
            });
        }

        return res.json({
            success: true,
            message: "Login berhasil",
            user: {
                id: user.id,
                nama: user.nama,
                email: user.email,
                noHp: user.no_hp,
                foto: user.foto,
            },
        });
    } catch (error) {
        console.error("Login Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Terjadi kesalahan server",
        });
    }
};

// ===============================
// FORGOT PASSWORD
// ===============================
const forgotPassword = async (req, res) => {
    try {
        const { email } = req.body;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: "Email wajib diisi",
            });
        }

        const emailClean = email.trim().toLowerCase();

        // Cek apakah email terdaftar
        const [users] = await db.query(
            `SELECT id, nama, email
             FROM users
             WHERE email = ?
             LIMIT 1`,
            [emailClean]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Email tidak terdaftar",
            });
        }

        const user = users[0];

        // Cek cooldown 60 detik jika sebelumnya sudah ada permintaan reset
        const [existingReset] = await db.query(
            `SELECT (UNIX_TIMESTAMP(NOW()) - UNIX_TIMESTAMP(created_at)) AS elapsed_seconds
             FROM password_resets
             WHERE email = ?
             ORDER BY id DESC
             LIMIT 1`,
            [emailClean]
        );

        if (existingReset.length > 0 && existingReset[0].elapsed_seconds !== null && existingReset[0].elapsed_seconds < 60) {
            const remaining = 60 - Math.floor(existingReset[0].elapsed_seconds);
            return res.status(429).json({
                success: false,
                message: `Harap tunggu ${remaining} detik sebelum meminta kode OTP reset password baru.`,
                retryAfter: remaining,
            });
        }

        // Generate OTP 6 digit
        const kode = Math.floor(100000 + Math.random() * 900000).toString();

        // Berlaku maksimal 5 menit
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        // Hash OTP sebelum disimpan
        const hashedKode = await bcrypt.hash(kode, 10);

        // Hapus OTP lama
        await db.query(
            "DELETE FROM password_resets WHERE email = ?",
            [emailClean]
        );

        // Simpan OTP baru dengan hashed kode dan attempts counter
        await db.query(
            `INSERT INTO password_resets
            (
                email,
                kode,
                expires_at,
                attempts
            )
            VALUES (?, ?, ?, 0)`,
            [
                emailClean,
                hashedKode,
                expiresAt,
            ]
        );

        // Kirim OTP ke email
        let mailSent = false;
        try {
            const mailRes = await mailer.sendResetPasswordEmail(
                emailClean,
                kode,
                user.nama
            );
            if (mailRes && mailRes.sent) mailSent = true;
        } catch (emailError) {
            console.error("Reset Password Email Error:", emailError.message);
        }

        if (!mailSent) {
            await db.query(
                "DELETE FROM password_resets WHERE email = ?",
                [emailClean]
            );
            return res.status(500).json({
                success: false,
                message: "Gagal mengirim email reset password. Silakan coba beberapa saat lagi.",
            });
        }

        // Log aman tanpa kode OTP
        console.log(`[RESET PASSWORD OTP] Email: ${emailClean}`);

        // Response aman tanpa kode OTP
        return res.json({
            success: true,
            message: "Kode reset password telah dikirim ke email Anda. Silakan periksa folder kotak masuk atau spam.",
        });

    } catch (error) {
        console.error("Forgot Password Error:", error.message);

        return res.status(500).json({
            success: false,
            message: "Terjadi kesalahan saat memproses reset password",
        });
    }
};

// ===============================
// VERIFY RESET OTP
// ===============================
const verifyResetOTP = async (req, res) => {
    try {
        const { email, kode } = req.body;

        if (!email || !kode) {
            return res.status(400).json({
                success: false,
                message: "Email dan kode OTP wajib diisi.",
            });
        }

        const emailClean = email.trim().toLowerCase();
        const kodeClean = String(kode).trim();

        // Ambil OTP reset password terbaru
        const [rows] = await db.query(
            `
            SELECT *
            FROM password_resets
            WHERE email = ?
            ORDER BY id DESC
            LIMIT 1
            `,
            [emailClean]
        );

        if (rows.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Kode OTP tidak ditemukan atau sudah kedaluwarsa. Silakan kirim ulang OTP.",
            });
        }

        const resetData = rows[0];

        // Cek batas percobaan
        if (resetData.attempts >= 5) {
            await db.query("DELETE FROM password_resets WHERE id = ?", [resetData.id]);
            return res.status(400).json({
                success: false,
                message: "Batas percobaan verifikasi telah habis (maksimal 5 kali). Silakan minta kode OTP baru.",
            });
        }

        // Cek expired
        const now = new Date();
        const expiresAt = new Date(resetData.expires_at);

        if (now > expiresAt) {
            await db.query("DELETE FROM password_resets WHERE id = ?", [resetData.id]);
            return res.status(400).json({
                success: false,
                message: "Kode OTP sudah kedaluwarsa. Silakan kirim ulang OTP.",
            });
        }

        // Cek kode OTP (support bcrypt hash atau legacy plain text)
        const isOtpValid = resetData.kode.startsWith("$2")
            ? await bcrypt.compare(kodeClean, resetData.kode)
            : String(resetData.kode) === kodeClean;

        if (!isOtpValid) {
            const nextAttempts = (resetData.attempts || 0) + 1;
            await db.query(
                "UPDATE password_resets SET attempts = attempts + 1 WHERE id = ?",
                [resetData.id]
            );

            const remainingAttempts = Math.max(0, 5 - nextAttempts);

            if (remainingAttempts === 0) {
                await db.query("DELETE FROM password_resets WHERE id = ?", [resetData.id]);
                return res.status(400).json({
                    success: false,
                    message: "Kode OTP salah. Batas percobaan habis. Silakan kirim ulang OTP baru.",
                });
            }

            return res.status(400).json({
                success: false,
                message: `Kode OTP salah. Sisa percobaan: ${remainingAttempts} kali.`,
            });
        }

        return res.status(200).json({
            success: true,
            message: "OTP berhasil diverifikasi.",
        });
    } catch (error) {
        console.error("VERIFY RESET OTP ERROR:", error.message);

        return res.status(500).json({
            success: false,
            message: "Terjadi kesalahan pada server.",
        });
    }
};

// ===============================
// RESET PASSWORD
// ===============================
const resetPassword = async (req, res) => {
    try {
        const {
            email,
            password,
            confirmPassword,
        } = req.body;

        if (!email || !password || !confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "Email, password, dan konfirmasi password wajib diisi.",
            });
        }

        const emailClean = email.trim().toLowerCase();

        // Validasi password
        if (password.length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password minimal 8 karakter.",
            });
        }

        if (!/\d/.test(password)) {
            return res.status(400).json({
                success: false,
                message: "Password harus mengandung minimal 1 angka.",
            });
        }

        if (password !== confirmPassword) {
            return res.status(400).json({
                success: false,
                message: "Konfirmasi password tidak cocok.",
            });
        }

        // Cari akun berdasarkan email
        const [users] = await db.query(
            `
            SELECT id, password
            FROM users
            WHERE email = ?
            LIMIT 1
            `,
            [emailClean]
        );

        if (users.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Akun dengan email tersebut tidak ditemukan.",
            });
        }

        const user = users[0];

        // Pastikan password baru berbeda dari password lama
        const passwordSama = await bcrypt.compare(
            password,
            user.password
        );

        if (passwordSama) {
            return res.status(400).json({
                success: false,
                message: "Password baru tidak boleh sama dengan password sebelumnya.",
            });
        }

        // Hash password baru
        const hashedPassword = await bcrypt.hash(
            password,
            10
        );

        // Update password
        await db.query(
            `
            UPDATE users
            SET password = ?
            WHERE id = ?
            `,
            [hashedPassword, user.id]
        );

        // Hapus OTP yang sudah digunakan agar tidak dapat digunakan kembali
        await db.query(
            `
            DELETE FROM password_resets
            WHERE email = ?
            `,
            [emailClean]
        );

        return res.status(200).json({
            success: true,
            message: "Password berhasil diubah. Silakan login kembali.",
        });
    } catch (error) {
        console.error("RESET PASSWORD ERROR:", error.message);

        return res.status(500).json({
            success: false,
            message: "Terjadi kesalahan pada server.",
        });
    }
};

module.exports = {
    register,
    verifyEmail,
    resendVerification,
    login,
    forgotPassword,
    verifyResetOTP,
    resetPassword,
};
