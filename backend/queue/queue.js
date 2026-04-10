import { Queue } from "bullmq";
import IORedis from "ioredis";

const queueName = "screenshot-uploaded";
let baseRedis = null;
let screenshotQueue = null;
let lastRedisErrorLogAt = 0;

const buildRedisConfig = () => {
  return {
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
    maxRetriesPerRequest: 1,
    enableReadyCheck: true,
    connectionName: "webhook-queue",
    lazyConnect: true,
    retryStrategy: () => null,
  };
};

const logRedisErrorThrottled = (message) => {
  const now = Date.now();
  if (now - lastRedisErrorLogAt < 15000) return;
  lastRedisErrorLogAt = now;
  console.error("[queue] Redis unavailable:", message);
};

const getRedisConnection = async () => {
  if (baseRedis && baseRedis.status === "ready") {
    return baseRedis;
  }

  const redisConfig = buildRedisConfig();
  const client = process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, redisConfig)
    : new IORedis(redisConfig);

  client.on("error", (error) => {
    logRedisErrorThrottled(error.message);
  });

  try {
    await client.connect();
    baseRedis = client;
    console.log("[queue] Redis connected");
    return baseRedis;
  } catch (error) {
    try {
      await client.quit();
    } catch (_) {
      // Ignore cleanup failures.
    }
    const wrapped = new Error(`Redis unavailable: ${error.message}`);
    wrapped.code = "REDIS_UNAVAILABLE";
    throw wrapped;
  }
};

const getQueue = async () => {
  if (screenshotQueue) return screenshotQueue;
  const redis = await getRedisConnection();
  screenshotQueue = new Queue(queueName, {
    connection: redis,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: 2000,
      removeOnFail: 5000,
    },
  });
  return screenshotQueue;
};

export const addScreenshotJob = async (payload) => {
  const queue = await getQueue();
  const { refId } = payload;
  return queue.add("process-screenshot-upload", payload, {
    jobId: refId,
  });
};

export { queueName, getRedisConnection };
