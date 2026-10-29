import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { JWT_SECRET } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { progressRoutes } from "./progress.js";
import { xpRoutes } from "./xp.js";

const bearer = async (userId: string) => ({ authorization: `Bearer ${await new SignJWT({ sub: userId, typ: "access" })
  .setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(JWT_SECRET))}` });

describe("GET /v1/xp compatibility contract", () => {
  const app = Fastify();
  void app.register(xpRoutes);
  void app.register(progressRoutes);
  const users: string[] = [];

  beforeAll(async () => { await app.ready(); });
  afterEach(async () => {
    await pool.query("DELETE FROM challenge_participants WHERE user_id = ANY($1)", [users]);
    await pool.query("DELETE FROM challenges WHERE created_by = ANY($1)", [users]);
    await pool.query("DELETE FROM activity_sessions WHERE user_id = ANY($1)", [users]);
    await pool.query("DELETE FROM external_xp_awards WHERE user_id = ANY($1)", [users]);
    users.length = 0;
  });
  afterAll(async () => { await app.close(); });

  const newUser = () => { const id = crypto.randomUUID(); users.push(id); return id; };

  it("returns zero values and the full app shape for a user with no activity", async () => {
    const user = newUser();
    const response = await app.inject({ method: "GET", url: "/v1/xp", headers: await bearer(user) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["totalXp", "level", "today", "week", "bySource"].sort());
    expect(body.totalXp).toBe(0);
    expect(body.level).toEqual({ level: 1, currentXP: 0, xpForCurrentLevel: 0, xpForNextLevel: 2000, progress: 0 });
    expect(body.today).toBe(0);
    expect(body.week).toBe(0);
    expect(body.bySource).toEqual({ run: 0, exercise: 0, campus: 0, challenge: 0 });
  });

  it("matches progress XP and level, and groups reason breakdowns by source", async () => {
    const user = newUser();
    const now = new Date();
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'run', 'territory_run', $3, 1800, $4, 'run_module')`,
      [crypto.randomUUID(), user, now, JSON.stringify({ distance_m: 2000, territory_claimed: false,
        rejection_reason: null, timezone: "Asia/Kolkata" })]);
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'exercise', 'squat', $3, 600, $4, 'exercise_module')`,
      [crypto.randomUUID(), user, now, JSON.stringify({ good_reps: 5, active_time_s: 600, timezone: "Asia/Kolkata" })]);
    await pool.query(
      "INSERT INTO external_xp_awards (source, idempotency_key, user_id, amount, reason) VALUES ('campus', $1, $2, 12, 'territory_claim')",
      [crypto.randomUUID(), user]);
    const challengeId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO challenges (id, type, title, metric, comparator, threshold, starts_at, ends_at, xp_reward, state, created_by, resolved_at)
       VALUES ($1, 'daily', 'Test', 'runs_completed', 'gte', 1, now() - interval '1 day', now(), 8, 'resolved', $2, $3)`,
      [challengeId, user, now]);
    await pool.query(
      "INSERT INTO challenge_participants (challenge_id, user_id, status, is_winner, xp_awarded) VALUES ($1, $2, 'completed', true, 8)",
      [challengeId, user]);

    const response = await app.inject({ method: "GET", url: "/v1/xp", headers: await bearer(user) });
    const progressResponse = await app.inject({ method: "GET", url: "/v1/progress", headers: await bearer(user) });
    expect(response.statusCode).toBe(200);
    expect(progressResponse.statusCode).toBe(200);
    const body = response.json();
    const progress = progressResponse.json();
    expect(body).toMatchObject({
      totalXp: 130, // + the daily goal (ADR-033)
      level: { level: 1, currentXP: 130, xpForCurrentLevel: 0, xpForNextLevel: 2000, progress: 0.065 },
      bySource: { run: 70, exercise: 10, campus: 12, challenge: 8, daily_goal: 30 },
    });
    expect(body.totalXp).toBe(progress.totalXp);
    expect(body.level).toEqual(progress.level);
    expect(Object.keys(body.level).sort()).toEqual(["level", "currentXP", "xpForCurrentLevel", "xpForNextLevel", "progress"].sort());
    expect(Object.values(body.bySource as Record<string, number>).reduce((sum, value) => sum + value, 0)).toBe(body.totalXp);
  });

  it("matches today and current-week XP from the daily and weekly progress endpoints", async () => {
    const user = newUser();
    const now = new Date();
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'run', 'territory_run', $3, 1800, $4, 'run_module')`,
      [crypto.randomUUID(), user, now, JSON.stringify({ distance_m: 1000, territory_claimed: false,
        rejection_reason: null, timezone: "Asia/Kolkata" })]);

    const headers = await bearer(user);
    const xpResponse = await app.inject({ method: "GET", url: "/v1/xp", headers });
    const dailyResponse = await app.inject({ method: "GET", url: "/v1/progress/daily", headers });
    const weeklyResponse = await app.inject({ method: "GET", url: "/v1/progress/weekly", headers });
    expect(xpResponse.statusCode).toBe(200);
    expect(dailyResponse.statusCode).toBe(200);
    expect(weeklyResponse.statusCode).toBe(200);
    const xp = xpResponse.json();
    expect(xp.today).toBe(dailyResponse.json().xp);
    expect(xp.week).toBe(weeklyResponse.json().xp);
  });

  it("requires a user token", async () => {
    expect((await app.inject({ method: "GET", url: "/v1/xp" })).statusCode).toBe(401);
  });
});
