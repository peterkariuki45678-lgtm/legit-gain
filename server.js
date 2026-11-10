
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const UserSchema = new mongoose.Schema({
  fullName: String,
  phone: { type: String, unique: true },
  county: String,
  passwordHash: String,
  referralCode: { type: String, unique: true },
  referredBy: { type: String, default: "" },
  surveyAnswers: { type: [String], default: [] },
  createdAt: { type: Date, default: Date.now }
});

const TaskSchema = new mongoose.Schema({
  userId: mongoose.Schema.Types.ObjectId,
  taskId: String,
  taskName: String,
  notes: String,
  status: { type: String, default: "Pending review" },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model("User", UserSchema);
const TaskSubmission = mongoose.model("TaskSubmission", TaskSchema);

const hotels = [
"Sarova Stanley","Villa Rosa Kempinski","Fairmont The Norfolk",
"Hemingways Nairobi","Tribe Hotel","The Boma Nairobi",
"Radisson Blu Nairobi","Nairobi Serena Hotel","Ole Sereni","Eka Hotel",
"Four Points Sheraton Airport","Crowne Plaza Nairobi Airport",
"Glee Nairobi","Trademark Hotel","The Social House",
"Movenpick Hotel Nairobi","Golden Tulip Westlands",
"Best Western Meridian","PrideInn Azure","Panari Hotel",
"Sarova Panafric","Weston Hotel","ibis Styles Nairobi",
"Park Inn Radisson","Sankara Nairobi","Gem Forest Hotel",
"Kwetu Nairobi","Enashipai Resort","Lake Naivasha Resort",
"Lake Naivasha Sopa","Great Rift Valley Lodge","Sarova Lion Hill",
"The Cliff Nakuru","Mbweha Camp","Sarova Woodlands",
"Lake Elementaita Lodge","Lake Naivasha Country Club",
"Mombasa Serena","Sarova Whitesands","Voyager Beach Resort",
"PrideInn Paradise","Bamburi Beach Hotel","English Point Marina",
"Severin Sea Lodge","Diani Reef","Leopard Beach Resort",
"Baobab Beach Resort","Swahili Beach Resort","The Sands at Chale",
"Pinewood Beach Resort","Almanara Resort","Southern Palms",
"Kisumu Hotel","Acacia Premier Kisumu","Ciala Resort",
"Sovereign Hotel Kisumu","Boma Inn Eldoret","Eka Hotel Eldoret",
"Sirikwa Hotel","Fairmont Mount Kenya Safari Club",
"Serena Mountain Lodge","Ark Lodge","Aberdare Country Club"
].map((name, i) => ({
  id: "HOTEL-" + (i + 1),
  name
}));

function normalizePhone(phone) {
  phone = String(phone || "").replace(/\D/g, "");
  if (phone.startsWith("0")) phone = "254" + phone.slice(1);
  return phone;
}

function createToken(data) {
  const body = Buffer.from(JSON.stringify({
    ...data,
    expires: Date.now() + 7 * 86400000
  })).toString("base64url");

  const signature = crypto.createHmac(
    "sha256",
    process.env.TOKEN_SECRET || "temporary-secret"
  ).update(body).digest("base64url");

  return body + "." + signature;
}

function verifyToken(req, role) {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "");
    const [body, signature] = token.split(".");
    const expected = crypto.createHmac(
      "sha256",
      process.env.TOKEN_SECRET || "temporary-secret"
    ).update(body).digest("base64url");

    if (signature !== expected) return null;

    const data = JSON.parse(
      Buffer.from(body, "base64url").toString()
    );

    if (data.expires < Date.now() || data.role !== role) return null;
    return data;
  } catch {
    return null;
  }
}

function userAuth(req, res, next) {
  const data = verifyToken(req, "user");
  if (!data) return res.status(401).json({
    success: false,
    message: "Please sign in again."
  });
  req.userId = data.id;
  next();
}

function adminAuth(req, res, next) {
  const data = verifyToken(req, "admin");
  if (!data) return res.status(401).json({
    success: false,
    message: "Admin login required."
  });
  next();
}

function safeUser(user) {
  return {
    id: user._id,
    fullName: user.fullName,
    phone: user.phone,
    county: user.county,
    referralCode: user.referralCode,
    referredBy: user.referredBy,
    createdAt: user.createdAt
  };
}

app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    database: mongoose.connection.readyState === 1
      ? "Connected" : "Connecting",
    mode: "TEST MODE"
  });
});

