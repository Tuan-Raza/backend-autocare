import { describe, it, expect, vi, beforeEach } from "vitest";
const { db } = require("../config/database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const adminController = require("../controllers/adminController");
const { verifyToken, requireAdmin, JWT_SECRET } = require("../middleware/authMiddleware");

describe("Admin Controller & Auth Unit Tests", () => {
    let req;
    let res;

    beforeEach(() => {
        vi.clearAllMocks();
        db.query = vi.fn();
        bcrypt.compare = vi.fn();

        req = {
            body: {},
            query: {},
            params: {},
            headers: {},
        };

        res = {
            statusCode: 200,
            jsonBody: null,
            status: vi.fn(function (code) {
                this.statusCode = code;
                return this;
            }),
            json: vi.fn(function (data) {
                this.jsonBody = data;
                return this;
            }),
        };
    });

    describe("POST /api/admin/login", () => {
        it("harus menolak login jika email atau password kosong", async () => {
            req.body = { email: "", password: "" };
            await adminController.login(req, res);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.jsonBody.success).toBe(false);
        });

        it("harus menolak login jika akun bukan admin", async () => {
            db.query.mockResolvedValueOnce([
                [{ id: 1, email: "user@gmail.com", password: "hash", role: "user", status: "aktif" }],
            ]);

            req.body = { email: "user@gmail.com", password: "password123" };
            await adminController.login(req, res);

            expect(res.status).toHaveBeenCalledWith(403);
            expect(res.jsonBody.message).toContain("bukan administrator");
        });

        it("harus menolak login jika password salah", async () => {
            db.query.mockResolvedValueOnce([
                [{ id: 2, email: "admin@autocare.com", password: "hash", role: "admin", status: "aktif" }],
            ]);
            bcrypt.compare.mockResolvedValueOnce(false);

            req.body = { email: "admin@autocare.com", password: "wrongpassword" };
            await adminController.login(req, res);

            expect(res.status).toHaveBeenCalledWith(401);
            expect(res.jsonBody.success).toBe(false);
        });

        it("harus berhasil login dan menghasilkan JWT token untuk admin valid", async () => {
            db.query.mockResolvedValueOnce([
                [{ id: 3, nama: "Super Admin", email: "admin@autocare.com", password: "hash", role: "admin", status: "aktif" }],
            ]);
            bcrypt.compare.mockResolvedValueOnce(true);

            req.body = { email: "admin@autocare.com", password: "admin123" };
            await adminController.login(req, res);

            expect(res.jsonBody.success).toBe(true);
            expect(res.jsonBody.token).toBeDefined();
            expect(res.jsonBody.admin.email).toBe("admin@autocare.com");
        });
    });

    describe("Auth Middleware: verifyToken & requireAdmin", () => {
        it("harus menolak akses jika header Authorization tidak ada", async () => {
            req.headers = {};
            const next = vi.fn();

            await verifyToken(req, res, next);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(next).not.toHaveBeenCalled();
        });

        it("harus menolak akses jika token tidak valid", async () => {
            req.headers = { authorization: "Bearer invalid.token.signature" };
            const next = vi.fn();

            await verifyToken(req, res, next);
            expect(res.status).toHaveBeenCalledWith(401);
            expect(next).not.toHaveBeenCalled();
        });

        it("harus memverifikasi token JWT yang valid", async () => {
            const validToken = jwt.sign({ id: 99, email: "admin@autocare.com", role: "admin" }, JWT_SECRET);
            req.headers = { authorization: `Bearer ${validToken}` };
            const next = vi.fn();

            await verifyToken(req, res, next);
            expect(next).toHaveBeenCalled();
            expect(req.user.email).toBe("admin@autocare.com");
        });

        it("requireAdmin harus menolak user dengan role non-admin", async () => {
            req.user = { id: 10, role: "user" };
            const next = vi.fn();
            db.query.mockResolvedValueOnce([[{ id: 10, role: "user", status: "aktif" }]]);

            await requireAdmin(req, res, next);
            expect(res.status).toHaveBeenCalledWith(403);
            expect(next).not.toHaveBeenCalled();
        });

        it("requireAdmin harus meloloskan user dengan role admin", async () => {
            req.user = { id: 10, role: "admin" };
            const next = vi.fn();

            await requireAdmin(req, res, next);
            expect(next).toHaveBeenCalled();
        });
    });

    describe("Booking Status Transition", () => {
        it("harus menolak status booking yang tidak dikenal", async () => {
            req.params = { id: 1 };
            req.body = { status: "invalid_status" };

            await adminController.updateBookingStatus(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.jsonBody.success).toBe(false);
        });

        it("harus berhasil memperbarui status booking dan mencatat alasan pembatalan", async () => {
            db.query
                .mockResolvedValueOnce([[{ id: 1, kode_booking: "BK-001", status: "menunggu", catatan_admin: null }]])
                .mockResolvedValueOnce([{ affectedRows: 1 }]);

            req.params = { id: 1 };
            req.body = { status: "dibatalkan", catatan_admin: "Jadwal teknisi penuh" };

            await adminController.updateBookingStatus(req, res);
            expect(res.jsonBody.success).toBe(true);
            expect(res.jsonBody.data.status).toBe("dibatalkan");
            expect(res.jsonBody.data.catatan_admin).toBe("Jadwal teknisi penuh");
        });
    });

    describe("CRUD Services (Layanan)", () => {
        it("harus menolak pembuatan layanan baru jika nama atau harga kosong", async () => {
            req.body = { nama_layanan: "", harga: "" };

            await adminController.createService(req, res);
            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.jsonBody.success).toBe(false);
        });

        it("harus berhasil membuat layanan baru", async () => {
            db.query.mockResolvedValueOnce([{ insertId: 101 }]);

            req.body = {
                nama_layanan: "Servis Rem Komplit",
                deskripsi: "Pembersihan cakram dan tromol",
                harga: 175000,
                estimasi_menit: 45,
                status: "aktif",
            };

            await adminController.createService(req, res);
            expect(res.status).toHaveBeenCalledWith(201);
            expect(res.jsonBody.success).toBe(true);
            expect(res.jsonBody.data.id).toBe(101);
        });
    });
});
