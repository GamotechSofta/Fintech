import mongoose from "mongoose";

const smsReaderSchema = new mongoose.Schema(
  {
    amount: {
      type: Number,
      required: [true, "Amount is required"],
      min: [0, "Amount cannot be negative"],
    },
    utrNo: {
      type: String,
      required: [true, "UPI UTR is required"],
      trim: true,
      unique: true,
      index: true,
      match: [/^\d{12}$/, "UPI UTR must be exactly 12 digits"],
    },
    transactionType: {
      type: String,
      alias: "type",
      required: [true, "Transaction type is required"],
      enum: {
        values: ["credit", "debit"],
        message: "Transaction type must be credit or debit",
      },
      lowercase: true,
      trim: true,
    },
    bankAccountLastFourDigits: {
      type: String,
      alias: "accountLast4",
      required: [true, "Last four digits of bank account are required"],
      match: [/^[0-9]{4}$/, "Last four digits must contain exactly 4 numbers"],
      trim: true,
    },
    date: {
      type: String,
      required: [true, "Date is required"],
      trim: true,
    },
    time: {
      type: String,
      required: [true, "Time is required"],
      trim: true,
    },
    
    senderID: {
      type: String,
      alias: "senderId",
      required: [true, "Sender ID is required"],
      trim: true,
    },
    transactionId: {
      type: String,
      required: false,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true }
);

// Prevent duplicate banking SMS entries.
smsReaderSchema.index(
  { senderID: 1, utrNo: 1, date: 1, time: 1, amount: 1, transactionType: 1 },
  { unique: true }
);

const SmsReader = mongoose.model("SmsReader", smsReaderSchema);

export default SmsReader;
