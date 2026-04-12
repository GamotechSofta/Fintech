import axios from "axios";
import { getActiveLoginJwt } from "../utils/activeLoginJwtCache.js";

const LOG = "[singlepana/payment-status]";

const normalizeBaseUrl = (raw = "") => {
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : "";
};

const authHeaders = (jwt) => ({
  Authorization: `Bearer ${jwt}`,
  "Content-Type": "application/json",
});

const logJwtIncorrectIfAuthFailure = (status, context) => {
  if (status === 401 || status === 403) {
    console.error(
      `${LOG} JWT is incorrect or expired (${context}, HTTP ${status}). Re-register login JWT via /session/register-login-jwt or fix PAYMENTS_VERIFY_JWT.`,
    );
  }
};

/**
 * Singlepana expects Mongo payment _id in the path. Webhook refId is often `upload_<_id>`.
 */
export const toPaymentApiId = (refId) => {
  const s = String(refId || "").trim();
  if (s.toLowerCase().startsWith("upload_")) {
    return s.slice("upload_".length);
  }
  return s;
};

/**
 * POST /api/v1/payments/:id/approve | reject — matches admin UI.
 * JWT: active login cache first, then jwtFallback (webhook / PAYMENTS_VERIFY_JWT from caller).
 * Does not call declare-password routes.
 */
export async function runSinglepanaPaymentDecisionAfterVerification({
  jwt: jwtFallback,
  refId,
  verification,
}) {
  const token =
    String(getActiveLoginJwt() || "").trim() ||
    String(jwtFallback ?? "").trim();

  if (!token) {
    console.log(`${LOG} skipped (no JWT — register login JWT or pass x-app-jwt / PAYMENTS_VERIFY_JWT)`);
    return { skipped: true, reason: "no_jwt" };
  }

  const secretDeclarePassword = String(
    process.env.WEBHOOK_APPROVE_DECLARE_PASSWORD ?? "",
  ).trim();
  if (!secretDeclarePassword) {
    console.log(`${LOG} skipped (WEBHOOK_APPROVE_DECLARE_PASSWORD unset)`);
    return { skipped: true, reason: "missing_WEBHOOK_APPROVE_DECLARE_PASSWORD" };
  }

  const base = normalizeBaseUrl(process.env.Backend_URL || "");
  if (!base) {
    console.log(`${LOG} skipped (Backend_URL unset)`);
    return { skipped: true, reason: "missing_Backend_URL" };
  }

  const paymentId = toPaymentApiId(refId);
  const matched = verification?.matched === true;
  const action = matched ? "approve" : "reject";
  const url = `${base}/payments/${encodeURIComponent(paymentId)}/${action}`;

  const approvePayload = {
    adminRemarks: "",
    secretDeclarePassword,
  };

  const rejectReason =
    typeof verification?.reason === "string"
      ? verification.reason
      : "UTR_or_amount_verification_failed";
  const payload = matched
    ? approvePayload
    : {
        adminRemarks: `Rejected: ${rejectReason}`,
        secretDeclarePassword,
      };

  const timeout = Number(process.env.WEBHOOK_APPROVE_TIMEOUT_MS || 25000);

  console.log(
    `${LOG} POST payments/${paymentId}/${action} (refId=${refId} jwtSource=activeLoginJwtCache_first)`,
  );

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
        `${LOG} ${action} HTTP ${res.status} — response.data:`,
        res.data,
      );
    } else {
      console.log(`${LOG} ${action} HTTP ${res.status} ok`);
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
    console.error(`${LOG} ${action} request failed: ${err.message}`, data);
    return {
      decision: {
        action,
        paymentId,
        ok: false,
        error: err.message,
        status: err.response?.status,
        data,
      },
    };
  }
}

export async function runSinglepanaApproveAfterVerification({ jwt, refId }) {
  return runSinglepanaPaymentDecisionAfterVerification({
    jwt,
    refId,
    verification: { matched: true },
  });
}
