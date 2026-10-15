/**
 * requireAuth accepts user access tokens only: a token typed as anything other than "access"
 * (Exercise's service tokens are typ "service") is a 401 even with a UUID subject.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { SignJWT } from 'jose';
import { requireAuth, resetKeyCache } from './verify-jwt.js';

const SUB = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const SECRET = 'typ-test-secret-typ-test-secret-typ-test-secret';

async function call(claims: Record<string, unknown>) {
  const app = Fastify({ logger: false });
  app.get('/p', { onRequest: [requireAuth] }, async (req) => ({ userId: req.userId }));
  const token = await new SignJWT({ sub: SUB, exp: Math.floor(Date.now() / 1000) + 600, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .sign(new TextEncoder().encode(SECRET));
  const res = await app.inject({ method: 'GET', url: '/p', headers: { authorization: `Bearer ${token}` } });
  await app.close();
  return res.statusCode;
}

describe('requireAuth — token type', () => {
  beforeEach(() => {
    process.env['JWT_SECRET'] = SECRET;
    process.env['JWT_ALGORITHM'] = 'HS256';
    delete process.env['JWT_ISSUER'];
    delete process.env['JWT_AUDIENCE'];
    resetKeyCache();
  });

  it('accepts typ "access" and untyped tokens', async () => {
    expect(await call({ typ: 'access' })).toBe(200);
    expect(await call({})).toBe(200);
  });

  it('refuses a service token even when its sub is a UUID', async () => {
    expect(await call({ typ: 'service' })).toBe(401);
  });

  it('refuses any other typ', async () => {
    expect(await call({ typ: 'refresh' })).toBe(401);
  });
});
