import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AuthUnavailableError, verifyBearer, type Principal } from './jwt.js';
import { ApiError, errors } from '../lib/errors.js';
import { ensureUser, type UserRow } from '../users/repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
    user: UserRow | null;
  }
}

/** Decorates every request with `principal` (from the bearer token) and a JIT-provisioned `user`. */
export const authPlugin = fp(async (app: FastifyInstance) => {
  app.decorateRequest('principal', null);
  app.decorateRequest('user', null);
  app.addHook('onRequest', async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return;
    const token = h.slice(7).trim();
    if (!token) return;
    try {
      req.principal = await verifyBearer(token);
    } catch (e) {
      if (e instanceof AuthUnavailableError) {
        // Not the token's fault: the key set (AUTH_JWKS_URL) is unreachable. 503 keeps the app signed in.
        req.log.warn({ err: String(e.cause) }, 'auth: key set unreachable');
        throw new ApiError(503, 'auth_unreachable', 'Sign-in can’t be checked right now. Try again in a moment.', { retry_after_s: 30 });
      }
      req.log.debug({ err: e }, 'bearer rejected');
      throw errors.unauthorized('Your session is invalid or expired. Sign in again.');
    }
    req.user = await ensureUser(req.principal.userId, req.principal.claims);
    if (req.user.is_banned) throw errors.forbidden('This account is suspended.');
  });
});

/** Route preHandler: require a signed-in user. */
export async function requireAuth(req: FastifyRequest) {
  if (!req.user) throw errors.unauthorized();
}

export function currentUser(req: FastifyRequest): UserRow {
  if (!req.user) throw errors.unauthorized();
  return req.user;
}
