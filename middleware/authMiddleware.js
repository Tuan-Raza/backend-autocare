const jwt = require("jsonwebtoken");
const { db } = require("../config/database");

const JWT_SECRET = process.env.JWT_SECRET || "autocare_secret_key_2026_jwt";

/**
 * Middleware to verify JWT token from Authorization header (Bearer <token>)
 */
const verifyToken = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res.status(401).json({
                success: false,
                message: "Akses ditolak. Token autentikasi tidak ditemukan.",
            });
        }

        const token = authHeader.split(" ")[1];
        if (!token) {
            return res.status(401).json({
                success: false,
                message: "Format token tidak valid.",
            });
        }

        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        console.error("verifyToken error:", err.message);
        return res.status(401).json({
            success: false,
            message: "Token tidak valid atau sudah kedaluwarsa. Silakan login kembali.",
        });
    }
};

/**
 * Middleware to ensure authenticated user has 'admin' role
 */
const requireAdmin = async (req, res, next) => {
    try {
        if (!req.user || req.user.role !== "admin") {
            // Also double check database in case role changed
            if (req.user && req.user.id) {
                const [rows] = await db.query(
                    "SELECT id, role, status FROM users WHERE id = ?",
                    [req.user.id]
                );
                if (rows.length > 0 && rows[0].role === "admin" && rows[0].status !== "nonaktif") {
                    req.user.role = "admin";
                    return next();
                }
            }

            return res.status(403).json({
                success: false,
                message: "Akses terlarang. Hanya administrator yang dapat mengakses resource ini.",
            });
        }
        next();
    } catch (err) {
        console.error("requireAdmin error:", err.message);
        return res.status(500).json({
            success: false,
            message: "Terjadi kesalahan verifikasi hak akses admin.",
        });
    }
};

module.exports = {
    verifyToken,
    requireAdmin,
    JWT_SECRET,
};
