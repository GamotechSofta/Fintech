import axios from "axios";
import { processOneAndAutoSave } from "../extraction.js";
import { verifyPaymentAgainstApi } from "../paymentsApi.js";
import {
  matchSmsReaderToWebhookExtraction,
  verifySmsReaderWebhookConsistency,
} from "../utils/smsReaderWebhookMatch.js";
import { runSinglepanaApproveAfterVerification } from "./singlepanaApprovePayment.js";
import { getActiveLoginJwt } from "../utils/activeLoginJwtCache.js";

const FORWARD_URL = process.env.WEBHOOK_FORWARD_URL;

const LOG = "[webhook/process]";

/**
 * Runs Vision OCR, SMS UTR/amount match, optional payments API verify, optional forward — all in-process (no queue).
 */
export async function processWebhookScreenshotPayload(payload) {
  const refId = payload.refId;
  const screenshotUrl = String(payload.screenshotUrl || "").trim();
  if (!refId || !screenshotUrl) {
    console.error(`${LOG} ✗ missing refId or screenshotUrl`);
    throw new Error("refId and screenshotUrl are required");
  }

  const cachedLoginJwt = String(getActiveLoginJwt() || "").trim();
  const requestJwt = String(payload.jwtToken || "").trim();
  const envJwt = String(process.env.PAYMENTS_VERIFY_JWT || "").trim();
  const verifyJwt = cachedLoginJwt || requestJwt || envJwt;
  const jwtSource = cachedLoginJwt
    ? "login_screen_registered"
    : requestJwt
      ? "webhook_request"
      : envJwt
        ? "env_PAYMENTS_VERIFY_JWT"
        : "none";
  console.log(`${LOG} JWT source=${jwtSource} (payments verify + approve)`);

  console.log(`${LOG} A) OCR start refId=${refId} imageUrlLen=${screenshotUrl.length}`);
  const extraction = await processOneAndAutoSave({
    paymentId: refId,
    imageUrl: screenshotUrl,
  });
  console.log(`${LOG} A) OCR done refId=${refId}`, {
    status: extraction.status,
    utr: extraction.utr ?? null,
    amount: extraction.amount ?? null,
  });

  console.log(`${LOG} B) SMS reader match start refId=${refId}`);
  const smsMatch = await matchSmsReaderToWebhookExtraction(extraction, refId);
  console.log(`${LOG} B) SMS reader match done refId=${refId}`, smsMatch);

  console.log(
    `${LOG} C) UTR + triple amount verify (payload vs extracted vs SmsReader) refId=${refId}`,
  );
  const verification = await verifySmsReaderWebhookConsistency(
    extraction,
    payload,
    refId,
    smsMatch,
  );
  console.log(`${LOG} C) triple verify done refId=${refId}`, verification);

  let approveFlow = null;
  if (verification?.matched === true) {
    console.log(`${LOG} E) Singlepana approve (declare password + approve payment) refId=${refId}`);
    approveFlow = await runSinglepanaApproveAfterVerification({
      jwt: verifyJwt,
      refId,
    });
    console.log(`${LOG} E) approve flow result refId=${refId}`, approveFlow);
  } else {
    console.log(
      `${LOG} E) approve flow skipped (verification.matched !== true) refId=${refId}`,
    );
  }

  let paymentsApiVerification = null;
  if (verifyJwt) {
    console.log(
      `${LOG} C2) optional payments list API verify refId=${refId} jwtConfigured=true`,
    );
    paymentsApiVerification = await verifyPaymentAgainstApi({
      jwtToken: verifyJwt,
      screenshotUrl,
      extractedUtr: extraction.utr,
      extractedAmount: extraction.amount,
      payloadAmount: payload.amount,
      payloadUtr: payload.utr,
    });
    console.log(`${LOG} C2) payments API verify done refId=${refId}`, paymentsApiVerification);
  } else {
    console.log(
      `${LOG} C2) payments API verify skipped (no JWT: log in on app, or x-app-jwt / body jwtToken, or PAYMENTS_VERIFY_JWT) refId=${refId}`,
    );
  }

  if (FORWARD_URL) {
    console.log(`${LOG} D) forward POST → ${FORWARD_URL} refId=${refId}`);
    try {
      await axios.post(FORWARD_URL, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: Number(process.env.WEBHOOK_FORWARD_TIMEOUT_MS || 15000),
      });
      console.log(`${LOG} D) forward OK refId=${refId}`);
    } catch (forwardErr) {
      console.error(
        `${LOG} D) forward FAILED refId=${refId} message=${forwardErr.message}`,
        forwardErr.response?.status,
      );
      throw forwardErr;
    }
  } else {
    console.log(`${LOG} D) forward skipped (WEBHOOK_FORWARD_URL unset) refId=${refId}`);
  }

  console.log(`${LOG} ✓ pipeline complete refId=${refId}`);
  return { extraction, verification, smsMatch, paymentsApiVerification, approveFlow };
}
