/**
 * src/api/routes/health.ts
 *
 * GET /health — live dependency check.
 *
 * Returns 200 only when both Postgres and Redis are reachable.
 * Returns 503 if either dependency is down.
 *
 * PostGIS states:
 *   "enabled"               — PostGIS_version() succeeded
 *   "available_not_enabled" — extension not yet created (legitimate until RM-3.1)
 *   "unavailable"           — image does not have PostGIS at all
 *
 * A Postgres connection failure is "degraded" regardless of PostGIS state.
 * A failed connection/query times out after 2 s so a hung dependency cannot
 * stall the endpoint.
 */

import type { FastifyInstance } from "fastify";
import { pool } from "../../db/pool.js";
import { redis } from "../../redis/client.js";

// ── Types ──────────────────────────────────────────────────────────────────

type PostGISState = "enabled" | "available_not_enabled" | "unavailable";

interface PostgresHealth {
  connected: boolean;
  postgis: PostGISState;
  version: string | null;
  error: string | null;
}

interface RedisHealth {
  connected: boolean;
  error: string | null;
}

interface HealthBody {
  status: "ok" | "degraded";
  postgres: PostgresHealth;
  redis: RedisHealth;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const QUERY_TIMEOUT_MS = 2_000;

/** Run a promise and reject after timeoutMs if it hasn't resolved. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e: unknown) => { clearTimeout(timer); reject(e); }
    );
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function checkPostgres(): Promise<PostgresHealth> {
  let client;
  try {
    client = await withTimeout(pool.connect(), QUERY_TIMEOUT_MS);
  } catch (err) {
    return { connected: false, postgis: "unavailable", version: null, error: errorMessage(err) };
  }

  try {
    // Try to get the live PostGIS version (requires CREATE EXTENSION postgis).
    // Wrap in Promise.resolve so sync throws from the query are caught uniformly.
    const versionResult = await withTimeout(
      Promise.resolve(
        client.query<{ postgis_version: string }>(
          "SELECT PostGIS_version() AS postgis_version"
        )
      ),
      QUERY_TIMEOUT_MS
    );
    const version = versionResult.rows[0]?.postgis_version ?? null;
    return { connected: true, postgis: "enabled", version, error: null };
  } catch (versionErr) {
    // PostGIS_version() is undefined — extension not yet enabled. Check availability.
    try {
      const availResult = await withTimeout(
        Promise.resolve(
          client.query<{ default_version: string }>(
            "SELECT default_version FROM pg_available_extensions WHERE name = 'postgis'"
          )
        ),
        QUERY_TIMEOUT_MS
      );
      if ((availResult.rowCount ?? 0) > 0) {
        const version = availResult.rows[0]?.default_version ?? null;
        return {
          connected: true,
          postgis: "available_not_enabled",
          version,
          error: null,
        };
      }
      return {
        connected: true,
        postgis: "unavailable",
        version: null,
        error: null,
      };
    } catch (availErr) {
      // Even pg_available_extensions failed — still connected, PostGIS unknown
      return {
        connected: true,
        postgis: "unavailable",
        version: null,
        error: errorMessage(availErr),
      };
    }
  } finally {
    client.release();
  }
}

async function checkRedis(): Promise<RedisHealth> {
  try {
    await withTimeout(redis.ping(), QUERY_TIMEOUT_MS);
    return { connected: true, error: null };
  } catch (err) {
    return { connected: false, error: errorMessage(err) };
  }
}

// ── Route registration ─────────────────────────────────────────────────────

export function healthRoutes(
  fastify: FastifyInstance,
  _opts: Record<string, unknown>,
  done: () => void
): void {
  fastify.get("/health", async (_request, reply) => {
    const [postgres, redisResult] = await Promise.all([
      checkPostgres(),
      checkRedis(),
    ]);

    const healthy = postgres.connected && redisResult.connected;
    const body: HealthBody = {
      status: healthy ? "ok" : "degraded",
      postgres,
      redis: redisResult,
    };

    return reply.status(healthy ? 200 : 503).send(body);
  });

  done();
}
