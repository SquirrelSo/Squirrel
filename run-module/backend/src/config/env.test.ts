/**
 * src/config/env.test.ts
 *
 * Smoke tests for the env loader.
 * These run in process — they verify the module exports the expected shape
 * given a fully populated environment (set by the test harness via .env.example
 * values or CI environment variables).
 */

import { describe, it, expect } from "vitest";

describe("env module shape", () => {
  it("exports PORT as a number", async () => {
    // Set required env vars before importing env module
    process.env["DATABASE_URL"] = "postgres://postgres:postgres@localhost:5432/run_module";
    process.env["REDIS_URL"] = "redis://localhost:6379";
    process.env["PORT"] = "3000";
    process.env["NODE_ENV"] = "test";
    process.env["LOG_LEVEL"] = "silent";

    // Dynamic import so env vars are in place
    const { PORT, NODE_ENV, LOG_LEVEL } = await import("../config/env.js");

    expect(typeof PORT).toBe("number");
    expect(PORT).toBe(3000);
    expect(NODE_ENV).toBe("test");
    expect(LOG_LEVEL).toBe("silent");
  });
});
