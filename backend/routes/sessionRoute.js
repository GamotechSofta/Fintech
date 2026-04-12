import express from "express";
import { setActiveLoginJwt } from "../utils/activeLoginJwtCache.js";

const sessionRouter = express.Router();

/**
 * Optional: call after app login to cache JWT in memory. Webhook approve/reject uses
 * WEBHOOK_DECLARE_PASSWORD_JWT from env, not this cache.
 */
sessionRouter.post("/session/register-login-jwt", (req, res) => {
  const auth = req.header("authorization") || req.header("Authorization");
  if (!auth || !/^Bearer\s+/i.test(auth)) {
    return res.status(400).json({
      success: false,
      message: "Authorization: Bearer <token> required (login API token)",
    });
  }
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return res.status(400).json({ success: false, message: "Empty token" });
  }
  setActiveLoginJwt(token);
  console.log("[session] register-login-jwt stored (len=%s)", token.length);
  return res.status(200).json({ success: true, message: "Login JWT registered for server-side payment actions" });
});

export default sessionRouter;
