/**
 * src/auth/verify-jwt.test.ts
 *
 * Tests for requireAuth (RM-0c).
 *
 * All keys are generated at runtime — no key material is committed.
 *
 * Test strategy: spin up a minimal Fastify instance with:
 *   - GET /protected  — requires auth, returns 200 + { userId }
 *   - GET /public     — no auth, always 200 (mirrors /health)
 *
 * Each test overrides process.env JWT vars and calls resetKeyCache() so
 * the hook reads fresh config.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  SignJWT,
  exportSPKI,
  generateKeyPair,
} from "jose";
import { requireAuth, resetKeyCache } from "./verify-jwt.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_UUID = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
const NOT_A_UUID  = "definitely-not-a-uuid";

/** Create a minimal Fastify app wired with requireAuth on /protected. */
function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get("/public", async (_req, reply) => {
    return reply.status(200).send({ ok: true });
  });

  app.get(
    "/protected",
    { onRequest: [requireAuth] },
    async (req, reply) => {
      return reply.status(200).send({ userId: req.userId });
    }
  );

  return app;
}

/** Inject a GET /protected with an optional Authorization header. */
async function hitProtected(
  app: FastifyInstance,
  authorization?: string
): Promise<{ status: number; body: unknown }> {
  const response = await app.inject({
    method: "GET",
    url: "/protected",
    headers: authorization ? { authorization } : {},
  });
  return { status: response.statusCode, body: response.json() };
}

/** Generate a throwaway HS256 key (Uint8Array) for tests. */
function makeHsKey(): { key: Uint8Array; secret: string } {
  const secret = crypto.randomUUID() + crypto.randomUUID(); // 72 hex chars
  return { key: new TextEncoder().encode(secret), secret };
}

/** Sign a JWT with an explicit payload and key. */
async function sign(
  payload: Record<string, unknown>,
  secret: Uint8Array,
  alg: "HS256" | "RS256" = "HS256"
): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg })
    .sign(secret);
}

// ── Setup ─────────────────────────────────────────────────────────────────────

let app: FastifyInstance;

beforeEach(async () => {
  // Reset the cached key so tests start fresh with current env vars.
  resetKeyCache();
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ── AC11: /public (health-equivalent) always 200, no auth ────────────────────

describe("Public route — AC11", () => {
  it("returns 200 with no Authorization header", async () => {
    const response = await app.inject({ method: "GET", url: "/public" });
    expect(response.statusCode).toBe(200);
  });
});

// ── AC1: valid token → 200 + userId ──────────────────────────────────────────

describe("requireAuth — AC1: valid HS256 token", () => {
  it("sets request.userId to the sub UUID and returns 200", async () => {
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    delete process.env["JWT_ISSUER"];
    delete process.env["JWT_AUDIENCE"];
    resetKeyCache();

    const token = await sign(
      { sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) + 3600 },
      key
    );

    const { status, body } = await hitProtected(app, `Bearer ${token}`);
    expect(status).toBe(200);
    expect((body as { userId: string }).userId).toBe(VALID_UUID);
  });
});

// ── AC2: no Authorization header → 401 ───────────────────────────────────────

describe("requireAuth — AC2: missing Authorization header", () => {
  it("returns 401 when no Authorization header is sent", async () => {
    const { status, body } = await hitProtected(app);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });
  });
});

// ── AC3: malformed headers → 401 ─────────────────────────────────────────────

describe("requireAuth — AC3: malformed Authorization header", () => {
  const cases = [
    ["Token abc",           "wrong scheme"],
    ["Bearer",              "no token after Bearer"],
    ["",                    "empty string"],
    ["Bearer   ",           "Bearer with whitespace only"],
    ["Basic dXNlcjpwYXNz", "Basic auth scheme"],
  ];

  it.each(cases)("%s (%s) → 401", async (header) => {
    const { status, body } = await hitProtected(app, header);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });
  });

  it("lowercase 'bearer' is accepted (case-insensitive scheme)", async () => {
    // The hook normalises scheme to lowercase — 'bearer' must work.
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    const token = await sign(
      { sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) + 3600 },
      key
    );
    const { status } = await hitProtected(app, `bearer ${token}`);
    expect(status).toBe(200);
  });
});

