const express = require("express");
const router = express.Router();

const {
    createPayment,
    getPaymentStatus,
    paymentNotification,
    submitManualPayment,
    getPaymentByBookingId,
    verifyManualPayment,
} = require("../controllers/paymentController");

// Detail data pembayaran berdasarkan booking
router.get("/booking/:bookingId", getPaymentByBookingId);

// Upload bukti transfer & konfirmasi pembayaran manual (QRIS, DANA, SeaBank, Bayar di Tempat)
router.post("/manual", submitManualPayment);

// Status & verifikasi pembayaran
router.get("/:orderId/status", getPaymentStatus);

// Verifikasi / ACC status pembayaran (Admin / Test ACC)
router.post("/:orderId/verify", verifyManualPayment);
router.post("/verify", verifyManualPayment);

// Endpoint kompatibilitas lama
router.post("/create", createPayment);
router.post("/notification", paymentNotification);

module.exports = router;
