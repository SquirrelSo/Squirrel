import { describe, it, expect } from "vitest";
import { computeXp, DAILY_GOAL_XP, exerciseSessionXp, runLines, xpDay, type ActivityRow } from "./rules.js";

let seq = 0;
function row(over: Partial<ActivityRow> & { started_at: Date }): ActivityRow {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    type: "run",
    source_module: "run_module",
    duration_s: 1800,
    metrics: { distance_m: 5000, territory_claimed: true, rejection_reason: null },
    created_at: over.started_at,
    ...over,
  };
}

const IST = "Asia/Kolkata";
const at = (iso: string): Date => new Date(iso);

describe("run XP", () => {
  it("a 5 km run that captures territory earns 125 (50 + 50 + 25), plus the day's goal (ADR-033)", () => {
    expect(computeXp([row({ started_at: at("2026-09-26T01:00:00Z") })], IST)).toEqual({
      xp: 125 + DAILY_GOAL_XP,
      updated_at: at("2026-09-26T01:00:00Z"),
      breakdown: [
        { reason: "run_completed", xp: 50 },
        { reason: "run_distance", xp: 50 },
        { reason: "territory_captured", xp: 25 },
        { reason: "daily_goal", xp: DAILY_GOAL_XP },
      ],
      byDay: { "2026-09-26": 125 + DAILY_GOAL_XP },
    });
  });

  it("distance is 1 XP per whole 100 m; no territory, no territory XP", () => {
    expect(runLines({ distance_m: 799, territory_claimed: false, rejection_reason: null })).toEqual([
      { reason: "run_completed", xp: 50 },
      { reason: "run_distance", xp: 7 },
    ]);
  });

  it("a rejected run earns nothing", () => {
    const rejected = row({
      started_at: at("2026-09-26T01:00:00Z"),
      metrics: { distance_m: 5000, territory_claimed: false, rejection_reason: "anticheat_rejected" },
    });
    expect(computeXp([rejected], IST)).toEqual({ xp: 0, updated_at: null, breakdown: [], byDay: {} });
  });

  it("caps runs at 150 XP a day, cutting the latest runs, and shows the cap as a line", () => {
    const rows = [
      row({ started_at: at("2026-09-26T03:00:00Z") }), // 125
      row({ started_at: at("2026-09-26T05:00:00Z") }), // 125 → only 25 left
      row({ started_at: at("2026-09-26T07:00:00Z") }), // 125 → 0 left
    ];
    const summary = computeXp(rows, IST);
    expect(summary.xp).toBe(150 + DAILY_GOAL_XP); // the goal is outside the run cap
    expect(summary.breakdown.find((l) => l.reason === "run_daily_cap")).toEqual({ reason: "run_daily_cap", xp: -225 });
    // XP last went up with the second run; the third earned nothing.
    expect(summary.updated_at).toEqual(at("2026-09-26T05:00:00Z"));
  });

  it("the cap follows the Indian calendar day, not UTC", () => {
    // 23:00 UTC on the 25th is 04:30 IST on the 26th: same IST day as the 10:00 UTC run.
    const rows = [row({ started_at: at("2026-09-25T23:00:00Z") }), row({ started_at: at("2026-09-26T10:00:00Z") })];
    expect(computeXp(rows, IST).xp).toBe(150 + DAILY_GOAL_XP);
    expect(computeXp(rows, "UTC").xp).toBe(250 + 2 * DAILY_GOAL_XP);
    expect(xpDay(at("2026-09-25T23:00:00Z"), IST)).toBe("2026-09-26");
  });

  it("the order rows arrive in does not change the result", () => {
    const rows = [
      row({ started_at: at("2026-09-26T07:00:00Z"), metrics: { distance_m: 0, territory_claimed: false, rejection_reason: null } }),
      row({ started_at: at("2026-09-26T03:00:00Z") }),
      row({ started_at: at("2026-09-26T05:00:00Z") }),
    ];
    expect(computeXp(rows, IST)).toEqual(computeXp([...rows].reverse(), IST));
  });
});

