import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { rateLimitPlugin, rateLimitRedis } from './rate-limit.js';
import runsRoutes from './routes/runs.js';
import { createTestToken } from '../auth/test-token.js';
import crypto from 'crypto';

describe('Rate Limiting', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fastify = Fastify();
    await fastify.register(rateLimitPlugin);
    await fastify.register(runsRoutes);
  });

  afterEach(async () => {
    await fastify.close();
  });

  async function createRun(token: string): Promise<string> {
    const response = await fastify.inject({ method: 'POST', url: '/v1/runs', headers: { authorization: `Bearer ${token}` }, payload: {} });
    return JSON.parse(response.body).run_id;
  }

  async function upload(token: string, runId: string, key: string) {
    return fastify.inject({
      method: 'POST',
      url: `/v1/runs/${runId}/points`,
      headers: { authorization: `Bearer ${token}` },
      payload: { idempotency_key: key, points: [] },
    });
  }

  it('R1: Under the limit, requests succeed normally (existing behaviour)', async () => {
    const token = await createTestToken(crypto.randomUUID());
    const runId = await createRun(token);
    const response = await upload(token, runId, 'r1');
    expect(response.statusCode).toBe(202);
    expect(JSON.parse(response.body)).toEqual({ accepted: 0, duplicates_ignored: 0 });
  });

  it('R2 & R3: Exceeding POINTS_PER_MIN returns generic 429 with Retry-After and no leak', async () => {
    const token = await createTestToken(crypto.randomUUID());
    const runId = await createRun(token);
    let response: Awaited<ReturnType<typeof upload>> | undefined;
    for (let i = 0; i < 62; i++) response = await upload(token, runId, `r2-${i}`);
    expect(response!.statusCode).toBe(429);
    expect(response!.headers['retry-after']).toBeDefined();
    expect(response!.headers['x-ratelimit-limit']).toBeUndefined();
    expect(response!.headers['x-ratelimit-remaining']).toBeUndefined();
    expect(response!.headers['x-ratelimit-reset']).toBeUndefined();
    expect(JSON.parse(response!.body)).toEqual({
      statusCode: 429,
      error: 'Too Many Requests',
      message: 'Rate limit exceeded',
    });
  });

  it('R4: Limits are PER USER: user A exhausting their limit does not affect user B', async () => {
    const tokenA = await createTestToken(crypto.randomUUID());
    const tokenB = await createTestToken(crypto.randomUUID());
    const runA = await createRun(tokenA);
    for (let i = 0; i < 61; i++) await upload(tokenA, runA, `r4-${i}`);
    const runB = await createRun(tokenB);
    expect((await upload(tokenB, runB, 'r4-b')).statusCode).toBe(202);
  });

  it('R5: A realistic run does NOT trip the limit: simulate 27 batches of 200 points', async () => {
    const token = await createTestToken(crypto.randomUUID());
    const runId = await createRun(token);
    for (let i = 0; i < 27; i++) expect((await upload(token, runId, `r5-${i}`)).statusCode).toBe(202);
  });

  it('R6: With Redis unavailable, requests are ALLOWED and a warning is logged', async () => {
    const token = await createTestToken(crypto.randomUUID());
    const runId = await createRun(token);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const command = vi.spyOn(rateLimitRedis as any, 'rateLimit').mockImplementation((...args: any[]) => {
      const callback = args[args.length - 1];
      callback(new Error('Redis is down'));
      return rateLimitRedis;
    });
    rateLimitRedis.emit('error', new Error('Redis is down'));
    try {
      expect((await upload(token, runId, 'r6-outage')).statusCode).toBe(202);
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('Redis error; requests will fail open:'), 'Redis is down');
    } finally {
      command.mockRestore();
      warning.mockRestore();
    }
  });

  it('R7: GET routes are not limited: hammer GET /v1/runs/:id and assert no 429', async () => {
    const token = await createTestToken(crypto.randomUUID());
    const runId = await createRun(token);
    for (let i = 0; i < 65; i++) {
      const response = await fastify.inject({ method: 'GET', url: `/v1/runs/${runId}`, headers: { authorization: `Bearer ${token}` } });
      expect(response.statusCode).not.toBe(429);
    }
  });
});
