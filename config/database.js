const mysql = require("mysql2/promise");

const db = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: process.env.DB_PORT,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
});

const testConnection = async () => {
    try {
        const connection = await db.getConnection();
        console.log("Database connection successful!");

        // Pastikan kolom kode dapat menyimpan hash (VARCHAR 255) dan kolom attempts tersedia
        try {
            await connection.query("ALTER TABLE email_verifications MODIFY COLUMN kode VARCHAR(255) NOT NULL");
            await connection.query("ALTER TABLE email_verifications ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0");
            await connection.query("ALTER TABLE password_resets MODIFY COLUMN kode VARCHAR(255) NOT NULL");
            await connection.query("ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0");
            await connection.query("ALTER TABLE email_changes MODIFY COLUMN kode VARCHAR(255) NOT NULL");
            await connection.query("ALTER TABLE email_changes ADD COLUMN IF NOT EXISTS attempts INT DEFAULT 0");

            // Migration aman untuk Admin Panel AutoCare
            const [roleCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'role'");
            if (roleCols.length === 0) {
                await connection.query("ALTER TABLE users ADD COLUMN role ENUM('user', 'admin') DEFAULT 'user'");
            }
            const [statusCols] = await connection.query("SHOW COLUMNS FROM users LIKE 'status'");
            if (statusCols.length === 0) {
                await connection.query("ALTER TABLE users ADD COLUMN status ENUM('aktif', 'nonaktif') DEFAULT 'aktif'");
            }
            const [adminNoteCols] = await connection.query("SHOW COLUMNS FROM booking LIKE 'catatan_admin'");
            if (adminNoteCols.length === 0) {
                await connection.query("ALTER TABLE booking ADD COLUMN catatan_admin TEXT NULL");
            }

            // Migration aman untuk Payments (QRIS & COD)
            const [verifiedByCols] = await connection.query("SHOW COLUMNS FROM payments LIKE 'verified_by'");
            if (verifiedByCols.length === 0) {
                await connection.query("ALTER TABLE payments ADD COLUMN verified_by INT NULL");
            }
            const [verifiedAtCols] = await connection.query("SHOW COLUMNS FROM payments LIKE 'verified_at'");
            if (verifiedAtCols.length === 0) {
                await connection.query("ALTER TABLE payments ADD COLUMN verified_at DATETIME NULL");
            }
            const [catatanPenolakanCols] = await connection.query("SHOW COLUMNS FROM payments LIKE 'catatan_penolakan'");
            if (catatanPenolakanCols.length === 0) {
                await connection.query("ALTER TABLE payments ADD COLUMN catatan_penolakan TEXT NULL");
            }
        } catch (tableErr) {
            console.error("Migration warning:", tableErr.message);
        }

        connection.release();
    } catch (error) {
        console.error("Database connection failed:", error);
    }
};

module.exports = { db, testConnection };
