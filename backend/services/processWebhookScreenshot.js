import axios from "axios";
import { processOneAndAutoSave } from "../extraction.js";
import { verifyPaymentAgainstApi } from "../paymentsApi.js";
import {
  matchSmsReaderToWebhookExtraction,
  verifySmsReaderWebhookConsistency,
} from "../utils/smsReaderWebhookMatch.js";
import { runSinglepanaPaymentDecisionAfterVerification } from "./singlepanaApprovePayment.js";

const FORWARD_URL = process.env.WEBHOOK_FORWARD_URL;

const LOG = "[webhook/process]";

/**
 * Webhook pipeline (no throws): OCR → SMS match + triple verify → payments list verify → approve | reject.
 * Approve/reject uses WEBHOOK_DECLARE_PASSWORD_JWT + WEBHOOK_APPROVE_DECLARE_PASSWORD only.
 */
export async function processWebhookScreenshotPayload(payload) {
  const refId = payload.refId;
  const screenshotUrl = String(payload.screenshotUrl || "").trim();
  if (!refId || !screenshotUrl) {
    console.error(`${LOG} ✗ missing refId or screenshotUrl`);
    return {
      error: "missing_refId_or_screenshotUrl",
      extraction: null,
      verification: null,
      smsMatch: null,
      paymentsApiVerification: null,
      paymentDecision: null,
      approveFlow: null,
    };
  }

  const requestJwt = String(payload.jwtToken || "").trim();
  const paymentsListJwt =
    String(process.env.WEBHOOK_DECLARE_PASSWORD_JWT || "").trim() ||
    String(process.env.PAYMENTS_VERIFY_JWT || "").trim() ||
    requestJwt;

  console.log(
    `${LOG} payments list JWT: ${paymentsListJwt ? "configured" : "absent"}`,
  );

  console.log(`${LOG} A) OCR start refId=${refId} imageUrlLen=${screenshotUrl.length}`);
  let extraction;
  try {
    extraction = await processOneAndAutoSave({
      paymentId: refId,
      imageUrl: screenshotUrl,
      fallbackAmount: payload.amount,
    });
  } catch (ocrErr) {
    console.error(`${LOG} A) OCR failed refId=${refId}`, ocrErr.message);
    extraction = {
      paymentId: refId,
      imageUrl: screenshotUrl,
      utr: null,
      amount: null,
      status: "FAILED",
    };
  }
  console.log(`${LOG} A) OCR done refId=${refId}`, {
    status: extraction.status,
    utr: extraction.utr ?? null,
    amount: extraction.amount ?? null,
  });

  let smsMatch;
  try {
    console.log(`${LOG} B) SMS reader match start refId=${refId}`);
    smsMatch = await matchSmsReaderToWebhookExtraction(extraction, refId, payload);
    console.log(`${LOG} B) SMS reader match done refId=${refId}`, smsMatch);
  } catch (e) {
    console.error(`${LOG} B) SMS match error refId=${refId}`, e.message);
    smsMatch = { matched: false, error: e.message };
  }

  let verification;
  try {
    console.log(
      `${LOG} C) UTR + triple amount verify refId=${refId}`,
    );
    verification = await verifySmsReaderWebhookConsistency(
      extraction,
      payload,
      refId,
      smsMatch,
    );
    console.log(`${LOG} C) triple verify done refId=${refId}`, verification);
  } catch (e) {
    console.error(`${LOG} C) verify error refId=${refId}`, e.message);
    verification = {
      matched: false,
      reason: "verification_exception",
      error: e.message,
    };
  }

  let paymentsApiVerification = null;
  if (!paymentsListJwt) {
    console.warn(
      `${LOG} C2) payments API verify skipped (set WEBHOOK_DECLARE_PASSWORD_JWT or PAYMENTS_VERIFY_JWT or pass jwtToken) refId=${refId}`,
    );
    paymentsApiVerification = { skipped: true, reason: "no_jwt" };
  } else {
    try {
      console.log(`${LOG} C2) payments list API verify refId=${refId}`);
      paymentsApiVerification = await verifyPaymentAgainstApi({
        jwtToken: paymentsListJwt,
        screenshotUrl,
        extractedAmount: extraction.amount,
        payloadAmount: payload.amount,
      });
      console.log(
        `${LOG} C2) payments API verify done refId=${refId}`,
        paymentsApiVerification,
      );
    } catch (e) {
      console.error(`${LOG} C2) payments API verify error refId=${refId}`, e.message);
      paymentsApiVerification = {
        matched: false,
        reason: "payments_verify_exception",
        error: e.message,
      };
    }
  }

  const smsOk = verification?.matched === true;
  const paymentsRan =
    paymentsApiVerification &&
    paymentsApiVerification.skipped !== true;
  const paymentsOk =
    paymentsRan && paymentsApiVerification.matched === true;

  let paymentDecision = null;
  if (!paymentsRan) {
    console.warn(
      `${LOG} E) approve/reject skipped (payments API did not run) refId=${refId}`,
    );
    paymentDecision = {
      skipped: true,
      reason: "payments_api_not_run",
    };
  } else {
    const finalMatched = smsOk && paymentsOk;
    let decisionReason = null;
    if (!finalMatched) {
      if (!smsOk) decisionReason = verification?.reason || "sms_verification_failed";
      else decisionReason =
        paymentsApiVerification?.reason ||
        (paymentsApiVerification?.issues?.length
          ? paymentsApiVerification.issues.join(",")
          : "payments_api_mismatch");
    }

    try {
      console.log(
        `${LOG} E) payment decision refId=${refId} finalMatched=${finalMatched}`,
      );
      paymentDecision = await runSinglepanaPaymentDecisionAfterVerification({
        refId,
        verification: {
          matched: finalMatched,
          reason: decisionReason || undefined,
        },
      });
      console.log(`${LOG} E) done refId=${refId}`, paymentDecision);
    } catch (e) {
      console.error(`${LOG} E) payment decision error refId=${refId}`, e.message);
      paymentDecision = {
        skipped: true,
        reason: "payment_decision_exception",
        error: e.message,
      };
    }
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
    }
  } else {
    console.log(`${LOG} D) forward skipped (WEBHOOK_FORWARD_URL unset) refId=${refId}`);
  }

  console.log(`${LOG} ✓ pipeline complete refId=${refId}`);
  return {
    extraction,
    verification,
    smsMatch,
    paymentsApiVerification,
    paymentDecision,
    /** @deprecated same as paymentDecision */
    approveFlow: paymentDecision,
  };
}
