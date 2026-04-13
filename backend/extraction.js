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

const parseAmountCandidate = (raw = "") => {
  if (!raw) return null;
  const normalized = String(raw)
    .replace(/[,\s]/g, "")
    .replace(/[^\d.]/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const value = Number(normalized);
  if (!Number.isFinite(value) || value <= 0) return null;
  // Ignore 12+ digit integers which are likely UTR/reference numbers.
  if (!normalized.includes(".") && normalized.length >= 12) return null;
  return value;
};

const scanAmountFromText = (text = "", patterns = []) => {
  for (const pattern of patterns) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let m;
    while ((m = regex.exec(text)) !== null) {
      const value = parseAmountCandidate(m[1]);
      if (value != null) return value;
    }
  }
  return null;
};

const extractAmount = (text = "") => {
  const source = String(text || "");
  if (!source.trim()) return null;

  const currencyPatterns = [
    /(?:₹|rs\.?|inr)\s*[:\-]?\s*([0-9][0-9,\s]{0,12}(?:\.\d{1,2})?)/gi,
    /([0-9][0-9,\s]{0,12}(?:\.\d{1,2})?)\s*(?:₹|rs\.?|inr)\b/gi,
  ];

  // Prefer values near UTR line (usually the transaction amount in these screenshots).
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const utrLineIndex = lines.findIndex((line) => /\butr\b/i.test(line));
  if (utrLineIndex !== -1) {
    const start = Math.max(0, utrLineIndex - 3);
    const end = Math.min(lines.length - 1, utrLineIndex + 3);
    const localText = lines.slice(start, end + 1).join("\n");
    const nearbyValue = scanAmountFromText(localText, currencyPatterns);
    if (nearbyValue != null) return nearbyValue;
  }

  const currencyValue = scanAmountFromText(source, currencyPatterns);
  if (currencyValue != null) return currencyValue;

  const keywordValue = scanAmountFromText(source, [
    /(?:amount|amt|credited|credit|received|deposit(?:ed)?)\s*[:\-]?\s*(?:₹|rs\.?|inr)?\s*([0-9][0-9,\s]{0,12}(?:\.\d{1,2})?)/gi,
  ]);
  if (keywordValue != null) return keywordValue;

  return null;
};

const callVisionAPI = async (imageUrl) => {
  const apiKey = process.env.Google_Vision_API_KEY;
  if (!apiKey) {
    console.warn(
      "[OCR] Google_Vision_API_KEY missing in backend/.env — skipping Vision call",
    );
    return null;
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

const processOne = async ({ paymentId = "", imageUrl = "", fallbackAmount = undefined }) => {
  console.log("[OCR] Processing item:", { paymentId, imageUrl });
  const fullText = await callVisionAPI(imageUrl);
  if (!fullText) {
    const numericFallbackAmount = Number(fallbackAmount);
    const amount =
      Number.isFinite(numericFallbackAmount) ? numericFallbackAmount : null;
    console.log("[OCR] Marking FAILED: OCR text missing", { paymentId, imageUrl });
    return {
      paymentId,
      imageUrl,
      utr: null,
      amount,
      status: "FAILED",
    };
  }

  const utr = extractUTR(fullText);
  const amountFromOcr = extractAmount(fullText);
  const numericFallbackAmount = Number(fallbackAmount);
  const amount =
    amountFromOcr !== null
      ? amountFromOcr
      : Number.isFinite(numericFallbackAmount)
        ? numericFallbackAmount
        : null;
  const status = utr && amountFromOcr !== null ? "SUCCESS" : "FAILED";

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
