import { describe, it, expect, vi, beforeEach } from "vitest";

const { db } = require("../config/database");
const bcrypt = require("bcryptjs");
const mailer = require("../utils/mailer");
const {
    register,
    verifyEmail,
    resendVerification,
    forgotPassword,
    verifyResetOTP,
} = require("../controllers/authController");

describe("Security & Functional Testing - OTP System", () => {
    let req;
    let res;

    beforeEach(() => {
        vi.clearAllMocks();

        db.query = vi.fn();
        mailer.sendVerificationEmail = vi.fn();
        mailer.sendResetPasswordEmail = vi.fn();

        req = { body: {} };
        res = {
            status: vi.fn().mockReturnThis(),
            json: vi.fn().mockReturnThis(),
        };
    });

    describe("1. Register & OTP Generation Security", () => {
        it("harus mengirim OTP via email dan TIDAK membocorkan OTP di response", async () => {
            req.body = {
                nama: "Budi Santoso",
                email: "budi@example.com",
                noHp: "08123456789",
                password: "Password123!",
            };

            // Existing user check: tidak ada user dengan email ini
            db.query.mockResolvedValueOnce([[]]);
            // Delete old OTP
            db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
            // Insert email_verifications
            db.query.mockResolvedValueOnce([{ insertId: 10 }]);

            // Mock email sending berhasil
            mailer.sendVerificationEmail.mockResolvedValueOnce({
                sent: true,
                messageId: "msg-12345",
            });

            await register(req, res);

            expect(mailer.sendVerificationEmail).toHaveBeenCalledWith(
                "budi@example.com",
                expect.stringMatching(/^\d{6}$/),
                "Budi Santoso"
            );

            // Verifikasi query insert ke DB: kode harus di-hash (panjang 60 karakter bcrypt)
            const insertCall = db.query.mock.calls[2];
            const insertValues = insertCall[1];
            const storedKode = insertValues[4];
            const expiresAt = insertValues[5];

            // Kode di DB harus hash bcrypt (diawali $2)
            expect(storedKode).toMatch(/^\$2[aby]\$\d{2}\$/);
            // Masa berlaku maksimal 5 menit dari sekarang (300.000 ms)
            const diffMs = new Date(expiresAt).getTime() - Date.now();
            expect(diffMs).toBeGreaterThan(4 * 60 * 1000);
            expect(diffMs).toBeLessThanOrEqual(5 * 60 * 1000 + 5000);

            // Response status 201
            expect(res.status).toHaveBeenCalledWith(201);

            // PASTIKAN response TIDAK berisi properti otp atau kode
            const responseData = res.json.mock.calls[0][0];
            expect(responseData.success).toBe(true);
            expect(responseData.otp).toBeUndefined();
            expect(responseData.kode).toBeUndefined();
            expect(responseData.message).not.toMatch(/\d{6}/); // Pesan tidak boleh memuat 6 digit kode
        });

        it("harus mengembalikan error 500 jika pengiriman email gagal tanpa membocorkan OTP", async () => {
            req.body = {
                nama: "Budi Santoso",
                email: "budi@example.com",
                noHp: "08123456789",
                password: "Password123!",
            };

            db.query.mockResolvedValueOnce([[]]);
            db.query.mockResolvedValueOnce([{ affectedRows: 0 }]);
            db.query.mockResolvedValueOnce([{ insertId: 10 }]);
            db.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // delete on mail failure

            // Mock mailer gagal kirim
            mailer.sendVerificationEmail.mockResolvedValueOnce({
                sent: false,
                error: "SMTP Error",
            });

            await register(req, res);

            expect(res.status).toHaveBeenCalledWith(500);
            const responseData = res.json.mock.calls[0][0];
            expect(responseData.success).toBe(false);
            expect(responseData.otp).toBeUndefined();
            expect(responseData.message).not.toMatch(/\d{6}/);
        });
    });

    describe("2. Verify Email & One-Time Use", () => {
        it("harus berhasil memverifikasi dengan hash bcrypt dan menghapus OTP setelah digunakan", async () => {
            const rawOtp = "654321";
            const hashedOtp = await bcrypt.hash(rawOtp, 10);

            req.body = {
                email: "budi@example.com",
                kode: rawOtp,
            };

            const mockVerification = {
                id: 10,
                nama: "Budi Santoso",
                email: "budi@example.com",
                no_hp: "08123456789",
                password: "$2a$10$FakeHashedPassword",
                kode: hashedOtp,
                expires_at: new Date(Date.now() + 3 * 60 * 1000), // masih berlaku
                attempts: 0,
            };

            // 1. SELECT verification
            db.query.mockResolvedValueOnce([[mockVerification]]);
            // 2. SELECT users (existing check)
            db.query.mockResolvedValueOnce([[]]);
            // 3. INSERT users
            db.query.mockResolvedValueOnce([{ insertId: 55 }]);
            // 4. DELETE email_verifications (One-Time Use)
            db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

            await verifyEmail(req, res);

            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: true,
                    message: "Email berhasil diverifikasi! Pendaftaran Anda selesai.",
                    user: expect.objectContaining({
                        id: 55,
                        nama: "Budi Santoso",
                        email: "budi@example.com",
                    }),
                })
            );

            // Pastikan OTP dihapus dari DB (tidak dapat dipakai ulang)
            expect(db.query).toHaveBeenCalledWith(
                "DELETE FROM email_verifications WHERE LOWER(email) = ?",
                ["budi@example.com"]
            );
        });

        it("harus menolak OTP jika kode salah dan membatasi percobaan", async () => {
            const rawOtp = "654321";
            const wrongOtp = "111111";
            const hashedOtp = await bcrypt.hash(rawOtp, 10);

            req.body = {
                email: "budi@example.com",
                kode: wrongOtp,
            };

            const mockVerification = {
                id: 10,
                nama: "Budi",
                email: "budi@example.com",
                kode: hashedOtp,
                expires_at: new Date(Date.now() + 3 * 60 * 1000),
                attempts: 2,
            };

            db.query.mockResolvedValueOnce([[mockVerification]]);
            db.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE attempts

            await verifyEmail(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                success: false,
                message: "Kode verifikasi salah. Sisa percobaan: 2 kali.",
            });
        });

        it("harus menolak dan menghapus data verifikasi jika batas percobaan (5 kali) tercapai", async () => {
            const rawOtp = "654321";
            const wrongOtp = "111111";
            const hashedOtp = await bcrypt.hash(rawOtp, 10);

            req.body = {
                email: "budi@example.com",
                kode: wrongOtp,
            };

            const mockVerification = {
                id: 10,
                nama: "Budi",
                email: "budi@example.com",
                kode: hashedOtp,
                expires_at: new Date(Date.now() + 3 * 60 * 1000),
                attempts: 4, // percobaan ke-5 akan menghabiskan batas
            };

            db.query.mockResolvedValueOnce([[mockVerification]]);
            db.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // UPDATE attempts
            db.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE record

            await verifyEmail(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                success: false,
                message: "Kode verifikasi salah. Batas percobaan habis. Silakan kirim ulang kode baru.",
            });
        });

        it("harus menolak OTP yang sudah kedaluwarsa (> 5 menit)", async () => {
            req.body = {
                email: "budi@example.com",
                kode: "123456",
            };

            const mockVerification = {
                id: 10,
                nama: "Budi",
                email: "budi@example.com",
                kode: "$2a$10$FakeHashedOtp",
                expires_at: new Date(Date.now() - 1000), // sudah lewat
                attempts: 0,
            };

            db.query.mockResolvedValueOnce([[mockVerification]]);
            db.query.mockResolvedValueOnce([{ affectedRows: 1 }]); // DELETE expired

            await verifyEmail(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({
                success: false,
                message: "Kode verifikasi sudah kedaluwarsa. Silakan minta kode baru.",
            });
        });
    });

    describe("3. Resend OTP & Cooldown Mechanism", () => {
        it("harus menolak kirim ulang jika belum lewat 60 detik (HTTP 429)", async () => {
            req.body = { email: "budi@example.com" };

            // elapsed_seconds = 25 (kurang dari 60 detik)
            db.query.mockResolvedValueOnce([
                [
                    {
                        id: 10,
                        email: "budi@example.com",
                        elapsed_seconds: 25,
                    },
                ],
            ]);

            await resendVerification(req, res);

            expect(res.status).toHaveBeenCalledWith(429);
            const responseData = res.json.mock.calls[0][0];
            expect(responseData.success).toBe(false);
            expect(responseData.retryAfter).toBe(35);
            expect(responseData.message).toContain("35 detik");
        });

        it("harus mengizinkan kirim ulang setelah 60 detik dan TIDAK membocorkan OTP", async () => {
            req.body = { email: "budi@example.com" };

            // elapsed_seconds = 65 (sudah lebih dari 60 detik)
            db.query.mockResolvedValueOnce([
                [
                    {
                        id: 10,
                        nama: "Budi Santoso",
                        email: "budi@example.com",
                        elapsed_seconds: 65,
                    },
                ],
            ]);

            // UPDATE email_verifications
            db.query.mockResolvedValueOnce([{ affectedRows: 1 }]);

            mailer.sendVerificationEmail.mockResolvedValueOnce({
                sent: true,
                messageId: "msg-9999",
            });

            await resendVerification(req, res);

            expect(mailer.sendVerificationEmail).toHaveBeenCalled();
            const responseData = res.json.mock.calls[0][0];
            expect(responseData.success).toBe(true);
            expect(responseData.otp).toBeUndefined();
            expect(responseData.message).not.toMatch(/\d{6}/);
        });
    });

    describe("4. Forgot Password & Reset OTP", () => {
        it("harus menerapkan cooldown 60 detik dan tidak membocorkan reset OTP", async () => {
            req.body = { email: "budi@example.com" };

            db.query.mockResolvedValueOnce([
                [{ id: 1, nama: "Budi", email: "budi@example.com" }],
            ]);

            // Cooldown check: baru 15 detik
            db.query.mockResolvedValueOnce([[{ elapsed_seconds: 15 }]]);

            await forgotPassword(req, res);

            expect(res.status).toHaveBeenCalledWith(429);
            expect(res.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    success: false,
                    retryAfter: 45,
                })
            );
        });
    });
});
