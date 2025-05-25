
const express = require("express");
const fetch = require("node-fetch");

const app = express();

app.get("/", async (req, res) => {
  const total = req.query.total || "1100";
  console.log("▶️ Received request. Total:", total);

  const payload = {
    terminal: "0882577012",
    user: "TestYotam",
    password: "TestYotam1",
    ActionType: "J4",
    Currency: "1",
    FreeTotal: "False",
    ShopNo: "001",
    Total: total,
    GoodURL: "https://puahlimudim.org.il/",
    NotificationGoodMail: "ronyt@puah.org.il"
  };

  try {
    const peleRes = await fetch("https://gateway21.pelecard.biz/PaymentGW/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await peleRes.json();
    console.log("📩 Pelecard response:", data);

    if (data.URL) {
      return res.redirect(data.URL);
    } else {
      console.error("❌ Pelecard error:", data);
      return res.status(500).send("Pelecard error: " + JSON.stringify(data));
    }
  } catch (err) {
    console.error("🔥 Server error:", err);
    return res.status(500).send("Server error: " + err.message);
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("🚀 Server is listening on port", port);
});
