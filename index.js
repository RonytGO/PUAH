// index.js
const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const { pool } = require("./db");

const app = express();

// Body parsing: keep text for odd callbacks + JSON for normal traffic
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

/** Fail fast if DB not reachable (once at boot) */
// NON-BLOCKING STARTUP CHECK (SERVICE STILL STARTS)
(async () => {
  try {
    const { rows } = await pool.query('SELECT 1 AS ok');
    console.log('DB connected at startup:', rows[0]);
  } catch (e) {
    console.error('DB check failed at startup (service will still start):', e.message);
    console.error('→ Verify Cloud SQL connection + env vars; use /db-ping to test.');
  }
})();


/** Quick health route to confirm DB + networking */
app.get("/db-ping", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT now() AS ts");
    res.json(rows[0]); // { ts: "..." }
  } catch (e) {
    console.error("db-ping error:", e);
    res.status(500).json({ error: e.message });
  }
});

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
    `&Total=${encodeURIComponent(total)}`;

  // Keep a registration record (upsert)
  try {
    await pool.query(
      `INSERT INTO registrations (reg_id, fa_response_id, customer_name, customer_email, phone, course)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (reg_id) DO UPDATE
       SET fa_response_id = EXCLUDED.fa_response_id,
           customer_name  = EXCLUDED.customer_name,
           customer_email = EXCLUDED.customer_email,
           phone          = EXCLUDED.phone,
           course         = EXCLUDED.course,
           updated_at     = now()`,
      [RegID, FAResponseID, CustomerName, CustomerEmail, phone, Course]
    );
  } catch (e) {
    console.error("registrations upsert failed:", e);
    // continue; not fatal for redirect to Pelecard
  }

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
// 2) PELECARD SERVER CALLBACK  (audit + idempotent upsert)
// ────────────────────────────────────────────────────────
app.post("/pelecard-callback", async (req, res) => {
  try {
    // Some gateways send malformed JSON or text—normalize:
    let bodyObj;
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      bodyObj = req.body;
    } else {
      const raw = String(req.body || "")
        .replace(/'/g, '"')
        .replace(/ResultData\s*:\s*\[([^[\]]+?)\]/g, 'ResultData:{$1}');
      bodyObj = JSON.parse(raw);
    }

    const rd = bodyObj.ResultData || bodyObj;
    const regId = (rd.AdditionalDetailsParamX || "").split("|")[1] || "";
    const last4 = (rd.CreditCardNumber || "").split("*").pop() || "0000";
    const payments = parseInt(rd.TotalPayments || "1", 10);
    const txId = rd.TransactionId || null;
    const amountMinor = parseInt(rd.Total || "0", 10);
    const shva = rd.ShvaResult || "";
    const status = shva === "000" ? "approved" : "failed";
    const errorMsg = rd.ErrorMessage || bodyObj.ErrorMessage || "";

    // 2.1) Always store raw event for audit
    await pool.query(
      `INSERT INTO callback_events (reg_id, kind, raw_payload, headers)
       VALUES ($1,$2,$3,$4)`,
      [regId || null, "pelecard_server", bodyObj, req.headers]
    );

    // 2.2) Idempotent upsert by gateway TransactionId
    if (txId) {
      await pool.query(
        `INSERT INTO payment_attempts
           (reg_id, status, amount_minor, total_payments, last4,
            pelecard_transaction_id, shva_result, approve_number, confirmation_key,
            error_message, raw_payload)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (pelecard_transaction_id) DO UPDATE
         SET status = EXCLUDED.status,
             amount_minor = EXCLUDED.amount_minor,
             total_payments = EXCLUDED.total_payments,
             last4 = EXCLUDED.last4,
             shva_result = EXCLUDED.shva_result,
             approve_number = EXCLUDED.approve_number,
             confirmation_key = EXCLUDED.confirmation_key,
             error_message = EXCLUDED.error_message,
             raw_payload = EXCLUDED.raw_payload`,
        [
          regId,
          status,
          amountMinor,
          payments,
          last4,
          txId,
          shva || null,
          rd.DebitApproveNumber || null,
          rd.ConfirmationKey || null,
          errorMsg || null,
          bodyObj
        ]
      );
    }

    // Return 200 so the gateway doesn't retry aggressively
    res.status(200).send("OK");
  } catch (err) {
    console.error("Pelecard Callback Error:", err);
    // Still 200 to avoid repeated retries; change to 500 if you prefer retries.
    res.status(200).send("OK");
  }
});