describe("exercise XP", () => {
  it("pays for counted reps and lifts, never for time", () => {
    expect(exerciseSessionXp({ reps: 12, good_reps: 12, correct_pct: 100 })).toBe(24);
    // the field test: 36 squats, every one shallow → none counted
    expect(exerciseSessionXp({ reps: 0, good_reps: 0, reps_not_counted: 36, correct_pct: 0 })).toBe(0);
    expect(exerciseSessionXp({ reps: 50, good_reps: 50 })).toBe(70); // per-session cap
    expect(exerciseSessionXp({ lifts: 61, correct_pct: 80 })).toBe(30); // timed: 1 per 2 lifts
    expect(exerciseSessionXp({})).toBe(0);
    expect(exerciseSessionXp(null)).toBe(0);
  });

  it("scores rows from before good reps were reported by their correct share", () => {
    // reps then included shallow ones; correct_pct excludes them
    expect(exerciseSessionXp({ reps: 36, correct_pct: 0 })).toBe(0);
    expect(exerciseSessionXp({ reps: 20, correct_pct: 50 })).toBe(20);
  });

  it("ignores how long the session took: idle time earns nothing", () => {
    const long = row({ started_at: at("2026-09-26T02:00:00Z"), type: "exercise", source_module: "exercise_module", duration_s: 3 * 3600, metrics: { good_reps: 0 } });
    expect(computeXp([long], IST).xp).toBe(0);
  });

  const workout = (iso: string, goodReps: number): ActivityRow =>
    row({ started_at: at(iso), type: "exercise", source_module: "exercise_module", duration_s: 600, metrics: { reps: goodReps, good_reps: goodReps } });

  it("caps exercise at 150 XP a day, separately from runs", () => {
    const rows = [
      workout("2026-09-26T02:00:00Z", 50), // 70
      workout("2026-09-26T04:00:00Z", 50), // 70
      workout("2026-09-26T06:00:00Z", 50), // 70 → 10
      row({ started_at: at("2026-09-26T08:00:00Z") }), // run: 125, its own cap
    ];
    const summary = computeXp(rows, IST);
    expect(summary.xp).toBe(150 + 125 + DAILY_GOAL_XP); // one goal for the day, whatever earned it
    expect(summary.breakdown).toEqual([
      { reason: "run_completed", xp: 50 },
      { reason: "run_distance", xp: 50 },
      { reason: "territory_captured", xp: 25 },
      { reason: "exercise_session", xp: 210 },
      { reason: "exercise_daily_cap", xp: -60 },
      { reason: "daily_goal", xp: DAILY_GOAL_XP },
    ]);
  });

  it("a session with no counted reps earns nothing and does not move updated_at", () => {
    expect(computeXp([workout("2026-09-26T02:00:00Z", 0)], IST)).toEqual({ xp: 0, updated_at: null, breakdown: [], byDay: {} });
  });

  it("counts a row only when the module that owns its type wrote it", () => {
    const forged = [
      row({ started_at: at("2026-09-26T02:00:00Z"), type: "exercise", source_module: "run_module", duration_s: 3600 }),
      row({ started_at: at("2026-09-26T03:00:00Z"), type: "run", source_module: "exercise_module" }),
      row({ started_at: at("2026-09-26T04:00:00Z"), type: "yoga", source_module: "exercise_module", duration_s: 3600 }),
    ];
    expect(computeXp(forged, IST).xp).toBe(0);
  });

  it("a new user has 0 XP, never null", () => {
    expect(computeXp([], IST)).toEqual({ xp: 0, updated_at: null, breakdown: [], byDay: {} });
  });
});

describe("each row's own day", () => {
  const workout = (iso: string, timezone?: string): ActivityRow =>
    row({ started_at: at(iso), type: "exercise", source_module: "exercise_module", metrics: { good_reps: 35, ...(timezone ? { timezone } : {}) } });

  it("puts a 00:30 IST workout on its IST day, not the UTC day before", () => {
    // 2026-09-26 00:30 IST = 2026-09-25 19:00 UTC; two capped days, not one
    const rows = [workout("2026-09-25T10:00:00Z", IST), workout("2026-09-25T12:00:00Z", IST), workout("2026-09-25T19:00:00Z", IST)];
    expect(computeXp(rows, "UTC").xp).toBe(140 + 70 + 2 * DAILY_GOAL_XP);
  });

  it("follows the phone's zone for each row, falling back to the default", () => {
    // 23:30 UTC on the 25th is the 26th in Kolkata but still the 25th in New York
    const ny = [workout("2026-09-25T15:00:00Z", "America/New_York"), workout("2026-09-25T16:00:00Z", "America/New_York"), workout("2026-09-25T23:30:00Z", "America/New_York")];
    expect(computeXp(ny, IST).xp).toBe(150 + DAILY_GOAL_XP);
    const unknown = [workout("2026-09-25T15:00:00Z", "Mars/Olympus"), workout("2026-09-25T16:00:00Z"), workout("2026-09-25T23:30:00Z")];
    expect(computeXp(unknown, IST).xp).toBe(140 + 70 + 2 * DAILY_GOAL_XP);
  });
});

