/**
 * Bearer-token verification. Production: RS256 via JWKS (AUTH_JWKS_URL) or a PEM public key —
 * the same tokens the Run Module accepts, user id = `sub`. Development only: HS256 with
 * AUTH_DEV_HS256_SECRET so `npm run dev:token` can mint local tokens. Never enabled in production.
 *
 * The key set is fetched at start-up (warmKeys) and kept 12 h; a token with a key id not in the set
 * triggers a refetch, so a new key is picked up at once. When the key set can't be fetched (the
 * Exercise backend asleep or down) verification throws AuthUnavailableError — a 503 "try again",
 * never a 401, which would make the app drop a perfectly good session.
 */
import { createRemoteJWKSet, errors as joseErrors, importSPKI, jwtVerify, type JWTPayload, type KeyLike } from 'jose';
import { config } from '../config.js';

export type Principal = { userId: string; claims: JWTPayload };

/** The key source could not be reached (503 auth_unreachable — not a code ending in "unavailable", which the app reads as "feature not live"); the token itself was never judged. */
export class AuthUnavailableError extends Error {
  constructor(cause: unknown) {
    super('token keys unavailable', { cause });
    this.name = 'AuthUnavailableError';
  }
}

const KEYSET_MAX_AGE_MS = 12 * 60 * 60 * 1000;

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let pemKey: KeyLike | null = null;

function remoteKeys() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(config.auth.jwksUrl), { timeoutDuration: config.auth.jwksTimeoutMs, cacheMaxAge: KEYSET_MAX_AGE_MS });
  }
  return jwks;
}

async function keyResolver() {
  if (config.auth.jwksUrl) return remoteKeys();
  if (config.auth.publicKeyPem) {
    if (!pemKey) pemKey = await importSPKI(config.auth.publicKeyPem.replace(/\\n/g, '\n'), 'RS256');
    return pemKey;
  }
  return null;
}

/** Fetch the key set in the background at start-up, so the first sign-in doesn't wait for it. */
export function warmKeys(log: { info: (m: string) => void; warn: (o: object, m: string) => void }): void {
  if (!config.auth.jwksUrl) return;
  remoteKeys()
    .reload()
    .then(() => log.info('auth: key set loaded from AUTH_JWKS_URL'))
    .catch((err) => log.warn({ err: String(err) }, 'auth: key set not reachable yet (AUTH_JWKS_URL); will retry on the first sign-in'));
}

/**
 * True when a jwtVerify failure came from fetching the remote key set, not from the token: a timeout,
 * a non-200 or malformed key set, or a network error (anything that isn't a JOSE error).
 */
export function isKeySourceFailure(e: unknown, usingRemoteKeys: boolean): boolean {
  if (!usingRemoteKeys) return false;
  if (e instanceof joseErrors.JWKSTimeout || e instanceof joseErrors.JWKSInvalid) return true;
  if (e instanceof joseErrors.JOSEError) return e.code === 'ERR_JOSE_GENERIC' && /JSON Web Key Set/.test(e.message);
  return true;
}

export function authConfigured(): boolean {
  return !!(config.auth.jwksUrl || config.auth.publicKeyPem || (!config.isProd && config.auth.devHs256Secret));
}

export async function verifyBearer(token: string): Promise<Principal> {
  const opts = { issuer: config.auth.issuer, audience: config.auth.audience, clockTolerance: 30 };
  const key = await keyResolver();
  if (key) {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, key as Parameters<typeof jwtVerify>[1], { ...opts, algorithms: ['RS256', 'RS384', 'RS512', 'ES256'] }));
    } catch (e) {
      if (isKeySourceFailure(e, !!config.auth.jwksUrl)) throw new AuthUnavailableError(e);
      throw e;
    }
    return toPrincipal(payload);
  }
  if (!config.isProd && config.auth.devHs256Secret) {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(config.auth.devHs256Secret), { ...opts, algorithms: ['HS256'] });
    return toPrincipal(payload);
  }
  throw new Error('auth not configured: set AUTH_JWKS_URL or AUTH_PUBLIC_KEY_PEM');
}

function toPrincipal(payload: JWTPayload): Principal {
  if (typeof payload.sub !== 'string' || !payload.sub) throw new Error('token has no sub');
  // Exercise's service tokens (typ "service", sub "exercise_module") are never a user.
  if (payload.typ !== undefined && payload.typ !== 'access') throw new Error('not an access token');
  return { userId: payload.sub, claims: payload };
}
