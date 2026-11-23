require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { db, testConnection } = require("../config/database");
const bcrypt = require("bcryptjs");

async function seedAdmin() {
    try {
        console.log("=== SEEDING / VERIFYING ADMIN ACCOUNT ===");
        await testConnection();

        const adminEmail = process.env.ADMIN_DEFAULT_EMAIL || "admin@autocare.com";
        const adminPassword = process.env.ADMIN_DEFAULT_PASSWORD || "admin123";
        const adminName = "Administrator AutoCare";
        const adminPhone = "081234567890";

        // Check if admin already exists
        const [existing] = await db.query(
            "SELECT * FROM users WHERE LOWER(email) = ?",
            [adminEmail.toLowerCase()]
        );

        if (existing.length > 0) {
            console.log(`User ${adminEmail} already exists. Updating to admin role...`);
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            await db.query(
                "UPDATE users SET role = 'admin', password = ?, nama = ?, nama_lengkap = ? WHERE id = ?",
                [hashedPassword, adminName, adminName, existing[0].id]
            );
            console.log(`✅ Admin account updated successfully!`);
            console.log(`Email: ${adminEmail}`);
            console.log(`Password: ${adminPassword}`);
        } else {
            console.log(`Creating new admin account ${adminEmail}...`);
            const hashedPassword = await bcrypt.hash(adminPassword, 10);
            await db.query(
                `INSERT INTO users (nama, email, no_hp, password, nama_lengkap, kontak, role, status)
                 VALUES (?, ?, ?, ?, ?, ?, 'admin', 'aktif')`,
                [adminName, adminEmail.toLowerCase(), adminPhone, hashedPassword, adminName, adminPhone]
            );
            console.log(`✅ Admin account created successfully!`);
            console.log(`Email: ${adminEmail}`);
            console.log(`Password: ${adminPassword}`);
        }

        // Also ensure admin_settings has at least 1 default row
        const [settings] = await db.query("SELECT * FROM admin_settings LIMIT 1");
        if (settings.length === 0) {
            await db.query(
                `INSERT INTO admin_settings (nama_admin, kontak_admin, nama_autocare, alamat_autocare)
                 VALUES (?, ?, ?, ?)`,
                [adminName, adminPhone, "AutoCare Service Center", "Jl. Raya Otomotif No. 123, Jakarta"]
            );
            console.log("✅ Initial admin_settings row created!");
        }

        console.log("Seeding finished successfully.");
        process.exit(0);
    } catch (err) {
        console.error("❌ Seeding failed:", err);
        process.exit(1);
    }
}

seedAdmin();
