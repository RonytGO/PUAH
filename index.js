// index.js
const express = require("express");
const fetch   = require("node-fetch");

const app = express();

// ────────────────────────────────────────────────────────
// 1) INIT PAYMENT
// ────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  const total        = req.query.total         || "6500";
  const RegID        = req.query.RegID         || "";
  const FAResponseID = req.query.FAResponseID  || "";
  // build your X-param however you like:
  const paramX = `ML|${RegID}`;

  // instead of pointing directly to FormAssembly,
  // tell Pelecard to callback to our `/callback` endpoint:
  const baseCallback = `https://${req.get("host")}/callback`;
  const commonQS = 
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(total)}` +
    `&ParamX=${encodeURIComponent(paramX)}`;

  const payload = {
    terminal:    process.env.PELE_TERMINAL,
    user:        process.env.PELE_USER,
    password:    process.env.PELE_PASSWORD,

    ActionType:  "J4",
    Currency:    "1",
    FreeTotal:   "False",
    ShopNo:      "001",
    Total:       total,

    // on *success* Pelecard will GET /callback?…&Status=approved
    GoodURL:  `${baseCallback}${commonQS}&Status=approved`,
    // on *failure* Pelecard will GET /callback?…&Status=failed
    ErrorURL: `${baseCallback}${commonQS}&Status=failed`,

    NotificationGoodMail:  "ronyt@puah.org.il",
    NotificationErrorMail: "ronyt@puah.org.il",

    ParamX:      paramX,
    MaxPayments:          "10",
    MinPayments:          "1",
    FirstPayment:         "auto",
    FirstPaymentLock:     "False"
  };

  try {
    const peleRes = await fetch(
      "https://gateway21.pelecard.biz/PaymentGW/init",
      {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload)
      }
    );
    const data = await peleRes.json();

    if (data.URL) {
      return res.redirect(data.URL);
    }
    console.error("Pelecard init error:", data);
    return res.status(500).send("Pelecard error: " + JSON.stringify(data));
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).send("Server error: " + err.message);
  }
});


// ────────────────────────────────────────────────────────
// 2) CALLBACK (after user pays or fails)
// ────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const {
    RegID,
    FAResponseID,
    Total,
    Status,
    TransactionId,
    ConfirmationKey
  } = req.query;

  console.log("Pelecard callback:", req.query);

  // If it was approved, fire off your Summit “create document”:
  if (Status === "approved") {
    try {
      const summitPayload = {
        Details: {
          Date:        new Date().toISOString(),          // or null
          Customer:    { ExternalIdentifier: FAResponseID },
          SendByEmail: { EmailAddress: "ronyt@puah.org.il", Original: true },
          Type:        1,
          ExternalReference: RegID,
        },
        Items: [
          {
            Quantity:            1,
            UnitPrice:           parseFloat(Total),
            TotalPrice:          parseFloat(Total),
            Item: { Name: "קורס" }
          }
        ],
        Payments: [
          {
            Amount: parseFloat(Total),
            Details_CreditCard: {
              Last4Digits: (ConfirmationKey||"").slice(-4)
            }
          }
        ],
        VATIncluded: true,
        Credentials: {
          CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
          APIKey:    process.env.SUMMIT_API_KEY
        }
      };

      const summitRes = await fetch(
        "https://app.sumit.co.il/accounting/documents/create/",
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(summitPayload)
        }
      );
      const summitData = await summitRes.json();
      console.log("Summit response:", summitData);
    } catch (err) {
      console.error("Summit API error:", err);
    }
  }

  // Finally, redirect the user on to your FormAssembly “17”:
  const onward = `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}`;
  res.redirect(onward);
});


const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on port", port));
