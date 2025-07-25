// index.js
const express = require("express");
const fetch = require("node-fetch");
const nodemailer = require("nodemailer");

const app = express();

// ────────────────────────────────────────────────────────
// Utility: extract 4 digits from CreditCard / MaskedCard / ShvaOutput
function extractLast4Digits({ CreditCardNumber, MaskedCardNo, ShvaOutput }) {
  const raw = CreditCardNumber || MaskedCardNo || "";
  const clean = raw.replace(/\D/g, "");
  if (clean.length >= 4) return clean.slice(-4);

  if (ShvaOutput) {
    const match = ShvaOutput.match(/\*+(\d{4})/); // looks for ******1234
    if (match) return match[1];
  }

  return "[Missing]";
}

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
// 2) SEND MAIL TO STAFF
// ────────────────────────────────────────────────────────
async function sendBccCopyToStaff(receiptLink, customerName, regId) {
  const transporter = nodemailer.createTransport({
    service: "Gmail",
    auth: {
      user: process.env.MY_EMAIL,
      pass: process.env.MY_PASSWORD
    }
  });

  await transporter.sendMail({
    from: `Puah Payments <${process.env.MY_EMAIL}>`,
    to: ["ronyt@puah.org.il", "hd@puah.org.il"],
    subject: `New Payment Received – ${customerName}`,
    html: `<p>New payment was received for registration ID: ${regId}.</p>
           <p>Receipt link: <a href="${receiptLink}">${receiptLink}</a></p>`
  });
}

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
    CreditCardNumber = "",
    MaskedCardNo = "",
    ShvaOutput = "",
    Course = "",
    Payments = "1",
    FirstPaymentTotal = "",
    FixedPaymentTotal = "",
    TotalPayments = "1"
  } = req.query;

  console.log("Pelecard callback:", req.query);

  if (Status === "approved") {
    const amount = parseFloat(Total) / 100;
    const courseClean = Course.replace(/^[\(]+|[\)]+$/g, "");
    const last4 = extractLast4Digits({ CreditCardNumber, MaskedCardNo, ShvaOutput });
    const totalPayments = parseInt(TotalPayments, 10) || 1;
    const firstPay = parseFloat(FirstPaymentTotal || 0) / 100;
    const fixedPay = parseFloat(FixedPaymentTotal || 0) / 100;

    let payments = [];

    if (totalPayments > 1 && fixedPay > 0 && firstPay > 0) {
      payments.push({
        Amount: firstPay,
        Details_CreditCard: {
          Last4Digits: last4,
          NumberOfPayments: totalPayments
        }
      });

      for (let i = 1; i < totalPayments; i++) {
        payments.push({
          Amount: fixedPay,
          Details_CreditCard: {
            Last4Digits: last4,
            NumberOfPayments: totalPayments
          }
        });
      }
    } else {
      payments.push({
        Amount: amount,
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
        ExternalReference: RegID
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
      const summitRes = await fetch("https://app.sumit.co.il/accounting/documents/create/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(summitPayload)
      });

      const summitData = await summitRes.json();
      console.log("Summit response status:", summitRes.status);
      console.log("Summit response:", summitData);

      if (summitData?.DocumentUrl) {
        await sendBccCopyToStaff(summitData.DocumentUrl, CustomerName, RegID);
      }
    } catch (err) {
      console.error("Summit API error:", err);
    }
  }

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
