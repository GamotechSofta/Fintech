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
    console.log("[OCR] Skipping Vision call: imageUrl missing");
    return null;
  }

  if (ocrCache.has(imageUrl)) {
    console.log("[OCR] Cache hit for image:", imageUrl);
    return ocrCache.get(imageUrl);
  }

  try {
    console.log("[OCR] Calling Vision API for image:", imageUrl);
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
    console.log(
      "[OCR] Vision response received:",
      fullText ? "text detected" : "no text detected",
    );
    ocrCache.set(imageUrl, fullText);
    return fullText;
  } catch (error) {
    console.error("Vision OCR failed:", imageUrl, error.message);
    ocrCache.set(imageUrl, null);
    return null;
  }
};

const processOne = async ({ paymentId = "", imageUrl = "" }) => {
  console.log("[OCR] Processing item:", { paymentId, imageUrl });
  const fullText = await callVisionAPI(imageUrl);
  if (!fullText) {
    console.log("[OCR] Marking FAILED: OCR text missing", { paymentId, imageUrl });
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
  console.log("[OCR] Extracted result:", result);
  return result;
};

const saveExtractionResult = async (result) => {
  console.log("[OCR] Saving extraction result for image:", result.imageUrl);
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
    { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
  );
  console.log("[OCR] Save complete for image:", result.imageUrl);
};

// Explicit auto-save helper for extracted JSON payload.
const autoSaveExtractionJson = async (result) => {
  console.log("[OCR] Auto-save triggered for payment:", result.paymentId || "N/A");
  await saveExtractionResult(result);
  return result;
};

const processOneAndAutoSave = async (item) => {
  console.log("[OCR] processOneAndAutoSave started");
  const result = await processOne(item);
  await autoSaveExtractionJson(result);
  console.log("[OCR] processOneAndAutoSave completed");
  return result;
};

const processBatch = async (items = []) => {
  return Promise.all(items.map((item) => processOne(item)));
};

const runBatched = async (items = []) => {
  console.log("[OCR] Running batched extraction. Total items:", items.length);
  const out = [];
  for (let i = 0; i < items.length; i += MAX_BATCH_SIZE) {
    const batch = items.slice(i, i + MAX_BATCH_SIZE);
    console.log(
      "[OCR] Processing batch:",
      `${Math.floor(i / MAX_BATCH_SIZE) + 1}`,
      "size:",
      batch.length,
    );
    const result = await processBatch(batch);
    out.push(...result);
  }
  console.log("[OCR] Batched extraction complete. Total results:", out.length);
  return out;
};

const runBatchedAndAutoSave = async (items = []) => {
  console.log("[OCR] runBatchedAndAutoSave started");
  const results = await runBatched(items);
  await Promise.all(results.map((result) => autoSaveExtractionJson(result)));
  console.log("[OCR] runBatchedAndAutoSave completed");
  return results;
};

const getScreenshotItemsFromPayments = async (jwtToken) => {
  console.log("[OCR] Fetching payment screenshots from payments API");
  const payments = await fetchPaymentsAmountAndScreenshot(jwtToken);
  console.log("[OCR] Payments fetched:", payments.length);
  const screenshotItems = payments
    .filter((item) => item?.screenshotUrl)
    .map((item, index) => ({
      paymentId: `payment_${index + 1}`,
      imageUrl: item.screenshotUrl,
    }));
  console.log("[OCR] Payments with screenshots:", screenshotItems.length);
  return screenshotItems;
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
