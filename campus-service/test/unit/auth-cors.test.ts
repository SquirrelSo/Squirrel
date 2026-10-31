import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect } from 'vitest';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { isKeySourceFailure } from '../../src/auth/jwt.js';
import { corsOrigins } from '../../src/lib/cors.js';

const allowed = (list: (string | RegExp)[] | false, origin: string) =>
  list !== false && list.some((o) => (typeof o === 'string' ? o === origin : o.test(origin)));

describe('CORS_ORIGINS', () => {
  it('keeps exact origins and turns * into a same-domain pattern', () => {
    const list = corsOrigins(['https://squirrel-social.vercel.app/', ' https://squirrel-*.vercel.app ']);
    expect(allowed(list, 'https://squirrel-social.vercel.app')).toBe(true);
    expect(allowed(list, 'https://squirrel-git-feature-x.vercel.app')).toBe(true);
    expect(allowed(list, 'https://squirrel-a.b.vercel.app')).toBe(false); // * never crosses a dot
    expect(allowed(list, 'https://squirrel-x.vercel.app.evil.com')).toBe(false);
    expect(allowed(list, 'http://squirrel-x.vercel.app')).toBe(false);
  });
  it('is off (same-origin only) when empty', () => {
    expect(corsOrigins([])).toBe(false);
    expect(corsOrigins([' ', ''])).toBe(false);
  });
});

/** A token-shaped string: verification must reach the key set before judging it. */
const TOKEN = [{ alg: 'RS256', kid: 'k1' }, { sub: 'u' }].map((o) => Buffer.from(JSON.stringify(o)).toString('base64url')).join('.') + '.c2ln';

async function failureFrom(handler: http.RequestListener, timeoutDuration = 200): Promise<unknown> {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  try {
    await jwtVerify(TOKEN, createRemoteJWKSet(new URL(`http://127.0.0.1:${port}/jwks.json`), { timeoutDuration }));
    return null;
  } catch (e) {
    return e;
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

describe('key-set failures are "unavailable", not "bad token"', () => {
  it('a key set that does not answer in time (Exercise asleep)', async () => {
    const e = await failureFrom(() => undefined);
    expect(e).toBeInstanceOf(joseErrors.JWKSTimeout);
    expect(isKeySourceFailure(e, true)).toBe(true);
  });
  it('a key set answering 5xx, or not JSON', async () => {
    expect(isKeySourceFailure(await failureFrom((_q, s) => { s.statusCode = 502; s.end('bad gateway'); }), true)).toBe(true);
    expect(isKeySourceFailure(await failureFrom((_q, s) => { s.setHeader('content-type', 'application/json'); s.end('{"nope":1}'); }), true)).toBe(true);
  });
  it('a network error (nothing listening)', async () => {
    let e: unknown;
    try { await jwtVerify(TOKEN, createRemoteJWKSet(new URL('http://127.0.0.1:1/jwks.json'), { timeoutDuration: 500 })); } catch (err) { e = err; }
    expect(isKeySourceFailure(e, true)).toBe(true);
  });
  it('real token problems stay "bad token"', () => {
    expect(isKeySourceFailure(new joseErrors.JWTExpired('expired', {}), true)).toBe(false);
    expect(isKeySourceFailure(new joseErrors.JWSSignatureVerificationFailed(), true)).toBe(false);
    expect(isKeySourceFailure(new joseErrors.JWKSNoMatchingKey(), true)).toBe(false);
    expect(isKeySourceFailure(new joseErrors.JWSInvalid('bad'), true)).toBe(false);
  });
  it('never "unavailable" with a local PEM key', () => {
    expect(isKeySourceFailure(new Error('anything'), false)).toBe(false);
  });
});
