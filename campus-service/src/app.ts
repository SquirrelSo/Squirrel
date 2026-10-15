import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import { config } from './config.js';
import { ApiError } from './lib/errors.js';
import { authPlugin } from './auth/plugin.js';
import { registerRealtime } from './realtime/ws.js';
import { userRoutes } from './users/routes.js';
import { zoneRoutes } from './zones/routes.js';
import { activityRoutes } from './activities/routes.js';
import { presenceRoutes } from './presence/routes.js';
import { challengeRoutes } from './challenges/routes.js';
import { leaderboardRoutes } from './leaderboards/routes.js';
import { statsRoutes } from './stats/routes.js';
import { blockRoutes } from './blocks/routes.js';
import { meetupRoutes } from './meetups/routes.js';
import { sharedZoneRoutes } from './shared-zones/routes.js';
import { heatmapRoutes } from './heatmap/routes.js';
import { squirrelDateRoutes } from './shared-zones/date-suggestions.js';
import { bubbleRoutes } from './bubble/routes.js';
import { discoverRoutes } from './discover/routes.js';
import { getPool } from './db/pool.js';
import { registerInboundIdentity } from './identity/inbound.js';
import { translateOutbound } from './identity/translate.js';
import { corsOrigins } from './lib/cors.js';

export async function buildApp(opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? { level: config.logLevel },
    bodyLimit: 2 * 1024 * 1024, // 2 MB: a 1000-point batch is ~120 KB
    trustProxy: true,
  });

  await app.register(cors, { origin: corsOrigins(config.corsOrigins) });
  await app.register(rateLimit, {
    global: true, max: 300, timeWindow: '1 minute',
    keyGenerator: (req) => (req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`),
    // The plugin throws what this returns: an ApiError carries its status (a plain object became a 500).
    errorResponseBuilder: (_req, ctx) => new ApiError(ctx.statusCode === 403 ? 403 : 429, 'rate_limited', `Too many requests. Retry in ${Math.ceil(ctx.ttl / 1000)} s.`),
  });
  await app.register(websocket);
  await app.register(authPlugin);
  // Identity bridge (no-ops while SOCIAL_API_URL / SOCIAL_INTERNAL_TOKEN are unset): client-sent profile ids →
  // subs before handlers run; subs → Social profile ids + Social names in every JSON response.
  registerInboundIdentity(app);
  app.addHook('preSerialization', async (_req, _reply, payload) => translateOutbound(payload));

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send(err.toJSON());
    if (err instanceof ZodError) return reply.code(422).send({ code: 'invalid', detail: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), issues: err.issues });
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    if (e.statusCode === 429) return reply.code(429).send({ code: 'rate_limited', detail: e.message ?? 'Too many requests' });
    if (e.statusCode === 413 || e.code === 'FST_ERR_CTP_BODY_TOO_LARGE') return reply.code(413).send({ code: 'payload_too_large', detail: 'Request body too large' });
    if (e.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || e.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' || (e.statusCode && e.statusCode < 500)) return reply.code(e.statusCode ?? 400).send({ code: 'bad_request', detail: e.message ?? 'Bad request' });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ code: 'internal_error', detail: 'Something went wrong' });
  });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ code: 'not_found', detail: 'Route not found' }));

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (_req, reply) => {
    try { await getPool().query('SELECT 1'); return { ok: true }; } catch { return reply.code(503).send({ ok: false }); }
  });

  registerRealtime(app);
  await app.register(userRoutes);
  await app.register(zoneRoutes);
  await app.register(activityRoutes);
  await app.register(presenceRoutes);
  await app.register(challengeRoutes);
  await app.register(blockRoutes);
  await app.register(meetupRoutes);
  await app.register(sharedZoneRoutes);
  await app.register(heatmapRoutes);
  await app.register(squirrelDateRoutes);
  await app.register(bubbleRoutes);
  await app.register(discoverRoutes);
  await app.register(leaderboardRoutes);
  await app.register(statsRoutes);
  return app;
}
