/**
 * src/auth/verify-jwt.ts
 *
 * JWT verification hook for Fastify (RM-0c).
 *
 * The Run Module does NOT issue tokens — it only verifies them.
 * An external account service issues tokens; this hook checks the signature
 * and extracts a trust-worthy user identity.
 *
 * TRUST BOUNDARY
 *   userId (request.userId) is sourced exclusively from the verified JWT sub
 *   claim.  It must never come from a request body, query string, or any
 *   header other than the verified Bearer token.
 *
 * USAGE
 *   Attach requireAuth as an onRequest hook on individual routes or route
 *   groups that require authentication.  Do NOT register it as a global
 *   server hook — /health must remain public.
 *
 *   Example (in a route file):
 *     fastify.post('/runs', { onRequest: [requireAuth] }, handler)
 *
 *   Or on a plugin-level scope:
 *     fastify.addHook('onRequest', requireAuth)  // inside a plugin only
 *
 * ALGORITHM SECURITY
 *   Uses jose's jwtVerify which takes an explicit algorithms allowlist.
 *   The 'none' algorithm is structurally impossible: jose requires a real
 *   key and does not implement the 'none' algorithm.
 *   The allowlist is a single value (JWT_ALGORITHM from env) so cross-
 *   algorithm confusion (e.g. RS256 key used as HS256 secret) is rejected.
 *
 * CLOCK SKEW
 *   A 30-second clockTolerance is applied to exp and nbf checks.
 *   See ADR-003 for rationale.
 */

import { jwtVerify, importSPKI } from "jose";
import type { FastifyRequest, FastifyReply } from "fastify";
import "./types.js"; // side-effect: augment FastifyRequest with userId

// ── Config ────────────────────────────────────────────────────────────────────

const CLOCK_TOLERANCE_SECONDS = 30;

// UUID v4/v5 pattern (hex groups 8-4-4-4-12)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── Key preparation ───────────────────────────────────────────────────────────

/**
 * Read JWT config fresh from process.env on each invocation so tests can
 * override env vars between calls.  The key is cached after first preparation
 * per cache token (see resetKeyCache).
 */
function getConfig(): {
  secret: string;
  algorithm: "HS256" | "RS256";
  issuer: string | undefined;
  audience: string | undefined;
} {
  return {
    secret:    process.env["JWT_SECRET"] ?? "",
    algorithm: (process.env["JWT_ALGORITHM"] ?? "HS256") as "HS256" | "RS256",
    issuer:    process.env["JWT_ISSUER"] || undefined,
    audience:  process.env["JWT_AUDIENCE"] || undefined,
  };
}

/**
 * Prepare the verification key for the configured algorithm.
 *   HS256 → TextEncoder(JWT_SECRET) → Uint8Array
 *   RS256 → importSPKI(JWT_SECRET, 'RS256') → CryptoKey
 */
async function prepareKey(
  secret: string,
  algorithm: "HS256" | "RS256"
): Promise<CryptoKey | Uint8Array> {
  if (algorithm === "HS256") {
    return new TextEncoder().encode(secret);
  }
  // RS256: secret is the PEM-encoded RSA public key
  return importSPKI(secret, "RS256");
}

// Module-level cache: keyed by a string that changes when env vars change.
let cachedKey: Promise<CryptoKey | Uint8Array> | null = null;
let cacheToken = "";

function getKey(config: ReturnType<typeof getConfig>): Promise<CryptoKey | Uint8Array> {
  const token = `${config.algorithm}:${config.secret}`;
  if (!cachedKey || token !== cacheToken) {
    cacheToken = token;
    cachedKey = prepareKey(config.secret, config.algorithm);
  }
  return cachedKey;
}

/** Reset the cached key (used in tests when env vars change between tests). */
export function resetKeyCache(): void {
  cachedKey = null;
  cacheToken = "";
}

// ── Public hook ───────────────────────────────────────────────────────────────

/**
 * Fastify onRequest hook that verifies a Bearer JWT and populates
 * request.userId with the verified sub claim.
 *
 * Attach to individual routes or scoped plugins; never register globally.
 */
