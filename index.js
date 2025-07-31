const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

let latestPelecardResponse = {};
let lastPelecardData = null;

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
    NotificationGoodMail: "ronyt@puah.org.il",
    NotificationErrorMail: "ronyt@puah.org.il",
    ParamX: paramX,
    MaxPayments: "10",
    MinPayments: "1",
    FirstPayment: "auto",
    FirstPaymentLock: "False",
    FeedbackDataTransferMethod: "GET"
  };

  try {
    const peleRes = await fetch("https://gateway21.pelecard.biz/PaymentGW/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await peleRes.json();
    console.log("Pelecard response:", data);

    if (data.URL) {
      return res.redirect(data.URL);
    }

    console.error("Pelecard init error:", data);
    res.status(500).send("Pelecard error: " + JSON.stringify(data));
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).send("Server error: " + err.message);
  }
});

// ────────────────────────────────────────────────────────
// 2) PELECARD CALLBACK POST
// ────────────────────────────────────────────────────────
app.post("/pelecard-callback", (req, res) => {
  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      console.error("Failed to parse Pelecard body JSON:", req.body);
      return res.status(400).send("Bad JSON");
    }
  }

  const resultData = body?.ResultData || body;

  if (resultData?.TransactionId) {
    latestPelecardResponse[resultData.TransactionId] = resultData;
    console.log("Stored callback for TransactionId:", resultData.TransactionId);
  } else {
    console.warn("Pelecard callback missing TransactionId:", resultData);
  }

  lastPelecardData = resultData;
  res.status(200).send("OK");
});

// ────────────────────────────────────────────────────────
// 3) CALLBACK (after user pays or fails)
// ────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const {
    RegID = "",
    FAResponseID = "",
    Total = "",
    Status = "",
    TransactionId = "",
    ConfirmationKey = "",
    CustomerName = "",
    CustomerEmail = "",
    phone = "",
    Course = ""
  } = req.query;

  const onward =
    `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}`;

  console.log("Callback triggered:", req.originalUrl);

  if (Status === "approved") {
    console.log("Looking for TransactionId:", TransactionId);
    const peleData = latestPelecardResponse[TransactionId] || lastPelecardData;
    console.log("Found PeleData?", !!peleData);

    if (!peleData) {
      console.error("No Pelecard data found for TransactionId:", TransactionId);
      return res.redirect(onward);
    }

    const {
      CreditCardNumber = "",
      TotalPayments = 1,
      FirstPaymentTotal = 0,
      FixedPaymentTotal = 0,
      ShvaResult = ""
    } = peleData;

    const last4 = CreditCardNumber.replace(/\D/g, "").slice(-4) || "0000";
    const totalPayments = parseInt(TotalPayments) || 1;
    const firstPay = parseFloat(FirstPaymentTotal || 0) / 100;
    const fixedPay = parseFloat(FixedPaymentTotal || 0) / 100;
    const amount = parseFloat(Total) / 100;
    const courseClean = Course.replace(/^[\(]+|[\)]+$/g, "");

    let payments = [];

    if (totalPayments > 1 && fixedPay > 0 && firstPay > 0) {
      payments.push({
        Amount: firstPay,
        Type: "CreditCard",
        Details_CreditCard: {
          Last4Digits: last4,
          NumberOfPayments: totalPayments
        }
      });

      for (let i = 1; i < totalPayments; i++) {
        payments.push({
          Amount: fixedPay,
          Type: "CreditCard",
          Details_CreditCard: {
            Last4Digits: last4,
            NumberOfPayments: totalPayments
          }
        });
      }
    } else {
      payments.push({
        Amount: amount,
        Type: "CreditCard",
        Details_CreditCard: {
          Last4Digits: last4,
          NumberOfPayments: 1
        }
      });
    }

    const summitPayload = {
      Details: {
        Date: new Date().toISOString(),
        Customer: {
          ExternalIdentifier: FAResponseID,
          SearchMode: 0,
          Name: CustomerName || "Unknown",
          EmailAddress: CustomerEmail || "unknown@puah.org.il"
        },
        SendByEmail: {
          EmailAddress: CustomerEmail || "unknown@puah.org.il",
          Original: true,
          SendAsPaymentRequest: false
        },
        Type: 1,
        ExternalReference: RegID,
        Comments: `ShvaResult: ${ShvaResult}`
      },
      Items: [
        {
          Quantity: 1,
          UnitPrice: amount,
          TotalPrice: amount,
          Item: { Name: courseClean || "קורס" }
        }
      ],
      Payments: payments,
      VATIncluded: true,
      Credentials: {
        CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
        APIKey: process.env.SUMMIT_API_KEY
      }
    };

    try {
      console.time("📤 SummitDocCreate");
      const summitRes = await fetch("https://app.sumit.co.il/accounting/documents/create/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(summitPayload)
      });
      const summitData = await summitRes.json();
      console.timeEnd("📤 SummitDocCreate");
      console.log("Summit response status:", summitRes.status);
      console.dir(summitData, { depth: null });
    } catch (err) {
      console.error("Summit API error:", err);
    }
  }

  console.log("🔁 Redirecting to FA:", onward);
  res.redirect(onward);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("🚀 Listening on port", port));
