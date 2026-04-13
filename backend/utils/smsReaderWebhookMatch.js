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
      reason: smsMatch?.reason || "sms_reader_match_required_first",
      smsMatch,
    };
  }

  const doc = await SmsReader.findById(smsMatch.smsReaderId).lean();
  if (!doc) {
    console.log(`${LOG} verify triple ✗ refId=${refId} SmsReader doc missing id=${smsMatch.smsReaderId}`);
    return { matched: false, reason: "sms_reader_doc_missing" };
  }

  const extractedUtr = normalize12DigitUtr(extraction?.utr);
  const payloadUtr = normalize12DigitUtr(payload?.utr);
  const effectiveUtr = extractedUtr || payloadUtr;
  const smsUtr = String(doc.utrNo || "").trim();
  if (!effectiveUtr || effectiveUtr !== smsUtr) {
    console.log(
      `${LOG} verify triple ✗ refId=${refId} UTR mismatch extracted=${extractedUtr} payload=${payloadUtr} smsReader=${smsUtr}`,
    );
    return {
      matched: false,
      reason: "utr_extracted_vs_sms_reader_mismatch",
      extractedUtr: effectiveUtr,
      smsReaderUtr: smsUtr,
    };
  }

  const extractedAmountRaw = Number(extraction?.amount);
  const payloadAmountRaw = Number(payload?.amount);
  const extractedAmount = Number.isFinite(extractedAmountRaw) ? extractedAmountRaw : null;
  const payloadAmount = Number.isFinite(payloadAmountRaw) ? payloadAmountRaw : null;
  const effectiveAmount =
    extractedAmount !== null ? extractedAmount : payloadAmount;
  const smsReaderAmount = Number(doc.amount);
  if (!Number.isFinite(effectiveAmount) || !Number.isFinite(smsReaderAmount)) {
    console.log(`${LOG} verify triple ✗ refId=${refId} invalid amounts`);
    return {
      matched: false,
      reason: "invalid_extracted_or_sms_amount",
      extractedAmount: extraction?.amount,
      payloadAmount: payload?.amount,
      smsReaderAmount: doc.amount,
    };
  }

  if (!sameAmount(effectiveAmount, smsReaderAmount)) {
    console.log(
      `${LOG} verify triple ✗ refId=${refId} effective vs SMS amount effective=${effectiveAmount} sms=${smsReaderAmount}`,
    );
    return {
      matched: false,
      reason: "extracted_vs_sms_amount_mismatch",
      extractedAmount: effectiveAmount,
      smsReaderAmount,
    };
  }

  if (payloadAmount === null) {
    console.log(`${LOG} verify triple ✗ refId=${refId} payload.amount missing`);
    return {
      matched: false,
      reason: "payload_amount_required",
      extractedAmount: effectiveAmount,
      smsReaderAmount,
    };
  }

  const pe = sameAmount(payloadAmount, effectiveAmount);
  const ps = sameAmount(payloadAmount, smsReaderAmount);
  if (pe && ps) {
    console.log(
      `${LOG} verify triple ✓ refId=${refId} utr=${effectiveUtr} amount=${effectiveAmount} (payload/effective/SMS matched)`,
    );
    return {
      matched: true,
      utr: effectiveUtr,
      payloadAmount,
      extractedAmount: effectiveAmount,
      smsReaderAmount,
    };
  }

  console.log(
    `${LOG} verify triple ✗ refId=${refId} triple amount mismatch payload=${payloadAmount} effective=${effectiveAmount} sms=${smsReaderAmount}`,
  );
  return {
    matched: false,
    reason: "triple_amount_mismatch",
    payloadAmount,
    extractedAmount: effectiveAmount,
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
export async function matchSmsReaderToWebhookExtraction(extraction, refId = "n/a", payload = {}) {
  const extractedUtr = normalize12DigitUtr(extraction?.utr);
  const payloadUtr = normalize12DigitUtr(payload?.utr);
  const utr = extractedUtr || payloadUtr;
  const extractedAmount = Number(extraction?.amount);
  const payloadAmount = Number(payload?.amount);
  const amount = Number.isFinite(extractedAmount)
    ? extractedAmount
    : Number.isFinite(payloadAmount)
      ? payloadAmount
      : null;

  if (!utr) {
    console.log(
      `${LOG} ✗ refId=${refId} reason=invalid_or_missing_utr extracted=${String(extraction?.utr)} payload=${String(payload?.utr)}`,
    );
    return { matched: false, reason: "invalid_or_missing_utr" };
  }
  if (amount == null || !Number.isFinite(Number(amount))) {
    console.log(
      `${LOG} ✗ refId=${refId} reason=invalid_or_missing_amount extracted=${String(extraction?.amount)} payload=${String(payload?.amount)}`,
    );
    return { matched: false, reason: "invalid_or_missing_amount" };
  }

  const normalizedUtr = String(utr).trim();
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
