// Connecting to the sql in the cloud

const { pool } = require('./db');

// optional: fail fast if DB not reachable
(async () => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    console.log('DB connected:', rows[0]);
  } catch (e) {
    console.error('DB connect failed:', e);
    process.exit(1);
  }
})();


const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

const paymentMap = new Map(); // לזיכרון זמני של פרטי כרטיס

// ────────────────────────────────────────────────────────
// 1) INIT PAYMENT
// ────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  const {
    total = "6500",
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

// ────────────────────────────────────────────────────────
// 2) PELECARD CALLBACK
// ────────────────────────────────────────────────────────
app.post("/pelecard-callback", async (req, res) => {
  try {
    let rawBody = typeof req.body === "object" && !Buffer.isBuffer(req.body) 
      ? JSON.stringify(req.body) 
      : req.body;

    const cleanedBody = rawBody
      .replace(/'/g, '"')
      .replace(/ResultData\s*:\s*\[([^[\]]+?)\]/g, 'ResultData:{$1}');

    const body = JSON.parse(cleanedBody);
    const resultData = body.ResultData || body;

    const regId = (resultData.AdditionalDetailsParamX || "").split("|")[1] || "";
    const last4 = (resultData.CreditCardNumber || "").split("*").pop() || "0000";
    const payments = parseInt(resultData.TotalPayments || "1");
    const errorMsg = resultData.ErrorMessage || body.ErrorMessage || "";

    if (regId) {
      paymentMap.set(regId, {
        Last4Digits: last4,
        TotalPayments: payments,
        ErrorMessage: errorMsg
      });
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error(" Pelecard Callback Error:", err);
    res.status(500).send("Server Error");
  }
});

// ────────────────────────────────────────────────────────
// 3) CALLBACK REDIRECT + SUMMIT DOC
// ────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const {
    Status = "",
    RegID = "",
    FAResponseID = "",
    Total = "",
    phone = "",
    Course = "",
    CustomerName = "",
    CustomerEmail = ""
  } = req.query;

  const paymentData = paymentMap.get(RegID) || { Last4Digits: "0000", TotalPayments: 1, ErrorMessage: "" };
  const amount = parseFloat(Total) / 100;
  const courseClean = Course.replace(/^[\(]+|[\)]+$/g, "");

  const onward = `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}` +
    `&ErrorMessage=${encodeURIComponent(paymentData.ErrorMessage || "")}`;

  // צור מסמך רק אם יש FAResponseID
  if (FAResponseID && RegID) {
    const summitPayload = {
      Details: {
        Date: new Date().toISOString(),
        Customer: {
          ExternalIdentifier: FAResponseID,
          Name: CustomerName || "Unknown",
          EmailAddress: CustomerEmail || "unknown@puah.org.il"
        },
        Type: Status === "approved" ? 1 : 3,
        Comments: `Pelecard Status: ${Status}, Error: ${paymentData.ErrorMessage || "N/A"}`,
        ExternalReference: RegID
      },
      Items: Status === "approved" ? [{
        Quantity: 1,
        UnitPrice: amount,
        TotalPrice: amount,
        Item: { Name: courseClean || "קורס" }
      }] : [],
      Payments: Status === "approved" ? [{
        Amount: amount,
        Type: "CreditCard",
        Details_CreditCard: {
          Last4Digits: paymentData.Last4Digits,
          NumberOfPayments: paymentData.TotalPayments
        }
      }] : [],
      VATIncluded: true,
      Credentials: {
        CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
        APIKey: process.env.SUMMIT_API_KEY
      }
    };

    try {
      const summitRes = await fetch("https://app.sumit.co.il/accounting/documents/create/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(summitPayload)
      });
      const summitData = await summitRes.json();
      console.log("📄 Summit Response:", summitData);
    } catch (err) {
      console.error("❌ Summit Error:", err);
    }

    paymentMap.delete(RegID); // נקה מהזיכרון
  }

  res.redirect(onward);
});

// ────────────────────────────────────────────────────────
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("✅ Server running on port", port));
