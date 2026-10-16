/**
 * src/api/server.ts
 *
 * Fastify server bootstrap.
 * Registers routes and starts listening on the configured PORT.
 * Application logic begins at RM-1.5 / RM-2.1 — this file is
 * intentionally minimal.
 *
 * AUTHENTICATION PATTERN (RM-0c)
 *   requireAuth is an OPT-IN per-route hook — it is NOT registered globally
 *   so that /health (and any future public endpoints) remain unauthenticated.
 *
 *   Attach it to individual routes:
 *     fastify.post('/runs', { onRequest: [requireAuth] }, handler)
 *
 *   Or to a scoped plugin (all routes inside the plugin become protected):
 *     async function protectedRoutes(fastify: FastifyInstance) {
 *       fastify.addHook('onRequest', requireAuth);
 *       fastify.post('/runs', handler);
 *     }
 *      *
 *   In both cases, request.userId is the verified UUID sub claim from the JWT.
 *   Never read a userId from a request body, query string, or any other header.
 */

import Fastify from "fastify";
import { PORT, LOG_LEVEL, NODE_ENV } from "../config/env.js";
import { healthRoutes } from "./routes/health.js";
// requireAuth is imported here for TypeScript module augmentation (types.ts
// side-effect) and to surface it in one canonical location for route authors.
// It is not registered globally.
import runsRoutes from './routes/runs.js';
import { territoriesRoutes } from './routes/territories.js';
import tilesRoutes from './routes/tiles.js';
import { leaderboardRoutes } from './routes/leaderboard.js';
import { xpRoutes } from './routes/xp.js';
import { progressRoutes } from './routes/progress.js';
import { liveRoutes } from './routes/live.js';
import { challengesRoutes } from './routes/challenges.js';
import { rateLimitPlugin } from './rate-limit.js';
import { registerCors } from './cors.js';
export { requireAuth } from "../auth/verify-jwt.js";

const fastify = Fastify({
  logger: {
    level: LOG_LEVEL,
    ...(NODE_ENV === "development" && {
      transport: {
        target: "pino-pretty",
        options: { translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
      },
    }),
  },
});


await registerCors(fastify, process.env["CORS_ALLOWED_ORIGINS"]);
await fastify.register(rateLimitPlugin);
await fastify.register(healthRoutes);
await fastify.register(runsRoutes);
await fastify.register(territoriesRoutes, { prefix: '/v1/territories' });
await fastify.register(tilesRoutes);
await fastify.register(leaderboardRoutes, { prefix: '/v1/leaderboard' });
await fastify.register(xpRoutes);
await fastify.register(progressRoutes);
await fastify.register(liveRoutes);
await fastify.register(challengesRoutes, { prefix: '/v1/challenges' });

const start = async (): Promise<void> => {
  try {
    await fastify.listen({ port: PORT, host: "0.0.0.0" });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

await start();

// Hosts without background workers (Render's free plan): RUN_WORKERS_IN_API=1 runs every worker and
// scheduled job in this process instead of src/workers/start.ts. They close with the server.
if (process.env["RUN_WORKERS_IN_API"] === "1") {
  const { startAllWorkers } = await import("../workers/all.js");
  const workers = await startAllWorkers();
  fastify.log.info(`Running ${workers.length} background workers in the API process`);
  const stop = async (): Promise<void> => {
    await Promise.all(workers.map((w) => w.close()));
    await fastify.close();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
}

