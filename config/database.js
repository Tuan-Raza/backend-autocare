
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

const ensureColumn = async (connection, table, column, definition) => {
    const [cols] = await connection.query(
        "SHOW COLUMNS FROM ?? LIKE ?",
        [table, column]
    );

    if (cols.length === 0) {
        await connection.query(
            `ALTER TABLE ?? ADD COLUMN ?? ${definition}`,
            [table, column]
        );
    }
};

const testConnection = async () => {
    let connection;

    try {
        connection = await db.getConnection();
        console.log("Database connection successful!");

        try {
            // Migration email verification
            await connection.query(
                "ALTER TABLE email_verifications MODIFY COLUMN kode VARCHAR(255) NOT NULL"
            );
            await ensureColumn(
                connection,
                "email_verifications",
                "attempts",
                "INT DEFAULT 0"
            );

            // Migration password reset
            await connection.query(
                "ALTER TABLE password_resets MODIFY COLUMN kode VARCHAR(255) NOT NULL"
            );
            await ensureColumn(
                connection,
                "password_resets",
                "attempts",
                "INT DEFAULT 0"
            );

            // Migration email changes
            await connection.query(
                "ALTER TABLE email_changes MODIFY COLUMN kode VARCHAR(255) NOT NULL"
            );
            await ensureColumn(
                connection,
                "email_changes",
                "attempts",
                "INT DEFAULT 0"
            );

            // Migration Admin Panel
            await ensureColumn(
                connection,
                "users",
                "role",
                "ENUM('user', 'admin') DEFAULT 'user'"
            );

            await ensureColumn(
                connection,
                "users",
                "status",
                "ENUM('aktif', 'nonaktif') DEFAULT 'aktif'"
            );

            await ensureColumn(
                connection,
                "booking",
                "catatan_admin",
                "TEXT NULL"
            );

            // Migration Payment QRIS & COD
            await ensureColumn(
                connection,
                "payments",
                "verified_by",
                "INT NULL"
            );

            await ensureColumn(
                connection,
                "payments",
                "verified_at",
                "DATETIME NULL"
            );

            await ensureColumn(
                connection,
                "payments",
                "catatan_penolakan",
                "TEXT NULL"
            );

            console.log("Database migrations checked successfully!");
        } catch (tableErr) {
            console.error("Migration warning:", tableErr.message);
        }
    } catch (error) {
        console.error("Database connection failed:", error);
    } finally {
        if (connection) {
            connection.release();
        }
    }
};

module.exports = { db, testConnection };
