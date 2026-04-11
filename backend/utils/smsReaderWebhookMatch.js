import SmsReader from "../models/SmsReader.js";

const LOG = "[webhook/sms-match]";

const sameAmount = (a, b) => {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  return Math.abs(x - y) < 0.01;
};

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
