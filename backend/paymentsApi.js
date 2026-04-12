import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

/* ------------------ HELPERS ------------------ */

const normalizeBaseUrl = (raw = "") => {
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const resolvePaymentsUrl = () => {
  const raw = process.env.BACKEND_URL;

  if (!raw) {
    console.warn("BACKEND_URL missing, skipping API call");
    return null;
  }

  const base = normalizeBaseUrl(raw);

  if (!base) {
    console.warn("⚠️ Invalid BACKEND_URL after normalization");
    return null;
  }

  return base.endsWith("/payments/generic")
    ? base
    : `${base}/payments/generic`;
};

const normalizeUrl = (u) => String(u ?? "").trim();

const amountsClose = (a, b) => {
  if (a == null || b == null) return true;
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.01;
};

const extractPaymentPreview = (item = {}) => ({
  amount: item.amount ?? null,
  screenshotUrl:
    item.screenshotUrl ??
    item.screenshot ??
    item.screenShotUrl ??
    null,
  utr: item.utr ?? item.UTR ?? item.utrNo ?? null,
  refId: item.refId ?? item.ref_id ?? null,
});

const extractList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.payments)) return payload.payments;
    if (Array.isArray(payload.results)) return payload.results;
  }
  return [];
};

const PAY_LOG = "[webhook/payments-verify]";

/* ------------------ CORE API ------------------ */

export const fetchPaymentsAmountAndScreenshot = async (jwtToken) => {
  if (!jwtToken) {
    console.log(`${PAY_LOG} skipped (no JWT)`);
    return [];
  }

  const url = resolvePaymentsUrl();

  // ✅ CRITICAL FIX: prevent axios crash
  if (!url) {
    console.log(`${PAY_LOG} ❌ skipping API call (no BACKEND_URL)`);
    return [];
  }

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    });

    const list = extractList(response.data);
    return list.map(extractPaymentPreview);
  } catch (error) {
    console.error(`${PAY_LOG} ✗ API error: ${error.message}`);
    return [];
  }
};

/* ------------------ VERIFICATION ------------------ */

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
    console.log(`${PAY_LOG} skipped (no JWT)`);
    return { skipped: true, reason: "no_jwt" };
  }

  try {
    console.log(`${PAY_LOG} fetching payments list…`);

    const list = await fetchPaymentsAmountAndScreenshot(token);

    if (!list.length) {
      console.log(`${PAY_LOG} ❌ empty payments list`);
      return { matched: false, reason: "empty_list" };
    }

    console.log(`${PAY_LOG} payments list length=${list.length}`);

    const target = normalizeUrl(screenshotUrl);

    const row = list.find(
      (p) => normalizeUrl(p.screenshotUrl) === target
    );

    if (!row) {
      console.log(`${PAY_LOG} ✗ no matching screenshot`);
      return { matched: false, reason: "payment_row_not_found" };
    }

    console.log(
      `${PAY_LOG} found payment row refId=${row.refId ?? row._id} amount=${row.amount}`
    );

    const issues = [];
    const apiAmount =
      row.amount != null ? Number(row.amount) : null;

    // Amount checks
    if (
      extractedAmount != null &&
      Number.isFinite(extractedAmount) &&
      apiAmount != null &&
      !amountsClose(extractedAmount, apiAmount)
    ) {
      issues.push("extracted_amount_vs_api_mismatch");
    }

    if (
      payloadAmount != null &&
      Number.isFinite(Number(payloadAmount)) &&
      apiAmount != null &&
      !amountsClose(payloadAmount, apiAmount)
    ) {
      issues.push("payload_amount_vs_api_mismatch");
    }

    // UTR checks
    const normUtr = (s) => {
      if (!s) return null;
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

    const result = {
      matched: issues.length === 0,
      issues,
      apiSnapshot: {
        amount: row.amount ?? null,
        utr: row.utr ?? null,
        refId: row.refId ?? null,
      },
    };

    console.log(
      `${PAY_LOG} result matched=${result.matched} issues=${
        issues.length ? issues.join(",") : "none"
      }`
    );

    return result;
  } catch (error) {
    console.error(`${PAY_LOG} ✗ verify error: ${error.message}`);
    return {
      matched: false,
      reason: "verification_error",
      error: error.message,
    };
  }
};