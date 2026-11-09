require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static("public"));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/task_portal")
  .then(() => console.log("Database connected successfully"))
  .catch(err => console.error("Database connection error:", err));

const TransactionSchema = new mongoose.Schema({
  phoneNumber: String,
  amount: Number,
  checkoutRequestId: String,
  status: { type: String, default: "Pending" },
  createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model("Transaction", TransactionSchema);

const AdminSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true }
});
const Admin = mongoose.model("Admin", AdminSchema);

// --- DARAJA ACCESS TOKEN GENERATOR ---
async function getDarajaAccessToken() {
  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  const buffer = Buffer.from(`${consumerKey}:${consumerSecret}`);
  const auth = buffer.toString("base64");

  try {
    const response = await axios.get(
      "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
      { headers: { Authorization: `Basic ${auth}` } }
    );
    return response.data.access_token;
  } catch (error) {
    console.error("Daraja Token Error:", error.response?.data || error.message);
    throw new Error("Failed to connect to Safaricom Daraja");
  }
}

// --- 1. USER: TRIGGER M-PESA STK PUSH ---
app.post("/api/unlock-task", async (req, res) => {
  let { phoneNumber, amount } = req.body;
  if (phoneNumber.startsWith("0")) {
    phoneNumber = "254" + phoneNumber.slice(1);
  }

  try {
    const accessToken = await getDarajaAccessToken();
    const timestamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
    const shortCode = process.env.DARAJA_SHORTCODE || "174379";
    const passkey = process.env.DARAJA_PASSKEY;
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString("base64");

    const stkResponse = await axios.post(
      "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest",
      {
        BusinessShortCode: shortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phoneNumber,
        PartyB: shortCode,
        PhoneNumber: phoneNumber,
        CallBackURL: "https://mydomain.com/api/mpesa/callback", // Replace with your live deployed URL later
        AccountReference: "TaskUnlock",
        TransactionDesc: "Unlock Task Fee"
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    await Transaction.create({
      phoneNumber,
      amount,
      checkoutRequestId: stkResponse.data.CheckoutRequestID,
      status: "Pending"
    });

    res.json({
      success: true,
      message: "Please check your phone. Enter your M-Pesa phone number to unlock the task.",
      checkoutRequestId: stkResponse.data.CheckoutRequestID
    });
  } catch (error) {
    console.error("STK Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Failed to initiate M-Pesa prompt" });
  }
});

// --- 2. ADMIN: SECURE LOGIN ---
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    let admin = await Admin.findOne({ username });
    if (!admin) {
      // Auto-create default admin on first try if none exists
      const hash = await bcrypt.hash("AdminSecret2026!", 10);
      admin = await Admin.create({ username: "admin", passwordHash: hash });
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) return res.status(400).json({ success: false, message: "Invalid credentials" });

    res.json({ success: true, message: "Welcome Admin", token: "admin_session_token_xyz" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// --- 3. ADMIN: DASHBOARD BALANCE ---
app.get("/api/admin/dashboard", async (req, res) => {
  try {
    const successfulTxs = await Transaction.find({ status: "Success" });
    const totalBalance = successfulTxs.reduce((sum, tx) => sum + tx.amount, 0);
    res.json({ success: true, totalBalance, transactions: successfulTxs });
  } catch (err) {
    res.status(500).json({ success: false, error: "Error fetching balance" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