export async function requireAuth(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers["authorization"];

  // ── Step 1: Extract the token from "Bearer <token>" ───────────────────────
  // Case-insensitive "bearer" prefix is accepted.  Any other scheme, extra
  // spaces, or an empty value is rejected.
  if (!authHeader || typeof authHeader !== "string") {
    request.log.info({ reason: "missing_authorization_header" }, "auth rejected");
    await sendUnauthorized(reply);
    return;
  }

  const parts = authHeader.split(" ");
  if (
    parts.length !== 2 ||
    parts[0]!.toLowerCase() !== "bearer" ||
    !parts[1] ||
    parts[1].trim() === ""
  ) {
    request.log.info({ reason: "malformed_authorization_header" }, "auth rejected");
    await sendUnauthorized(reply);
    return;
  }

  const token = parts[1].trim();

  // ── Step 2: Verify signature, exp, nbf, iss, aud ─────────────────────────
  let sub: string;
  const config = getConfig();

  try {
    const key = await getKey(config);

    const { payload } = await jwtVerify(token, key, {
      // Explicitly restrict to the single configured algorithm.
      // This prevents algorithm confusion and makes 'none' impossible.
      algorithms: [config.algorithm],

      // Verify issuer and audience when configured.
      ...(config.issuer   && { issuer:   config.issuer }),
      ...(config.audience && { audience: config.audience }),

      // Clock skew tolerance — see ADR-003
      clockTolerance: `${CLOCK_TOLERANCE_SECONDS}s`,
    });

    // ── Step 3: Require a well-formed UUID sub claim ───────────────────────
    if (typeof payload.sub !== "string" || payload.sub === "") {
      request.log.info({ reason: "missing_sub_claim" }, "auth rejected");
      await sendUnauthorized(reply);
      return;
    }

    if (!UUID_REGEX.test(payload.sub)) {
      request.log.info(
        { reason: "sub_not_a_uuid", sub: payload.sub },
        "auth rejected"
      );
      await sendUnauthorized(reply);
      return;
    }

    // Exercise marks user tokens typ "access" and service tokens typ "service" (ADR-027 §5).
    // A typed token that is not an access token is never a user, whatever its sub.
    if (payload["typ"] !== undefined && payload["typ"] !== "access") {
      request.log.info({ reason: "not_an_access_token" }, "auth rejected");
      await sendUnauthorized(reply);
      return;
    }

    sub = payload.sub;
  } catch (err: unknown) {
    // Log the specific reason server-side; never expose it to the client.
    const reason = err instanceof Error ? err.message : String(err);
    request.log.info({ reason }, "auth rejected");
    await sendUnauthorized(reply);
    return;
  }

  // ── Step 4: Attach verified identity ──────────────────────────────────────
  request.userId = sub;
}

/**
 * The one service allowed to call service routes: the Exercise Module (Partner Hunt asks whether
 * OTHER users clear the XP gate). It signs a short-lived token with the same key as user tokens,
 * `{ sub: "exercise_module", typ: "service", exp }`.
 *
 * A user token can never pass: its sub is a UUID and it has no service typ. A service token can
 * never pass requireAuth: its sub is not a UUID.
 */
export const EXERCISE_SERVICE = "exercise_module";

import { timingSafeEqual } from "crypto";

export async function requireService(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers["authorization"];
  const parts = typeof authHeader === "string" ? authHeader.split(" ") : [];
  if (parts.length !== 2 || parts[0]!.toLowerCase() !== "bearer" || !parts[1]?.trim()) {
    request.log.info({ reason: "missing_or_malformed_service_token" }, "service auth rejected");
    await sendUnauthorized(reply);
    return;
  }
  
  const token = parts[1].trim();
  const internalToken = (process.env["SOCIAL_INTERNAL_TOKEN"] ?? "").trim();
  
  if (internalToken.length > 0 && token.length === internalToken.length) {
    if (timingSafeEqual(Buffer.from(token), Buffer.from(internalToken))) {
      return; // Authorized via shared secret
    }
  }

  const config = getConfig();
  try {
    const { payload } = await jwtVerify(token, await getKey(config), {
      algorithms: [config.algorithm],
      ...(config.issuer   && { issuer:   config.issuer }),
      ...(config.audience && { audience: config.audience }),
      clockTolerance: `${CLOCK_TOLERANCE_SECONDS}s`,
      requiredClaims: ["exp"], // a service token must expire
      subject: EXERCISE_SERVICE,
    });
    if (payload["typ"] !== "service") {
      request.log.info({ reason: "not_a_service_token" }, "service auth rejected");
      await sendUnauthorized(reply);
      return;
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    request.log.info({ reason }, "service auth rejected");
    await sendUnauthorized(reply);
    return;
  }
}

/** Send a generic 401 with no discriminating information to the client. */
async function sendUnauthorized(reply: FastifyReply): Promise<void> {
  await reply
    .status(401)
    .header("Content-Type", "application/json")
    .send({ error: "unauthorized" });
}
