const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const { pool } = require("./db");

const app = express();

// Parse JSON and also raw text (gateway sometimes sends odd JSON)
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

// Non-blocking DB check
(async () => {
  try {
    const { rows } = await pool.query("SELECT 1 AS ok");
    console.log("DB connected at startup:", rows[0]);
  } catch (e) {
    console.error("DB check failed at startup:", e.message);
  }
})();

// Health
app.get("/db-ping", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT now() AS ts");
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 1) INIT PAYMENT (store registration; redirect to Pelecard)
app.get("/", async (req, res) => {
  const {
    total = "6500", // send whatever FA gives you; no conversions here
    RegID = "",
    FAResponseID = "",
    CustomerName = "",
    CustomerEmail = "",
    phone = "",
    Course = ""
  } = req.query;

  const paramX = `ML|${RegID}`;
  const baseCallback = `https://${req.get("host")}/callback`;
  const serverCallback = `https://${req.get("host")}/pelecard-callback`;

  const commonQS =
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&CustomerName=${encodeURIComponent(CustomerName)}` +
    `&CustomerEmail=${encodeURIComponent(CustomerEmail)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}` +
    `&Total=${encodeURIComponent(total)}`;

  // Upsert registration (store FA total as-is for audit only; we DO NOT use it later)
  try {
    await pool.query(
      `INSERT INTO registrations (reg_id, fa_response_id, customer_name, customer_email, phone, course, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (reg_id) DO UPDATE
       SET fa_response_id = EXCLUDED.fa_response_id,
           customer_name  = EXCLUDED.customer_name,
           customer_email = EXCLUDED.customer_email,
           phone          = EXCLUDED.phone,
           course         = EXCLUDED.course,
           total          = EXCLUDED.total,
           updated_at     = now()`,
      [RegID, FAResponseID, CustomerName, CustomerEmail, phone, Course, total]
    );
  } catch (e) {
    console.error("registrations upsert failed:", e);
  }

  const payload = {
    terminal: process.env.PELE_TERMINAL,
    user: process.env.PELE_USER,
    password: process.env.PELE_PASSWORD,
    ActionType: "J4",
    Currency: "1",
    FreeTotal: "False",
    ShopNo: "001",
    Total: total,
    GoodURL: `${baseCallback}${commonQS}&Status=approved`,
    ErrorURL: `${baseCallback}${commonQS}&Status=failed`,
    NotificationGoodMail: "ronyt@puah.org.il",
    NotificationErrorMail: "ronyt@puah.org.il",
    ServerSideGoodFeedbackURL: serverCallback,
    ServerSideErrorFeedbackURL: serverCallback,
    ParamX: paramX,
    MaxPayments: "10",
    MinPayments: "1"
  };

  try {
    const peleRes = await fetch("https://gateway21.pelecard.biz/PaymentGW/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await peleRes.json();
    if (data.URL) return res.redirect(data.URL);
    res.status(500).send("Pelecard error: " + JSON.stringify(data));
  } catch (err) {
    res.status(500).send("Server error: " + err.message);
  }
});

// 2) PELECARD WEBHOOK (authoritative; creates Summit doc idempotently)
app.post("/pelecard-callback", async (req, res) => {
  try {
    // Normalize body -> object
    let bodyObj;
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      bodyObj = req.body;
    } else {
      const raw = String(req.body || "")
        .replace(/'/g, '"')
        .replace(/ResultData\s*:\s*\[([^[\]()]()]()
