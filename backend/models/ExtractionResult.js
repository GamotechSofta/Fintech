import mongoose from "mongoose";

const extractionResultSchema = new mongoose.Schema(
  {
    paymentId: {
      type: String,
      required: false,
      trim: true,
      index: true,
    },
    imageUrl: {
      type: String,
      required: [true, "imageUrl is required"],
      trim: true,
      unique: true,
    },
    utr: {
      type: String,
      required: false,
      trim: true,
      match: [/^\d{12}$/, "UTR must be exactly 12 digits"],
      unique: true,
    },
    amount: {
      type: Number,
      required: false,
      min: [0, "Amount cannot be negative"],
    },
    status: {
      type: String,
      enum: ["SUCCESS", "FAILED"],
      required: [true, "status is required"],
      uppercase: true,
      trim: true,
    },
  },
  { timestamps: true },
);

const ExtractionResult = mongoose.model(
  "ExtractionResult",
  extractionResultSchema,
);

export default ExtractionResult;
