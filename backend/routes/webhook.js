import express from "express";
import WebhookEvent from "../models/webhook.model.js";
import { processWebhookScreenshotPayload } from "../services/processWebhookScreenshot.js";
import { validateWebhookSecret, verifyHmacSignature } from "../utils/security.js";

const LOG = "[webhook/screenshot-uploaded]";

const webhookRouter = express.Router();

const normalizePayload = (body = {}) => ({
  refId: String(body.refId || "").trim(),
  screenshotUrl: String(body.screenshotUrl || "").trim(),
  amount:
    body.amount === undefined || body.amount === null || body.amount === ""
      ? undefined
      : Number(body.amount),
  utr: body.utr ? String(body.utr).trim() : undefined,
  jwtToken: String(
    body.jwtToken || body.token || body.appJwt || body.accessToken || "",
  ).trim(),
});

/** App login JWT: header wins over body; used for payments verify + approve (fallback: PAYMENTS_VERIFY_JWT). */
const resolveAppJwtForWebhook = (req, payload) => {
  const fromHeader = String(req.header("x-app-jwt") || "").trim();
  if (fromHeader) return fromHeader;
  const appAuth = req.header("x-app-authorization");
  if (appAuth && /^Bearer\s+/i.test(String(appAuth))) {
    return String(appAuth).replace(/^Bearer\s+/i, "").trim();
  }
  return String(payload.jwtToken || "").trim();
};

const validatePayload = (payload) => {
  const errors = [];
  if (!payload.refId) errors.push("refId is required");
  if (!payload.screenshotUrl) errors.push("screenshotUrl is required");
  if (payload.amount !== undefined && !Number.isFinite(payload.amount)) {
    errors.push("amount must be a number");
  }
  return errors;
};

webhookRouter.post("/webhook/screenshot-uploaded", async (req, res) => {
  const requestAt = Date.now();
  const refForLog = req.body?.refId || "n/a";
  console.log(`${LOG} → POST received refId=${refForLog}`);
  try {
    const incomingSecret = req.header("x-webhook-secret");
    console.log(`${LOG} ① check x-webhook-secret header ${incomingSecret ? "present" : "missing"}`);
    if (!validateWebhookSecret(incomingSecret)) {
      console.log(`${LOG} ✗ FAIL secret mismatch or invalid`);
      return res.status(401).json({ success: false, message: "Unauthorized webhook request" });
    }
    console.log(`${LOG} ✓ secret OK`);

    const signature = req.header("x-webhook-signature");
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    console.log(
      `${LOG} ② HMAC ${signature ? "header present — verifying" : "header absent — skip verify (per security.js)"}`,
    );
    if (!verifyHmacSignature({ signature, rawBody })) {
      console.log(`${LOG} ✗ FAIL invalid HMAC signature`);
      return res.status(401).json({ success: false, message: "Invalid webhook signature" });
    }
    console.log(`${LOG} ✓ HMAC OK`);

    const payload = normalizePayload(req.body);
    const appJwt = resolveAppJwtForWebhook(req, payload);
    const processingPayload = { ...payload, jwtToken: appJwt };
    console.log(`${LOG} ③ normalized payload`, {
      refId: payload.refId,
      screenshotUrl: payload.screenshotUrl ? `${payload.screenshotUrl.slice(0, 80)}…` : "",
      amount: payload.amount,
      utr: payload.utr,
      appJwt: appJwt ? "present (x-app-jwt or body)" : "absent",
    });
    const errors = validatePayload(payload);
    if (errors.length > 0) {
      console.log(`${LOG} ✗ FAIL validation: ${errors.join(", ")}`);
      return res.status(400).json({ success: false, message: errors.join(", ") });
    }
    console.log(`${LOG} ✓ payload validation OK`);

    try {
      await WebhookEvent.create({
        refId: payload.refId,
        status: "pending",
        payload: {
          refId: payload.refId,
          screenshotUrl: payload.screenshotUrl,
          amount: payload.amount,
          utr: payload.utr,
        },
      });
      console.log(`${LOG} ④ WebhookEvent created status=pending refId=${payload.refId}`);
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await WebhookEvent.findOne({ refId: payload.refId });
      console.log(
        `${LOG} ④ duplicate refId (skip processing) refId=${payload.refId} existingStatus=${existing?.status || "unknown"}`,
      );
      return res.status(200).json({ success: true, message: "Already accepted", refId: payload.refId });
    }

    try {
      console.log(`${LOG} ⑤ start processWebhookScreenshotPayload refId=${payload.refId}`);
      const result = await processWebhookScreenshotPayload(processingPayload);
      await WebhookEvent.updateOne(
        { refId: payload.refId },
        {
          $set: {
            status: "processed",
            processedAt: new Date(),
            lastError: "",
          },
        },
      );
      const latencyMs = Date.now() - requestAt;
      console.log(
        `${LOG} ⑥ SUCCESS refId=${payload.refId} latencyMs=${latencyMs} extraction.status=${result.extraction?.status} smsMatch.matched=${result.smsMatch?.matched} verification.matched=${result.verification?.matched}`,
      );
      return res.status(200).json({
        success: true,
        refId: payload.refId,
        ...(result.error ? { pipelineError: result.error } : {}),
        extraction: result.extraction
          ? {
              utr: result.extraction.utr,
              amount: result.extraction.amount,
              status: result.extraction.status,
            }
          : null,
        smsMatch: result.smsMatch,
        verification: result.verification,
        paymentsApiVerification: result.paymentsApiVerification,
        paymentDecision: result.paymentDecision,
        approveFlow: result.paymentDecision,
      });
    } catch (processError) {
      console.error(
        `${LOG} ✗ processWebhookScreenshotPayload FAILED refId=${payload.refId} message=${processError.message}`,
      );
      await WebhookEvent.updateOne(
        { refId: payload.refId },
        { $set: { status: "failed", lastError: processError.message } },
      );
      console.log(`${LOG} ⑥ WebhookEvent updated status=failed refId=${payload.refId}`);
      throw processError;
    }
  } catch (error) {
    console.error(`${LOG} ✗ UNHANDLED refId=${refForLog} name=${error.name} message=${error.message}`);
    if (error.stack) {
      console.error(`${LOG} stack`, error.stack);
    }
    return res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});


export default webhookRouter;
