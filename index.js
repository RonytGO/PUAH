const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const { pool } = require("./db");

const app = express();

// Accept odd Pelecard payloads
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

// --- minimal helpers (no fancy amount transforms) ---
const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const n = parseInt(s.replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

// Amount (minor units): prefer DebitTotal, else *Minor, else Total (digits-only → minor)
const getAmountMinor = (rd) => {
  const cand = [rd.DebitTotal, rd.TotalMinor, rd.AmountMinor, rd.Total];
  for (const c of cand) {
    const n = toInt(c);
    if (n !== null) return n;
  }
  return 0;
};

// Installments: common fields; fallback to first number in JParam; else 1
const getPayments = (rd) => {
  for (const f of ["TotalPayments", "NumberOfPayments", "Payments", "PaymentsNum"]) {
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

// --- NEW: unwrap Summit envelope { Data: {...}, Status, ... } ---
const unwrapSummit = (obj) => (obj && typeof obj === "object" && obj.Data ? obj.Data : obj || {});

// Non-blocking DB check
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
    total = "6500", // expect minor units; pass-through to Pelecard
    RegID = "",
    FAResponseID = "",
    CustomerName = "",
    CustomerEmail = "",
    phone = "",
    Course = ""
  } = req.query;

  const paramX = `${RegID}`;
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

// 2) PELECARD WEBHOOK (create + email Summit doc; store ReceiptURL)
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

    // Use Pelecard amount (minor) + payments as-is
    let amountMinor = getAmountMinor(rd);
    if (!amountMinor || amountMinor <= 0) {
      // fallback to FA stored total (minor)
      try {
        const { rows } = await pool.query(`SELECT total FROM registrations WHERE reg_id = $1 LIMIT 1`, [regId]);
        const faMinor = toInt(rows[0]?.total);
        if (faMinor && faMinor > 0) amountMinor = faMinor;
      } catch (e) {
        console.error("fallback amount query failed:", e.message);
      }
    }
    const payments = getPayments(rd);

    const last4 = (rd.CreditCardNumber || "").split("*").pop() || "0000";
    const errorMsg = rd.ErrorMessage || bodyObj.ErrorMessage || rd.StatusMessage || "";

    // Audit webhook
    await pool.query(
      `INSERT INTO callback_events (reg_id, kind, raw_payload, headers)
       VALUES ($1,$2,$3,$4)`,
      [regId || null, "pelecard_server", bodyObj, req.headers]
    );

    // Upsert payment attempt
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

    // Create + email (approved only)
    if (txId && status === "approved") {
      // Idempotency
      const { rows: existing } = await pool.query(
        `SELECT summit_doc_id FROM summit_documents WHERE pelecard_transaction_id = $1 LIMIT 1`,
        [txId]
      );
      let summitDocId = existing[0]?.summit_doc_id || null;

      if (!summitDocId) {
        // Registration details (email, name, course, FA external id)
        let r = {};
        if (regId) {
          const { rows: regRows } = await pool.query(
            `SELECT fa_response_id, customer_name, customer_email, phone, course, total
             FROM registrations WHERE reg_id = $1 LIMIT 1`,
            [regId]
          );
          r = regRows[0] || {};
        }

        // Major units for Summit once
        const amount = (amountMinor || toInt(r.total) || 0) / 100;
        const courseClean = (r?.course || "").replace(/^[\(]+|[\)]+$/g, "");
        const emailTo = (r?.customer_email || rd.CardHolderEmail || "").trim();

        // ---- SUMMIT CREATE with SendByEmail ----
        const summitPayload = {
          Details: {
            Date: new Date().toISOString(),
            Customer: {
              ExternalIdentifier: r?.fa_response_id || "",
              Name: r?.customer_name || "Unknown",
              EmailAddress: emailTo || "unknown@puah.org.il"
            },
            SendByEmail: emailTo
              ? { EmailAddress: emailTo, Original: true, SendAsPaymentRequest: false }
              : undefined,
            Type: 1, // approved
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
            // Summit accepts numeric codes; 5 = Credit Card (matches your working example)
            Type: 5,
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

        // --- CREATE & UNWRAP { Data: {...} } ---
        const summitRes = await fetch(
          "https://app.sumit.co.il/accounting/documents/create/",
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(summitPayload) }
        );

        // keep full envelope for auditing, but use unwrapped Data to read fields
        const summitEnvelopeRaw = await summitRes.text();
        let summitEnvelope;
        try {
          summitEnvelope = JSON.parse(summitEnvelopeRaw);
        } catch {
          summitEnvelope = { raw: summitEnvelopeRaw };
        }
        const sd = unwrapSummit(summitEnvelope); // <<<<<< THE ONLY LOGIC CHANGE

        summitDocId = sd?.DocumentID || null;
        const receiptUrl = sd?.DocumentDownloadURL || null;

        // Persist (store full envelope; save receipt_url)
        await pool.query(
          `INSERT INTO summit_documents
             (reg_id, fa_response_id, status, amount_minor, summit_doc_id, raw_response, pelecard_transaction_id, receipt_url)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
           ON CONFLICT (pelecard_transaction_id) DO UPDATE
           SET summit_doc_id = COALESCE(summit_documents.summit_doc_id, EXCLUDED.summit_doc_id),
               receipt_url   = COALESCE(summit_documents.receipt_url, EXCLUDED.receipt_url),
               raw_response  = EXCLUDED.raw_response`,
          [
            regId,
            r?.fa_response_id || null,
            "approved",
            amountMinor || 0,
            summitDocId,
            summitEnvelope,   // full envelope for debugging
            txId,
            receiptUrl
          ]
        );

        console.log("Summit create response (unwrapped):", {
          DocumentID: summitDocId,
          DocumentDownloadURL: receiptUrl
        });
      }
    }

    res.status(200).send("OK");
  } catch (err) {
    console.error("Pelecard Callback Error:", err);
    // still 200 so Pelecard doesn't spam retries
    res.status(200).send("OK");
  }
});

// 3) CLIENT REDIRECT (no doc creation here) — includes ReceiptURL param if present
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

  // get latest receipt_url if exists
  let receiptUrl = "";
  try {
    const { rows } = await pool.query(
      `SELECT receipt_url
       FROM summit_documents
       WHERE reg_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [RegID]
    );
    receiptUrl = rows[0]?.receipt_url || "";
  } catch (e) {
    console.error("fetch receipt_url failed:", e.message);
  }

  const onward =
    `https://puah.tfaforms.net/17` +
    `?RegID=${encodeURIComponent(RegID)}` +
    `&FAResponseID=${encodeURIComponent(FAResponseID)}` +
    `&Total=${encodeURIComponent(Total)}` +
    `&Status=${encodeURIComponent(Status)}` +
    `&phone=${encodeURIComponent(phone)}` +
    `&Course=${encodeURIComponent(Course)}` +
    `&ReceiptURL=${encodeURIComponent(receiptUrl)}`;

  res.redirect(onward);
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log("Server running on port", port));
