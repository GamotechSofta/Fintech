import express from "express";
import WebhookEvent from "../models/webhook.model.js";
import { addScreenshotJob } from "../queue/queue.js";
import { validateWebhookSecret, verifyHmacSignature } from "../utils/security.js";

const webhookRouter = express.Router();

const normalizePayload = (body = {}) => ({
  refId: String(body.refId || "").trim(),
  screenshotUrl: String(body.screenshotUrl || "").trim(),
  amount:
    body.amount === undefined || body.amount === null || body.amount === ""
      ? undefined
      : Number(body.amount),
  utr: body.utr ? String(body.utr).trim() : undefined,
});

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
  try {
    const incomingSecret = req.header("x-webhook-secret");
    if (!validateWebhookSecret(incomingSecret)) {
      return res.status(401).json({ success: false, message: "Unauthorized webhook request" });
    }

    const signature = req.header("x-webhook-signature");
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    if (!verifyHmacSignature({ signature, rawBody })) {
      return res.status(401).json({ success: false, message: "Invalid webhook signature" });
    }

    const payload = normalizePayload(req.body);
    const errors = validatePayload(payload);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, message: errors.join(", ") });
    }

    try {
      await WebhookEvent.create({
        refId: payload.refId,
        status: "pending",
        payload,
      });
    } catch (error) {
      if (error?.code !== 11000) throw error;
      const existing = await WebhookEvent.findOne({ refId: payload.refId });
      console.log(
        `[webhook] duplicate refId=${payload.refId} existingStatus=${existing?.status || "unknown"}`,
      );
      return res.status(200).json({ success: true, message: "Already accepted", refId: payload.refId });
    }

    await addScreenshotJob(payload);

    console.log(
      `[webhook] accepted refId=${payload.refId} queued=true latencyMs=${Date.now() - requestAt}`,
    );
    return res.status(202).json({ success: true, queued: true, refId: payload.refId });
  } catch (error) {
    if (error?.code === "REDIS_UNAVAILABLE") {
      console.error(`[webhook] queue unavailable refId=${refForLog} error=${error.message}`);
      return res.status(503).json({
        success: false,
        message: "Queue unavailable. Please retry shortly.",
      });
    }
    console.error(`[webhook] failed refId=${refForLog} error=${error.message}`);
    return res.status(500).json({ success: false, message: "Webhook processing failed" });
  }
});

export default webhookRouter;
