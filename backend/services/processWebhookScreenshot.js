import axios from "axios";
import { processOneAndAutoSave } from "../extraction.js";
import { verifyPaymentAgainstApi } from "../paymentsApi.js";
import { matchSmsReaderToWebhookExtraction } from "../utils/smsReaderWebhookMatch.js";

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

  const verifyJwt = String(process.env.PAYMENTS_VERIFY_JWT || "").trim();
  console.log(
    `${LOG} C) payments API verify start refId=${refId} jwtConfigured=${Boolean(verifyJwt)}`,
  );
  const verification = await verifyPaymentAgainstApi({
    jwtToken: verifyJwt || undefined,
    screenshotUrl,
    extractedUtr: extraction.utr,
    extractedAmount: extraction.amount,
    payloadAmount: payload.amount,
    payloadUtr: payload.utr,
  });
  console.log(`${LOG} C) payments API verify done refId=${refId}`, verification);

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
  return { extraction, verification, smsMatch };
}