describe("XP per day (for the boards)", () => {
  it("counts each day's XP after the caps, on the day of each row's own time zone", () => {
    const rows = [
      row({ id: "a", started_at: at("2026-09-26T01:00:00Z"), metrics: { distance_m: 20_000, territory_claimed: false, rejection_reason: null } }),
      row({ id: "b", started_at: at("2026-09-26T03:00:00Z"), metrics: { distance_m: 5000, territory_claimed: false, rejection_reason: null } }),
      // 19:00 UTC is 00:30 the next day in India
      row({ id: "c", started_at: at("2026-09-26T19:00:00Z"), metrics: { distance_m: 1000, territory_claimed: false, rejection_reason: null } }),
    ];
    expect(computeXp(rows, IST).byDay).toEqual({ "2026-09-26": 150 + DAILY_GOAL_XP, "2026-09-27": 60 + DAILY_GOAL_XP });
  });
});

describe("daily goal (ADR-033)", () => {
  const run = (iso: string, metrics: Record<string, unknown> = { distance_m: 1000, territory_claimed: false, rejection_reason: null }): ActivityRow =>
    row({ started_at: at(iso), metrics });
  const workout = (iso: string, goodReps: number, timezone?: string): ActivityRow =>
    row({ started_at: at(iso), type: "exercise", source_module: "exercise_module", metrics: { good_reps: goodReps, ...(timezone ? { timezone } : {}) } });

  it("pays 30 once per XP day with a run or a counted exercise session", () => {
    const summary = computeXp([run("2026-09-26T03:00:00Z"), workout("2026-09-26T05:00:00Z", 10), run("2026-09-27T03:00:00Z")], IST);
    expect(summary.breakdown.find((l) => l.reason === "daily_goal")).toEqual({ reason: "daily_goal", xp: 2 * DAILY_GOAL_XP });
    expect(summary.byDay).toEqual({ "2026-09-26": 60 + 20 + DAILY_GOAL_XP, "2026-09-27": 60 + DAILY_GOAL_XP });
  });

  it("an exercise session alone completes the goal", () => {
    expect(computeXp([workout("2026-09-26T05:00:00Z", 5)], IST).xp).toBe(10 + DAILY_GOAL_XP);
  });

  it("is not earned by a rejected run, a session with no counted reps, or another module's row", () => {
    const rows = [
      run("2026-09-26T03:00:00Z", { distance_m: 5000, territory_claimed: false, rejection_reason: "anticheat_rejected" }),
      workout("2026-09-26T04:00:00Z", 0),
      row({ started_at: at("2026-09-26T05:00:00Z"), type: "run", source_module: "exercise_module" }),
    ];
    expect(computeXp(rows, IST)).toEqual({ xp: 0, updated_at: null, breakdown: [], byDay: {} });
  });

  it("is outside the run and exercise caps: a capped day still has its goal", () => {
    const rows = [run("2026-09-26T03:00:00Z", { distance_m: 20_000, territory_claimed: false, rejection_reason: null }),
      run("2026-09-26T04:00:00Z", { distance_m: 20_000, territory_claimed: false, rejection_reason: null })];
    expect(computeXp(rows, IST).xp).toBe(150 + DAILY_GOAL_XP);
  });

  it("follows each row's own XP day", () => {
    // 19:00 UTC is 00:30 the next day in India: two goal days in IST, one in UTC
    const rows = [workout("2026-09-26T10:00:00Z", 5, IST), workout("2026-09-26T19:00:00Z", 5, IST)];
    expect(computeXp(rows, "UTC").breakdown.find((l) => l.reason === "daily_goal")?.xp).toBe(2 * DAILY_GOAL_XP);
    const utc = [workout("2026-09-26T10:00:00Z", 5), workout("2026-09-26T19:00:00Z", 5)];
    expect(computeXp(utc, "UTC").breakdown.find((l) => l.reason === "daily_goal")?.xp).toBe(DAILY_GOAL_XP);
  });
});
