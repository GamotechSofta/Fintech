import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const normalizeBaseUrl = (raw = "") => {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
};

const resolvePaymentsUrl = () => {
  const base = normalizeBaseUrl(process.env.Backend_URL || "");
  if (!base) {
    throw new Error("Backend_URL is missing in backend/.env");
  }
  return base.endsWith("/payments/generic") ? base : `${base}/payments/generic`;
};

const extractPaymentPreview = (item = {}) => ({
  amount: item.amount ?? null,
  screenshotUrl: item.screenshotUrl ?? item.screenshot ?? item.screenShotUrl ?? null,
});

const extractList = (payload) => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.payments)) return payload.payments;
    if (Array.isArray(payload.results)) return payload.results;
  }
  return [];
};

export const fetchPaymentsAmountAndScreenshot = async (jwtToken) => {
  if (!jwtToken) {
    throw new Error("JWT token is required");
  }

  const url = resolvePaymentsUrl();
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${jwtToken}`,
      "Content-Type": "application/json",
    },
    timeout: 30000,
  });

  const list = extractList(response.data);
  return list.map(extractPaymentPreview);
};

// Optional CLI usage:
// node paymentsApi.js <JWT_TOKEN>
if (process.argv[1] && process.argv[1].endsWith("paymentsApi.js")) {
  const token = process.argv[2];
  fetchPaymentsAmountAndScreenshot(token)
    .then((data) => {
      console.log(JSON.stringify(data, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
