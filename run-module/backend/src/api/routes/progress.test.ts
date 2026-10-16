import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import Fastify from "fastify";
import { SignJWT } from "jose";
import { JWT_SECRET } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { progressRoutes } from "./progress.js";

const bearer = async (userId: string) => ({ authorization: `Bearer ${await new SignJWT({ sub: userId, typ: "access" })
  .setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(new TextEncoder().encode(JWT_SECRET))}` });

describe("Progress API", () => {
  const app = Fastify();
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
  async function addRun(userId: string, startedAt: Date, distanceM = 2000) {
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, calories_kcal, metrics, source_module)
       VALUES ($1, $2, 'run', 'territory_run', $3, 1800, 100, $4, 'run_module')`,
      [crypto.randomUUID(), userId, startedAt, JSON.stringify({ distance_m: distanceM, moving_time_s: 1800,
        territory_claimed: false, rejection_reason: null, timezone: "Asia/Kolkata" })]);
  }
  async function addWorkout(userId: string, startedAt: Date) {
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, calories_kcal, metrics, source_module)
       VALUES ($1, $2, 'exercise', 'squat', $3, 600, 80, $4, 'exercise_module')`,
      [crypto.randomUUID(), userId, startedAt, JSON.stringify({ good_reps: 25, active_time_s: 600, timezone: "Asia/Kolkata" })]);
  }

  it("GET /v1/progress: a user with no activity receives zero totals in the app's contract shape", async () => {
    const user = newUser();
    const response = await app.inject({ method: "GET", url: "/v1/progress", headers: await bearer(user) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["challengesCompleted", "level", "streak", "timezone", "today", "totalActiveMinutes", "totalCalories", "totalDistanceKm", "totalSteps", "totalWorkoutMinutes", "totalWorkouts", "totalXp", "userId"].sort());
    expect(body.totalXp).toBe(0);
    expect(body.totalWorkouts).toBe(0);
    expect(body.today).toMatchObject({ date: expect.any(String), xp: 0, steps: 0, workouts: 0, workoutMinutes: 0,
      activeMinutes: 0, distanceKm: 0, calories: 0, challengesCompleted: 0, goalsCompleted: 0,
      goals: [], goalsTotal: 0, isToday: true });
  });

  it("GET /v1/progress: lifetime totals include runs, exercise, campus XP and challenge awards", async () => {
    const user = newUser();
    const now = new Date();
    await addRun(user, now, 2000);
    await addWorkout(user, now);
    await pool.query(
      "INSERT INTO external_xp_awards (source, idempotency_key, user_id, amount, reason) VALUES ('campus', $1, $2, 25, 'territory_claim')",
      [crypto.randomUUID(), user]);
    const challengeId = crypto.randomUUID();
    await pool.query(
      `INSERT INTO challenges (id, type, title, metric, comparator, threshold, starts_at, ends_at, xp_reward, state, created_by, resolved_at)
       VALUES ($1, 'daily', 'Test', 'runs_completed', 'gte', 1, now() - interval '1 day', now(), 10, 'resolved', $2, $3)`,
      [challengeId, user, now]);
    await pool.query(
      "INSERT INTO challenge_participants (challenge_id, user_id, status, is_winner, xp_awarded) VALUES ($1, $2, 'completed', true, 10)",
      [challengeId, user]);

    const response = await app.inject({ method: "GET", url: "/v1/progress", headers: await bearer(user) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.totalXp).toBe(185); // run 70 + exercise 50 + campus 25 + challenge 10 + daily goal 30 (ADR-033)
    // Runs now count as workouts alongside exercise sessions.
    expect(body.totalWorkouts).toBe(2);
    expect(body.totalDistanceKm).toBeCloseTo(2);
    expect(body.totalWorkoutMinutes).toBe(40);
    expect(body.challengesCompleted).toBe(1);
    expect(body.today.xp).toBe(185);
  });

  it("GET /v1/progress/daily uses the requested XP day and XP timezone boundary", async () => {
    const user = newUser();
    await addRun(user, new Date("2026-09-25T23:00:00.000Z"), 2000); // 04:30 on Sep 26 in Asia/Kolkata
    const response = await app.inject({ method: "GET", url: "/v1/progress/daily?date=2026-09-26", headers: await bearer(user) });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ date: "2026-09-26", xp: 70 + 30, distanceKm: 2, isToday: false }); // + daily goal
  });

  it("GET /v1/progress/weekly returns the requested seven calendar days and totals", async () => {
    const user = newUser();
    await addRun(user, new Date("2026-09-21T08:00:00.000Z"), 2000);
    const response = await app.inject({ method: "GET", url: "/v1/progress/weekly?weekStart=2026-09-21", headers: await bearer(user) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.weekStart).toBe("2026-09-21");
    expect(body.weekEnd).toBe("2026-09-27");
    expect(Object.keys(body).sort()).toEqual(["activeDays", "activeMinutes", "calories", "challengesCompleted", "change", "days", "distanceKm", "goalsCompleted", "previous", "streak", "steps", "weekEnd", "weekStart", "workoutMinutes", "workouts", "xp"].sort());
    expect(body.days).toHaveLength(7);
    expect(body.days.map((day: { date: string }) => day.date)).toEqual([
      "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25", "2026-09-26", "2026-09-27"]);
    expect(body.xp).toBe(70 + 30); // run + daily goal
  });

  it("GET /v1/progress/history respects days and rejects an absurd window", async () => {
    const user = newUser();
    const response = await app.inject({ method: "GET", url: "/v1/progress/history?days=5", headers: await bearer(user) });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(["days", "from", "to"]);
    expect(body.days).toHaveLength(5);
    expect(body.from).toBe(body.days[0].date);
    expect(body.to).toBe(body.days[4].date);
    const absurd = await app.inject({ method: "GET", url: "/v1/progress/history?days=9999", headers: await bearer(user) });
    expect(absurd.statusCode).toBe(400);
  });

  it("all four progress endpoints require a user token", async () => {
    for (const url of ["/v1/progress", "/v1/progress/daily", "/v1/progress/weekly", "/v1/progress/history?days=7"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
    }
  });

  it("a run-only user has matching workout count, active days, and streak", async () => {
    const user = newUser();
    await addRun(user, new Date(), 2000);

    const lifetimeResponse = await app.inject({ method: "GET", url: "/v1/progress", headers: await bearer(user) });
    expect(lifetimeResponse.statusCode).toBe(200);
    const lifetime = lifetimeResponse.json();
    const today = lifetime.today.date as string;
    expect(lifetime.totalWorkouts).toBe(1);
    expect(lifetime.totalWorkoutMinutes).toBe(30);
    expect(lifetime.today.workouts).toBe(1);
    expect(lifetime.streak.current).toBe(1);

    const day = new Date(`${today}T00:00:00.000Z`);
    day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
    const weekStart = day.toISOString().slice(0, 10);
    const weeklyResponse = await app.inject({ method: "GET", url: `/v1/progress/weekly?weekStart=${weekStart}`, headers: await bearer(user) });
    expect(weeklyResponse.statusCode).toBe(200);
    const weekly = weeklyResponse.json();
    expect(weekly.activeDays).toBe(1);
    expect(weekly.workouts).toBe(1);
    expect(weekly.workoutMinutes).toBe(30);
    expect(weekly.streak.current).toBe(1);
  });

  it("returns whole-minute values consistently in lifetime, daily, weekly, and history", async () => {
    const user = newUser();
    const now = new Date();
    const runMetrics = { distance_m: 1000, moving_time_s: 740, timezone: "Asia/Kolkata" };
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'run', 'territory_run', $3, 740, $4, 'run_module')`,
      [crypto.randomUUID(), user, now, JSON.stringify(runMetrics)]);
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'exercise', 'squat', $3, 745, $4, 'exercise_module')`,
      [crypto.randomUUID(), user, now, JSON.stringify({ active_time_s: 745, timezone: "Asia/Kolkata" })]);

    const lifetimeResponse = await app.inject({ method: "GET", url: "/v1/progress", headers: await bearer(user) });
    expect(lifetimeResponse.statusCode).toBe(200);
    const lifetime = lifetimeResponse.json();
    const today = lifetime.today.date as string;
    const dateValues = new Date(`${today}T00:00:00.000Z`);
    dateValues.setUTCDate(dateValues.getUTCDate() - ((dateValues.getUTCDay() + 6) % 7));
    const weekStart = dateValues.toISOString().slice(0, 10);

    const dailyResponse = await app.inject({ method: "GET", url: `/v1/progress/daily?date=${today}`, headers: await bearer(user) });
    const weeklyResponse = await app.inject({ method: "GET", url: `/v1/progress/weekly?weekStart=${weekStart}`, headers: await bearer(user) });
    const historyResponse = await app.inject({ method: "GET", url: "/v1/progress/history?days=1", headers: await bearer(user) });
    expect(dailyResponse.statusCode).toBe(200);
    expect(weeklyResponse.statusCode).toBe(200);
    expect(historyResponse.statusCode).toBe(200);
    const daily = dailyResponse.json();
    const weekly = weeklyResponse.json();
    const history = historyResponse.json();

    expect(lifetime.totalWorkoutMinutes).toBe(25);
    expect(lifetime.totalActiveMinutes).toBe(25);
    expect(lifetime.today.workoutMinutes).toBe(25);
    expect(lifetime.today.activeMinutes).toBe(25);
    expect(daily.workoutMinutes).toBe(25);
    expect(daily.activeMinutes).toBe(25);
    expect(weekly.workoutMinutes).toBe(25);
    expect(weekly.activeMinutes).toBe(25);
    expect(weekly.days.find((row: { date: string }) => row.date === today)).toMatchObject({ workoutMinutes: 25, activeMinutes: 25 });
    expect(history.days[0]).toMatchObject({ date: today, workoutMinutes: 25, activeMinutes: 25 });
    const minuteValues = [lifetime.totalWorkoutMinutes, lifetime.totalActiveMinutes, lifetime.today.workoutMinutes,
      lifetime.today.activeMinutes, daily.workoutMinutes, daily.activeMinutes, weekly.workoutMinutes,
      weekly.activeMinutes, weekly.previous.workoutMinutes, weekly.previous.activeMinutes,
      ...weekly.days.flatMap((row: { workoutMinutes: number; activeMinutes: number }) => [row.workoutMinutes, row.activeMinutes]),
      ...history.days.flatMap((row: { workoutMinutes: number; activeMinutes: number }) => [row.workoutMinutes, row.activeMinutes])];
    expect(minuteValues.every(Number.isInteger)).toBe(true);
  });
});
