import axios from "axios";
import dotenv from "dotenv";
import { Worker } from "bullmq";
import connectDB from "../config/db.js";
import WebhookEvent from "../models/webhook.model.js";
import { getRedisConnection, queueName } from "../queue/queue.js";

dotenv.config();

const FORWARD_URL = process.env.WEBHOOK_FORWARD_URL;
const WORKER_CONCURRENCY = Number(process.env.WEBHOOK_WORKER_CONCURRENCY || 8);

if (!FORWARD_URL) {
  console.warn("[worker] WEBHOOK_FORWARD_URL is missing; jobs will fail until set");
}

const processWebhookJob = async (job) => {
  const payload = job.data || {};
  const { refId } = payload;
  if (!refId) {
    throw new Error("Missing refId in job payload");
  }

  const event = await WebhookEvent.findOne({ refId });
  if (!event) {
    throw new Error(`WebhookEvent not found for refId=${refId}`);
  }

  if (event.status === "processed") {
    console.log(`[worker] refId=${refId} already processed; skipping`);
    return;
  }

  if (!FORWARD_URL) {
    throw new Error("WEBHOOK_FORWARD_URL is missing");
  }

  console.log(`[worker] processing refId=${refId} attempt=${job.attemptsMade + 1}`);

  try {
    await axios.post(FORWARD_URL, payload, {
      headers: { "Content-Type": "application/json" },
      timeout: Number(process.env.WEBHOOK_FORWARD_TIMEOUT_MS || 15000),
    });

    await WebhookEvent.updateOne(
      { refId },
      {
        $set: {
          status: "processed",
          processedAt: new Date(),
          lastError: "",
        },
      },
    );
    console.log(`[worker] processed refId=${refId}`);
  } catch (error) {
    await WebhookEvent.updateOne(
      { refId },
      { $set: { status: "failed", lastError: error.message } },
    );
    console.error(`[worker] failed refId=${refId} error=${error.message}`);
    throw error;
  }
};

const startWorker = async () => {
  await connectDB();
  const redis = await getRedisConnection();

  const worker = new Worker(queueName, processWebhookJob, {
    connection: redis.duplicate(),
    concurrency: WORKER_CONCURRENCY,
  });

  worker.on("completed", (job) => {
    console.log(`[worker] completed jobId=${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(
      `[worker] failed jobId=${job?.id} refId=${job?.data?.refId || "n/a"} attempts=${job?.attemptsMade} error=${error.message}`,
    );
  });

  worker.on("error", (error) => {
    console.error("[worker] fatal worker error:", error.message);
  });

  const shutdown = async (signal) => {
    console.log(`[worker] received ${signal}; shutting down`);
    await worker.close();
    await redis.quit();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
};

startWorker().catch((error) => {
  console.error("[worker] startup failed:", error);
  process.exit(1);
});
