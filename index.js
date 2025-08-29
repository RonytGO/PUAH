const express = require("express");
const fetch = require("node-fetch");
const bodyParser = require("body-parser");
const { pool } = require("./db");

const app = express();

// Parse JSON and also raw text (gateway sometimes sends odd JSON)
app.use(bodyParser.text({ type: "*/*" }));
app.use(bodyParser.json());

// ---------- Helpers ----------
const toInt = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s) return null;
  const cleaned = s.replace(/[^\d-]/g, ""); // keep digits and minus
  if (!cleaned) return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
};

/** Return amount in MINOR units (agorot). Accepts 6500, "6500", 65.00, "65.00", "65,00" */
const parseMinorAmount = (val) => {
  if (val === null || val === undefined) return null;
  if (typeof val === "number") {
    return Number.isInteger(val) ? val : Math.round(val * 100);
  }
  const s = String(val).trim();
  if (!s) return null;
  const sDot = s.replace(",", "."); // handle "65,00"
  if (/^\d+(\.\d+)?$/.test(sDot)) {
    // numeric string, maybe decimal (major units)
    const f = parseFloat(sDot);
    return Number.isFinite(f) ? Math.round(f * 100) : null;
  }
  // fallback: strip non-digits (assume already minor)
  const digits = s.replace(/[^\d]/g, "");
  if (!digits) return null;
  const n = parseInt(digits, 10);
  return Number.isFinite(n) ? n : null;
};

/** Extract minor amount from a Pelecard-like result object */
const extractMinorAmount = (rd) => {
  const fields = [
    "TotalMinor",
    "AmountMinor",
    "TotalAmountMinor",
    "Total",
    "TotalAmount",
    "Amount",
    "TransactionAmount"
  ];
  for (const f of fields) {
    const n = parseMinorAmount(rd[f]);
    if (n !== null) return n;
  }
  return null;
};

/** Parse number of payments; checks several fields incl. JParam */
const parsePayments = (rd) => {
  const direct = ["TotalPayments", "NumberOfPayments", "Payments", "PaymentsNum"];
  for (const f of direct) {
    const n = toInt(rd[f]);
    if (n && n > 0) return n;
  }
  // Heuristic: JParam may contain "3" or "מספר תשלומים: 3"
  if (rd.JParam) {
    const m = String(rd.JParam).match(/(\d{1,2})/);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > 0) return n;
    }
  }
  return 1;
};

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
    total = "6500", // prefer minor units from FA if you can
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

  // Upsert registration (store FA total as-is for fallback)
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
      try {
        bodyObj = JSON.parse(raw);
      } catch (e) {
        console.error("Failed to parse raw body:", raw);
        throw e;
      }
    }

    // Handle different Pelecard wrappers
    const rd = bodyObj.ResultData || bodyObj.Result || bodyObj;

    const regId = (rd.AdditionalDetailsParamX || rd.ParamX || "").split("|")[1] || "";
    const txId = rd.TransactionId || null;
    const shva = rd.ShvaResult || rd.StatusCode || "";
    const status = (shva === "000" || shva === "0") ? "approved" : "failed";

    // Amount (minor units) with fallbacks
    let amountMinor = extractMinorAmount(rd);
    // Payments count with fallbacks
    let payments = parsePayments(rd);

    const last4 = (rd.CreditCardNumber || "").split("*").pop() || "0000";
    const errorMsg = rd.ErrorMessage || bodyObj.ErrorMessage || rd.StatusMessage || "";

    // If amount missing/zero, fallback to FA 'registrations.total'
    if (!amountMinor || amountMinor <= 0) {
      try {
        const { rows } = await pool.query(
          `SELECT total FROM registrations WHERE reg_id = $1 LIMIT 1`,
          [regId]
        );
        const faTotal = rows[0]?.total;
        const faMinor = parseMinorAmount(faTotal);
        if (faMinor && faMinor > 0) amountMinor = faMinor;
      } catch (e) {
        console.error("fallback amount query failed:", e.message);
      }
    }

    console.log("[pelecard] parsed", {
      regId, txId, shva, status,
      rawTotals: { Total: rd.Total, TotalAmount: rd.TotalAmount, Amount: rd.Amount, TransactionAmount: rd.TransactionAmount },
      amountMinor,
      paymentsRaw: { TotalPayments: rd.TotalPayments, NumberOfPayments: rd.NumberOfPayments, Payments: rd.Payments, JParam: rd.JParam },
      payments
    });

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

    // Create Summit doc here (idempotent by txId; approved only)
    if (txId && status === "approved") {
      const { rows: existing } = await pool.query(
        `SELECT 1 FROM summit_documents WHERE pelecard_transaction_id = $1 LIMIT 1`,
        [txId]
      );

      if (!existing[0]) {
        // pull registration data
        let r = {};
        if (regId) {
          const { rows: regRows } = await pool.query(
            `SELECT fa_response_id, customer_name, customer_email, phone, course, total
             FROM registrations WHERE reg_id = $1 LIMIT 1`,
            [regId]
          );
          r = regRows[0] || {};
        }

        // final amount (major units)
        const amount = (amountMinor || parseMinorAmount(r.total) || 0) / 100;
        const courseClean = (r?.course || "").replace(/^[\(]+|[\)]+$/g, "");

        const summitPayload = {
          Details: {
            Date: new Date().toISOString(),
            Customer: {
              ExternalIdentifier: r?.fa_response_id || "",
              Name: r?.customer_name || "Unknown",
              EmailAddress: r?.customer_email || "unknown@puah.org.il"
            },
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

        try {
          const summitRes = await fetch(
            "https://app.sumit.co.il/accounting/documents/create/",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(summitPayload)
            }
          );
          let summitData;
          try {
            summitData = await summitRes.json();
          } catch (e) {
            console.error("Failed to parse Summit response:", await summitRes.text());
            summitData = { error: "Failed to parse response" };
          }

          await pool.query(
            `INSERT INTO summit_documents
               (reg_id, fa_response_id, status, amount_minor, summit_doc_id, raw_response, pelecard_transaction_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              regId,
              r?.fa_response_id || null,
              "approved",
              Math.round(amount * 100),
              summitData?.DocumentID || null,
              summitData,
              txId
            ]
          );

          console.log("Summit document created:", summitData?.DocumentID);
        } catch (e) {
          console.error("Summit create (webhook) failed:", e.message);
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
