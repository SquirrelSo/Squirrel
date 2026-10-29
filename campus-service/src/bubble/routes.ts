/**
 * Bubble — an ephemeral proximity layer.
 *
 *   POST /v1/bubble/join   { lat, lng, accuracy_m?, activity_type? }   requires Open to Meet; 6/min
 *   POST /v1/bubble/leave
 *   GET  /v1/bubble                                                  the caller's own state only
 *   GET  /v1/bubble/nearby?state=&limit=&cursor=                     members in the 3×3 cell neighbourhood
 *
 * Coordinates are used once, to find the grid cell and the containing zone, then discarded. No response
 * carries coordinates or distances; proximity is a coarse bucket.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, currentUser } from '../auth/plugin.js';
import { errors } from '../lib/errors.js';
import { config } from '../config.js';
import { haversineM } from '../activities/gps.js';
import { CursorQuery, LimitQuery, paginate } from '../lib/pagination.js';
import { BUBBLE_STATES, bubbleView, joinBubble, leaveBubble, myBubbleState, openNow, proximityKey } from './service.js';

const JoinBody = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy_m: z.number().min(0).max(5000).nullable().optional(),
  activity_type: z.enum(['run', 'walk', 'workout']).nullable().optional(),
}).strict();

const NearbyQuery = z.object({
  state: z.enum(BUBBLE_STATES).optional(),
  limit: LimitQuery.default(20),
  cursor: CursorQuery.optional(),
}).strict();

export async function bubbleRoutes(app: FastifyInstance) {
  app.post('/v1/bubble/join', { preHandler: requireAuth, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req) => {
    const user = currentUser(req);
    const b = JoinBody.parse(req.body ?? {});
    if (!(await openNow(user.id))) throw errors.conflict('open_to_meet_required', 'Turn on Open to Meet to join the bubble.');
    if (haversineM(config.campus.centerLat, config.campus.centerLng, b.lat, b.lng) > config.campus.maxRadiusM) {
      await leaveBubble(user.id); // off campus: no longer near anyone here
      return { accepted: false, reason: 'off_campus', ...(await myBubbleState(user.id)) };
    }
    await joinBubble(user.id, { lat: b.lat, lng: b.lng, activity_type: b.activity_type });
    return { accepted: true, reason: null, ...(await myBubbleState(user.id)) };
  });

  app.post('/v1/bubble/leave', { preHandler: requireAuth }, async (req, reply) => {
    const user = currentUser(req);
    z.object({}).strict().parse(req.body ?? {});
    await leaveBubble(user.id);
    return reply.code(204).send();
  });

  app.get('/v1/bubble', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    z.object({}).strict().parse(req.query ?? {}); // no way to name another user
    return myBubbleState(user.id);
  });

  app.get('/v1/bubble/nearby', { preHandler: requireAuth }, async (req) => {
    const user = currentUser(req);
    const q = NearbyQuery.parse(req.query ?? {});
    const v = await bubbleView(user.id);
    const items = q.state ? v.items.filter((i) => i.states.includes(q.state!)) : v.items;
    const page = paginate(items, proximityKey, Math.min(q.limit, 20), q.cursor);
    return { items: page.items, next_cursor: page.next_cursor, in_bubble: !!v.me, hidden_reason: v.hidden_reason, as_of: new Date().toISOString() };
  });
}
