import crypto from "crypto";

const timingSafeEqual = (a, b) => {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
};

export const validateWebhookSecret = (incomingSecret) => {
  const configured = process.env.WEBHOOK_SECRET || "";
  if (!configured) {
    throw new Error("WEBHOOK_SECRET is missing in environment");
  }
  return timingSafeEqual(configured, incomingSecret || "");
};

export const verifyHmacSignature = ({ signature, rawBody }) => {
  if (!signature) return true;
  const hmacSecret = process.env.WEBHOOK_HMAC_SECRET || process.env.WEBHOOK_SECRET;
  if (!hmacSecret) {
    throw new Error("WEBHOOK_HMAC_SECRET/WEBHOOK_SECRET is missing in environment");
  }
  const expected = crypto
    .createHmac("sha256", hmacSecret)
    .update(rawBody || "")
    .digest("hex");
  return timingSafeEqual(expected, signature);
};
