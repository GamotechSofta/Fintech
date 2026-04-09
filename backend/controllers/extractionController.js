import {
  getScreenshotItemsFromPayments,
  processOne,
  runBatched,
  saveExtractionResult,
} from "../extraction.js";

export const extractSingle = async (req, res) => {
  try {
    const { paymentId, imageUrl } = req.body ?? {};
    if (!imageUrl) {
      return res.status(400).json({
        success: false,
        message: "imageUrl is required",
      });
    }

    const result = await processOne({ paymentId, imageUrl });
    await saveExtractionResult(result);
    return res.status(200).json({
      paymentId: result.paymentId,
      utr: result.utr,
      amount: result.amount,
      status: result.status,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to process OCR extraction",
      error: error.message,
    });
  }
};

export const extractBulk = async (req, res) => {
  try {
    const { items, imageUrls, jwtToken } = req.body ?? {};
    let inputItems = [];

    if (Array.isArray(items)) {
      inputItems = items
        .filter((v) => v && v.imageUrl)
        .map((v) => ({ paymentId: v.paymentId ?? "", imageUrl: v.imageUrl }));
    } else if (Array.isArray(imageUrls)) {
      inputItems = imageUrls
        .filter(Boolean)
        .map((url, index) => ({ paymentId: `bulk_${index + 1}`, imageUrl: url }));
    } else if (jwtToken) {
      inputItems = await getScreenshotItemsFromPayments(jwtToken);
    }

    if (inputItems.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          "Provide items[] / imageUrls[] / jwtToken with at least one valid imageUrl",
      });
    }

    const results = await runBatched(inputItems);
    await Promise.all(results.map((result) => saveExtractionResult(result)));
    const successCount = results.filter((r) => r.status === "SUCCESS").length;
    const failedCount = results.length - successCount;

    return res.status(200).json({
      success: true,
      count: results.length,
      successCount,
      failedCount,
      data: results.map((r) => ({
        paymentId: r.paymentId,
        utr: r.utr,
        amount: r.amount,
        status: r.status,
      })),
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to process bulk OCR extraction",
      error: error.message,
    });
  }
};
