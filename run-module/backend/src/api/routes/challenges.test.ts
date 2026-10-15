import { test, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type LightMyRequestResponse } from 'fastify';
import { challengesRoutes } from './challenges.js';
import * as jose from 'jose';
import crypto from 'node:crypto';
import { createTestToken } from "../../auth/test-token.js";
import { requireAuth } from '../../auth/verify-jwt.js';

const TEST_USER = crypto.randomUUID();

const fastify = Fastify();
fastify.decorateRequest('userId', null);

fastify.register(async (app) => {
  app.addHook('onRequest', requireAuth);
  app.register(challengesRoutes, { prefix: '/v1/challenges' });
});

let validToken = '';

beforeAll(async () => {
  validToken = await createTestToken(TEST_USER);
});

afterAll(async () => {
  await fastify.close();
});

test('H11: No token 401 on every route', async () => {
  const routes = [
    { method: 'GET', url: '/v1/challenges/mine' },
    { method: 'POST', url: '/v1/challenges' },
    { method: 'GET', url: '/v1/challenges/some-id' },
    { method: 'POST', url: '/v1/challenges/some-id/accept' },
    { method: 'POST', url: '/v1/challenges/some-id/decline' },
    { method: 'POST', url: '/v1/challenges/some-id/join' },
    { method: 'POST', url: '/v1/challenges/some-id/invite' }
  ];

  for (const route of routes) {
    const response = await fastify.inject(route as any);
    expect(response.statusCode).toBe(401);
  }
});

test('H10: Isolation - cannot GET challenge not part of, nor accept/join', async () => {
  const id = crypto.randomUUID();
  
  // Note: Since these routes check participation (and throw Forbidden), 
  // they correctly deny access to an unrelated user even if the challenge exists/doesn't exist.
  // Wait, if it doesn't exist, they might throw 404/500, but they should throw 403 on participation check!
  
  const getRes = await fastify.inject({
    method: 'GET',
    url: '/v1/challenges/' + id,
    headers: { Authorization: "Bearer " + validToken }
  });
  expect(getRes.statusCode).toBe(403);

  const acceptRes = await fastify.inject({
    method: 'POST',
    url: '/v1/challenges/' + id + '/accept',
    headers: { Authorization: "Bearer " + validToken }
  });
  expect(acceptRes.statusCode).toBe(403);

  const joinRes = await fastify.inject({
    method: 'POST',
    url: '/v1/challenges/' + id + '/join',
    headers: { Authorization: "Bearer " + validToken }
  });
  expect(joinRes.statusCode).toBe(403);
});

test('POST /v1/challenges validation - rejects unknown metric', async () => {
  const payload = {
    type: 'daily',
    title: 'Test',
    metric: 'steps', // invalid
    comparator: 'gte',
    threshold: 1000,
    starts_at: '2025-01-01T00:00:00Z',
    ends_at: '2025-01-02T00:00:00Z',
    xp_reward: 100
  };

  const res = await fastify.inject({
    method: 'POST',
    url: '/v1/challenges',
    headers: { Authorization: "Bearer " + validToken },
    payload
  });
  
  expect(res.statusCode).toBe(400);
  expect(res.json().error).toContain('Invalid metric');
  expect(res.json().error).toContain('distance_m');
});

test('POST /v1/challenges validation - accepts allowed metrics', async () => {
  const metrics = ['distance_m', 'duration_s', 'runs_completed', 'territory_area_m2', 'territories_captured'];
  
  for (const metric of metrics) {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/challenges',
      headers: { Authorization: "Bearer " + validToken },
      payload: {
        type: 'daily',
        title: `Test ${metric}`,
        metric,
        comparator: 'gte',
        threshold: 10,
        starts_at: '2025-01-01T00:00:00Z',
        ends_at: '2025-01-02T00:00:00Z',
        xp_reward: 50
      }
    });
    expect(res.statusCode).toBe(201);
  }
});

test('POST /v1/challenges validation - rejects unvalidated fields', async () => {
  const base = {
    type: 'daily', title: 'Test', metric: 'distance_m', comparator: 'gte', threshold: 10,
    starts_at: '2025-01-01T00:00:00Z', ends_at: '2025-01-02T00:00:00Z', xp_reward: 50
  };

  const cases = [
    { mod: { type: 'weekly' }, err: 'Invalid type' },
    { mod: { comparator: 'eq' }, err: 'Invalid comparator' },
    { mod: { threshold: '10' }, err: 'valid number' },
    { mod: { xp_reward: -5 }, err: 'positive integer' },
    { mod: { title: '   ' }, err: 'non-empty string' },
    { mod: { starts_at: 'not-a-date' }, err: 'valid date string' },
    { mod: { ends_at: '2024-01-01T00:00:00Z' }, err: 'ends_at must be after starts_at' },
  ];

  for (const { mod, err } of cases) {
    const res = await fastify.inject({
      method: 'POST',
      url: '/v1/challenges',
      headers: { Authorization: "Bearer " + validToken },
      payload: { ...base, ...mod }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain(err);
  }
});
test('POST /v1/challenges caps xp_reward at 200 (ADR-033)', async () => {
  const base = {
    type: 'daily', title: 'Reward cap', metric: 'distance_m', comparator: 'gte', threshold: 10,
    starts_at: '2025-01-01T00:00:00Z', ends_at: '2025-01-02T00:00:00Z'
  };
  const post = (xp_reward: number): Promise<LightMyRequestResponse> => fastify.inject({
    method: 'POST', url: '/v1/challenges', headers: { Authorization: "Bearer " + validToken }, payload: { ...base, xp_reward }
  });
  for (const tooMuch of [201, 1000, 1_000_000_000]) {
    const res = await post(tooMuch);
    expect(res.statusCode).toBe(422);
    expect(res.json<{ error: string }>().error).toContain('at most 200');
  }
  expect((await post(200)).statusCode).toBe(201);
});

test('POST /v1/challenges/:id/invite requires invitee_id to be a UUID', async () => {
  const create = await fastify.inject({
    method: 'POST', url: '/v1/challenges', headers: { Authorization: "Bearer " + validToken },
    payload: { type: 'head_to_head', title: 'Invite check', metric: 'distance_m', comparator: 'gte', threshold: 10,
      starts_at: '2025-01-01T00:00:00Z', ends_at: '2025-01-02T00:00:00Z', xp_reward: 10 }
  });
  const id = create.json<{ id: string }>().id;
  for (const payload of [{ invitee_id: 'not-a-uuid' }, { invitee_id: 42 }, {}, { invitee_id: "'; DROP TABLE challenges; --" }]) {
    const res = await fastify.inject({
      method: 'POST', url: `/v1/challenges/${id}/invite`, headers: { Authorization: "Bearer " + validToken }, payload
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invitee_id must be a UUID');
  }
  const ok = await fastify.inject({
    method: 'POST', url: `/v1/challenges/${id}/invite`, headers: { Authorization: "Bearer " + validToken },
    payload: { invitee_id: crypto.randomUUID() }
  });
  expect(ok.statusCode).toBe(200);
});
