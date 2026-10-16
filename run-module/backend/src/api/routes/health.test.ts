/**
 * src/api/routes/health.test.ts
 *
 * Unit tests for GET /health.
 * Both pg Pool and ioredis client are mocked so no real services are needed.
 *
 * Cases covered:
 *   1. Both healthy          -> 200, status "ok"
 *   2. Postgres down         -> 503, status "degraded", postgres.connected false
 *   3. Redis down            -> 503, status "degraded", redis.connected false
 *   4. PostGIS not enabled   -> 200, postgis "available_not_enabled", version set
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";

// ── Set required env vars before any module that imports env.ts ─────────────
process.env["DATABASE_URL"] =
  "postgres://postgres:postgres@localhost:5432/run_module";
process.env["REDIS_URL"] = "redis://localhost:6379";
process.env["PORT"] = "3000";
process.env["NODE_ENV"] = "test";
process.env["LOG_LEVEL"] = "silent";

// ── Mock pool and redis before importing the route ──────────────────────────

vi.mock("../../db/pool.js", () => ({
  pool: { connect: vi.fn() },
}));

vi.mock("../../redis/client.js", () => ({
  redis: { ping: vi.fn() },
}));

// Import after mocks are wired — modules are fully replaced by vi.mock
const poolModule = await import("../../db/pool.js");
const redisModule = await import("../../redis/client.js");
const { healthRoutes } = await import("./health.js");

// Cast mocked objects to access vi.fn() methods.
// Destructure to obtain the mock fn references.
// eslint-disable-next-line @typescript-eslint/unbound-method
const { connect: _connectFn } = poolModule.pool;
// eslint-disable-next-line @typescript-eslint/unbound-method
const { ping: _pingFn } = redisModule.redis;
const mockConnect = _connectFn as unknown as MockInstance;
const mockPing = _pingFn as unknown as MockInstance;

// ── Helpers ──────────────────────────────────────────────────────────────────

type MockQuery = (sql: string) => unknown;

function makePgClient(queryImpl: MockQuery): {
  query: MockInstance;
  release: MockInstance;
} {
  return {
    query: vi.fn().mockImplementation((sql: string) => queryImpl(sql)),
    release: vi.fn(),
  };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  void app.register(healthRoutes);
  await app.ready();
  return app;
}

// ── Response body shape ───────────────────────────────────────────────────────

interface HealthBody {
  status: string;
  postgres: {
    connected: boolean;
    postgis: string;
    version: string | null;
    error: string | null;
  };
  redis: { connected: boolean; error: string | null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("GET /health", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── 1. Both healthy ─────────────────────────────────────────────────────────
  it("returns 200 and status ok when both dependencies are healthy", async () => {
    const client = makePgClient(() => ({
      rows: [{ postgis_version: "3.4.3 r..." }],
      rowCount: 1,
    }));
    mockConnect.mockResolvedValue(client);
    mockPing.mockResolvedValue("PONG");

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json<HealthBody>();
    expect(body.status).toBe("ok");
    expect(body.postgres.connected).toBe(true);
    expect(body.redis.connected).toBe(true);
  });

  // ── 2. Postgres down ────────────────────────────────────────────────────────
  it("returns 503 and status degraded when Postgres is unreachable", async () => {
    mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));
    mockPing.mockResolvedValue("PONG");

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(503);
    const body = res.json<HealthBody>();
    expect(body.status).toBe("degraded");
    expect(body.postgres.connected).toBe(false);
    expect(body.postgres.error).toMatch(/ECONNREFUSED/);
  });

  // ── 3. Redis down ───────────────────────────────────────────────────────────
  it("returns 503 and status degraded when Redis is unreachable", async () => {
    const client = makePgClient(() => ({
      rows: [{ postgis_version: "3.4.3 r..." }],
      rowCount: 1,
    }));
    mockConnect.mockResolvedValue(client);
    mockPing.mockRejectedValue(new Error("Redis connection refused"));

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(503);
    const body = res.json<HealthBody>();
    expect(body.status).toBe("degraded");
    expect(body.redis.connected).toBe(false);
    expect(body.redis.error).toMatch(/refused/i);
  });

  // ── 4. PostGIS not yet enabled ──────────────────────────────────────────────
  it("returns 200 with postgis available_not_enabled when extension exists but is not created", async () => {
    const postgisVersionError = new Error(
      "function postgis_version() does not exist"
    );
    let callCount = 0;
    const client = makePgClient(() => {
      callCount++;
      if (callCount === 1) throw postgisVersionError;
      return { rows: [{ default_version: "3.4.3" }], rowCount: 1 };
    });
    mockConnect.mockResolvedValue(client);
    mockPing.mockResolvedValue("PONG");

    const res = await app.inject({ method: "GET", url: "/health" });

    expect(res.statusCode).toBe(200);
    const body = res.json<HealthBody>();
    expect(body.status).toBe("ok");
    expect(body.postgres.connected).toBe(true);
    expect(body.postgres.postgis).toBe("available_not_enabled");
    expect(body.postgres.version).toBe("3.4.3");
  });
});