// ── AC4: wrong secret → 401 ──────────────────────────────────────────────────

describe("requireAuth — AC4: wrong signing secret", () => {
  it("returns 401 when token is signed with a different secret", async () => {
    const { key: goodKey } = makeHsKey();
    const { secret: wrongSecret } = makeHsKey();

    // Server uses wrongSecret, token signed with goodKey
    process.env["JWT_SECRET"] = wrongSecret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    const token = await sign(
      { sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) + 3600 },
      goodKey
    );

    const { status, body } = await hitProtected(app, `Bearer ${token}`);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });
  });
});

// ── AC5: expired token → 401 ─────────────────────────────────────────────────

describe("requireAuth — AC5: expired token", () => {
  it("returns 401 for a token whose exp is in the past (beyond clock skew)", async () => {
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    const expiredAt = Math.floor(Date.now() / 1000) - 120; // 2 minutes ago (> 30s skew)
    const token = await sign({ sub: VALID_UUID, exp: expiredAt }, key);

    const { status, body } = await hitProtected(app, `Bearer ${token}`);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });
  });
});

// ── AC6: alg:none → 401 ──────────────────────────────────────────────────────

describe("requireAuth — AC6: alg 'none' explicitly rejected", () => {
  it("rejects the classic 'none' algorithm JWT vulnerability", async () => {
    const { secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    // Craft a 'none'-algorithm JWT manually.
    // jose does not have a none-signer, so we construct the token by hand.
    const header  = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const noneToken = `${header}.${payload}.`;

    const { status, body } = await hitProtected(app, `Bearer ${noneToken}`);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });
  });
});

// ── AC7: algorithm confusion → 401 ───────────────────────────────────────────

describe("requireAuth — AC7: algorithm confusion (HS256 token, RS256 config)", () => {
  it("returns 401 when token alg does not match JWT_ALGORITHM", async () => {
    // Generate RS256 keypair — token will be signed with RS256 private key
    // but the SERVER is configured for HS256 with an HS key. The server's
    // algorithms allowlist is ['HS256'] so RS256 tokens must be rejected.
    //
    // Also test the inverse (HS256 token vs RS256 config) which is the
    // classic confusion attack.
    const { secret } = makeHsKey();
    const { publicKey, privateKey } = await generateKeyPair("RS256", { modulusLength: 2048 });

    // --- Case A: server=HS256, token=RS256 ---
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    const rs256Token = await new SignJWT({ sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) + 3600 })
      .setProtectedHeader({ alg: "RS256" })
      .sign(privateKey);

    const { status: s1, body: b1 } = await hitProtected(app, `Bearer ${rs256Token}`);
    expect(s1).toBe(401);
    expect(b1).toStrictEqual({ error: "unauthorized" });

    // --- Case B: server=RS256, token=HS256 ---
    const spki = await exportSPKI(publicKey);
    process.env["JWT_SECRET"] = spki;
    process.env["JWT_ALGORITHM"] = "RS256";
    resetKeyCache();

    const { key: hsKey, secret: hsSecret } = makeHsKey();
    void hsSecret; // unused; key is what we sign with
    const hs256Token = await sign(
      { sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) + 3600 },
      hsKey
    );

    const { status: s2, body: b2 } = await hitProtected(app, `Bearer ${hs256Token}`);
    expect(s2).toBe(401);
    expect(b2).toStrictEqual({ error: "unauthorized" });
  });
});

// ── AC8: no sub claim → 401 ──────────────────────────────────────────────────

