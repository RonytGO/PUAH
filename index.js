const express = require("express");
const fetch = require("node-fetch");

const app = express();

app.get("/", async (req, res) => {
  const total        = req.query.total || "6500";
  const FAResponseID = req.query.FAResponseID || "";
  const paramX       = "Merkaz Limud";

  // Build two URLs — one for success, one for failure
  const successURL = `https://puah.tfaforms.net/17` +
    `?FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(total)}` +
    `&ParamX=${encodeURIComponent(paramX)}` +
    `&Status=approved`;

  const errorURL = `https://puah.tfaforms.net/17` +
    `?FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(total)}` +
    `&ParamX=${encodeURIComponent(paramX)}` +
    `&Status=failed`;

  console.log("Received request – total:", total, "FAResponseID:", FAResponseID);

  const payload = {
    terminal: process.env.PELE_TERMINAL,
    user:     process.env.PELE_USER,
    password: process.env.PELE_PASSWORD,
    ActionType: "J4",
    Currency: "1",
    FreeTotal: "False",
    ShopNo: "001",
    Total: total,
    GoodURL: successURL,      // Pelecard will redirect here on success
    ErrorURL: errorURL,       // …or here on failure
    NotificationGoodMail: "ronyt@puah.org.il",
    NotificationErrorMail: "ronyt@puah.org.il",
    ParamX: paramX,

    // ←— SPLIT PAYMENTS —→
    MaxPayments:          "10",    // allow up to 10 installments
    MinPayments:          "1",     // minimum 1 installment
    MinPaymentsForCredit: "1",     // threshold to treat as credit sale
    FirstPayment:         "auto",  // auto-calculate the first installment
    FirstPaymentLock:     "False"  // allow user to change first installment
  };

  try {
    const peleRes = await fetch("https://gateway21.pelecard.biz/PaymentGW/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await peleRes.json();
    console.log("Pelecard init response:", data);

    if (data.URL) {
      // Send the user to Pelecard's payment page
      return res.redirect(data.URL);
    } else {
      console.error("Pelecard error:", data);
      return res.status(500).send("Pelecard error: " + JSON.stringify(data));
    }
  } catch (err) {
    console.error("Server error:", err);
    return res.status(500).send("Server error: " + err.message);
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("Listening on port", port);
});
