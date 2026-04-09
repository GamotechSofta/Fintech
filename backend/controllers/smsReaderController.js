import SmsReader from "../models/SmsReader.js";

const normalizeSmsPayload = (body = {}) => {
  const amountValue = Number(body.amount);
  const utr = (body.utrNo ?? body.utr ?? body.UTR ?? "").toString().trim();
  const senderId = (body.senderID ?? body.senderId ?? body.sender ?? "").toString().trim();
  const type = (body.transactionType ?? body.type ?? "").toString().trim().toLowerCase();
  const accountLast4 = (
    body.bankAccountLastFourDigits ??
    body.accountLast4 ??
    ""
  )
    .toString()
    .trim();

  return {
    amount: Number.isFinite(amountValue) ? amountValue : body.amount,
    transactionType: type,
    bankAccountLastFourDigits: accountLast4,
    date: body.date,
    time: body.time,
    senderID: senderId,
    utrNo: utr,
    transactionId: body.transactionId,
  };
};

export const createSmsRecord = async (req, res) => {
  try {
    const {
      amount,
      transactionType,
      bankAccountLastFourDigits,
      date,
      time,
      senderID,
      utrNo,
      transactionId,
    } =
      normalizeSmsPayload(req.body);

    if (
      amount === undefined ||
      !transactionType ||
      !bankAccountLastFourDigits ||
      !date ||
      !time ||
      !senderID ||
      !utrNo
    ) {
      return res.status(400).json({
        success: false,
        message:
          "amount, transactionType/type, bankAccountLastFourDigits/accountLast4, date, time, senderID/senderId and utrNo/utr are required",
      });
    }

    const existingRecord = await SmsReader.findOne({
      senderID,
      utrNo,
      date,
      time,
      amount,
      transactionType: transactionType.toLowerCase(),
    });

    if (existingRecord) {
      existingRecord.transactionId = transactionId ?? existingRecord.transactionId;
      await existingRecord.save();

      return res.status(200).json({
        success: true,
        message: "SMS record already exists (updated with latest JSON fields)",
        data: existingRecord,
      });
    }

    const smsRecord = await SmsReader.create({
      amount,
      transactionType,
      bankAccountLastFourDigits,
      date,
      time,
      senderID,
      utrNo,
      transactionId,
    });

    return res.status(201).json({
      success: true,
      message: "SMS record created successfully",
      data: smsRecord,
    });
  } catch (error) {
    if (error?.name === "ValidationError") {
      return res.status(400).json({
        success: false,
        message: "Validation failed for SMS record",
        error: error.message,
      });
    }

    if (error?.code === 11000) {
      return res.status(200).json({
        success: true,
        message: "SMS record already exists",
      });
    }

    return res.status(500).json({
      success: false,
      message: "Failed to create SMS record",
      error: error.message,
    });
  }
};

export const createBulkSmsRecords = async (req, res) => {
  try {
    const rawRecords = Array.isArray(req.body?.records)
      ? req.body.records
      : Array.isArray(req.body)
      ? req.body
      : null;

    if (!rawRecords || rawRecords.length === 0) {
      return res.status(400).json({
        success: false,
        message: "records array is required",
      });
    }

    const results = [];
    let created = 0;
    let duplicates = 0;
    let failed = 0;

    for (let i = 0; i < rawRecords.length; i += 1) {
      const normalized = normalizeSmsPayload(rawRecords[i]);
      const {
        amount,
        transactionType,
        bankAccountLastFourDigits,
        date,
        time,
        senderID,
        utrNo,
        transactionId,
      } = normalized;

      const missingRequired =
        amount === undefined ||
        !transactionType ||
        !bankAccountLastFourDigits ||
        !date ||
        !time ||
        !senderID ||
        !utrNo;

      if (missingRequired) {
        failed += 1;
        results.push({
          index: i,
          success: false,
          message:
            "amount, transactionType/type, bankAccountLastFourDigits/accountLast4, date, time, senderID/senderId and utrNo/utr are required",
        });
        continue;
      }

      try {
        const existingRecord = await SmsReader.findOne({
          senderID,
          utrNo,
          date,
          time,
          amount,
          transactionType: transactionType.toLowerCase(),
        });

        if (existingRecord) {
          existingRecord.transactionId =
            transactionId ?? existingRecord.transactionId;
          await existingRecord.save();
          duplicates += 1;
          results.push({
            index: i,
            success: true,
            message: "SMS record already exists",
            status: "duplicate",
            data: existingRecord,
          });
          continue;
        }

        const smsRecord = await SmsReader.create({
          amount,
          transactionType,
          bankAccountLastFourDigits,
          date,
          time,
          senderID,
          utrNo,
          transactionId,
        });

        created += 1;
        results.push({
          index: i,
          success: true,
          message: "SMS record created successfully",
          status: "created",
          data: smsRecord,
        });
      } catch (error) {
        if (error?.code === 11000) {
          duplicates += 1;
          results.push({
            index: i,
            success: true,
            message: "SMS record already exists",
            status: "duplicate",
          });
        } else {
          failed += 1;
          results.push({
            index: i,
            success: false,
            message: error?.name === "ValidationError"
              ? "Validation failed for SMS record"
              : "Failed to create SMS record",
            error: error.message,
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      message: "Bulk SMS processing completed",
      count: rawRecords.length,
      created,
      duplicates,
      failed,
      results,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to process bulk SMS records",
      error: error.message,
    });
  }
};

export const getAllSmsRecords = async (req, res) => {
  try {
    const records = await SmsReader.find().sort({ createdAt: -1 });

    return res.status(200).json({
      success: true,
      count: records.length,
      data: records,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch SMS records",
      error: error.message,
    });
  }
};

export const getSmsRecordById = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await SmsReader.findById(id);

    if (!record) {
      return res.status(404).json({
        success: false,
        message: "SMS record not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: record,
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to fetch SMS record",
      error: error.message,
    });
  }
};

export const deleteSmsRecord = async (req, res) => {
  try {
    const { id } = req.params;
    const record = await SmsReader.findByIdAndDelete(id);

    if (!record) {
      return res.status(404).json({
        success: false,
        message: "SMS record not found",
      });
    }

    return res.status(200).json({
      success: true,
      message: "SMS record deleted successfully",
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: "Failed to delete SMS record",
      error: error.message,
    });
  }
};
