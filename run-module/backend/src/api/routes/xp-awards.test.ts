/**
 * XP from other services, reversals, caps, stats, history, the board and level-ups (ADR-033),
 * against the real database.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import Fastify, { type LightMyRequestResponse } from "fastify";
import { SignJWT } from "jose";
import { JWT_SECRET, RATE_LIMIT_XP_READ_PER_MIN } from "../../config/env.js";
import { pool } from "../../db/pool.js";
import { xpRoutes } from "./xp.js";
import { progressRoutes } from "./progress.js";
import { shiftDay, weekStartFor, xpTimeZone } from "../../xp/query.js";
import { xpDay } from "../../xp/rules.js";

const key = (): Uint8Array => new TextEncoder().encode(JWT_SECRET);
const userToken = (sub: string): Promise<string> =>
  new SignJWT({ sub, typ: "access" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(key());
const serviceToken = (): Promise<string> =>
  new SignJWT({ sub: "exercise_module", typ: "service" }).setProtectedHeader({ alg: "HS256" }).setExpirationTime("5m").sign(key());
const bearer = (token: string): { authorization: string } => ({ authorization: `Bearer ${token}` });

type Stats = {
  total: number; level: number;
  level_progress: { current_level_xp: number; next_level_xp: number; into_level: number; needed: number };
  today: number; week: number; month: number; by_source: Record<string, number>;
};
type HistoryItem = { id: string; amount: number; source: string; reason: string; source_id: string | null; created_at: string; reversed: boolean };
type History = { items: HistoryItem[]; next_cursor: string | null };
type Board = { window: string; entries: { rank: number; user_id: string; xp: number }[]; me: { xp: number } | null };

describe("XP awards from other services (ADR-033)", () => {
  const app = Fastify();
  void app.register(xpRoutes);
  void app.register(progressRoutes);
  const users: string[] = [];
  let service: { authorization: string };

  beforeAll(async () => {
    await app.ready();
    service = bearer(await serviceToken());
  });
  afterEach(async () => {
    await pool.query("DELETE FROM challenge_participants WHERE user_id = ANY($1)", [users]);
    await pool.query("DELETE FROM challenges WHERE created_by = ANY($1)", [users]);
    await pool.query("DELETE FROM activity_sessions WHERE user_id = ANY($1)", [users]);
    await pool.query("DELETE FROM external_xp_awards WHERE user_id = ANY($1)", [users]);
    await pool.query("DELETE FROM notification_outbox WHERE user_id = ANY($1)", [users]);
    users.length = 0;
  });
  afterAll(async () => { await app.close(); });

  const newUser = (): string => { const id = crypto.randomUUID(); users.push(id); return id; };

  const award = (payload: Record<string, unknown>, headers: Record<string, string> = service): Promise<LightMyRequestResponse> =>
    app.inject({ method: "POST", url: "/internal/v1/xp/award", headers, payload });
  const reverse = (payload: Record<string, unknown>, headers: Record<string, string> = service): Promise<LightMyRequestResponse> =>
    app.inject({ method: "POST", url: "/internal/v1/xp/reverse", headers, payload });
  const get = async <T>(url: string, user: string): Promise<{ status: number; body: T }> => {
    const res = await app.inject({ method: "GET", url, headers: bearer(await userToken(user)) });
    return { status: res.statusCode, body: res.json<T>() };
  };
  const total = async (user: string): Promise<number> => (await get<{ xp: number }>("/v1/users/me/xp", user)).body.xp;

  /** An award row recorded in the past (the routes always record now). */
  async function pastAward(user: string, daysAgo: number, amount: number, reason = "territory_claim", source = "campus"): Promise<void> {
    await pool.query(
      `INSERT INTO external_xp_awards (source, idempotency_key, user_id, amount, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, now() - make_interval(days => $6))`,
      [source, crypto.randomUUID(), user, amount, reason, daysAgo],
    );
  }

  async function challengeWin(user: string, xp: number, resolvedAt: Date = new Date()): Promise<string> {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO challenges (id, type, title, metric, comparator, threshold, starts_at, ends_at, xp_reward, state, created_by, resolved_at)
       VALUES ($1, 'daily', 'Test', 'runs_completed', 'gte', 1, now() - interval '1 day', now(), $3, 'resolved', $2, $4)`,
      [id, user, xp, resolvedAt]);
    await pool.query(
      "INSERT INTO challenge_participants (challenge_id, user_id, status, is_winner, xp_awarded) VALUES ($1, $2, 'completed', true, $3)",
      [id, user, xp]);
    return id;
  }

  it("accepts each new source at its amount and returns the bare new total", async () => {
    const u = newUser();
    const cases: [string, string, number, string][] = [
      ["campus", "meetup_checkin", 25, `meetup:m-1:${u}`],
      ["exercise", "shared_workout_finished", 20, "sw-1"],
      ["exercise", "buddy_connected", 20, `buddy:pair-1:${u}`],
      ["social", "ambassador_referral", 50, "ref-1"],
      ["social", "ambassador_task", 100, "task-1"],
      ["social", "special_event", 60, "event-1"],
    ];
    let expected = 0;
    for (const [source, reason, amount, idempotency_key] of cases) {
      expected += amount;
      const res = await award({ subject: u, source, reason, amount, idempotency_key, source_id: `${reason}-id`, metadata: { note: "ok" } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toBe(expected);
    }
    const stored = await pool.query("SELECT source_id, metadata FROM external_xp_awards WHERE user_id = $1 AND reason = 'special_event'", [u]);
    expect(stored.rows[0]).toEqual({ source_id: "special_event-id", metadata: { note: "ok" } });
    const me = (await get<{ breakdown: { reason: string; xp: number }[] }>("/v1/users/me/xp", u)).body;
    expect(me.breakdown).toContainEqual({ reason: "ambassador_task", xp: 100 });
    expect(me.breakdown).toContainEqual({ reason: "meetup_checkin", xp: 25 });
  });

  it("refuses unknown sources/reasons and manipulated amounts with 422, writing nothing", async () => {
    const u = newUser();
    const refused = [
      { source: "campus", reason: "meetup_checkin", amount: 50, idempotency_key: `meetup:m-1:${u}` },
      { source: "campus", reason: "meetup_checkin", amount: 25, idempotency_key: "meetup-without-format" },
      { source: "exercise", reason: "shared_workout_finished", amount: 200, idempotency_key: "a" },
      { source: "social", reason: "ambassador_referral", amount: 5000, idempotency_key: "b" },
      { source: "social", reason: "ambassador_task", amount: 201, idempotency_key: "c" },
      { source: "social", reason: "ambassador_task", amount: 0, idempotency_key: "d" },
      { source: "social", reason: "ambassador_task", amount: -50, idempotency_key: "e" },
      { source: "social", reason: "special_event", amount: 101, idempotency_key: "f" },
      { source: "campus", reason: "territory_claim", amount: 101, idempotency_key: "g" },
      { source: "campus", reason: "territory_claim", amount: "1000", idempotency_key: "h" },
      { source: "run", reason: "run_completed", amount: 50, idempotency_key: "i" },
      { source: "social", reason: "territory_claim", amount: 10, idempotency_key: "j" },
      { source: "social", reason: "special_event", amount: 10, idempotency_key: "x".repeat(201) },
      { source: "social", reason: "special_event", amount: 10, idempotency_key: "k", source_id: "x".repeat(201) },
      { source: "social", reason: "special_event", amount: 10, idempotency_key: "l", metadata: { blob: "x".repeat(3000) } },
    ];
    for (const body of refused) {
      const res = await award({ subject: u, ...body });
      expect(res.statusCode, JSON.stringify(body).slice(0, 120)).toBe(422);
    }
    // shape errors stay 400
    expect((await award({ subject: u, source: "social", reason: "special_event", amount: 10.5, idempotency_key: "m" })).statusCode).toBe(400);
    expect((await award({ subject: "not-a-uuid", source: "social", reason: "special_event", amount: 10, idempotency_key: "n" })).statusCode).toBe(400);
    expect((await award({ subject: u, source: "social", reason: "special_event", amount: 10, idempotency_key: "o", metadata: "str" })).statusCode).toBe(400);
    const rows = await pool.query("SELECT 1 FROM external_xp_awards WHERE user_id = $1", [u]);
    expect(rows.rowCount).toBe(0);
  });

  it("a replay answers the same total without a second row; a different award on the key is 409", async () => {
    const u = newUser();
    const body = { subject: u, source: "social", reason: "ambassador_task", amount: 80, idempotency_key: "task:7" };
    expect((await award(body)).json()).toBe(80);
    const replay = await award(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toBe(80);
    expect((await pool.query("SELECT 1 FROM external_xp_awards WHERE source = 'social' AND idempotency_key = 'task:7'")).rowCount).toBe(1);
    expect((await award({ ...body, amount: 90 })).statusCode).toBe(409);
    expect((await award({ ...body, subject: newUser() })).statusCode).toBe(409);
    expect((await award({ ...body, reason: "special_event", amount: 80 })).statusCode).toBe(409);
    expect(await total(u)).toBe(80);
  });

  it("reverses an award: the total drops, the row stays marked, reversing again is the same 200, unknown is 404", async () => {
    const u = newUser();
    await award({ subject: u, source: "social", reason: "special_event", amount: 70, idempotency_key: "ev-1" });
    await award({ subject: u, source: "exercise", reason: "shared_workout_finished", amount: 20, idempotency_key: "sw-1" });
    const first = await reverse({ source: "social", idempotency_key: "ev-1", reason: "event cancelled" });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toBe(20);
    const again = await reverse({ source: "social", idempotency_key: "ev-1", reason: "second try" });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toBe(20);
    const row = await pool.query<{ reversed_at: Date | null; reversal_reason: string | null }>("SELECT reversed_at, reversal_reason FROM external_xp_awards WHERE source = 'social' AND idempotency_key = 'ev-1'");
    expect(row.rows[0]!.reversed_at).toBeInstanceOf(Date);
    expect(row.rows[0]!.reversal_reason).toBe("event cancelled");
    // replaying the original award does not bring it back
    expect((await award({ subject: u, source: "social", reason: "special_event", amount: 70, idempotency_key: "ev-1" })).json()).toBe(20);

    const missing = await reverse({ source: "social", idempotency_key: "nope", reason: "x" });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: "not_found" });
    expect((await reverse({ source: "social", idempotency_key: "ev-1", reason: "" })).statusCode).toBe(400);

    const history = (await get<History>("/v1/xp/history", u)).body;
    expect(history.items.find((i) => i.reason === "special_event")).toMatchObject({ amount: 70, reversed: true, source: "social" });
  });

  it("caps non-territory awards at 300 a day, shared workouts at 3 a day, territory unchanged at 150", async () => {
    const u = newUser();
    for (let i = 1; i <= 4; i++) {
      await award({ subject: u, source: "exercise", reason: "shared_workout_finished", amount: 20, idempotency_key: `sw-${i}` });
    }
    expect(await total(u)).toBe(60); // the 4th counts 0
    await award({ subject: u, source: "social", reason: "ambassador_task", amount: 200, idempotency_key: "t-1" });
    const capped = await award({ subject: u, source: "social", reason: "special_event", amount: 100, idempotency_key: "e-1" });
    expect(capped.json()).toBe(300);
    for (let i = 1; i <= 4; i++) {
      await award({ subject: u, source: "campus", reason: "territory_claim", amount: 50, idempotency_key: `tc-${i}` });
    }
    expect(await total(u)).toBe(300 + 150);
    const me = (await get<{ breakdown: { reason: string; xp: number }[] }>("/v1/users/me/xp", u)).body;
    expect(me.breakdown).toContainEqual({ reason: "shared_workout_daily_limit", xp: -20 });
    expect(me.breakdown).toContainEqual({ reason: "social_awards_daily_cap", xp: -60 });
    expect(me.breakdown).toContainEqual({ reason: "territory_daily_cap", xp: -50 });
    // the capped rows are kept for audit
    expect((await pool.query("SELECT 1 FROM external_xp_awards WHERE user_id = $1", [u])).rowCount).toBe(10);
    // every view agrees
    const stats = (await get<Stats>("/v1/xp/stats", u)).body;
    const progress = (await get<{ totalXp: number; today: { xp: number } }>("/v1/progress", u)).body;
    const board = (await get<Board>("/v1/leaderboard/xp?window=daily&limit=1000", u)).body;
    expect([stats.total, stats.today, progress.totalXp, progress.today.xp, board.me?.xp]).toEqual([450, 450, 450, 450, 450]);
  });

  it("derives the 30 XP daily goal from activity on read", async () => {
    const u = newUser();
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'exercise', 'squat', now(), 600, '{"good_reps": 5}', 'exercise_module'),
              ($3, $2, 'exercise', 'squat', now(), 600, '{"good_reps": 5}', 'exercise_module')`,
      [crypto.randomUUID(), u, crypto.randomUUID()]);
    const stats = (await get<Stats>("/v1/xp/stats", u)).body;
    expect(stats.total).toBe(10 + 10 + 30);
    expect(stats.by_source).toMatchObject({ exercise: 20, daily_goal: 30 });
  });

  it("caps challenge wins at 200 a day on read and counts them in stats, history and every board window", async () => {
    const u = newUser();
    const tz = xpTimeZone();
    const now = new Date();
    await challengeWin(u, 150, new Date(now.getTime() - 60_000));
    await challengeWin(u, 150, now);
    await award({ subject: u, source: "social", reason: "special_event", amount: 40, idempotency_key: "ev" });
    await pastAward(u, 40, 100); // before this month and week: lifetime only

    const stats = (await get<Stats>("/v1/xp/stats", u)).body;
    expect(stats.total).toBe(200 + 40 + 100);
    expect(stats.today).toBe(240);
    expect(stats.month).toBe(240);
    expect(stats.week).toBe(240);
    expect(stats.by_source).toEqual({ run: 0, exercise: 0, campus: 100, challenge: 200, social: 40, daily_goal: 0 });
    expect(stats.level).toBe(1);
    expect(stats.level_progress).toEqual({ current_level_xp: 0, next_level_xp: 2000, into_level: 340, needed: 1660 });

    for (const window of ["daily", "weekly", "monthly"]) {
      const board = (await get<Board>(`/v1/leaderboard/xp?window=${window}&limit=1000`, u)).body;
      expect(board.window).toBe(window);
      expect(board.me?.xp, window).toBe(240);
    }
    const history = (await get<History>("/v1/xp/history?limit=100", u)).body;
    expect(history.items.filter((i) => i.source === "challenge").map((i) => i.amount).sort()).toEqual([-100, 150, 150]);
    expect(xpDay(now, tz)).toBe(xpDay(new Date(history.items[0]!.created_at), tz));
  });

  it("week and month follow the Monday week and the calendar month in XP_TIMEZONE", async () => {
    const u = newUser();
    const tz = xpTimeZone();
    const today = xpDay(new Date(), tz);
    for (const daysAgo of [1, 3, 8, 20, 35]) await pastAward(u, daysAgo, 10 + daysAgo);
    const stats = (await get<Stats>("/v1/xp/stats", u)).body;
    let week = 0;
    let month = 0;
    for (const daysAgo of [1, 3, 8, 20, 35]) {
      const day = xpDay(new Date(Date.now() - daysAgo * 86_400_000), tz);
      if (day >= weekStartFor(today) && day <= shiftDay(weekStartFor(today), 6)) week += 10 + daysAgo;
      if (day.slice(0, 7) === today.slice(0, 7)) month += 10 + daysAgo;
    }
    expect(stats).toMatchObject({ total: 11 + 13 + 18 + 30 + 45, today: 0, week, month });
  });

  it("pages the history newest first with a keyset cursor; the non-reversed amounts add up to the total", async () => {
    const u = newUser();
    await pool.query(
      `INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics, source_module)
       VALUES ($1, $2, 'run', 'territory_run', now() - interval '2 days', 1800, $3, 'run_module')`,
      [crypto.randomUUID(), u, JSON.stringify({ distance_m: 20_000, territory_claimed: true, rejection_reason: null })]);
    for (let d = 1; d <= 3; d++) await pastAward(u, d, 30);
    await award({ subject: u, source: "social", reason: "special_event", amount: 10, idempotency_key: "ev" });
    await award({ subject: u, source: "social", reason: "ambassador_task", amount: 5, idempotency_key: "t" });
    await reverse({ source: "social", idempotency_key: "t", reason: "duplicate" });

    const seen: HistoryItem[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = `/v1/xp/history?limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const page: History = (await get<History>(url, u)).body;
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items);
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 20);

    const all = (await get<History>("/v1/xp/history?limit=100", u)).body;
    expect(all.next_cursor).toBeNull();
    expect(seen.map((i) => i.id)).toEqual(all.items.map((i) => i.id));
    expect(new Set(seen.map((i) => i.id)).size).toBe(seen.length);
    const times = seen.map((i) => Date.parse(i.created_at));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(seen.map((i) => i.reason)).toEqual(expect.arrayContaining(
      ["run_completed", "run_distance", "territory_captured", "run_daily_cap", "daily_goal", "territory_claim", "special_event", "ambassador_task"]));
    expect(seen.filter((i) => !i.reversed).reduce((sum, i) => sum + i.amount, 0)).toBe(await total(u));
    expect(seen.find((i) => i.reason === "run_completed")?.source).toBe("run");

    for (const bad of ["limit=0", "limit=101", "limit=abc", "cursor=%25%25", `cursor=${Buffer.from("nope").toString("base64url")}`]) {
      expect((await get(`/v1/xp/history?${bad}`, u)).status, bad).toBe(400);
    }
  });

  it("writes one xp.level_up outbox row when an award crosses a level; a reversal lowers it silently", async () => {
    const u = newUser();
    for (let d = 1; d <= 13; d++) await pastAward(u, d, 150); // 1950: level 1
    const crossing = await award({ subject: u, source: "social", reason: "ambassador_task", amount: 60, idempotency_key: "t-1" });
    expect(crossing.json()).toBe(2010);
    type OutboxRow = { id: string; event_type: string; payload: Record<string, unknown> };
    const outbox = async (): Promise<OutboxRow[]> => (await pool.query<OutboxRow>(
      "SELECT id, event_type, payload FROM notification_outbox WHERE user_id = $1", [u])).rows;
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe("xp.level_up");
    expect(rows[0]!.payload).toEqual({ level: 2, xp: 2010, dedupe_key: `level:${u}:2` });

    // a replay or another award within the level writes nothing
    await award({ subject: u, source: "social", reason: "ambassador_task", amount: 60, idempotency_key: "t-1" });
    await award({ subject: u, source: "social", reason: "special_event", amount: 5, idempotency_key: "e-1" });
    expect(await outbox()).toHaveLength(1);

    // reversing drops back to level 1 without a notification
    const down = await reverse({ source: "social", idempotency_key: "t-1", reason: "fraud" });
    expect(down.json()).toBe(1955);
    expect((await get<Stats>("/v1/xp/stats", u)).body.level).toBe(1);
    expect(await outbox()).toHaveLength(1);

    // reaching level 2 again is not announced twice
    expect((await award({ subject: u, source: "social", reason: "ambassador_task", amount: 60, idempotency_key: "t-2" })).json()).toBe(2015);
    expect(await outbox()).toHaveLength(1);
  });

  it("the internal routes need a service token; the app routes need a user token", async () => {
    const u = newUser();
    const body = { subject: u, source: "social", reason: "special_event", amount: 10, idempotency_key: "auth" };
    const user = bearer(await userToken(u));
    expect((await award(body, {})).statusCode).toBe(401);
    expect((await award(body, user)).statusCode).toBe(401);
    expect((await award(body, { authorization: "Bearer wrong" })).statusCode).toBe(401);
    expect((await reverse({ source: "social", idempotency_key: "auth", reason: "x" }, {})).statusCode).toBe(401);
    expect((await reverse({ source: "social", idempotency_key: "auth", reason: "x" }, user)).statusCode).toBe(401);
    expect((await pool.query("SELECT 1 FROM external_xp_awards WHERE user_id = $1", [u])).rowCount).toBe(0);
    for (const url of ["/v1/xp/stats", "/v1/xp/history"]) {
      expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);
      expect((await app.inject({ method: "GET", url, headers: service })).statusCode).toBe(401);
    }
  });

  it("rate-limits the XP reads per user", async () => {
    const u = newUser();
    const headers = bearer(await userToken(u));
    let last = 0;
    for (let i = 0; i <= RATE_LIMIT_XP_READ_PER_MIN; i++) {
      last = (await app.inject({ method: "GET", url: "/v1/xp/history?limit=1", headers })).statusCode;
    }
    expect(last).toBe(429);
    // another user is unaffected
    expect((await get("/v1/xp/stats", newUser())).status).toBe(200);
  });
});