// ────────────────────────────────────────────────────────
// 3) CLIENT REDIRECT + SUMMIT DOC
// ────────────────────────────────────────────────────────
app.get("/callback", async (req, res) => {
  const {
    Status = "",
    RegID = "",
    FAResponseID = "",
    Total = "",
    phone = "",
    Course = "",
    CustomerName = "",
    CustomerEmail = ""
  } = req.query;

  // Audit the redirect too
  try {
    await pool.query(
      `INSERT INTO callback_events (reg_id, kind, raw_payload, headers)
       VALUES ($1,$2,$3,$4)`,
      [RegID || null, "client_redirect", req.query, req.headers]
    );
  } catch (e) {
    console.error("callback_events insert (client_redirect) failed:", e);
  }

  // Pull latest attempt for this RegID
  let p = { last4: "0000", total_payments: 1, error_message: "" };
  try {
    const { rows } = await pool.query(
      `SELECT last4, total_payments, error_message, amount_minor
       FROM payment_attempts
       WHERE reg_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [RegID]
    );
    if (rows[0]) p = rows[0];
  } catch (e) {
    console.error("payment_attempts select failed:", e);
  }

  // Amount: prefer query Total (if provided), else DB value
  const amountMinor = Number.isFinite(parseInt(Total, 10))
    ? parseInt(Total, 10)
    : (Number.isFinite(parseInt(p.amount_minor, 10)) ? parseInt(p.amount_minor, 10) : 0);
  const amount = amountMinor / 100;

  const courseClean = (Course || "").replace(/^[\(]+|[\)]+$/g, "");

  const onward =
    `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(String(amountMinor))}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}` +
    `&ErrorMessage=${encodeURIComponent(p.error_message || "")}`;

  // Create Summit doc only if we have both FAResponseID and RegID
  if (FAResponseID && RegID) {
    const summitPayload = {
      Details: {
        Date: new Date().toISOString(),
        Customer: {
          ExternalIdentifier: FAResponseID,
          Name: CustomerName || "Unknown",
            EmailAddress: CustomerEmail || "unknown@puah.org.il"
        },
        Type: Status === "approved" ? 1 : 3,
        Comments: `Pelecard Status: ${Status}, Error: ${p.error_message || "N/A"}`,
        ExternalReference: RegID
      },
      Items:
        Status === "approved"
          ? [
              {
                Quantity: 1,
                UnitPrice: amount,
                TotalPrice: amount,
                Item: { Name: courseClean || "קורס" }
              }
            ]
          : [],
      Payments:
        Status === "approved"
          ? [
              {
                Amount: amount,
                Type: "CreditCard",
                Details_CreditCard: {
                  Last4Digits: p.last4 || "0000",
                  NumberOfPayments: p.total_payments || 1
                }
              }
            ]
          : [],
      VATIncluded: true,
      Credentials: {
        CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
        APIKey: process.env.SUMMIT_API_KEY
      }
    };

    try {
      const summitRes = await fetch(
        "https://app.sumit.co.il/accounting/documents/create/",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(summitPayload)
        }
      );
      const summitData = await summitRes.json();
      console.log("📄 Summit Response:", summitData);

      // Log the Summit response
      try {
        await pool.query(
          `INSERT INTO summit_documents (reg_id, fa_response_id, status, amount_minor, summit_doc_id, raw_response)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [
            RegID,
            FAResponseID,
            Status,
            amountMinor,
            summitData?.DocumentID || null,
            summitData
          ]
        );
      } catch (e) {
        console.error("summit_documents insert failed:", e);
      }
    } catch (err) {
      console.error("❌ Summit Error:", err);
    }
  }

  res.redirect(onward);
});

// ────────────────────────────────────────────────────────
const port = process.env.PORT || 8080;
app.listen(port, () => console.log("✅ Server running on port", port));
