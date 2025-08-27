const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const { pool } = require("./db");

const app = express();

// Parse JSON and also raw text (gateway sometimes sends odd JSON)
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

// Non-blocking DB check
(async () => {
  try {
    const { rows } = await pool.query("SELECT 1 AS ok");
    console.log("DB connected at startup:", rows[0]);
  } catch (e) {
    console.error("DB check failed at startup:", e.message);
  }
})();

// Health
app.get("/db-ping", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT now() AS ts");
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 1) INIT PAYMENT (store registration; redirect to Pelecard)
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

  // Upsert registration for later use by webhook
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

// 2) PELECARD WEBHOOK (authoritative; creates Summit doc idempotently)
app.post("/pelecard-callback", async (req, res) => {
  try {
    // Normalize body -> object
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
    const txId = rd.TransactionId || null;
    const shva = rd.ShvaResult || "";
    const status = shva === "000" ? "approved" : "failed";
    const amountMinor = parseInt(rd.Total || "0", 10);
    const payments = parseInt(rd.TotalPayments || "1", 10);
    const last4 = (rd.CreditCardNumber || "").split("*").pop() || "0000";
    const errorMsg = rd.ErrorMessage || bodyObj.ErrorMessage || "";

    // Audit webhook
    await pool.query(
      `INSERT INTO callback_events (reg_id, kind, raw_payload, headers)
       VALUES ($1,$2,$3,$4)`,
      [regId || null, "pelecard_server", bodyObj, req.headers]
    );

    // Upsert payment attempt by TransactionId
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
          regId, status, amountMinor, payments, last4,
          txId, shva || null, rd.DebitApproveNumber || null,
          rd.ConfirmationKey || null, errorMsg || null, bodyObj
        ]
      );
    }

    // Create Summit doc here (idempotent by txId)
    if (txId) {
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM summit_documents WHERE pelecard_transaction_id = $1 LIMIT 1`,
        [txId]
      );
      if (!existing[0]) {
        const { rows: regRows } = await pool.query(
          `SELECT fa_response_id, customer_name, customer_email, phone, course
           FROM registrations WHERE reg_id = $1 LIMIT 1`,
          [regId]
        );
        const r = regRows[0] || {};
        const amount = (amountMinor || 0) / 100;
        const courseClean = (r?.course || "").replace(/^[\(]+|[\)]+$/g, "");
        const isApproved = status === "approved";

        const summitPayload = {
          Details: {
            Date: new Date().toISOString(),
            Customer: {
              ExternalIdentifier: r?.fa_response_id || "",
              Name: r?.customer_name || "Unknown",
              EmailAddress: r?.customer_email || "unknown@puah.org.il"
            },
            Type: isApproved ? 1 : 3,
            Comments: isApproved
              ? `Pelecard Status: approved`
              : `Pelecard Status: failed; Error: ${errorMsg || "N/A"}`,
            ExternalReference: regId
          },
          Items: isApproved
            ? [{ Quantity: 1, UnitPrice: amount, TotalPrice: amount, Item: { Name: courseClean || "קורס" } }]
            : [],
          Payments: isApproved
            ? [{ Amount: amount, Type: "CreditCard",
                 Details_CreditCard: { Last4Digits: last4, NumberOfPayments: payments } }]
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
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(summitPayload) }
          );
          const summitData = await summitRes.json();

          await pool.query(
            `INSERT INTO summit_documents
               (reg_id, fa_response_id, status, amount_minor, summit_doc_id, raw_response, pelecard_transaction_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              regId,
              r?.fa_response_id || null,
              status,
              amountMinor || 0,
              summitData?.DocumentID || null,
              summitData,
              txId
            ]
          );
        } catch (e) {
          console.error("Summit create (webhook) failed:", e);
        }
      }
    }

    // Always 200 to avoid gateway retries storm
    res.status(200).send("OK");
  } catch (err) {
    console.error("Pelecard Callback Error:", err);
    res.status(200).send("OK");
  }
});

// 3) CLIENT REDIRECT (no doc creation here)
app.get("/callback", async (req, res) => {
  const {
    Status = "",
    RegID = "",
    FAResponseID = "",
    Total = "",
    phone = "",
    Course = ""
  } = req.query;

  // Audit redirect
  try {
    await pool.query(
      `INSERT INTO callback_events (reg_id, kind, raw_payload, headers)
       VALUES ($1,$2,$3,$4)`,
      [RegID || null, "client_redirect", req.query, req.headers]
    );
  } catch (e) {
    console.error("callback_events insert (client_redirect) failed:", e);
  }

  // Best-effort error message for onward URL
  let errMsg = "";
  try {
    const { rows } = await pool.query(
      `SELECT error_message FROM payment_attempts
       WHERE reg_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [RegID]
    );
    errMsg = rows[0]?.error_message || "";
  } catch {}

  const onward =
    `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}` +
    `&ErrorMessage=${encodeURIComponent(errMsg)}`;

  res.redirect(onward);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on port", port));
