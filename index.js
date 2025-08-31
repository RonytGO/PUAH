const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const { pool } = require("./db");

const app = express();

// Accept odd Pelecard payloads
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

// --- small helpers (simple & deterministic) ---
const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

// Amount: prefer DebitTotal (minor units), else TotalMinor/AmountMinor, else Total (assume minor if digits-only)
const getAmountMinor = (rd) => {
  const candidates = [
    rd.DebitTotal,
    rd.TotalMinor,
    rd.AmountMinor,
    rd.Total
  ];
  for (const c of candidates) {
    const n = toInt(c);
    if (n !== null) return n;
  }
  return 0;
};

// Payments: look at common fields; fallback to first number in JParam; else 1
const getPayments = (rd) => {
  const fields = ["TotalPayments", "NumberOfPayments", "Payments", "PaymentsNum"];
  for (const f of fields) {
    const n = toInt(rd[f]);
    if (n && n > 0) return n;
  }
  if (rd.JParam) {
    const m = String(rd.JParam).match(/(\d{1,2})/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0) return n;
    }
  }
  return 1;
};

// Non-blocking DB ping on boot
(async () => {
  try {
    const { rows } = await pool.query("SELECT 1 AS ok");
    console.log("DB connected at startup:", rows[0]);
  } catch (e) {
    console.error("DB check failed at startup:", e.message);
  }
})();

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
    total = "6500", // send what FA gives (prefer minor units)
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

  // Keep FA data for later
  try {
    await pool.query(
      `INSERT INTO registrations (reg_id, fa_response_id, customer_name, customer_email, phone, course, total)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (reg_id) DO UPDATE
       SET fa_response_id = EXCLUDED.fa_response_id,
           customer_name  = EXCLUDED.customer_name,
           customer_email = EXCLUDED.customer_email,
           phone          = EXCLUDED.phone,
           course         = EXCLUDED.course,
           total          = EXCLUDED.total,
           updated_at     = now()`,
      [RegID, FAResponseID, CustomerName, CustomerEmail, phone, Course, total]
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

// 2) PELECARD WEBHOOK (authoritative; creates doc + emails it)
app.post("/pelecard-callback", async (req, res) => {
  try {
    // Normalize body
    let bodyObj;
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) {
      bodyObj = req.body;
    } else {
      const raw = String(req.body || "")
        .replace(/'/g, '"')
        .replace(/ResultData\s*:\s*\[([^[\]]+?)\]/g, 'ResultData:{$1}');
      bodyObj = JSON.parse(raw);
    }
    const rd = bodyObj.ResultData || bodyObj.Result || bodyObj;

    const regId = (rd.AdditionalDetailsParamX || rd.ParamX || "").split("|")[1] || "";
    const txId = rd.TransactionId || null;
    const shva = rd.ShvaResult || rd.StatusCode || "";
    const status = (shva === "000" || shva === "0") ? "approved" : "failed";

    // Amount from Pelecard (minor units) and payments
    let amountMinor = getAmountMinor(rd);
    const payments = getPayments(rd);

    const last4 = (rd.CreditCardNumber || "").split("*").pop() || "0000";
    const errorMsg = rd.ErrorMessage || bodyObj.ErrorMessage || rd.StatusMessage || "";

    // If amount still missing, fallback to FA's stored total
    if (!amountMinor || amountMinor <= 0) {
      try {
        const { rows } = await pool.query(
          `SELECT total FROM registrations WHERE reg_id = $1 LIMIT 1`,
          [regId]
        );
        const faMinor = toInt(rows[0]?.total);
        if (faMinor && faMinor > 0) amountMinor = faMinor;
      } catch (e) {
        console.error("fallback amount query failed:", e.message);
      }
    }

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
          regId, status, amountMinor || 0, payments, last4,
          txId, shva || null, rd.DebitApproveNumber || rd.ApproveNumber || null,
          rd.ConfirmationKey || null, errorMsg || null, bodyObj
        ]
      );
    }

    // Create + SEND Summit doc (only for approved)
    if (txId && status === "approved") {
      // idempotency: skip if we already created for this tx
      const { rows: existing } = await pool.query(
        `SELECT summit_doc_id FROM summit_documents WHERE pelecard_transaction_id = $1 LIMIT 1`,
        [txId]
      );

      let summitDocId = existing[0]?.summit_doc_id || null;

      if (!summitDocId) {
        // Pull registration
        let r = {};
        if (regId) {
          const { rows: regRows } = await pool.query(
            `SELECT fa_response_id, customer_name, customer_email, phone, course, total
             FROM registrations WHERE reg_id = $1 LIMIT 1`,
            [regId]
          );
          r = regRows[0] || {};
        }

        // Convert minor -> major exactly once for Summit
        const amount = (amountMinor || toInt(r.total) || 0) / 100;
        const courseClean = (r?.course || "").replace(/^[\(]+|[\)]+$/g, "");

        const summitPayload = {
          Details: {
            Date: new Date().toISOString(),
            Customer: {
              ExternalIdentifier: r?.fa_response_id || "",
              Name: r?.customer_name || "Unknown",
              EmailAddress: r?.customer_email || "unknown@puah.org.il"
            },
            Type: 1,
            Comments: `Pelecard Status: approved | Transaction: ${txId}`,
            ExternalReference: regId || txId
          },
          Items: [{
            Quantity: 1,
            UnitPrice: amount,
            TotalPrice: amount,
            Item: { Name: courseClean || "קורס" }
          }],
          Payments: [{
            Amount: amount,
            Type: "CreditCard",
            Details_CreditCard: {
              Last4Digits: last4,
              NumberOfPayments: payments
            }
          }],
          VATIncluded: true,
          Credentials: {
            CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
            APIKey: process.env.SUMMIT_API_KEY
          }
        };

        // CREATE
        const summitRes = await fetch(
          "https://app.sumit.co.il/accounting/documents/create/",
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(summitPayload) }
        );
        let summitData;
        try {
          summitData = await summitRes.json();
        } catch {
          summitData = { raw: await summitRes.text() };
        }

        summitDocId = summitData?.DocumentID || null;

        // Persist
        await pool.query(
          `INSERT INTO summit_documents
             (reg_id, fa_response_id, status, amount_minor, summit_doc_id, raw_response, pelecard_transaction_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (pelecard_transaction_id) DO UPDATE
           SET summit_doc_id = COALESCE(summit_documents.summit_doc_id, EXCLUDED.summit_doc_id),
               raw_response  = EXCLUDED.raw_response`,
          [
            regId,
            r?.fa_response_id || null,
            "approved",
            amountMinor || 0,
            summitDocId,
            summitData,
            txId
          ]
        );
      }

      // SEND (email) — only if we have a doc id
      if (summitDocId) {
        const emailTo = (await (async () => {
          if (!regId) return null;
          try {
            const { rows } = await pool.query(
              `SELECT customer_email FROM registrations WHERE reg_id = $1 LIMIT 1`,
              [regId]
            );
            return (rows[0]?.customer_email || "").trim() || null;
          } catch {
            return null;
          }
        })()) || (rd.CardHolderEmail || "").trim() || undefined;

        const sendPayload = {
          DocumentID: summitDocId,
          // If you omit EmailAddress, SUMIT uses customer's email on file.
          EmailAddress: emailTo,
          Credentials: {
            CompanyID: parseInt(process.env.SUMMIT_COMPANY_ID, 10),
            APIKey: process.env.SUMMIT_API_KEY
          }
        };

        const sendRes = await fetch("https://app.sumit.co.il/accounting/documents/send/", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(sendPayload)
        });
        let sendData;
        try {
          sendData = await sendRes.json();
        } catch {
          sendData = { raw: await sendRes.text() };
        }
        console.log("📧 SUMIT send response:", sendData);
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Pelecard Callback Error:", err);
    res.status(200).send("OK");
  }
});

// 3) CLIENT REDIRECT (no doc creation here)
app.get("/callback", async (req, res) => {
  const { Status = "", RegID = "", FAResponseID = "", Total = "", phone = "", Course = "" } = req.query;

  try {
    await pool.query(
      `INSERT INTO callback_events (reg_id, kind, raw_payload, headers)
       VALUES ($1,$2,$3,$4)`,
      [RegID || null, "client_redirect", req.query, req.headers]
    );
  } catch (e) {
    console.error("callback_events insert (client_redirect) failed:", e);
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
app.listen(port, () => console.log("Server running on port", port));
