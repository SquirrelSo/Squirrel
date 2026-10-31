/**
 * src/redis/client.ts
 *
 * ioredis client singleton.
 * Reads REDIS_URL from the validated env config.
 */

import { Redis } from "ioredis";
import { REDIS_URL } from "../config/env.js";

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
  enableReadyCheck: true,
});

redis.on("error", (err: Error) => {
  console.error("[redis] Connection error:", err.message);
});

redis.on("connect", () => {
  // intentionally silent â€” health route verifies liveness
});
