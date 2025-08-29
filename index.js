const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const { pool } = require("./db");

const app = express();

// Parse JSON and also raw text (gateway sometimes sends odd JSON)
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

// ---------- Helpers ----------
const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^\d-]/g, ""); // keep digits and minus
  if (!cleaned) return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
};

/** Return amount in MINOR units (agorot). Accepts 6500, "6500", 65.00, "65.00", "65,00" */
const parseMinorAmount = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") {
    return Number.isInteger(val) ? val : Math.round(val * 100);
  }
  const s = String(val).trim();
  if (!s) return null;
  const sDot = s.replace(",", "."); // handle "65,00"
  if (/^\d+(\.\d+)?$/.test(sDot)) {
    // numeric string, maybe decimal (major units)
    const f = parseFloat(sDot);
    return Number.isFinite(f) ? Math.round(f * 100) : null;
  }
  // fallback: strip non-digits (assume already minor)
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
};

/** Extract minor amount from a Pelecard-like result object */
const extractMinorAmount = (rd) => {
  const fields = [
    "TotalMinor",
    "AmountMinor",
    "TotalAmountMinor",
    "Total",
    "TotalAmount",
    "Amount",
    "TransactionAmount"
  ];
  for (const f of fields) {
    const n = parseMinorAmount(rd[f]);
    if (n !== null) return n;
  }
  return null;
};

/** Parse number of payments; checks several fields incl. JParam */
const parsePayments = (rd) => {
  const direct = ["TotalPayments", "NumberOfPayments", "Payments", "PaymentsNum"];
  for (const f of direct) {
    const n = toInt(rd[f]);
    if (n && n > 0) return n;
  }
  // Heuristic: JParam may contain "3" or "מספר תשלומים: 3"
  if (rd.JParam) {
    const m = String(rd.JParam).match(/(\d{1,2})/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0) return n;
    }
  }
  return 1;
};

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
    total = "6500", // prefer minor units from FA if you can
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

  // Upsert registration (store FA total as-is for fallback)
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
    re
