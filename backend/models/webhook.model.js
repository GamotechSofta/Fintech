import mongoose from "mongoose";

const webhookEventSchema = new mongoose.Schema(
  {
    refId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["pending", "processed", "failed"],
      default: "pending",
      index: true,
    },
    payload: {
      refId: { type: String, required: true, trim: true },
      screenshotUrl: { type: String, required: true, trim: true },
      amount: { type: Number, required: false },
      utr: { type: String, required: false, trim: true },
    },
    lastError: {
      type: String,
      required: false,
      trim: true,
    },
    processedAt: {
      type: Date,
      required: false,
    },
  },
  { timestamps: true },
);

webhookEventSchema.index({ status: 1, createdAt: -1 });
webhookEventSchema.index({ "payload.screenshotUrl": 1 });

const WebhookEvent = mongoose.model("WebhookEvent", webhookEventSchema);

export default WebhookEvent;
