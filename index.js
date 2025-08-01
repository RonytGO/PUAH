const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.text({ type: "*/*" })); // Handle raw body for malformed JSON
app.use(bodyParser.json());

// ────────────────────────────────────────────────────────
// 1) INIT PAYMENT (IFRAME REDIRECT)
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
    `&Total=${encodeURIComponent(total)}` +
    `&ParamX=${encodeURIComponent(paramX)}`;

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
// 2) PELECARD SERVER CALLBACK (SUMMIT INTEGRATION)
// ────────────────────────────────────────────────────────
app.post("/pelecard-callback", async (req, res) => {
  try {
    // Handle malformed JSON from Pelecard
    let rawBody = typeof req.body === "object" && !Buffer.isBuffer(req.body) 
      ? JSON.stringify(req.body) 
      : req.body;

    const cleanedBody = rawBody
      .replace(/'/g, '"')
      .replace(/ResultData\s*:\s*\[([^[\]]+?)\]/g, 'ResultData:{$1}');

    const body = JSON.parse(cleanedBody);
    const resultData = body.ResultData || body;

    if (!resultData?.TransactionId) {
      console.error("Invalid Pelecard callback:", cleanedBody);
      return res.status(400).send("Missing TransactionId");
    }

    // Debug: Log full payload
    console.log("Pelecard Data:", JSON.stringify(resultData, null, 2));

    // Process payment data
    const last4 = (resultData.CreditCardNumber || "").split("*").pop() || "0000";
    const amount = parseFloat(resultData.DebitTotal || "0") / 100;
    const regId = (resultData.AdditionalDetailsParamX || "").split("|")[1] || "";

    // Submit to Summit
    const summitPayload = {
      Details: {
        Date: new Date().toISOString(),
        Customer: {
          ExternalIdentifier: regId,
          Name: resultData.CardHolderName || "Unknown",
          EmailAddress: resultData.CardHolderEmail || "unknown@puah.org.il"
        },
        Type: 1,
        ExternalReference: regId,
        Comments: `Payment via Pelecard (TXN: ${resultData.TransactionId})`
      },
      Payments: [{
        Amount: amount,
        Type: "CreditCard",
        Details_CreditCard: {
          Last4Digits: last4,
          NumberOfPayments: parseInt(resultData.TotalPayments || "1")
        }
      }],
      Credentials: {
        CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
        APIKey: process.env.SUMMIT_API_KEY
      }
    };

    console.log("Summit Payload:", JSON.stringify(summitPayload, null, 2));
    const summitRes = await fetch("https://app.sumit.co.il/accounting/documents/create/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(summitPayload)
    });
    
    const summitData = await summitRes.json();
    console.log("📩 Summit Response:", summitData);
    res.status(200).send("OK");

  } catch (err) {
    console.error(" Pelecard Callback Error:", err);
    res.status(500).send("Server Error");
  }
});

// ────────────────────────────────────────────────────────
// 3) USER REDIRECT (AFTER PAYMENT)
// ────────────────────────────────────────────────────────
app.get("/callback", (req, res) => {
  const { Status, RegID, FAResponseID, Total, phone, Course } = req.query;
  const onward = `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}`;
  res.redirect(onward);
});

// Start server
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on port", port));
