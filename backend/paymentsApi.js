import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const normalizeBaseUrl = (raw = "") => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const resolvePaymentsUrl = () => {
  const base = normalizeBaseUrl(process.env.Backend_URL || "");
  if (!base) {
    throw new Error("Backend_URL is missing in backend/.env");
  }
  return base.endsWith("/payments/generic") ? base : `${base}/payments/generic`;
};

const extractPaymentPreview = (item = {}) => ({
  amount: item.amount ?? null,
  screenshotUrl: item.screenshotUrl ?? item.screenshot ?? item.screenShotUrl ?? null,
  utr: item.utr ?? item.UTR ?? item.utrNo ?? null,
  refId: item.refId ?? item.ref_id ?? null,
});

const normalizeUrl = (u) => String(u ?? "").trim();

const amountsClose = (a, b) => {
  if (a == null || b == null) return true;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.01;
};

/**
 * Compares webhook + OCR data with a row from GET payments (same screenshot URL).
 * Requires PAYMENTS_VERIFY_JWT (or caller-supplied jwtToken) with access to the payments list.
 */
const PAY_LOG = "[webhook/payments-verify]";

export const verifyPaymentAgainstApi = async ({
  jwtToken,
  screenshotUrl,
  extractedUtr,
  extractedAmount,
  payloadAmount,
  payloadUtr,
}) => {
  const token = String(jwtToken ?? "").trim();
  if (!token) {
    console.log(`${PAY_LOG} skipped (PAYMENTS_VERIFY_JWT empty) screenshotUrlLen=${String(screenshotUrl).length}`);
    return { skipped: true, reason: "no_jwt" };
  }

  try {
    console.log(`${PAY_LOG} fetching payments list…`);
    const list = await fetchPaymentsAmountAndScreenshot(token);
    console.log(`${PAY_LOG} payments list length=${list.length}`);
    const target = normalizeUrl(screenshotUrl);
    const row = list.find((p) => normalizeUrl(p.screenshotUrl) === target);
    if (!row) {
      console.log(`${PAY_LOG} ✗ no row for screenshotUrl (normalized len=${target.length})`);
      return { matched: false, reason: "payment_row_not_found" };
    }
    console.log(`${PAY_LOG} found payment row refId=${row.refId ?? row._id} amount=${row.amount}`);

    const issues = [];
    const apiAmount = row.amount != null ? Number(row.amount) : null;

    if (
      extractedAmount != null &&
      Number.isFinite(extractedAmount) &&
      apiAmount != null &&
      Number.isFinite(apiAmount) &&
      !amountsClose(extractedAmount, apiAmount)
    ) {
      issues.push("extracted_amount_vs_api_mismatch");
    }

    if (
      payloadAmount != null &&
      payloadAmount !== "" &&
      Number.isFinite(Number(payloadAmount)) &&
      apiAmount != null &&
      Number.isFinite(apiAmount) &&
      !amountsClose(payloadAmount, apiAmount)
    ) {
      issues.push("payload_amount_vs_api_mismatch");
    }

    const normUtr = (s) => {
      if (s == null || s === "") return null;
      const m = String(s).replace(/\D/g, "").match(/\d{12}/);
      return m ? m[0] : null;
    };
    const apiUtr = normUtr(row.utr);
    const extUtr = normUtr(extractedUtr);
    const payUtr = normUtr(payloadUtr);
    if (extUtr && apiUtr && extUtr !== apiUtr) {
      issues.push("extracted_utr_vs_api_mismatch");
    }
    if (payUtr && extUtr && payUtr !== extUtr) {
      issues.push("payload_utr_vs_extracted_mismatch");
    }

    const out = {
      matched: issues.length === 0,
      issues,
      apiSnapshot: {
        amount: row.amount ?? null,
        utr: row.utr ?? null,
        refId: row.refId ?? null,
      },
    };
    console.log(
      `${PAY_LOG} result matched=${out.matched} issues=${issues.length ? issues.join(",") : "none"}`,
    );
    return out;
  } catch (error) {
    console.error(`${PAY_LOG} ✗ payments API error: ${error.message}`);
    return {
      matched: false,
      reason: "payments_api_error",
      error: error.message,
    };
  }
};

const extractList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.payments)) return payload.payments;
    if (Array.isArray(payload.results)) return payload.results;
  }
  return [];
};

export const fetchPaymentsAmountAndScreenshot = async (jwtToken) => {
  if (!jwtToken) {
    throw new Error("JWT token is required");
  }

  const url = resolvePaymentsUrl();
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  const list = extractList(response.data);
  return list.map(extractPaymentPreview);
};

// Optional CLI usage:
// node paymentsApi.js <JWT_TOKEN>
if (process.argv[1] && process.argv[1].endsWith("paymentsApi.js")) {
  const token = process.argv[2];
  fetchPaymentsAmountAndScreenshot(token)
    .then((data) => {
      console.log(JSON.stringify(data, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