app.post("/api/signup", async (req, res) => {
  try {
    const { fullName, county, password } = req.body;
    const phone = normalizePhone(req.body.phone);

    if (!fullName || !county || !password || password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Complete all fields. Password must be at least 6 characters."
      });
    }

    if (!/^254\d{9}$/.test(phone)) {
      return res.status(400).json({
        success: false,
        message: "Enter a valid Kenyan phone number."
      });
    }

    if (await User.findOne({ phone })) {
      return res.status(409).json({
        success: false,
        message: "Phone already registered. Please sign in."
      });
    }

    const referralCode =
      "LG" + crypto.randomBytes(4).toString("hex").toUpperCase();

    const referredBy = String(req.body.referralCode || "").trim().toUpperCase();

    if (referredBy && !(await User.findOne({ referralCode: referredBy }))) {
      return res.status(400).json({
        success: false,
        message: "Invalid referral code."
      });
    }

    const user = await User.create({
      fullName,
      phone,
      county,
      passwordHash: await bcrypt.hash(password, 12),
      referralCode,
      referredBy
    });

    res.json({
      success: true,
      user: safeUser(user),
      token: createToken({ role: "user", id: String(user._id) })
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Signup failed. Please try again."
    });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const user = await User.findOne({ phone });

    if (!user || !(await bcrypt.compare(
      String(req.body.password || ""),
      user.passwordHash
    ))) {
      return res.status(401).json({
        success: false,
        message: "Incorrect phone number or password."
      });
    }

    res.json({
      success: true,
      user: safeUser(user),
      token: createToken({ role: "user", id: String(user._id) })
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Login failed."
    });
  }
});

app.get("/api/me", userAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({
      success: false,
      message: "User not found."
    });

    const submissions = await TaskSubmission.find({
      userId: user._id
    }).sort({ createdAt: -1 });

    const referrals = await User.countDocuments({
      referredBy: user.referralCode
    });

    res.json({
      success: true,
      user: safeUser(user),
      submissions,
      referrals,
      wallet: {
        balance: 0,
        earned: 0,
        message: "Test mode. Cash earnings are not enabled."
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Could not load dashboard."
    });
  }
});

app.get("/api/tasks", userAuth, (req, res) => {
  res.json({ success: true, tasks: hotels });
});

app.post("/api/tasks/:id/submit", userAuth, async (req, res) => {
  try {
    const task = hotels.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({
      success: false,
      message: "Task not found."
    });

    const notes = String(req.body.notes || "").trim();
    if (notes.length < 30) return res.status(400).json({
      success: false,
      message: "Please enter at least 30 characters of research."
    });

    const submission = await TaskSubmission.create({
      userId: req.userId,
      taskId: task.id,
      taskName: task.name,
      notes
    });

    res.json({
      success: true,
      submission,
      message: "Research submitted for review. No cash reward is enabled in test mode."
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Submission failed."
    });
  }
});

app.post("/api/survey", userAuth, async (req, res) => {
  const answers = req.body.answers;

  if (!Array.isArray(answers) || answers.length !== 10 ||
      answers.some(a => !String(a).trim())) {
    return res.status(400).json({
      success: false,
      message: "Answer all ten questions."
    });
  }

  await User.findByIdAndUpdate(req.userId, {
    surveyAnswers: answers
  });

  res.json({
    success: true,
    message: "Survey saved. No cash reward is enabled in test mode."
  });
});

app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) {
    return res.status(503).json({
      success: false,
      message: "Configure admin credentials in Render."
    });
  }

  if (req.body.username !== process.env.ADMIN_USERNAME ||
      req.body.password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({
      success: false,
      message: "Incorrect admin credentials."
    });
  }

  res.json({
    success: true,
    token: createToken({ role: "admin", id: "admin" })
  });
});

app.get("/api/admin/overview", adminAuth, async (req, res) => {
  const [users, submissions, pending] = await Promise.all([
    User.countDocuments(),
    TaskSubmission.countDocuments(),
    TaskSubmission.countDocuments({ status: "Pending review" })
  ]);

  res.json({
    success: true,
    users,
    submissions,
    pending,
    message: "Test mode. No payment or cash withdrawals."
  });
});

app.get("/api/admin/submissions", adminAuth, async (req, res) => {
  const submissions = await TaskSubmission.find()
    .populate("userId", "fullName phone")
    .sort({ createdAt: -1 })
    .limit(200);

  res.json({ success: true, submissions });
});

app.patch("/api/admin/submissions/:id", adminAuth, async (req, res) => {
  if (!["Approved", "Rejected"].includes(req.body.status)) {
    return res.status(400).json({
      success: false,
      message: "Invalid status."
    });
  }

  const submission = await TaskSubmission.findByIdAndUpdate(
    req.params.id,
    { status: req.body.status },
    { new: true }
  );

  if (!submission) return res.status(404).json({
    success: false,
    message: "Submission not found."
  });

  res.json({
    success: true,
    message: "Submission updated. No cash reward is issued in test mode."
  });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("MongoDB connected"))
  .catch(error => console.error("MongoDB error:", error.message));

app.listen(process.env.PORT || 3000, () => {
  console.log("Legit Gain server running.");
});
