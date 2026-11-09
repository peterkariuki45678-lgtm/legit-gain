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
const mongoUri = process.env.MONGO_URI;
if (mongoUri) {
  mongoose.connect(mongoUri)
    .then(() => console.log("Database connected successfully"))
    .catch(err => console.error("Database connection error:", err));
}

// Schemas
const UserSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  balance: { type: Number, default: 0 },
  surveyCompleted: { type: Boolean, default: false },
  referredBy: String,
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

// --- DARAJA TOKEN ---
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

// --- USER SIGNUP & LOGIN ---
app.post("/api/signup", async (req, res) => {
  let { phone, password } = req.body;
  if (!phone || !password) return res.json({ success: false, message: "Fill all fields" });
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);

  try {
    const existing = await User.findOne({ phone });
    if (existing) return res.json({ success: false, message: "User already exists. Please Sign In." });

    const passwordHash = await bcrypt.hash(password, 10);
    const newUser = await User.create({ phone, passwordHash, balance: 0 });
    res.json({ success: true, user: newUser });
  } catch (err) {
    res.status(500).json({ success: false, message: "Signup error" });
  }
});

app.post("/api/login", async (req, res) => {
  let { phone, password } = req.body;
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);

  try {
    const user = await User.findOne({ phone });
    if (!user) return res.json({ success: false, message: "User not found" });

    const match = await bcrypt.compare(password, user.passwordHash);
    if (!match) return res.json({ success: false, message: "Incorrect password" });

    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, message: "Login error" });
  }
});

// --- SURVEY REWARD ROUTE ---
app.post("/api/survey", async (req, res) => {
  let { phone, county, education } = req.body;
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);

  try {
    const user = await User.findOne({ phone });
    if (!user || user.surveyCompleted) return res.json({ success: false, message: "Invalid or already completed" });

    // 2 questions answered = 80 KSh (40 KSh per question)
    user.balance += 80;
    user.surveyCompleted = true;
    await user.save();

    res.json({ success: true, balance: user.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: "Survey error" });
  }
});

app.get("/api/user/:phone", async (req, res) => {
  const user = await User.findOne({ phone: req.params.phone });
  res.json({ success: true, user });
});

// --- DARAJA STK PUSH (DYNAMIC AMOUNT) ---
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
        Amount: amount, // Dynamic amount (e.g. 400 KSh)
        PartyA: phoneNumber,
        PartyB: shortCode,
        PhoneNumber: phoneNumber,
        CallBackURL: "https://legit-gain.onrender.com/api/mpesa/callback",
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

    res.json({
      success: true,
      message: `Prompt sent to your phone for KES ${amount}. Enter your M-Pesa PIN to unlock!`
    });
  } catch (error) {
    console.res?.data || error.message;
    res.status(500).json({ success: false, error: "Failed to trigger M-Pesa prompt" });
  }
});

// --- WITHDRAWAL THRESHOLD CHECK ---
app.post("/api/withdraw", async (req, res) => {
  let { phone, name, amount } = req.body;
  const WITHDRAWAL_LIMIT = 5000;

  try {
    const user = await User.findOne({ phone });
    if (!user) return res.json({ success: false, message: "User not found" });

    if (amount < WITHDRAWAL_LIMIT || user.balance < WITHDRAWAL_LIMIT) {
      return res.json({ 
        success: false, 
        message: `Withdrawal failed! Minimum withdrawal limit is KES 5,000. Your current balance is KES ${user.balance}.` 
      });
    }

    user.balance -= amount;
    await user.save();
    res.json({ success: true, message: `Success! KES ${amount} sent to ${name} (${phone}).` });
  } catch (err) {
    res.status(500).json({ success: false, message: "Withdrawal error" });
  }
});

// --- ADMIN LOGIN & DASHBOARD ---
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    let admin = await Admin.findOne({ username: "admin" });
    if (!admin) {
      const hash = await bcrypt.hash("AdminSecret2026!", 10);
      admin = await Admin.create({ username: "admin", passwordHash: hash });
    }

    if (username !== "admin") return res.json({ success: false });
    const match = await bcrypt.compare(password, admin.passwordHash);
    if (!match) return res.json({ success: false });

    res.json({ success: true, token: "admin_token" });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

app.get("/api/admin/dashboard", async (req, res) => {
  const successfulTxs = await Transaction.find({ status: "Success" });
  const totalBalance = successfulTxs.reduce((sum, tx) => sum + tx.amount, 0);
  res.json({ success: true, totalBalance });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
