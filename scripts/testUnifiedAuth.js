require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { db } = require("../config/database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/authMiddleware");
const authController = require("../controllers/authController");
const adminController = require("../controllers/adminController");
const { verifyToken, requireAdmin } = require("../middleware/authMiddleware");

function createMockRes() {
    return {
        statusCode: 200,
        jsonBody: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(data) {
            this.jsonBody = data;
            return this;
        },
    };
}

async function runTestSuite() {
    console.log("=================================================");
    console.log("AUTOCARE UNIFIED AUTHENTICATION TEST SUITE");
    console.log("=================================================");

    try {
        // ------------------------------------------------------------------
        // TEST 1: Login Akun User Biasa melalui Endpoint Unified Login
        // ------------------------------------------------------------------
        console.log("\n[1] Menguji Login Akun User Biasa (POST /api/auth/login)...");
        const [users] = await db.query(
            "SELECT id, nama, email, password, role FROM users WHERE role = 'user' LIMIT 1"
        );
        if (users.length === 0) throw new Error("Tidak ada akun user di database");
        const normalUser = users[0];

        // Pastikan password diketahui untuk testing (update password user test jika perlu)
        const testUserPassword = "user123";
        const hashedUserPwd = await bcrypt.hash(testUserPassword, 10);
        await db.query("UPDATE users SET password = ? WHERE id = ?", [hashedUserPwd, normalUser.id]);

        const userLoginReq = {
            body: {
                email: normalUser.email,
                password: testUserPassword,
            },
        };
        const userLoginRes = createMockRes();
        await authController.login(userLoginReq, userLoginRes);

        if (!userLoginRes.jsonBody?.success) {
            throw new Error("Login user gagal: " + JSON.stringify(userLoginRes.jsonBody));
        }

        const userToken = userLoginRes.jsonBody.token;
        const loggedInUser = userLoginRes.jsonBody.user;

        console.log(`✓ Login User Berhasil!`);
        console.log(`  - Nama : ${loggedInUser.nama}`);
        console.log(`  - Email: ${loggedInUser.email}`);
        console.log(`  - Role : ${loggedInUser.role} (Verified by Backend)`);
        console.log(`  - Token diterima: ${Boolean(userToken)}`);

        if (loggedInUser.role !== "user") {
            throw new Error("Role user tidak sesuai! Diharapkan 'user', diterima: " + loggedInUser.role);
        }

        const decodedUserToken = jwt.verify(userToken, JWT_SECRET);
        if (decodedUserToken.role !== "user") {
            throw new Error("JWT token tidak memuat role yang benar!");
        }
        console.log("✓ Payload JWT Token terverifikasi aman berstatus role: 'user'.");

        // ------------------------------------------------------------------
        // TEST 2: Login Akun Administrator melalui Endpoint Unified Login
        // ------------------------------------------------------------------
        console.log("\n[2] Menguji Login Akun Administrator pada Halaman Login yang Sama (POST /api/auth/login)...");
        const [admins] = await db.query(
            "SELECT id, nama, email, password, role FROM users WHERE role = 'admin' LIMIT 1"
        );
        if (admins.length === 0) throw new Error("Tidak ada akun admin di database");
        const adminUser = admins[0];

        const testAdminPassword = "admin123";
        const hashedAdminPwd = await bcrypt.hash(testAdminPassword, 10);
        await db.query("UPDATE users SET password = ? WHERE id = ?", [hashedAdminPwd, adminUser.id]);

        const adminLoginReq = {
            body: {
                email: adminUser.email,
                password: testAdminPassword,
            },
        };
        const adminLoginRes = createMockRes();
        await authController.login(adminLoginReq, adminLoginRes);

        if (!adminLoginRes.jsonBody?.success) {
            throw new Error("Login admin gagal: " + JSON.stringify(adminLoginRes.jsonBody));
        }

        const adminToken = adminLoginRes.jsonBody.token;
        const loggedInAdmin = adminLoginRes.jsonBody.user;

        console.log(`✓ Login Admin Berhasil pada endpoint login utama!`);
        console.log(`  - Nama : ${loggedInAdmin.nama}`);
        console.log(`  - Email: ${loggedInAdmin.email}`);
        console.log(`  - Role : ${loggedInAdmin.role} (Verified by Backend)`);
        console.log(`  - Token diterima: ${Boolean(adminToken)}`);

        if (loggedInAdmin.role !== "admin") {
            throw new Error("Role admin tidak sesuai! Diharapkan 'admin', diterima: " + loggedInAdmin.role);
        }

        const decodedAdminToken = jwt.verify(adminToken, JWT_SECRET);
        if (decodedAdminToken.role !== "admin") {
            throw new Error("JWT token admin tidak memuat role yang benar!");
        }
        console.log("✓ Payload JWT Token terverifikasi aman berstatus role: 'admin'.");

        // ------------------------------------------------------------------
        // TEST 3: User Biasa Ditolak Saat Mengakses Endpoint Admin
        // ------------------------------------------------------------------
        console.log("\n[3] Menguji Penolakan Akses Endpoint Admin untuk Token User Biasa...");
        const adminAccessReqWithUserToken = {
            headers: {
                authorization: `Bearer ${userToken}`,
            },
        };
        const adminAccessResWithUserToken = createMockRes();

        // Jalankan middleware verifyToken lalu requireAdmin
        await verifyToken(adminAccessReqWithUserToken, adminAccessResWithUserToken, async () => {
            await requireAdmin(adminAccessReqWithUserToken, adminAccessResWithUserToken, async () => {
                // If it reached next(), it was not blocked
                adminAccessResWithUserToken.status(200).json({ success: true, message: "Akses diizinkan" });
            });
        });

        console.log(`  - Status Code Respons : ${adminAccessResWithUserToken.statusCode} (Expected: 403)`);
        console.log(`  - Pesan Penolakan     : ${adminAccessResWithUserToken.jsonBody?.message}`);

        if (adminAccessResWithUserToken.statusCode !== 403) {
            throw new Error("Keamanan gagal! User biasa tidak diblokir dari endpoint admin!");
        }
        console.log("✓ User biasa berhasil DIBLOKIR dengan kode 403 Forbidden!");

        // ------------------------------------------------------------------
        // TEST 4: Pemalsuan Role di Token (Tampering) Tetap Ditolak Backend
        // ------------------------------------------------------------------
        console.log("\n[4] Menguji Proteksi Terhadap Token yang Dimanipulasi (Faked Admin Role)...");
        // Token dibuat dengan role 'admin' tetapi ID-nya adalah ID user biasa
        const forgedToken = jwt.sign(
            {
                id: normalUser.id,
                email: normalUser.email,
                role: "admin", // faked role
            },
            JWT_SECRET,
            { expiresIn: "1h" }
        );

        const forgedReq = {
            headers: {
                authorization: `Bearer ${forgedToken}`,
            },
        };
        const forgedRes = createMockRes();

        await verifyToken(forgedReq, forgedRes, async () => {
            await requireAdmin(forgedReq, forgedRes, async () => {
                forgedRes.status(200).json({ success: true, message: "Akses bocor!" });
            });
        });

        console.log(`  - Status Code Respons : ${forgedRes.statusCode} (Expected: 403)`);
        console.log(`  - Pesan Penolakan     : ${forgedRes.jsonBody?.message}`);

        if (forgedRes.statusCode !== 403) {
            throw new Error("Keamanan gagal! Token faked admin berhasil menembus backend!");
        }
        console.log("✓ Backend berhasil memverifikasi database asli dan menolak token manipulasi!");

        // ------------------------------------------------------------------
        // TEST 5: Administrator Berhasil Mengakses Endpoint Admin
        // ------------------------------------------------------------------
        console.log("\n[5] Menguji Akses Administrator ke Endpoint Admin (/api/admin/dashboard)...");
        const adminAccessReq = {
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            user: decodedAdminToken,
            query: {},
        };
        const adminAccessRes = createMockRes();

        await verifyToken(adminAccessReq, adminAccessRes, async () => {
            await requireAdmin(adminAccessReq, adminAccessRes, async () => {
                await adminController.getDashboard(adminAccessReq, adminAccessRes);
            });
        });

        console.log(`  - Status Code Respons : ${adminAccessRes.statusCode} (Expected: 200)`);
        console.log(`  - Total Pelanggan     : ${adminAccessRes.jsonBody?.data?.totalUsers}`);
        console.log(`  - Total Booking       : ${adminAccessRes.jsonBody?.data?.totalBookings}`);

        if (adminAccessRes.statusCode !== 200 || !adminAccessRes.jsonBody?.success) {
            throw new Error("Admin gagal mengakses dashboard: " + JSON.stringify(adminAccessRes.jsonBody));
        }
        console.log("✓ Administrator berhasil mengakses data dan endpoint admin!");

        // ------------------------------------------------------------------
        // TEST 6: Pengujian Akun Nonaktif
        // ------------------------------------------------------------------
        console.log("\n[6] Menguji Proteksi Terhadap Akun yang Dinonaktifkan...");
        await db.query("UPDATE users SET status = 'nonaktif' WHERE id = ?", [normalUser.id]);

        const deactivatedLoginReq = {
            body: {
                email: normalUser.email,
                password: testUserPassword,
            },
        };
        const deactivatedLoginRes = createMockRes();
        await authController.login(deactivatedLoginReq, deactivatedLoginRes);

        console.log(`  - Status Code Respons : ${deactivatedLoginRes.statusCode} (Expected: 403)`);
        console.log(`  - Pesan Penolakan     : ${deactivatedLoginRes.jsonBody?.message}`);

        if (deactivatedLoginRes.statusCode !== 403) {
            throw new Error("Akun nonaktif tidak diblokir saat login!");
        }
        console.log("✓ Akun nonaktif berhasil dicegah masuk ke sistem!");

        // Kembalikan status aktif user
        await db.query("UPDATE users SET status = 'aktif' WHERE id = ?", [normalUser.id]);

        console.log("\n=================================================");
        console.log("🎉 SELURUH PENGUJIAN AUTENTIKASI SATU PINTU LOLOS 100%!");
        console.log("=================================================\n");
        process.exit(0);
    } catch (err) {
        console.error("\n❌ TEST SUITE GAGAL:", err);
        process.exit(1);
    }
}

runTestSuite();
