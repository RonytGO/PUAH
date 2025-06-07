const express = require("express");
const fetch = require("node-fetch");

const app = express();

app.get("/", async (req, res) => {
  const total = req.query.total || "6500";
  const FAResponseID = req.query.FAResponseID || "";

  console.log("Received request. Total:", total);

  const payload = {
    terminal: "0882577012",
    user: "TestYotam",
    password: "TestYotam1",
    ActionType: "J4",
    Currency: "1",
    FreeTotal: "False",
    ShopNo: "001",
    Total: total,
    GoodURL: "https://placeholder.com", // placeholder, replaced dynamically after response
    NotificationGoodMail: "ronyt@puah.org.il",
    ParamX: "Merkaz Limud"
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
      // Build GoodURL with returned Pelecard data
      const goodURL = `https://puah.tfaforms.net/17?FAResponseID=${encodeURIComponent(FAResponseID)}&TransactionId=${encodeURIComponent(data.TransactionId || "")}&ConfirmationKey=${encodeURIComponent(data.ConfirmationKey || "")}&Status=${encodeURIComponent(data.Status || "")}&Total=${encodeURIComponent(total)}&ParamX=${encodeURIComponent(payload.ParamX)}`;

      console.log("Redirecting to:", goodURL);
      return res.redirect(goodURL);
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
