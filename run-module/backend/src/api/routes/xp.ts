/**
 * src/api/routes/xp.ts
 *
 * XP (ADR-027, ADR-033). No balance is stored: every read derives XP from activity_sessions,
 * challenge wins and the awards other services report, with the daily caps applied on read.
 *
 *   GET /v1/users/me/xp                    the signed-in user   → { xp, updated_at, breakdown }
 *   GET /v1/users/:userId/xp               service only         → { xp, updatedAt }
 *   GET /v1/users/:userId/xp-gate?minXP=N  service only         → true | false
 *   GET /v1/leaderboard/xp?window=daily|weekly|monthly&limit=N   any user → { window, day,
 *                                          entries[{rank, user_id, xp}], me, total_ranked }: XP earned today,
 *                                          in the last 7 days, or this calendar month, in XP_TIMEZONE, after
 *                                          the caps, challenge wins and awards included; the Social service
 *                                          adds names and hostels (its /v1/leaderboards/xp and /hostels)
 *   GET /v1/xp/stats                       the signed-in user   → { total, level, level_progress, today,
 *                                          week, month, by_source } (ADR-033)
 *   GET /v1/xp/history?limit=&cursor=      the signed-in user   → { items[], next_cursor }, newest first
 *   POST /internal/v1/xp/award             service only         → new total (bare integer) (ADR-033)
 *   POST /internal/v1/xp/reverse           service only         → new total (bare integer) (ADR-033)
 *   POST /internal/v1/xp/totals            service only         → { subject: total }
 *
 * The two service routes are the Integration Contract's getUserXP / meetsXPGate, for Partner Hunt
 * in the Exercise Module, which must ask about OTHER users. A user token cannot call them.
 * minXP is the caller's (a product decision the Run Module does not store).
 */

import type { FastifyPluginAsync } from "fastify";
import { requireAuth, requireService } from "../../auth/verify-jwt.js";
import { getUserXp, getXpBoard, meetsXpGate, XP_BOARD_WINDOWS, type XpBoardWindow } from "../../xp/query.js";
import { xpCompatibilitySummary } from "../../progress/summary.js";
import { checkAward } from "../../xp/awards.js";
import { recordLevelUp } from "../../xp/level-up.js";
import { decodeCursor, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT, xpHistory, xpStats } from "../../xp/stats.js";
import { pool } from "../../db/pool.js";
import { getRateLimitOptions, rateLimitPlugin } from "../rate-limit.js";
import { RATE_LIMIT_XP_READ_PER_MIN } from "../../config/env.js";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MIN_XP = 1_000_000;
const MAX_BOARD_LIMIT = 1000;

const line = {
  type: "object",
  required: ["reason", "xp"],
  properties: { reason: { type: "string" }, xp: { type: "integer" } },
} as const;

type AwardBody = {
  subject: string; amount: number; reason: string; source: string; idempotency_key: string;
  source_id?: string | null; metadata?: Record<string, unknown> | null;
};
type ReverseBody = { source: string; idempotency_key: string; reason: string };

