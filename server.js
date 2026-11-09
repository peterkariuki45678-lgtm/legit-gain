require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const cors = require("cors");
const axios = require("axios");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

// MongoDB Connection
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Database connected successfully"))
  .catch(err => console.error("Database connection error:", err));

// User Schema with Name and Location
const UserSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  county: { type: String, required: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
  surveyCompleted: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});
const User = mongoose.model("User", UserSchema);

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

// Daraja Token Generator
async function getDarajaAccessToken() {
  const consumerKey = process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;
  const buffer = Buffer.from(`${consumerKey}:${consumerSecret}`);
  const auth = buffer.toString("base64");

  const response = await axios.get(
    "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials",
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return response.data.access_token;
}

// --- SIGN UP ---
app.post("/api/signup", async (req, res) => {
  let { fullName, phone, county, password } = req.body;
  if (!fullName || !phone || !county || !password) {
    return res.json({ success: false, message: "All fields are required!" });
  }
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);

  try {
    const existing = await User.findOne({ phone });
    if (existing) {
      return res.json({ success: false, message: "Phone number already registered. Please Sign In." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = await User.create({ fullName, phone, county, passwordHash, balance: 360, surveyCompleted: true });
    res.json({ success: true, user: newUser });
  } catch (err) {
    console.error("Signup Error:", err);
    res.status(500).json({ success: false, message: "Server error during signup" });
  }
});

// --- SIGN IN ---
app.post("/api/login", async (req, res) => {
  let { phone, password } = req.body;
  if (!phone || !password) return res.json({ success: false, message: "Enter phone and password" });
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);

  try {
    const user = await User.findOne({ phone });
    if (!user) return res.json({ success: false, message: "User not found. Please sign up." });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.json({ success: false, message: "Incorrect password." });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error during login" });
  }
});

app.get("/api/user/:phone", async (req, res) => {
  const user = await User.findOne({ phone: req.params.phone });
  res.json({ success: true, user });
});

// --- M-PESA STK PUSH ---
app.post("/api/unlock-task", async (req, res) => {
  let { phoneNumber, amount } = req.body;
  if (phoneNumber.startsWith("0")) phoneNumber = "254" + phoneNumber.slice(1);

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
        CallBackURL: "https://mydomain.com/api/callback",
        AccountReference: "LegitGainUnlock",
        TransactionDesc: "Task Unlock Fee"
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    await Transaction.create({
      phoneNumber,
      amount,
      checkoutRequestId: stkResponse.data.CheckoutRequestID,
      status: "Pending"
    });

    res.json({ success: true, message: `M-Pesa STK prompt sent for KES ${amount}. Enter your PIN!` });
  } catch (error) {
    console.error("STK Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Failed to trigger M-Pesa prompt" });
  }
});

// --- SECURE ADMIN LOGIN ---
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    let admin = await Admin.findOne({ username: "admin" });
    if (!admin) {
      const hash = await bcrypt.hash("AdminSecret2026!", 10);
      admin = await Admin.create({ username: "admin", passwordHash: hash });
    }

    if (username !== "admin") {
      return res.json({ success: false, message: "Wrong credentials" });
    }

    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) {
      return res.json({ success: false, message: "Wrong credentials" });
    }

    res.json({ success: true, token: "admin_token" });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

app.get("/api/admin/dashboard", async (req, res) => {
  try {
    const txs = await Transaction.find({ status: "Success" });
    const totalBalance = txs.reduce((sum, tx) => sum + tx.amount, 0);
    res.json({ success: true, totalBalance });
  } catch (err) {
    res.status(500).json({ success: false, totalBalance: 0 });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
