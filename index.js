// index.js
const express = require("express");
const fetch   = require("node-fetch");

const app = express();

// ────────────────────────────────────────────────────────
// 1) INIT PAYMENT
// ────────────────────────────────────────────────────────
app.get("/", async (req, res) => {
  // pull everything from the querystring
  const {
    total         = "6500",
    RegID         = "",
    FAResponseID  = "",
    CustomerName  = "",
    CustomerEmail = "",
    phone         = "",
    Course        = ""
  } = req.query;

  // our internal X-param
  const paramX = `ML|${RegID}`;

  // build the callback URL that Pelecard will hit once they're done
  const baseCallback = `https://${req.get("host")}/callback`;
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
    terminal:    process.env.PELE_TERMINAL,
    user:        process.env.PELE_USER,
    password:    process.env.PELE_PASSWORD,
    ActionType:  "J4",
    Currency:    "1",
    FreeTotal:   "False",
    ShopNo:      "001",
    Total:       total,
    GoodURL:     `${baseCallback}${commonQS}&Status=approved`,
    ErrorURL:    `${baseCallback}${commonQS}&Status=failed`,
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
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      }
    );
    const data = await peleRes.json();

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
// 2) CALLBACK (after user pays or fails)
// ────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const {
    RegID         = "",
    FAResponseID  = "",
    Total         = "",
    Status        = "",
    TransactionId = "",
    ConfirmationKey = "",
    CustomerName  = "",
    CustomerEmail = "",
    phone         = "",
    CreditCardNumber = "",
    MaskedCardNo  = "",
    Course        = ""
  } = req.query;

  console.log("Pelecard callback:", req.query);

  if (Status === "approved") {
    // Pelecard sends cents (e.g. 100 => ₪1), so convert back:
    const amount = parseFloat(Total) / 100;

    // strip any stray parentheses from Course
    const courseClean = Course.replace(/^\(+/, "").replace(/\)+$/, "");

    // Improved last-4 digits extraction
    const getLast4 = (cardNumber) => {
      if (!cardNumber) return '';
      const digitsOnly = cardNumber.replace(/\D/g, '');
      return digitsOnly.slice(-4);
    };
    const last4 = getLast4(CreditCardNumber || MaskedCardNo || '');

     // build a comma-separated "bcc" list
    const toList = ["ronyt@puah.org.il", "hd@puah.org.il"]
      .filter(Boolean)
      .join(",");



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
          EmailAddress:   CustomerEmail || "unknown@puah.org.il",
          BccEmailAddress:toList,
          Original:       true,
          SendAsPaymentRequest: false
        },
        Type: 1,
        ExternalReference: RegID
      },
      Items: [
        {
          Quantity:   1,
          UnitPrice:  amount,
          TotalPrice: amount,
          Item:       { Name: courseClean || "קורס" }
        }
      ],
      Payments: [
        {
          Amount: amount,
          Details_CreditCard: {
            Last4Digits: last4
          }
        }
      ],
      VATIncluded: true,
      Credentials: {
        CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
        APIKey:    process.env.SUMMIT_API_KEY
      }
    };

    try {
      const summitRes = await fetch(
        "https://app.sumit.co.il/accounting/documents/create/",
        {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify(summitPayload)
        }
      );
      console.log("Summit response status:", summitRes.status);
    } catch (err) {
      console.error("Summit API error:", err);
    }
  }

  // finally send the user back to your FA form 17:
  const onward =
    `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}`;
  res.redirect(onward);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Listening on port", port));
