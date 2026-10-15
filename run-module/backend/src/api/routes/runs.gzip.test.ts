/**
 * WI-03: gzip request bodies are capped after decompression, not just on the wire.
 * The parser runs before the auth preHandler, so most cases need no run row.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import crypto from 'crypto';
import zlib from 'zlib';
import Fastify from 'fastify';
import * as jose from 'jose';
import { pool } from '../../db/pool.js';
import runsRoutes from './runs.js';
import { JWT_SECRET, JWT_ALGORITHM } from '../../config/env.js';

const userId = crypto.randomUUID();
const runIds: string[] = [];

async function token() {
  return new jose.SignJWT({})
    .setProtectedHeader({ alg: JWT_ALGORITHM })
    .setSubject(userId)
    .setIssuer('run_module')
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

describe('gzip bodies are capped after decompression (WI-03)', () => {
  let fastify: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    fastify = Fastify();
    await fastify.register(runsRoutes);
  });

  afterAll(async () => {
    if (runIds.length === 0) return;
    await pool.query('DELETE FROM idempotency_keys WHERE run_id = ANY($1)', [runIds]);
    await pool.query('DELETE FROM run_point_flags WHERE run_id = ANY($1)', [runIds]);
    await pool.query('DELETE FROM run_batches WHERE run_id = ANY($1)', [runIds]);
    await pool.query('DELETE FROM run_points WHERE run_id = ANY($1)', [runIds]);
    await pool.query('DELETE FROM runs WHERE id = ANY($1)', [runIds]);
  });

  const post = async (url: string, payload: Buffer, encoding = 'gzip') => fastify.inject({
    method: 'POST',
    url,
    headers: { authorization: `Bearer ${await token()}`, 'content-encoding': encoding, 'content-type': 'application/json' },
    payload,
  });

  it('a small gzip body that inflates past the route bodyLimit (10 MB on /points) is refused with 413', async () => {
    // ~11 MB of JSON compresses to ~11 KB: far under bodyLimit on the wire.
    const bomb = zlib.gzipSync(JSON.stringify({ idempotency_key: 'bomb', points: [], pad: 'a'.repeat(11 * 1024 * 1024) }));
    expect(bomb.length).toBeLessThan(100 * 1024);
    const res = await post(`/v1/runs/${crypto.randomUUID()}/points`, bomb);
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body).error).toBe('Payload Too Large');
  });

  it('a route without its own bodyLimit caps the inflated body at the 1 MB default', async () => {
    const res = await post('/v1/runs', zlib.gzipSync(JSON.stringify({ pad: 'a'.repeat(2 * 1024 * 1024) })));
    expect(res.statusCode).toBe(413);
  });

  it('a full 1000-point gzipped batch is still accepted with 202', async () => {
    const created = await post('/v1/runs', zlib.gzipSync('{}'));
    expect(created.statusCode).toBe(201);
    const runId = JSON.parse(created.body).run_id as string;
    runIds.push(runId);
    const t0 = Date.now();
    const points = Array.from({ length: 1000 }, (_, seq) => ({
      seq, lat: 22.96 + seq * 1e-5, lng: 88.52, accuracy_m: 5, recorded_at: new Date(t0 + seq * 1000).toISOString(),
    }));
    const res = await post(`/v1/runs/${runId}/points`, zlib.gzipSync(JSON.stringify({ idempotency_key: 'full', points })));
    expect(res.statusCode).toBe(202);
    expect(JSON.parse(res.body).accepted).toBe(1000);
  });

  it('a body that is not gzip, or not JSON, is a 400 rather than a 500', async () => {
    expect((await post('/v1/runs', Buffer.from('not gzip at all'))).statusCode).toBe(400);
    expect((await post('/v1/runs', zlib.gzipSync('{not json'))).statusCode).toBe(400);
    expect((await post('/v1/runs', Buffer.from('{not json'), 'identity')).statusCode).toBe(400);
  });

  it('an unauthenticated gzip body is refused with 401 before it is inflated', async () => {
    const bomb = zlib.gzipSync(JSON.stringify({ pad: 'a'.repeat(11 * 1024 * 1024) }));
    const res = await fastify.inject({
      method: 'POST',
      url: `/v1/runs/${crypto.randomUUID()}/points`,
      headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' },
      payload: bomb,
    });
    expect(res.statusCode).toBe(401);
  });

  it('an empty Content-Encoding header is treated as none', async () => {
    expect((await post('/v1/runs', Buffer.from('{}'), '')).statusCode).toBe(201);
  });

  it('an unsupported Content-Encoding is a 415, never parsed as plain JSON', async () => {
    expect((await post('/v1/runs', zlib.deflateSync('{}'), 'deflate')).statusCode).toBe(415);
  });
});
