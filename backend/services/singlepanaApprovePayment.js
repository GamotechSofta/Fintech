import axios from "axios";

const LOG = "[singlepana/payment-status]";

const normalizeBaseUrl = (raw = "") => {
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const authHeaders = (jwt) => ({
  Authorization: `Bearer ${jwt}`,
  "Content-Type": "application/json",
});

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
 * After webhook processing: declare password, then
 * - POST …/payments/:id/approve if verification matched (UTR + amounts)
 * - POST …/payments/:id/reject if not matched
 */
export async function runSinglepanaPaymentDecisionAfterVerification({
  jwt,
  refId,
  verification,
}) {
  const token = String(jwt ?? "").trim();
  if (!token) {
    console.log(`${LOG} skipped (no JWT)`);
    return { skipped: true, reason: "no_jwt" };
  }

  const base = normalizeBaseUrl(process.env.Backend_URL || "");
  if (!base) {
    console.log(`${LOG} skipped (Backend_URL unset)`);
    return { skipped: true, reason: "missing_Backend_URL" };
  }

  const password = String(process.env.WEBHOOK_APPROVE_DECLARE_PASSWORD ?? "").trim();
  if (!password) {
    console.log(`${LOG} skipped (WEBHOOK_APPROVE_DECLARE_PASSWORD unset)`);
    return { skipped: true, reason: "missing_declare_password_env" };
  }

  const paymentId = toPaymentApiId(refId);
  const matched = verification?.matched === true;

  const headers = authHeaders(token);
  const timeout = Number(process.env.WEBHOOK_APPROVE_TIMEOUT_MS || 25000);

  const declareUrl = `${base}/admin/me/secret-declare-password-status`;

  console.log(`${LOG} 1) POST secret-declare-password-status`);
  let declareRes;
  try {
    declareRes = await axios.post(
      declareUrl,
      { password },
      { headers, timeout, validateStatus: () => true },
    );
  } catch (err) {
    console.error(`${LOG} 1) declare request error`, err.message);
    return {
      declare: { ok: false, error: err.message },
      decision: { ok: false, skipped: true, reason: "declare_request_failed" },
    };
  }

  const declareOk = declareRes.status >= 200 && declareRes.status < 300;
  console.log(`${LOG} 1) declare status=${declareRes.status} ok=${declareOk}`);
  if (!declareOk) {
    return {
      declare: { ok: false, status: declareRes.status, data: declareRes.data },
      decision: { ok: false, skipped: true, reason: "declare_not_ok" },
    };
  }

  const action = matched ? "approve" : "reject";
  const actionUrl = `${base}/payments/${encodeURIComponent(paymentId)}/${action}`;

  const rejectReason =
    typeof verification?.reason === "string"
      ? verification.reason
      : "UTR_or_amount_verification_failed";
  const actionBody = matched
    ? {}
    : {
        adminRemarks: `Rejected: ${rejectReason}`,
        reason: rejectReason,
      };

  console.log(
    `${LOG} 2) POST payments/${paymentId}/${action} (refId=${refId} matched=${matched})`,
  );
  let actionRes;
  try {
    actionRes = await axios.post(actionUrl, actionBody, {
      headers,
      timeout,
      validateStatus: () => true,
    });
  } catch (err) {
    console.error(`${LOG} 2) ${action} request error`, err.message);
    return {
      declare: { ok: true, status: declareRes.status },
      decision: { action, ok: false, error: err.message },
    };
  }

  const actionOk = actionRes.status >= 200 && actionRes.status < 300;
  console.log(`${LOG} 2) ${action} status=${actionRes.status} ok=${actionOk}`);

  return {
    declare: { ok: true, status: declareRes.status, data: declareRes.data },
    decision: {
      action,
      paymentId,
      ok: actionOk,
      status: actionRes.status,
      data: actionRes.data,
    },
  };
}

/** @deprecated use runSinglepanaPaymentDecisionAfterVerification */
export async function runSinglepanaApproveAfterVerification({ jwt, refId }) {
  return runSinglepanaPaymentDecisionAfterVerification({
    jwt,
    refId,
    verification: { matched: true },
  });
}