export const xpRoutes: FastifyPluginAsync = async (fastify) => {
  if (!fastify.hasDecorator("rateLimit")) await fastify.register(rateLimitPlugin);
  const readLimit = fastify.rateLimit(getRateLimitOptions(RATE_LIMIT_XP_READ_PER_MIN, "1 minute", "xp_read_min"));

  fastify.get(
    "/v1/xp",
    {
      onRequest: [requireAuth],
      schema: {
        response: {
          200: {
            type: "object",
            required: ["totalXp", "level", "today", "week", "bySource"],
            properties: {
              totalXp: { type: "integer" },
              level: {
                type: "object",
                required: ["level", "currentXP", "xpForCurrentLevel", "xpForNextLevel", "progress"],
                properties: {
                  level: { type: "integer" }, currentXP: { type: "integer" },
                  xpForCurrentLevel: { type: "integer" }, xpForNextLevel: { type: "integer" }, progress: { type: "number" },
                },
              },
              today: { type: "integer" },
              week: { type: "integer" },
              bySource: { type: "object", additionalProperties: { type: "integer" } },
            },
          },
        },
      },
    },
    async (request) => xpCompatibilitySummary(request.userId),
  );

  fastify.get(
    "/v1/users/me/xp",
    {
      onRequest: [requireAuth],
      schema: {
        response: {
          200: {
            type: "object",
            required: ["xp", "updated_at", "breakdown"],
            properties: {
              xp: { type: "integer" },
              updated_at: { type: ["string", "null"] },
              breakdown: { type: "array", items: line },
            },
          },
        },
      },
    },
    async (request) => {
      const summary = await getUserXp(request.userId);
      return { xp: summary.xp, updated_at: summary.updated_at?.toISOString() ?? null, breakdown: summary.breakdown };
    }
  );

  fastify.get<{ Params: { userId: string } }>(
    "/v1/users/:userId/xp",
    {
      onRequest: [requireService],
      schema: {
        response: {
          200: {
            type: "object",
            required: ["xp", "updatedAt"],
            properties: { xp: { type: "integer" }, updatedAt: { type: ["string", "null"] } },
          },
        },
      },
    },
    async (request, reply) => {
      const { userId } = request.params;
      if (!UUID_REGEX.test(userId)) return reply.code(400).send({ error: "userId must be a UUID" });
      const summary = await getUserXp(userId);
      return { xp: summary.xp, updatedAt: summary.updated_at?.toISOString() ?? null };
    }
  );

  fastify.get<{ Params: { userId: string }; Querystring: { minXP?: string } }>(
    "/v1/users/:userId/xp-gate",
    { onRequest: [requireService], schema: { response: { 200: { type: "boolean" } } } },
    async (request, reply) => {
      const { userId } = request.params;
      if (!UUID_REGEX.test(userId)) return reply.code(400).send({ error: "userId must be a UUID" });
      const raw = request.query.minXP;
      const minXp = raw !== undefined && /^\d{1,7}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(minXp) || minXp > MAX_MIN_XP) {
        return reply.code(400).send({ error: "minXP must be a whole number of XP" });
      }
      return meetsXpGate(userId, minXp);
    }
  );

  const boardEntry = {
    type: "object",
    required: ["rank", "user_id", "xp"],
    properties: { rank: { type: "integer" }, user_id: { type: "string" }, xp: { type: "integer" } },
  } as const;

  fastify.get<{ Querystring: { window?: string; limit?: string } }>(
    "/v1/leaderboard/xp",
    {
      onRequest: [requireAuth],
      preHandler: [readLimit],
      schema: {
        response: {
          200: {
            type: "object",
            required: ["window", "day", "entries", "me", "total_ranked"],
            properties: {
              window: { type: "string" },
              day: { type: "string" },
              entries: { type: "array", items: boardEntry },
              me: { anyOf: [boardEntry, { type: "null" }] },
              total_ranked: { type: "integer" },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const window = request.query.window ?? "daily";
      if (!(XP_BOARD_WINDOWS as string[]).includes(window)) return reply.code(400).send({ error: "window must be daily, weekly or monthly" });
      const raw = request.query.limit ?? "10";
      const limit = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_BOARD_LIMIT) {
        return reply.code(400).send({ error: `limit must be between 1 and ${MAX_BOARD_LIMIT}` });
      }
      const board = await getXpBoard(window as XpBoardWindow);
      return {
        window,
        day: board.day,
        entries: board.entries.slice(0, limit),
        me: board.entries.find((e) => e.user_id === request.userId) ?? null,
        total_ranked: board.entries.length,
      };
    }
  );

  // Awards from other services (ADR-033). Shape errors are 400; a source/reason the catalogue does
  // not have, an amount outside the reason's range, or an oversized key/source_id/metadata is 422.
  fastify.post<{ Body: AwardBody }>(
    "/internal/v1/xp/award",
    {
      onRequest: [requireService],
      schema: {
        body: {
          type: "object",
          required: ["subject", "amount", "reason", "source", "idempotency_key"],
          properties: {
            subject: { type: "string" },
            amount: { type: "integer" },
            reason: { type: "string" },
            source: { type: "string" },
            idempotency_key: { type: "string" },
            source_id: { type: ["string", "null"] },
            metadata: { type: ["object", "null"] },
          },
        },
        response: { 200: { type: "integer" } },
      },
    },
    async (request, reply) => {
      const { amount, reason, source, idempotency_key } = request.body;
      const sourceId = request.body.source_id ?? null;
      const metadata = request.body.metadata ?? {};
      if (!UUID_REGEX.test(request.body.subject)) return reply.code(400).send({ error: "subject must be a UUID" });
      const subject = request.body.subject.toLowerCase();
      const invalid = checkAward({ subject, amount, reason, source, idempotency_key, source_id: sourceId, metadata });
      if (invalid) return reply.code(422).send({ error: invalid });

      const before = (await getUserXp(subject)).xp;
      const inserted = await pool.query(
        `INSERT INTO external_xp_awards (source, idempotency_key, user_id, amount, reason, source_id, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source, idempotency_key) DO NOTHING
         RETURNING user_id`,
        [source, idempotency_key, subject, amount, reason, sourceId, JSON.stringify(metadata)],
      );
      if ((inserted.rowCount ?? 0) === 0) {
        // A replay: the same (subject, amount, reason) answers the current total; anything else is a
        // different award reusing the key.
        const existing = await pool.query<{ user_id: string; amount: number; reason: string }>(
          "SELECT user_id, amount, reason FROM external_xp_awards WHERE source = $1 AND idempotency_key = $2",
          [source, idempotency_key],
        );
        const row = existing.rows[0];
        if (!row || row.user_id !== subject || row.amount !== amount || row.reason !== reason) {
          return reply.code(409).send({ error: "idempotency mismatch" });
        }
        return (await getUserXp(subject)).xp;
      }

      const after = (await getUserXp(subject)).xp;
      await recordLevelUp(subject, before, after);
      return after;
    }
  );

  // Reverse an award (ADR-033): it stays in the table, marked, and counts 0. Idempotent.
  fastify.post<{ Body: ReverseBody }>(
    "/internal/v1/xp/reverse",
    {
      onRequest: [requireService],
      schema: {
        body: {
          type: "object",
          required: ["source", "idempotency_key", "reason"],
          properties: {
            source: { type: "string", minLength: 1, maxLength: 64 },
            idempotency_key: { type: "string", minLength: 1, maxLength: 200 },
            reason: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        response: { 200: { type: "integer" } },
      },
    },
    async (request, reply) => {
      const { source, idempotency_key, reason } = request.body;
      const existing = await pool.query<{ user_id: string }>(
        "SELECT user_id FROM external_xp_awards WHERE source = $1 AND idempotency_key = $2",
        [source, idempotency_key],
      );
      const subject = existing.rows[0]?.user_id;
      if (!subject) return reply.code(404).send({ error: "not_found" });
      const before = (await getUserXp(subject)).xp;
      const updated = await pool.query(
        `UPDATE external_xp_awards SET reversed_at = now(), reversal_reason = $3
         WHERE source = $1 AND idempotency_key = $2 AND reversed_at IS NULL`,
        [source, idempotency_key, reason],
      );
      const after = (await getUserXp(subject)).xp;
      // A reversal never adds XP, but the check is the same as for awards: only a rise notifies.
      if ((updated.rowCount ?? 0) > 0) await recordLevelUp(subject, before, after);
      return after;
    }
  );

  const historyItem = {
    type: "object",
    required: ["id", "amount", "source", "reason", "source_id", "created_at", "reversed"],
    properties: {
      id: { type: "string" }, amount: { type: "integer" }, source: { type: "string" }, reason: { type: "string" },
      source_id: { type: ["string", "null"] }, created_at: { type: "string" }, reversed: { type: "boolean" },
    },
  } as const;

  fastify.get(
    "/v1/xp/stats",
    {
      onRequest: [requireAuth],
      preHandler: [readLimit],
      schema: {
        response: {
          200: {
            type: "object",
            required: ["total", "level", "level_progress", "today", "week", "month", "by_source"],
            properties: {
              total: { type: "integer" },
              level: { type: "integer" },
              level_progress: {
                type: "object",
                required: ["current_level_xp", "next_level_xp", "into_level", "needed"],
                properties: {
                  current_level_xp: { type: "integer" }, next_level_xp: { type: "integer" },
                  into_level: { type: "integer" }, needed: { type: "integer" },
                },
              },
              today: { type: "integer" },
              week: { type: "integer" },
              month: { type: "integer" },
              by_source: { type: "object", additionalProperties: { type: "integer" } },
            },
          },
        },
      },
    },
    async (request) => xpStats(request.userId),
  );

  fastify.get<{ Querystring: { limit?: string; cursor?: string } }>(
    "/v1/xp/history",
    {
      onRequest: [requireAuth],
      preHandler: [readLimit],
      schema: {
        response: {
          200: {
            type: "object",
            required: ["items", "next_cursor"],
            properties: { items: { type: "array", items: historyItem }, next_cursor: { type: ["string", "null"] } },
          },
        },
      },
    },
    async (request, reply) => {
      const raw = request.query.limit ?? String(DEFAULT_HISTORY_LIMIT);
      const limit = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_HISTORY_LIMIT) {
        return reply.code(400).send({ error: `limit must be between 1 and ${MAX_HISTORY_LIMIT}` });
      }
      let cursor = null;
      if (request.query.cursor !== undefined && request.query.cursor !== "") {
        cursor = decodeCursor(request.query.cursor);
        if (!cursor) return reply.code(400).send({ error: "cursor is not valid" });
      }
      return xpHistory(request.userId, limit, cursor);
    }
  );

  fastify.post<{ Body: { subjects: string[] } }>(
    "/internal/v1/xp/totals",
    {
      onRequest: [requireService],
      schema: {
        body: {
          type: "object",
          required: ["subjects"],
          properties: {
            subjects: { type: "array", items: { type: "string" }, maxItems: 200 }
          }
        }
      }
    },
    async (request, reply) => {
      const { subjects } = request.body;
      if (!Array.isArray(subjects) || subjects.length > 200) {
         return reply.code(400).send({ error: "subjects array required, max 200" });
      }
      
      const bad = subjects.find((s) => !UUID_REGEX.test(s));
      if (bad) {
        return reply.code(400).send({ error: `subject must be a UUID: ${bad}` });
      }
      
      const res: Record<string, number> = {};
      
      const CONCURRENCY_LIMIT = 10;
      let active = 0;
      let index = 0;
      
      await new Promise<void>((resolve, reject) => {
        if (subjects.length === 0) return resolve();
        
        function next() {
          if (index >= subjects.length) {
            if (active === 0) resolve();
            return;
          }
          
          while (active < CONCURRENCY_LIMIT && index < subjects.length) {
            const subject = subjects[index++]!;
            active++;
            getUserXp(subject).then((summary) => {
              res[subject] = summary.xp;
              active--;
              next();
            }).catch(reject);
          }
        }
        
        next();
      });
      
      return res;
    }
  );
};
