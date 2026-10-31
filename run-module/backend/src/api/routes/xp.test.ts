import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import crypto from "crypto";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { xpRoutes } from "./xp.js";
import { pool } from "../../db/pool.js";
import { JWT_SECRET } from "../../config/env.js";

const key = (): Uint8Array => new TextEncoder().encode(JWT_SECRET);
const userToken = (sub: string): Promise<string> =>
  new SignJWT({ sub, typ: "access" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(key());
const serviceToken = (claims: Record<string, unknown> = {}, expires = true): Promise<string> => {
  const jwt = new SignJWT({ sub: "exercise_module", typ: "service", ...claims }).setProtectedHeader({ alg: "HS256" });
  return (expires ? jwt.setExpirationTime("5m") : jwt).sign(key());
};
const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

type MeXp = { xp: number; updated_at: string | null; breakdown: { reason: string; xp: number }[] };
type UserXp = { xp: number; updatedAt: string | null };

describe("XP routes", () => {
  const fastify = Fastify();
  void fastify.register(xpRoutes);
  const users: string[] = [];

  beforeAll(async () => {
    await fastify.ready();
  });
  afterEach(async () => {
    await pool.query("DELETE FROM activity_sessions WHERE user_id = ANY($1)", [users]);
    await pool.query("DELETE FROM external_xp_awards WHERE user_id = ANY($1)", [users]);
    users.length = 0;
  });
  afterAll(async () => {
    await pool.end();
  });

  function newUser(): string {
    const id = crypto.randomUUID();
    users.push(id);
    return id;
  }

  async function addRun(userId: string, startedAt: Date, metrics: Record<string, unknown>): Promise<void> {
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, intensity, metrics, source_module)
       VALUES ($1, $2, 'run', 'territory_run', $3, 1800, 'moderate', $4, 'run_module')`,
      [crypto.randomUUID(), userId, startedAt, JSON.stringify(metrics)]
    );
  }

  async function addWorkout(userId: string, startedAt: Date, durationS: number): Promise<void> {
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'exercise', 'squat', $3, $4, '{"reps": 25, "good_reps": 25}', 'exercise_module')`,
      [crypto.randomUUID(), userId, startedAt, durationS]
    );
  }

  it("GET /v1/users/me/xp: 0 for a new user, then the user's own XP with a breakdown", async () => {
    const ana = newUser();
    const empty = await fastify.inject({ method: "GET", url: "/v1/users/me/xp", headers: bearer(await userToken(ana)) });
    expect(empty.statusCode).toBe(200);
    expect(empty.json<MeXp>()).toEqual({ xp: 0, updated_at: null, breakdown: [] });

    await addRun(ana, new Date("2026-09-26T01:00:00Z"), { distance_m: 5000, territory_claimed: true, rejection_reason: null });
    await addWorkout(ana, new Date("2026-09-26T12:00:00Z"), 25 * 60);
    await addRun(newUser(), new Date("2026-09-26T01:00:00Z"), { distance_m: 9000, territory_claimed: true, rejection_reason: null });

    const res = await fastify.inject({ method: "GET", url: "/v1/users/me/xp", headers: bearer(await userToken(ana)) });
    expect(res.statusCode).toBe(200);
    const body = res.json<MeXp>();
    expect(body.xp).toBe(125 + 50 + 30); // her run, her 25 counted reps and the day's goal; not the other user's run
    expect(body.breakdown).toEqual([
      { reason: "run_completed", xp: 50 },
      { reason: "run_distance", xp: 50 },
      { reason: "territory_captured", xp: 25 },
      { reason: "exercise_session", xp: 50 },
      { reason: "daily_goal", xp: 30 },
    ]);
    expect(typeof body.updated_at).toBe("string");
  });

  it("GET /v1/users/me/xp needs a user token", async () => {
    expect((await fastify.inject({ method: "GET", url: "/v1/users/me/xp" })).statusCode).toBe(401);
    const asService = await fastify.inject({ method: "GET", url: "/v1/users/me/xp", headers: bearer(await serviceToken()) });
    expect(asService.statusCode).toBe(401);
  });

  it("getUserXP and meetsXPGate for Partner Hunt", async () => {
    const bob = newUser();
    await addRun(bob, new Date("2026-09-26T01:00:00Z"), { distance_m: 2000, territory_claimed: false, rejection_reason: null });
    const service = bearer(await serviceToken());

    const xp = await fastify.inject({ method: "GET", url: `/v1/users/${bob}/xp`, headers: service });
    expect(xp.statusCode).toBe(200);
    const status = xp.json<UserXp>();
    expect(status.xp).toBe(70 + 30); // run + daily goal
    expect(Number.isNaN(Date.parse(status.updatedAt ?? ""))).toBe(false); // when the row was recorded

    const pass = await fastify.inject({ method: "GET", url: `/v1/users/${bob}/xp-gate?minXP=100`, headers: service });
    expect(pass.statusCode).toBe(200);
    expect(pass.body).toBe("true");
    const fail = await fastify.inject({ method: "GET", url: `/v1/users/${bob}/xp-gate?minXP=101`, headers: service });
    expect(fail.body).toBe("false");

    const nobody = await fastify.inject({ method: "GET", url: `/v1/users/${crypto.randomUUID()}/xp`, headers: service });
    expect(nobody.json<UserXp>()).toEqual({ xp: 0, updatedAt: null });
  });

  it("service routes refuse user tokens, unexpiring or wrong service tokens, and bad input", async () => {
    const bob = newUser();
    const url = `/v1/users/${bob}/xp-gate?minXP=100`;
    const refused = [
      {},
      bearer(await userToken(bob)),
      bearer(await serviceToken({}, false)),
      bearer(await serviceToken({ sub: "someone_else" })),
      bearer(await serviceToken({ typ: "access" })),
      bearer(await new SignJWT({ sub: "exercise_module", typ: "service" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode("wrong-secret"))),
    ];
    for (const headers of refused) {
      expect((await fastify.inject({ method: "GET", url, headers })).statusCode).toBe(401);
      expect((await fastify.inject({ method: "GET", url: `/v1/users/${bob}/xp`, headers })).statusCode).toBe(401);
    }
    const service = bearer(await serviceToken());
    for (const bad of [`/v1/users/not-a-uuid/xp-gate?minXP=1`, `/v1/users/${bob}/xp-gate`, `/v1/users/${bob}/xp-gate?minXP=-1`,
                       `/v1/users/${bob}/xp-gate?minXP=abc`, `/v1/users/not-a-uuid/xp`]) {
      expect((await fastify.inject({ method: "GET", url: bad, headers: service })).statusCode).toBe(400);
    }
  });

  type Board = { window: string; day: string; entries: { rank: number; user_id: string; xp: number }[]; me: { rank: number; xp: number } | null; total_ranked: number };

  it("GET /v1/leaderboard/xp ranks XP earned today and this week, after the caps", async () => {
    const now = Date.now();
    const [ana, ben, cai] = [newUser(), newUser(), newUser()];
    // today: ana 20 km (capped at 150), ben 5 km (100), cai nothing today but 3 days ago; each + the 30 daily goal
    await addRun(ana, new Date(now - 60_000), { distance_m: 20_000, territory_claimed: false, rejection_reason: null });
    await addRun(ben, new Date(now - 60_000), { distance_m: 5000, territory_claimed: false, rejection_reason: null });
    await addRun(cai, new Date(now - 3 * 86_400_000), { distance_m: 30_000, territory_claimed: false, rejection_reason: null });

    const daily = await fastify.inject({ method: "GET", url: "/v1/leaderboard/xp?window=daily&limit=1000", headers: bearer(await userToken(ben)) });
    expect(daily.statusCode).toBe(200);
    const d = daily.json<Board>();
    const mine = d.entries.filter((e) => [ana, ben, cai].includes(e.user_id));
    expect(mine.map((e) => [e.user_id, e.xp])).toEqual([[ana, 180], [ben, 130]]);
    expect(d.me).toMatchObject({ user_id: ben, xp: 130 });
    expect(mine[0]!.rank).toBeLessThan(mine[1]!.rank);

    const weekly = (await fastify.inject({ method: "GET", url: "/v1/leaderboard/xp?window=weekly&limit=1000", headers: bearer(await userToken(cai)) })).json<Board>();
    expect(weekly.entries.find((e) => e.user_id === cai)?.xp).toBe(180);
    expect(weekly.me).toMatchObject({ user_id: cai, xp: 180 });
  });

  it("GET /v1/leaderboard/xp checks its input and needs a user", async () => {
    const token = await userToken(newUser());
    // monthly became a window in ADR-033; anything else is still refused
    expect((await fastify.inject({ method: "GET", url: "/v1/leaderboard/xp?window=yearly", headers: bearer(token) })).statusCode).toBe(400);
    expect((await fastify.inject({ method: "GET", url: "/v1/leaderboard/xp?limit=0", headers: bearer(token) })).statusCode).toBe(400);
    expect((await fastify.inject({ method: "GET", url: "/v1/leaderboard/xp" })).statusCode).toBe(401);
    const empty = (await fastify.inject({ method: "GET", url: "/v1/leaderboard/xp", headers: bearer(token) })).json<Board>();
    expect(empty.me).toBeNull();
  });

  it("POST /internal/v1/xp/award awards XP bypassing daily cap, appears in breakdown and getUserXp, prevents replays", async () => {
    const u = newUser();
    const service = bearer(await serviceToken());

    const body1 = { subject: u, amount: 25, reason: "territory_claim", source: "campus", idempotency_key: "claim-123" };
    const res1 = await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", headers: service, payload: body1 });
    expect(res1.statusCode).toBe(200);
    expect(res1.json<number>()).toBe(25);

    // Replay with exact same source and key
    const res2 = await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", headers: service, payload: body1 });
    expect(res2.statusCode).toBe(200);
    expect(res2.json<number>()).toBe(25); // same total, no double award

    // Same key, different source (not possible anymore as source must be 'campus', so use different key)
    const body3 = { subject: u, amount: 40, reason: "territory_steal", source: "campus", idempotency_key: "claim-456" };
    const res3 = await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", headers: service, payload: body3 });
    expect(res3.statusCode).toBe(200);
    expect(res3.json<number>()).toBe(65); // 25 + 40

    // Fetch me xp to verify breakdown
    const meRes = await fastify.inject({ method: "GET", url: "/v1/users/me/xp", headers: bearer(await userToken(u)) });
    const me = meRes.json<MeXp>();
    expect(me.xp).toBe(65);
    expect(me.breakdown).toContainEqual({ reason: "territory_claim", xp: 25 });
    expect(me.breakdown).toContainEqual({ reason: "territory_steal", xp: 40 });

    // Territory awards have their own 150/day cap, separate from the run and exercise caps.
    for (let i = 0; i < 10; i++) {
      await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", headers: service, payload: { ...body1, idempotency_key: `loop-${i}` } });
    }
    const capRes = await fastify.inject({ method: "GET", url: "/v1/users/me/xp", headers: bearer(await userToken(u)) });
    expect(capRes.json<MeXp>().xp).toBe(150);
  });

  it("POST /internal/v1/xp/totals handles batches, unknowns, empty subjects, and max 200", async () => {
    const u1 = newUser();
    const u2 = newUser();
    const service = bearer(await serviceToken());

    await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", headers: service, payload: { subject: u1, amount: 15, reason: "territory_defend", source: "campus", idempotency_key: "ik-1" } });

    // batch route test (all valid)
    const totalsRes = await fastify.inject({ 
      method: "POST", url: "/internal/v1/xp/totals", headers: service, 
      payload: { subjects: [u1, u2, crypto.randomUUID()] }
    });
    expect(totalsRes.statusCode).toBe(200);
    const totals = totalsRes.json<Record<string, number>>();
    
    // u1 has 15
    expect(totals[u1]).toBe(15);
    // u2 has no XP, returns 0, not an error
    expect(totals[u2]).toBe(0);

    // a batch containing a non-UUID subject is rejected entirely
    const badBatchRes = await fastify.inject({ 
      method: "POST", url: "/internal/v1/xp/totals", headers: service, 
      payload: { subjects: [u1, "not-a-uuid", u2] }
    });
    expect(badBatchRes.statusCode).toBe(400);
    expect(badBatchRes.json<{error: string}>().error).toMatch(/not-a-uuid/);
    
    // > 200 rejected
    const bigArray = Array(201).fill(u1);
    const bigRes = await fastify.inject({ method: "POST", url: "/internal/v1/xp/totals", headers: service, payload: { subjects: bigArray } });
    expect(bigRes.statusCode).toBe(400);
  });

  it("both internal routes reject without the service token", async () => {
    const u = newUser();
    const noAuth = { subject: u, amount: 25, reason: "territory_claim", source: "campus", idempotency_key: "ik-2" };
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", payload: noAuth })).statusCode).toBe(401);
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", payload: noAuth, headers: bearer(await userToken(u)) })).statusCode).toBe(401);

    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/totals", payload: { subjects: [u] } })).statusCode).toBe(401);
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/totals", payload: { subjects: [u] }, headers: bearer(await userToken(u)) })).statusCode).toBe(401);
  });

  it("both routes accept the shared token, accept a valid service JWT, and reject a wrong token and no token", async () => {
    const u = newUser();
    const originalToken = process.env["SOCIAL_INTERNAL_TOKEN"];
    process.env["SOCIAL_INTERNAL_TOKEN"] = "test-token-12345";
    const internalToken = "test-token-12345";
    const jwtAuth = bearer(await serviceToken());
    const sharedAuth = { authorization: `Bearer ${internalToken}` };
    const wrongAuth = { authorization: `Bearer wrong-token-123` };
    
    // Accept valid service JWT
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/totals", payload: { subjects: [u] }, headers: jwtAuth })).statusCode).toBe(200);
    
    // Accept shared token
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/totals", payload: { subjects: [u] }, headers: sharedAuth })).statusCode).toBe(200);
    
    // Reject wrong token
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/totals", payload: { subjects: [u] }, headers: wrongAuth })).statusCode).toBe(401);
    
    // Reject no token
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/totals", payload: { subjects: [u] } })).statusCode).toBe(401);

    // Same for /award (with valid body to avoid 400 validation error masking 401)
    const validBody = { subject: u, amount: 15, reason: "territory_claim", source: "campus", idempotency_key: "u1-auth-test" };
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", payload: validBody, headers: jwtAuth })).statusCode).toBe(200);
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", payload: validBody, headers: sharedAuth })).statusCode).toBe(200);
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", payload: validBody, headers: wrongAuth })).statusCode).toBe(401);
    expect((await fastify.inject({ method: "POST", url: "/internal/v1/xp/award", payload: validBody })).statusCode).toBe(401);
    
    if (originalToken === undefined) {
      delete process.env["SOCIAL_INTERNAL_TOKEN"];
    } else {
      process.env["SOCIAL_INTERNAL_TOKEN"] = originalToken;
    }
  });
});
