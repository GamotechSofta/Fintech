import axios from "axios";

const LOG = "[webhook/payment-decision]";

const normalizeBaseUrl = (raw = "") => {
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const authHeaders = (jwt) => ({
  Authorization: `Bearer ${jwt}`,
  "Content-Type": "application/json",
});

const REJECTION_REASON_MESSAGES = {
  sms_reader_match_required_first:
    "Could not verify this payment because no matching SMS record was confirmed yet.",
  sms_reader_doc_missing:
    "Could not verify this payment because the matched SMS record is missing.",
  utr_extracted_vs_sms_reader_mismatch:
    "The UTR in the uploaded screenshot does not match the UTR in our SMS records.",
  invalid_extracted_or_sms_amount:
    "Could not verify this payment because one of the required amounts is invalid.",
  extracted_vs_sms_amount_mismatch:
    "The amount in the uploaded screenshot does not match our SMS record.",
  payload_amount_required:
    "Could not verify this payment because the submitted payment amount is missing.",
  payload_amount_invalid:
    "Could not verify this payment because the submitted payment amount is invalid.",
  triple_amount_mismatch:
    "The payment amount did not match across request data, screenshot, and SMS record.",
  invalid_or_missing_utr:
    "Could not verify this payment because UTR is missing or invalid in the screenshot.",
  invalid_or_missing_amount:
    "Could not verify this payment because amount is missing or invalid in the screenshot.",
  no_sms_row_for_utr:
    "No matching SMS transaction was found for the provided UTR.",
  amount_mismatch:
    "The submitted amount does not match the amount in the SMS transaction.",
  empty_list:
    "Could not verify this payment because payment records are temporarily unavailable.",
  payment_row_not_found:
    "Could not verify this payment because no matching payment record was found.",
  extracted_amount_vs_api_mismatch:
    "The amount in the screenshot does not match our payment record.",
  payload_amount_vs_api_mismatch:
    "The submitted amount does not match our payment record.",
  verification_error:
    "Payment verification could not be completed due to a temporary server issue.",
  verification_exception:
    "Payment verification failed due to an internal processing issue.",
  payments_verify_exception:
    "Payment verification against records failed due to a temporary service issue.",
  payments_api_mismatch:
    "Payment details did not match our internal payment records.",
  sms_verification_failed:
    "Payment details did not match our SMS verification records.",
  verification_failed:
    "Payment details could not be verified with our records.",
};

const humanizeReasonCode = (code) =>
  String(code || "")
    .trim()
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

const getReasonCodes = (rawReason) => {
  const raw = String(rawReason || "").trim();
  if (!raw) return ["verification_failed"];
  const codes = raw
    .split(",")
    .map((x) => String(x || "").trim())
    .filter(Boolean);
  return codes.length ? codes : ["verification_failed"];
};

const buildRejectionAdminRemarks = (rawReason) => {
  const reasonCodes = getReasonCodes(rawReason);
  const rendered = reasonCodes.map((code) => {
    const message = REJECTION_REASON_MESSAGES[code] || `${humanizeReasonCode(code)}.`;
    return `${message} [code: ${code}]`;
  });
  return `Rejected: ${rendered.join(" ")}`;
};

const logJwtIncorrectIfAuthFailure = (status, context) => {
  if (status === 401 || status === 403) {
    console.error(
      `${LOG} JWT is incorrect or expired (${context}, HTTP ${status}). Set WEBHOOK_DECLARE_PASSWORD_JWT to a valid admin Bearer token.`,
    );
  }
};

/**
 * Convert webhook refId → Mongo _id (e.g. upload_69xxxx → 69xxxx).
 */
export const toPaymentApiId = (refId) => {
  const s = String(refId || "").trim();
  if (s.toLowerCase().startsWith("upload_")) {
    return s.slice("upload_".length);
  }
  return s;
};

export async function runSinglepanaPaymentDecisionAfterVerification({
  refId,
  verification,
}) {
  const token = String(process.env.WEBHOOK_DECLARE_PASSWORD_JWT ?? "").trim();
  if (!token) {
    console.warn(`${LOG} skipped (WEBHOOK_DECLARE_PASSWORD_JWT unset)`);
    return { skipped: true, reason: "no_WEBHOOK_DECLARE_PASSWORD_JWT" };
  }

  const secretDeclarePassword = String(
    process.env.WEBHOOK_APPROVE_DECLARE_PASSWORD ?? "",
  ).trim();

  if (!secretDeclarePassword) {
    console.warn(`${LOG} skipped (WEBHOOK_APPROVE_DECLARE_PASSWORD unset)`);
    return { skipped: true, reason: "missing_WEBHOOK_APPROVE_DECLARE_PASSWORD" };
  }

  const raw = process.env.BACKEND_URL;
  if (!raw) {
    console.warn(`${LOG} skipped (BACKEND_URL missing at runtime)`);
    return { skipped: true, reason: "missing_BACKEND_URL" };
  }

  const base = normalizeBaseUrl(raw);
  if (!base) {
    console.warn(`${LOG} skipped (invalid BACKEND_URL after normalization)`);
    return { skipped: true, reason: "invalid_BACKEND_URL" };
  }

  const paymentId = toPaymentApiId(refId);
  const matched = verification?.matched === true;
  const action = matched ? "approve" : "reject";
  const url = `${base}/payments/${encodeURIComponent(paymentId)}/${action}`;

  console.log(
    `${LOG} ${action} refId=${refId} paymentId=${paymentId} (POST …/payments/:id/${action})`,
  );

  const approvePayload = {
    adminRemarks: "",
    secretDeclarePassword,
  };

  const rejectReason =
    typeof verification?.reason === "string"
      ? verification.reason
      : "verification_failed";

  const payload = matched
    ? approvePayload
    : {
        adminRemarks: buildRejectionAdminRemarks(rejectReason),
        secretDeclarePassword,
      };

  const timeout = Number(process.env.WEBHOOK_APPROVE_TIMEOUT_MS || 25000);

  try {
    const res = await axios.post(url, payload, {
      headers: authHeaders(token),
      timeout,
      validateStatus: () => true,
    });

    const ok = res.status >= 200 && res.status < 300;

    if (!ok) {
      logJwtIncorrectIfAuthFailure(res.status, action);
      console.error(
        `${LOG} ${action} failed refId=${refId} paymentId=${paymentId} HTTP ${res.status}`,
        res.data,
      );
    } else {
      console.log(
        `${LOG} ${action} ok refId=${refId} paymentId=${paymentId} HTTP ${res.status}`,
      );
    }

    return {
      decision: {
        action,
        paymentId,
        ok,
        status: res.status,
        data: res.data,
      },
    };
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;

    if (status != null) logJwtIncorrectIfAuthFailure(status, action);

    console.error(
      `${LOG} ${action} request error refId=${refId} paymentId=${paymentId} ${err.message}`,
      data,
    );

    return {
      decision: {
        action,
        paymentId,
        ok: false,
        error: err.message,
        status,
        data,
      },
    };
  }
}

export async function runSinglepanaApproveAfterVerification({ refId }) {
  return runSinglepanaPaymentDecisionAfterVerification({
    refId,
    verification: { matched: true },
  });
}
