require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const { db } = require("../config/database");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../middleware/authMiddleware");

// Test controller functions directly and ensure all queries run cleanly on actual MySQL database
const adminController = require("../controllers/adminController");

async function runTests() {
    console.log("=== RUNNING ADMIN API END-TO-END TESTS ===");

    // Mock response helper
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

    try {
        // Test 1: Admin Login
        console.log("\n[1] Testing Admin Login...");
        const loginReq = {
            body: {
                email: "admin@autocare.com",
                password: "admin123",
            },
        };
        const loginRes = createMockRes();
        await adminController.login(loginReq, loginRes);

        if (!loginRes.jsonBody?.success || !loginRes.jsonBody?.token) {
            throw new Error("Admin login failed: " + JSON.stringify(loginRes.jsonBody));
        }
        console.log("✅ Admin Login SUCCESS! Token received.");
        const token = loginRes.jsonBody.token;
        const decoded = jwt.verify(token, JWT_SECRET);
        const adminUser = decoded;

        // Test 2: Get Dashboard Stats
        console.log("\n[2] Testing Dashboard Stats...");
        const dashReq = { user: adminUser };
        const dashRes = createMockRes();
        await adminController.getDashboard(dashReq, dashRes);
        console.log("✅ Dashboard Stats SUCCESS! Data:", {
            totalUsers: dashRes.jsonBody.data.totalUsers,
            totalVehicles: dashRes.jsonBody.data.totalVehicles,
            totalBookings: dashRes.jsonBody.data.totalBookings,
            totalRevenue: dashRes.jsonBody.data.totalRevenue,
            recentBookingsCount: dashRes.jsonBody.data.recentBookings.length,
        });

        // Test 3: Get Users List
        console.log("\n[3] Testing Users List...");
        const usersReq = { user: adminUser, query: { page: 1, limit: 10 } };
        const usersRes = createMockRes();
        await adminController.getUsers(usersReq, usersRes);
        console.log("✅ Users List SUCCESS! Total users found:", usersRes.jsonBody.pagination.total);

        // Test 4: Get Vehicles List
        console.log("\n[4] Testing Vehicles List...");
        const vReq = { user: adminUser, query: {} };
        const vRes = createMockRes();
        await adminController.getVehicles(vReq, vRes);
        console.log("✅ Vehicles List SUCCESS! Total vehicles found:", vRes.jsonBody.data.length);

        // Test 5: Get Bookings List
        console.log("\n[5] Testing Bookings List...");
        const bReq = { user: adminUser, query: {} };
        const bRes = createMockRes();
        await adminController.getBookings(bReq, bRes);
        console.log("✅ Bookings List SUCCESS! Total bookings found:", bRes.jsonBody.data.length);

        // Test 6: Get Services (Layanan)
        console.log("\n[6] Testing Services List...");
        const sReq = { user: adminUser, query: {} };
        const sRes = createMockRes();
        await adminController.getServices(sReq, sRes);
        console.log("✅ Services List SUCCESS! Total services found:", sRes.jsonBody.data.length);

        // Test 7: Get Reports
        console.log("\n[7] Testing Reports...");
        const rReq = { user: adminUser, query: { year: 2026 } };
        const rRes = createMockRes();
        await adminController.getReports(rReq, rRes);
        console.log("✅ Reports SUCCESS! Data summary:", {
            grand_total_booking: rRes.jsonBody.data.overall.grand_total_booking,
            grand_total_pendapatan: rRes.jsonBody.data.overall.grand_total_pendapatan,
        });

        // Test 8: Get Settings
        console.log("\n[8] Testing Settings...");
        const setReq = { user: adminUser };
        const setRes = createMockRes();
        await adminController.getSettings(setReq, setRes);
        console.log("✅ Settings SUCCESS! Data:", setRes.jsonBody.data);

        console.log("\n🎉 ALL BACKEND CONTROLLER & DATABASE TESTS PASSED PERFECTLY!");
        process.exit(0);
    } catch (err) {
        console.error("❌ Test failed:", err);
        process.exit(1);
    }
}

runTests();