describe("requireAuth — AC8: missing sub claim", () => {
  it("returns 401 when the token has no sub", async () => {
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    const token = await new SignJWT({ exp: Math.floor(Date.now() / 1000) + 3600, role: "user" })
      .setProtectedHeader({ alg: "HS256" })
      .sign(key);

    const { status, body } = await hitProtected(app, `Bearer ${token}`);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });
  });
});

// ── AC9: sub not a UUID → 401 ────────────────────────────────────────────────

describe("requireAuth — AC9: sub is not a UUID", () => {
  it("returns 401 when sub is an arbitrary string", async () => {
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    const token = await sign(
      { sub: NOT_A_UUID, exp: Math.floor(Date.now() / 1000) + 3600 },
      key
    );

    const { status, body } = await hitProtected(app, `Bearer ${token}`);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });
  });
});

// ── AC10: issuer mismatch → 401 ──────────────────────────────────────────────

describe("requireAuth — AC10: issuer mismatch", () => {
  it("returns 401 when iss does not match JWT_ISSUER", async () => {
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    process.env["JWT_ISSUER"] = "https://accounts.example.com";
    resetKeyCache();

    const token = await new SignJWT({
      sub: VALID_UUID,
      exp: Math.floor(Date.now() / 1000) + 3600,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("https://evil.example.com")  // wrong issuer
      .sign(key);

    const { status, body } = await hitProtected(app, `Bearer ${token}`);
    expect(status).toBe(401);
    expect(body).toStrictEqual({ error: "unauthorized" });

    delete process.env["JWT_ISSUER"];
  });
});

// ── AC12: identical 401 bodies (no information leak) ─────────────────────────

describe("requireAuth — AC12: uniform 401 body (no failure reason leak)", () => {
  it("all rejection paths return exactly { error: 'unauthorized' }", async () => {
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    delete process.env["JWT_ISSUER"];
    delete process.env["JWT_AUDIENCE"];
    resetKeyCache();

    const expiredToken = await sign(
      { sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) - 120 },
      key
    );
    const noSubToken = await new SignJWT({ exp: Math.floor(Date.now() / 1000) + 3600 })
      .setProtectedHeader({ alg: "HS256" })
      .sign(key);
    const badUuidToken = await sign(
      { sub: NOT_A_UUID, exp: Math.floor(Date.now() / 1000) + 3600 },
      key
    );

    const cases: Array<[string, string | undefined]> = [
      ["no header",   undefined],
      ["bad scheme",  "Token abc"],
      ["wrong secret", `Bearer eyJhbGciOiJIUzI1NiJ9.${Buffer.from('{"sub":"'+VALID_UUID+'","exp":9999999999}').toString("base64url")}.invalidsig`],
      ["expired",     `Bearer ${expiredToken}`],
      ["no sub",      `Bearer ${noSubToken}`],
      ["bad uuid sub", `Bearer ${badUuidToken}`],
    ];

    const EXPECTED = { error: "unauthorized" };
    for (const [label, auth] of cases) {
      const { status, body } = await hitProtected(app, auth);
      expect(status, `${label}: status must be 401`).toBe(401);
      expect(body,   `${label}: body must be { error: 'unauthorized' }`).toStrictEqual(EXPECTED);
    }
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("requireAuth — edge cases", () => {
  it("very large token (4 KB of padding) → 401", async () => {
    const padding = "x".repeat(4000);
    const { status } = await hitProtected(app, `Bearer ${padding}`);
    expect(status).toBe(401);
  });

  it("token with extra whitespace in header value → 401 (strict format)", async () => {
    // 'Bearer  token' (double space) is not the correct Bearer format
    const { key, secret } = makeHsKey();
    process.env["JWT_SECRET"] = secret;
    process.env["JWT_ALGORITHM"] = "HS256";
    resetKeyCache();

    const token = await sign(
      { sub: VALID_UUID, exp: Math.floor(Date.now() / 1000) + 3600 },
      key
    );
    // Two spaces between Bearer and token — split(" ") produces 3 parts
    const { status } = await hitProtected(app, `Bearer  ${token}`);
    expect(status).toBe(401);
  });
});
