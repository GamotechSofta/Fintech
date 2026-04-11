/** In-memory JWT from app login (POST /session/register-login-jwt). Lost on server restart. */
let activeLoginJwt = "";

export const setActiveLoginJwt = (token) => {
  activeLoginJwt = String(token || "").trim();
};

export const getActiveLoginJwt = () => activeLoginJwt;

export const clearActiveLoginJwt = () => {
  activeLoginJwt = "";
};
