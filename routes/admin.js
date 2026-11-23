const express = require("express");
const router = express.Router();
const { verifyToken, requireAdmin } = require("../middleware/authMiddleware");
const adminController = require("../controllers/adminController");

// ==========================================
// PUBLIC ADMIN ROUTE
// ==========================================
router.post("/login", adminController.login);

// ==========================================
// PROTECTED ADMIN ROUTES (Token + Role: admin)
// ==========================================
router.use(verifyToken, requireAdmin);

// Profile
router.get("/me", adminController.getMe);

// Dashboard
router.get("/dashboard", adminController.getDashboard);

// Users
router.get("/users", adminController.getUsers);
router.get("/users/:id", adminController.getUserDetail);
router.put("/users/:id", adminController.updateUser);
router.delete("/users/:id", adminController.deleteUser);

// Vehicles
router.get("/vehicles", adminController.getVehicles);

// Bookings
router.get("/bookings", adminController.getBookings);
router.put("/bookings/:id/status", adminController.updateBookingStatus);

// Service History
router.get("/service-history", adminController.getServiceHistory);

// Payments
router.get("/payments", adminController.getPayments);
router.put("/payments/:id/verify", adminController.verifyPayment);

// Services (Layanan) CRUD
router.get("/services", adminController.getServices);
router.post("/services", adminController.createService);
router.put("/services/:id", adminController.updateService);
router.delete("/services/:id", adminController.deleteService);

// Reports
router.get("/reports", adminController.getReports);

// Settings
router.get("/settings", adminController.getSettings);
router.put("/settings", adminController.updateSettings);

module.exports = router;
