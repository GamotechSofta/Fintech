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
        adminRemarks: `Rejected: ${rejectReason}`,
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
