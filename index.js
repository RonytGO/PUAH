const express = require("express");
const fetch = require("node-fetch");

const app = express();

app.get("/", async (req, res) => {
  const total = req.query.total || "6500";
  const FAResponseID = req.query.FAResponseID || "";
  const paramX = "Merkaz Limud";

  // Build the URLs that Pelecard will redirect to on success or failure
  const successURL = `https://puah.tfaforms.net/17?FAResponseID=${encodeURIComponent(FAResponseID)}&Total=${encodeURIComponent(total)}&ParamX=${encodeURIComponent(paramX)}&Status=approved`;
  const errorURL   = `https://puah.tfaforms.net/17?FAResponseID=${encodeURIComponent(FAResponseID)}&Total=${encodeURIComponent(total)}&ParamX=${encodeURIComponent(paramX)}&Status=failed`;

  console.log("Received request. Total:", total, "FAResponseID:", FAResponseID);

  const payload = {
    terminal: "0882577012",
    user: "TestYotam",
    password: "TestYotam1",
    ActionType: "J4",
    Currency: "1",
    FreeTotal: "False",
    ShopNo: "001",
    Total: total,
    GoodURL: successURL,       // Redirect here on payment success
    ErrorURL: errorURL,        // Redirect here on payment failure
    NotificationGoodMail: "ronyt@puah.org.il",
    NotificationErrorMail: "ronyt@puah.org.il",
    ParamX: paramX
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
      return res.redirect(data.URL); // Show Pelecard’s payment iframe/page
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
  console.log("Server is listening on port", port);
});
