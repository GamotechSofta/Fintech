/** In-memory JWT from app login (POST /session/register-login-jwt). Lost on server restart. */
let activeLoginJwt = "";

export const setActiveLoginJwt = (token) => {
  activeLoginJwt = String(token || "").trim();
};

export const getActiveLoginJwt = () => activeLoginJwt;

export const clearActiveLoginJwt = () => {
  activeLoginJwt = "";
};

/**
 * Prefer JWT from POST /session/register-login-jwt (in-memory).
 * If absent, use WEBHOOK_DECLARE_PASSWORD_JWT from env (server-side fallback).
 */
export const getActiveLoginJwtOrDeclarePasswordEnv = () => {
  const fromSession = String(getActiveLoginJwt() || "").trim();
  if (fromSession) return fromSession;
  return String(process.env.WEBHOOK_DECLARE_PASSWORD_JWT ?? "").trim();
};
