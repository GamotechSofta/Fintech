import axios from "axios";
import ExtractionResult from "./models/ExtractionResult.js";
import { fetchPaymentsAmountAndScreenshot } from "./paymentsApi.js";

const VISION_API_URL = "https://vision.googleapis.com/v1/images:annotate";
const MAX_BATCH_SIZE = 10;

// In-memory cache to avoid duplicate OCR calls for same screenshot URL.
const ocrCache = new Map();

const extractUTR = (text = "") => {
  const match = text.match(/\b\d{12}\b/);
  return match ? match[0] : null;
};

const extractAmount = (text = "") => {
  const match = text.match(/(?:₹|Rs\.?|INR)\s?([0-9,]+(?:\.\d{1,2})?)/i);
  if (!match || !match[1]) return null;
  const normalized = match[1].replaceAll(",", "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
};

const callVisionAPI = async (imageUrl) => {
  const apiKey = process.env.Google_Vision_API_KEY;
  if (!apiKey) {
    throw new Error("Google_Vision_API_KEY is missing in backend/.env");
  }

  if (!imageUrl) {
    return null;
  }

  if (ocrCache.has(imageUrl)) {
    return ocrCache.get(imageUrl);
  }

  try {
    const response = await axios.post(
      `${VISION_API_URL}?key=${apiKey}`,
      {
        requests: [
          {
            image: {
              source: { imageUri: imageUrl },
            },
            features: [{ type: "TEXT_DETECTION" }],
          },
        ],
      },
      {
        headers: { "Content-Type": "application/json" },
        timeout: 30000,
      },
    );

    const fullText =
      response?.data?.responses?.[0]?.fullTextAnnotation?.text ?? null;
    ocrCache.set(imageUrl, fullText);
    return fullText;
  } catch (error) {
    console.error("Vision OCR failed:", imageUrl, error.message);
    ocrCache.set(imageUrl, null);
    return null;
  }
};

const processOne = async ({ paymentId = "", imageUrl = "" }) => {
  const fullText = await callVisionAPI(imageUrl);
  if (!fullText) {
    return {
      paymentId,
      imageUrl,
      utr: null,
      amount: null,
      status: "FAILED",
    };
  }

  const utr = extractUTR(fullText);
  const amount = extractAmount(fullText);
  const status = utr && amount !== null ? "SUCCESS" : "FAILED";

  const result = {
    paymentId,
    imageUrl,
    utr,
    amount,
    status,
  };
  console.log("OCR result:", result);
  return result;
};

const saveExtractionResult = async (result) => {
  const payload = {
    paymentId: result.paymentId || "",
    imageUrl: result.imageUrl,
    utr: result.utr ?? undefined,
    amount: result.amount ?? undefined,
    status: result.status,
  };

  await ExtractionResult.findOneAndUpdate(
    { imageUrl: payload.imageUrl },
    payload,
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

// Explicit auto-save helper for extracted JSON payload.
const autoSaveExtractionJson = async (result) => {
  await saveExtractionResult(result);
  return result;
};

const processOneAndAutoSave = async (item) => {
  const result = await processOne(item);
  await autoSaveExtractionJson(result);
  return result;
};

const processBatch = async (items = []) => {
  return Promise.all(items.map((item) => processOne(item)));
};

const runBatched = async (items = []) => {
  const out = [];
  for (let i = 0; i < items.length; i += MAX_BATCH_SIZE) {
    const batch = items.slice(i, i + MAX_BATCH_SIZE);
    const result = await processBatch(batch);
    out.push(...result);
  }
  return out;
};

const runBatchedAndAutoSave = async (items = []) => {
  const results = await runBatched(items);
  await Promise.all(results.map((result) => autoSaveExtractionJson(result)));
  return results;
};

const getScreenshotItemsFromPayments = async (jwtToken) => {
  const payments = await fetchPaymentsAmountAndScreenshot(jwtToken);
  return payments
    .filter((item) => item?.screenshotUrl)
    .map((item, index) => ({
      paymentId: `payment_${index + 1}`,
      imageUrl: item.screenshotUrl,
    }));
};

export {
  callVisionAPI,
  extractUTR,
  extractAmount,
  processOne,
  processBatch,
  runBatched,
  getScreenshotItemsFromPayments,
  saveExtractionResult,
  autoSaveExtractionJson,
  processOneAndAutoSave,
  runBatchedAndAutoSave,
};
