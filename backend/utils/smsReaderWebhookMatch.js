import SmsReader from "../models/SmsReader.js";

const LOG = "[webhook/sms-match]";

export const sameAmount = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.01;
};

const normalize12DigitUtr = (value) => {
  if (value == null || value === "") return null;
  const digits = String(value).replace(/\D/g, "");
  const m = digits.match(/(\d{12})/);
  return m ? m[1] : null;
};

/**
 * After OCR + smsMatch: require extracted UTR === SmsReader.utrNo and
 * payload amount === extracted amount === SmsReader amount (all within tolerance).
 */
export async function verifySmsReaderWebhookConsistency(extraction, payload, refId, smsMatch) {
  if (!smsMatch?.matched || !smsMatch.smsReaderId) {
    console.log(`${LOG} verify triple skipped refId=${refId} (smsMatch.matched=false)`);
    return {
      matched: false,
      reason: "sms_reader_match_required_first",
      smsMatch,
    };
  }

  const doc = await SmsReader.findById(smsMatch.smsReaderId).lean();
  if (!doc) {
    console.log(`${LOG} verify triple ✗ refId=${refId} SmsReader doc missing id=${smsMatch.smsReaderId}`);
    return { matched: false, reason: "sms_reader_doc_missing" };
  }

  const extractedUtr = normalize12DigitUtr(extraction?.utr);
  const smsUtr = String(doc.utrNo || "").trim();
  if (!extractedUtr || extractedUtr !== smsUtr) {
    console.log(
      `${LOG} verify triple ✗ refId=${refId} UTR mismatch extracted=${extractedUtr} smsReader=${smsUtr}`,
    );
    return {
      matched: false,
      reason: "utr_extracted_vs_sms_reader_mismatch",
      extractedUtr,
      smsReaderUtr: smsUtr,
    };
  }

  const extractedAmount = Number(extraction?.amount);
  const smsReaderAmount = Number(doc.amount);
  if (!Number.isFinite(extractedAmount) || !Number.isFinite(smsReaderAmount)) {
    console.log(`${LOG} verify triple ✗ refId=${refId} invalid amounts`);
    return {
      matched: false,
      reason: "invalid_extracted_or_sms_amount",
      extractedAmount: extraction?.amount,
      smsReaderAmount: doc.amount,
    };
  }

  if (!sameAmount(extractedAmount, smsReaderAmount)) {
    console.log(
      `${LOG} verify triple ✗ refId=${refId} extracted vs SMS amount extracted=${extractedAmount} sms=${smsReaderAmount}`,
    );
    return {
      matched: false,
      reason: "extracted_vs_sms_amount_mismatch",
      extractedAmount,
      smsReaderAmount,
    };
  }

  const rawPayload = payload?.amount;
  if (rawPayload === undefined || rawPayload === null || rawPayload === "") {
    console.log(`${LOG} verify triple ✗ refId=${refId} payload.amount missing`);
    return {
      matched: false,
      reason: "payload_amount_required",
      extractedAmount,
      smsReaderAmount,
    };
  }

  const payloadAmount = Number(rawPayload);
  if (!Number.isFinite(payloadAmount)) {
    console.log(`${LOG} verify triple ✗ refId=${refId} payload.amount not a number`);
    return {
      matched: false,
      reason: "payload_amount_invalid",
      payloadAmount: rawPayload,
    };
  }

  const pe = sameAmount(payloadAmount, extractedAmount);
  const ps = sameAmount(payloadAmount, smsReaderAmount);
  if (pe && ps) {
    console.log(
      `${LOG} verify triple ✓ refId=${refId} utr=${extractedUtr} amount=${extractedAmount} (payload=extracted=SMS)`,
    );
    return {
      matched: true,
      utr: extractedUtr,
      payloadAmount,
      extractedAmount,
      smsReaderAmount,
    };
  }

  console.log(
    `${LOG} verify triple ✗ refId=${refId} triple amount mismatch payload=${payloadAmount} extracted=${extractedAmount} sms=${smsReaderAmount}`,
  );
  return {
    matched: false,
    reason: "triple_amount_mismatch",
    payloadAmount,
    extractedAmount,
    smsReaderAmount,
    checks: {
      payload_vs_extracted: pe,
      payload_vs_sms_reader: ps,
    },
  };
}

/**
 * After webhook screenshot OCR: if extracted UTR + amount match a stored SMS row, set check=true and log.
 */
export async function matchSmsReaderToWebhookExtraction(extraction, refId = "n/a") {
  const utr = extraction?.utr;
  const amount = extraction?.amount;

  if (!utr || typeof utr !== "string" || !/^\d{12}$/.test(utr.trim())) {
    console.log(`${LOG} ✗ refId=${refId} reason=invalid_or_missing_utr utr=${String(utr)}`);
    return { matched: false, reason: "invalid_or_missing_utr" };
  }
  if (amount == null || !Number.isFinite(Number(amount))) {
    console.log(`${LOG} ✗ refId=${refId} reason=invalid_or_missing_amount amount=${amount}`);
    return { matched: false, reason: "invalid_or_missing_amount" };
  }

  const normalizedUtr = utr.trim();
  const doc = await SmsReader.findOne({ utrNo: normalizedUtr });
  if (!doc) {
    console.log(`${LOG} ✗ refId=${refId} reason=no_sms_row_for_utr utr=${normalizedUtr}`);
    return { matched: false, reason: "no_sms_row_for_utr" };
  }

  if (!sameAmount(amount, doc.amount)) {
    console.log(
      `${LOG} ✗ refId=${refId} reason=amount_mismatch extracted=${amount} smsRow.amount=${doc.amount} utr=${normalizedUtr}`,
    );
    return { matched: false, reason: "amount_mismatch" };
  }

  const displayAmount = doc.amount;
  console.log(`${LOG} ✓ MATCH refId=${refId} utr=${normalizedUtr} amount=${displayAmount} smsReaderId=${doc._id}`);

  if (!doc.check) {
    doc.check = true;
    await doc.save();
    console.log(`${LOG} updated SmsReader.check=true id=${doc._id}`);
  }

  return { matched: true, smsReaderId: String(doc._id) };
}
