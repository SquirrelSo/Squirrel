import type { FastifyPluginAsync } from 'fastify';
import { requireAuth } from '../../auth/verify-jwt.js';
import { 
  createChallenge, 
  listMyChallenges, 
  getChallenge, 
  acceptInvite, 
  declineInvite, 
  joinGroupChallenge, 
  inviteUser 
} from '../../challenges/service.js';
import { ChallengeType, Comparator } from '../../challenges/types.js';
import { Metric } from '../../challenges/metrics.js';

import { MAX_CHALLENGE_XP_REWARD } from '../../xp/awards.js';
import { getRateLimitOptions, rateLimitPlugin } from '../rate-limit.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { RATE_LIMIT_WRITE_PER_MIN } from '../../config/env.js';

export const challengesRoutes: FastifyPluginAsync = async (fastify) => {
  if (!fastify.hasDecorator('rateLimit')) await fastify.register(rateLimitPlugin);
  fastify.addHook('onRequest', requireAuth);

  const writeLimit = {
    preHandler: [fastify.rateLimit(getRateLimitOptions(RATE_LIMIT_WRITE_PER_MIN, '1 minute', 'write_min'))]
  };

  fastify.post('/', writeLimit, async (request, reply) => {
    const userId = request.userId;
    const body = request.body as any;

    if (!body || typeof body !== 'object') {
      return reply.code(400).send({ error: 'Body must be an object' });
    }

    const ALLOWED_METRICS = ['distance_m', 'duration_s', 'runs_completed', 'territory_area_m2', 'territories_captured'];
    if (!ALLOWED_METRICS.includes(body.metric)) {
      return reply.code(400).send({ error: `Invalid metric. Allowed values: ${ALLOWED_METRICS.join(', ')}` });
    }

    const ALLOWED_TYPES = ['daily', 'head_to_head', 'group'];
    if (!ALLOWED_TYPES.includes(body.type)) {
      return reply.code(400).send({ error: `Invalid type. Allowed values: ${ALLOWED_TYPES.join(', ')}` });
    }

    const ALLOWED_COMPARATORS = ['gte', 'lte'];
    if (!ALLOWED_COMPARATORS.includes(body.comparator)) {
      return reply.code(400).send({ error: `Invalid comparator. Allowed values: ${ALLOWED_COMPARATORS.join(', ')}` });
    }

    if (typeof body.threshold !== 'number' || !Number.isFinite(body.threshold)) {
      return reply.code(400).send({ error: 'threshold must be a valid number' });
    }

    const xpReward: unknown = body.xp_reward;
    if (typeof xpReward !== 'number' || !Number.isInteger(xpReward) || xpReward < 0) {
      return reply.code(400).send({ error: 'xp_reward must be a positive integer' });
    }
    // The creator chooses the reward, so it is bounded here (ADR-033); wins also count toward a
    // per-day cap on read.
    if (xpReward > MAX_CHALLENGE_XP_REWARD) {
      return reply.code(422).send({ error: `xp_reward must be at most ${MAX_CHALLENGE_XP_REWARD}` });
    }

    if (typeof body.title !== 'string' || body.title.trim() === '') {
      return reply.code(400).send({ error: 'title must be a non-empty string' });
    }

    const startsAt = new Date(body.starts_at);
    if (Number.isNaN(startsAt.getTime())) {
      return reply.code(400).send({ error: 'starts_at must be a valid date string' });
    }

    const endsAt = new Date(body.ends_at);
    if (Number.isNaN(endsAt.getTime())) {
      return reply.code(400).send({ error: 'ends_at must be a valid date string' });
    }

    if (endsAt <= startsAt) {
      return reply.code(400).send({ error: 'ends_at must be after starts_at' });
    }

    const ch = await createChallenge(
      userId,
      body.type as ChallengeType,
      body.title,
      body.metric as Metric,
      body.comparator as Comparator,
      body.threshold,
      startsAt,
      endsAt,
      xpReward
    );
    return reply.code(201).send(ch);
  });

  fastify.get('/mine', async (request, reply) => {
    const userId = request.userId;
    const chs = await listMyChallenges(userId);
    return reply.code(200).send(chs);
  });

  fastify.get('/:id', async (request, reply) => {
    const userId = request.userId;
    const { id } = request.params as { id: string };
    try {
      const detail = await getChallenge(id, userId);
      return reply.code(200).send(detail);
    } catch (err: any) {
      if (err.message === 'Forbidden') return reply.code(403).send({ error: 'Forbidden' });
      throw err;
    }
  });

  fastify.post('/:id/accept', writeLimit, async (request, reply) => {
    const userId = request.userId;
    const { id } = request.params as { id: string };
    try {
      await acceptInvite(id, userId);
      return reply.code(200).send({ ok: true });
    } catch (err: any) {
      if (err.message === 'Forbidden') return reply.code(403).send({ error: 'Forbidden' });
      throw err;
    }
  });

  fastify.post('/:id/decline', writeLimit, async (request, reply) => {
    const userId = request.userId;
    const { id } = request.params as { id: string };
    try {
      await declineInvite(id, userId);
      return reply.code(200).send({ ok: true });
    } catch (err: any) {
      if (err.message === 'Forbidden') return reply.code(403).send({ error: 'Forbidden' });
      throw err;
    }
  });

  fastify.post('/:id/join', writeLimit, async (request, reply) => {
    const userId = request.userId;
    const { id } = request.params as { id: string };
    try {
      await joinGroupChallenge(id, userId);
      return reply.code(200).send({ ok: true });
    } catch (err: any) {
      if (err.message === 'Not Found' || err.message === 'Forbidden') return reply.code(403).send({ error: 'Forbidden' });
      return reply.code(400).send({ error: err.message });
    }
  });

  fastify.post('/:id/invite', writeLimit, async (request, reply) => {
    const userId = request.userId;
    const { id } = request.params as { id: string };
    const { invitee_id } = (request.body ?? {}) as { invitee_id?: unknown };
    if (typeof invitee_id !== 'string' || !UUID_REGEX.test(invitee_id)) {
      return reply.code(400).send({ error: 'invitee_id must be a UUID' });
    }
    try {
      await inviteUser(id, userId, invitee_id);
      return reply.code(200).send({ ok: true });
    } catch (err: any) {
      if (err.message === 'Forbidden') return reply.code(403).send({ error: 'Forbidden' });
      throw err;
    }
  });
};
