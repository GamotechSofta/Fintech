import axios from "axios";

const LOG = "[singlepana/approve]";

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
 * After webhook verification passes: declare password session, then approve payment by refId.
 * Uses PAYMENTS_VERIFY_JWT (same Singlepana API JWT) and WEBHOOK_APPROVE_DECLARE_PASSWORD.
 */
export async function runSinglepanaApproveAfterVerification({ jwt, refId }) {
  const token = String(jwt ?? "").trim();
  if (!token) {
    console.log(`${LOG} skipped (no PAYMENTS_VERIFY_JWT)`);
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

  const headers = authHeaders(token);
  const timeout = Number(process.env.WEBHOOK_APPROVE_TIMEOUT_MS || 25000);

  const declareUrl = `${base}/admin/me/secret-declare-password-status`;
  const approveUrl = `${base}/payments/${encodeURIComponent(refId)}/approve`;

  console.log(`${LOG} 1) POST secret-declare-password-status`);
  let declareRes;
  try {
    declareRes = await axios.post(declareUrl, { password }, { headers, timeout, validateStatus: () => true });
  } catch (err) {
    console.error(`${LOG} 1) declare request error`, err.message);
    return {
      declare: { ok: false, error: err.message },
      approve: { ok: false, skipped: true, reason: "declare_request_failed" },
    };
  }

  const declareOk = declareRes.status >= 200 && declareRes.status < 300;
  console.log(`${LOG} 1) declare status=${declareRes.status} ok=${declareOk}`);
  if (!declareOk) {
    return {
      declare: { ok: false, status: declareRes.status, data: declareRes.data },
      approve: { ok: false, skipped: true, reason: "declare_not_ok" },
    };
  }

  console.log(`${LOG} 2) POST payments/${refId}/approve`);
  let approveRes;
  try {
    approveRes = await axios.post(approveUrl, {}, { headers, timeout, validateStatus: () => true });
  } catch (err) {
    console.error(`${LOG} 2) approve request error`, err.message);
    return {
      declare: { ok: true, status: declareRes.status },
      approve: { ok: false, error: err.message },
    };
  }

  const approveOk = approveRes.status >= 200 && approveRes.status < 300;
  console.log(`${LOG} 2) approve status=${approveRes.status} ok=${approveOk}`);

  return {
    declare: { ok: true, status: declareRes.status, data: declareRes.data },
    approve: {
      ok: approveOk,
      status: approveRes.status,
      data: approveRes.data,
    },
  };
}
