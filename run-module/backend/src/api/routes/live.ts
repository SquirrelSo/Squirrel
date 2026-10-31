/**
 * src/api/routes/live.ts
 *
 * GET /v1/live → { running_now, as_of }: how many people are out on a run right now, for the app's
 * live counter. A run counts while it is active or paused and still sending points (one in the
 * last 10 minutes, or started in the last 15); an abandoned one stops counting on its own.
 * Counts only: no names, no places.
 */

import type { FastifyPluginAsync } from "fastify";
import { requireAuth } from "../../auth/verify-jwt.js";
import { pool } from "../../db/pool.js";

const RUNNING_NOW = `
  SELECT count(DISTINCT r.user_id)::int AS running_now
  FROM   runs r
  WHERE  r.status IN ('active', 'paused')
    AND  r.started_at > now() - interval '6 hours'
    AND  (r.started_at > now() - interval '15 minutes'
          OR EXISTS (SELECT 1 FROM run_points p
                     WHERE p.run_id = r.id AND p.recorded_at > now() - interval '10 minutes'))
`;

// eslint-disable-next-line @typescript-eslint/require-await -- Fastify plugins are async by contract
export const liveRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/v1/live",
    {
      onRequest: [requireAuth],
      schema: {
        response: {
          200: {
            type: "object",
            required: ["running_now", "as_of"],
            properties: { running_now: { type: "integer" }, as_of: { type: "string" } },
          },
        },
      },
    },
    async () => {
      const { rows } = await pool.query<{ running_now: number }>(RUNNING_NOW);
      return { running_now: rows[0]?.running_now ?? 0, as_of: new Date().toISOString() };
    }
  );
};
