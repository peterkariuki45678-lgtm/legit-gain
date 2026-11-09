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

// Connect to MongoDB Atlas
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("Database connected successfully"))
  .catch(err => console.error("Database connection error:", err));

// Database Schemas
const UserSchema = new mongoose.Schema({
  phone: { type: String, unique: true, required: true },
  balance: { type: Number, default: 0 },
  surveyCompleted: { type: Boolean, default: false },
  unlockedTasks: [Number],
  referralCode: String,
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

// --- USER REGISTRATION & SURVEY SUBMISSION ---
app.post("/api/register-survey", async (req, res) => {
  const { phone, answers, referralCode } = req.body;
  try {
    let user = await User.findOne({ phone });
    if (!user) {
      const generatedRef = "LG-" + Math.floor(1000 + Math.random() * 9000);
      user = new User({ phone, referralCode: generatedRef });
      
      if (referralCode) {
        const referrer = await User.findOne({ referralCode });
        if (referrer) {
          referrer.balance += 500; // Referral bonus
          await referrer.save();
          user.referredBy = referralCode;
        }
      }
    }

    if (!user.surveyCompleted) {
      // 9 survey questions * 40 KES = 360 KES credited
      const surveyEarnings = 9 * 40; 
      user.balance += surveyEarnings;
      user.surveyCompleted = true;
    }

    await user.save();
    res.json({ success: true, message: "Survey completed! Credited to your account.", user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- M-PESA STK PUSH (UNLOCK TASK WITH 40%) ---
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
        Amount: amount, // Dynamic 40% amount
        PartyA: phoneNumber,
        PartyB: shortCode,
        PhoneNumber: phoneNumber,
        CallBackURL: "https://mydomain.com/api/mpesa/callback",
        AccountReference: "LegitGainUnlock",
        TransactionDesc: "Unlock Hotel Review Task"
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
      message: `Prompt sent to ${phoneNumber} for KES ${amount}. Enter your M-Pesa PIN.`,
      checkoutRequestId: stkResponse.data.CheckoutRequestID
    });
  } catch (error) {
    console.error("STK Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Failed to initiate M-Pesa prompt" });
  }
});

// --- ADMIN LOGIN ---
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    let admin = await Admin.findOne({ username: "admin" });
    if (!admin) {
      const hash = await bcrypt.hash("AdminSecret2026!", 10);
      admin = await Admin.create({ username: "admin", passwordHash: hash });
    }

    const isMatch = await bcrypt.compare(password, admin.passwordHash);
    if (!isMatch) return res.status(400).json({ success: false, message: "Invalid credentials" });

    res.json({ success: true, token: "admin_token_secure" });
  } catch (err) {
    res.status(500).json({ success: false, error: "Server error" });
  }
});

// --- ADMIN DASHBOARD BALANCE ---
app.get("/api/admin/dashboard", async (req, res) => {
  try {
    const txs = await Transaction.find({ status: "Success" });
    const totalBalance = txs.reduce((sum, t) => sum + t.amount, 0);
    res.json({ success: true, totalBalance, transactions: txs });
  } catch (err) {
    res.status(500).json({ success: false, error: "Failed to load dashboard" });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
