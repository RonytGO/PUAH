const express = require("express");
const fetch = require("node-fetch");

const app = express();

app.get("/", async (req, res) => {
  const total         = req.query.total  || "6500";
  const RegID         = req.query.RegID  || "";
  const FAResponseID  = req.query.FAResponseID || "";
  const paramY        = req.query.phone  || "";    // <-- lower-case p

  const paramX = "Merkaz Limud";

  // Build your success / error URLs
  const successURL = 
    `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(total)}` +
    `&ParamX=${encodeURIComponent(paramX)}` +
    `&ParamY=${encodeURIComponent(paramY)}` +     // <-- use paramY
    `&Status=approved`;

  const errorURL = 
    `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(total)}` +
    `&ParamX=${encodeURIComponent(paramX)}` +
    `&ParamY=${encodeURIComponent(paramY)}` +     // <-- use paramY
    `&Status=failed`;

  console.log(
    "Received request →",
    { total, RegID, FAResponseID, paramY }
  );

  const payload = {
    terminal:    process.env.PELE_TERMINAL,
    user:        process.env.PELE_USER,
    password:    process.env.PELE_PASSWORD,
    ActionType:  "J4",
    Currency:    "1",
    FreeTotal:   "False",
    ShopNo:      "001",
    Total:       total,
    GoodURL:     successURL,
    ErrorURL:    errorURL,
    NotificationGoodMail:  "ronyt@puah.org.il",
    NotificationErrorMail: "ronyt@puah.org.il",
    ParamX:      paramX,
    ParamY:      paramY,                            // <-- use paramY

    // Split payments
    MaxPayments:          "10",
    MinPayments:          "1",
    MinPaymentsForCredit: "11",
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
    console.log("Pelecard init response:", data);

    if (data.URL) {
      return res.redirect(data.URL);
    } else {
      console.error("Pelecard error:", data);
      return res
        .status(500)
        .send("Pelecard error: " + JSON.stringify(data));
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
