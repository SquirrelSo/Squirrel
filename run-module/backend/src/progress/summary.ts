import { pool } from "../db/pool.js";
import { getUserXpEntries, shiftDay, weekStartFor, xpTimeZone } from "../xp/query.js";
import { levelForXp as xpLevel, summarize, xpByCategory, xpDay, validTimeZone, type ActivityRow, type XpCategory } from "../xp/rules.js";

export type DayRow = {
  date: string; xp: number; steps: number; workouts: number; workoutMinutes: number;
  activeMinutes: number; distanceKm: number; calories: number; challengesCompleted: number; goalsCompleted: number;
};
export type Streak = { current: number; longest: number; lastQualifyingDate: string | null; todayStatus: "done" | "at_risk" | "none" };

type ProgressActivity = ActivityRow & { user_id: string; calories_kcal: number | string | null };
type ChallengeAward = { resolved_at: Date };

const isoDate = (value: string | undefined, fallback: string): string => {
  const date = value ?? fallback;
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : null;
  if (!parsed || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw Object.assign(new Error("date must be YYYY-MM-DD"), { statusCode: 400 });
  }
  return date;
};

const number = (value: unknown): number => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
};

function activityDate(row: ProgressActivity, fallbackZone: string): string {
  return xpDay(row.started_at, validTimeZone(row.metrics?.["timezone"]) ?? fallbackZone);
}

function blankDay(date: string): DayRow {
  return { date, xp: 0, steps: 0, workouts: 0, workoutMinutes: 0, activeMinutes: 0, distanceKm: 0,
    calories: 0, challengesCompleted: 0, goalsCompleted: 0 };
}

export async function readProgress(userId: string): Promise<{ days: Map<string, DayRow>; streak: Streak; timezone: string; xp: number; byDay: Record<string, number>; xpBySource: Record<XpCategory, number> }> {
  const timezone = xpTimeZone();
  const [activityResult, xpEntries, challengeResult] = await Promise.all([
    pool.query<ProgressActivity>(
      `SELECT id, user_id, type, source_module, started_at, duration_s, metrics, created_at, calories_kcal
       FROM activity_sessions WHERE user_id = $1 ORDER BY started_at, created_at, id`, [userId]),
    getUserXpEntries(userId),
    pool.query<ChallengeAward>(
      `SELECT c.resolved_at
       FROM challenge_participants cp JOIN challenges c ON c.id = cp.challenge_id
       WHERE cp.user_id = $1 AND cp.is_winner IS TRUE AND cp.xp_awarded > 0 AND c.state = 'resolved'
         AND c.resolved_at IS NOT NULL
       ORDER BY c.resolved_at`, [userId]),
  ]);
  // XP per day comes only from the XP lines (src/xp), which already include challenge wins and
  // awards after every cap (ADR-033), so a day's XP here is the same number the boards and stats use.
  const xpSummary = summarize(xpEntries);

  const days = new Map<string, DayRow>();
  const rowFor = (date: string) => {
    let row = days.get(date);
    if (!row) { row = blankDay(date); days.set(date, row); }
    return row;
  };
  for (const row of activityResult.rows) {
    const day = rowFor(activityDate(row, timezone));
    const metrics = row.metrics ?? {};
    if (row.type === "exercise" && row.source_module === "exercise_module") {
      day.workouts += 1;
      day.workoutMinutes += Math.max(0, number(metrics["active_time_s"] ?? row.duration_s)) / 60;
    }
    if (row.type === "run" && row.source_module === "run_module") {
      day.workouts += 1;
      day.workoutMinutes += Math.max(0, number(metrics["moving_time_s"] ?? row.duration_s)) / 60;
      day.distanceKm += Math.max(0, number(metrics["distance_m"])) / 1000;
      day.activeMinutes += Math.max(0, number(metrics["moving_time_s"] ?? row.duration_s)) / 60;
    } else if (row.type === "exercise" && row.source_module === "exercise_module") {
      day.activeMinutes += Math.max(0, number(metrics["active_time_s"] ?? row.duration_s)) / 60;
    }
    day.steps += Math.max(0, number(metrics["steps"]));
    day.calories += Math.max(0, number(row.calories_kcal));
  }

  for (const award of challengeResult.rows) {
    rowFor(xpDay(award.resolved_at, timezone)).challengesCompleted += 1;
  }
  for (const [date, row] of days) row.xp = xpSummary.byDay[date] ?? 0;
  // Round at the day bucket so daily, weekly, history, and lifetime views share identical minutes.
  for (const row of days.values()) {
    row.workoutMinutes = Math.round(row.workoutMinutes);
    row.activeMinutes = Math.round(row.activeMinutes);
  }

  // The daily-goal bonus (ADR-033) is part of each day's XP above; the goals list stays empty
  // until goal targets are defined.
  const today = xpDay(new Date(), timezone);
  const activeDates = [...days.values()].filter((day) => day.workouts > 0 || day.distanceKm > 0 || day.steps > 0)
    .map((day) => day.date).sort();
  const active = new Set(activeDates);
  const yesterday = shiftDay(today, -1);
  let current = 0;
  let cursor = active.has(today) ? today : yesterday;
  while (active.has(cursor)) { current += 1; cursor = shiftDay(cursor, -1); }
  let longest = 0;
  let run = 0;
  let previous: string | null = null;
  for (const date of activeDates) {
    run = previous !== null && shiftDay(previous, 1) === date ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = date;
  }
  const lastQualifyingDate = activeDates.at(-1) ?? null;
  const streak: Streak = { current, longest, lastQualifyingDate,
    todayStatus: active.has(today) ? "done" : active.has(yesterday) ? "at_risk" : "none" };
  return { days, streak, timezone, xp: xpSummary.xp, byDay: xpSummary.byDay, xpBySource: xpByCategory(xpEntries) };
}

export function progressDay(data: Awaited<ReturnType<typeof readProgress>>, date: string, isToday: boolean): DayRow & {
  goals: never[]; goalsTotal: number; streak: Streak; isToday: boolean;
} {
  return { ...dayRow(data, date),
    goals: [], goalsTotal: 0, streak: data.streak, isToday };
}

function dayRow(data: Awaited<ReturnType<typeof readProgress>>, date: string): DayRow {
  const row = data.days.get(date);
  return { ...blankDay(date), ...(row ?? {}), xp: row?.xp ?? data.byDay[date] ?? 0 };
}

export function progressTotals(rows: DayRow[]) {
  const totals = rows.reduce((total, day) => ({
    xp: total.xp + day.xp, steps: total.steps + day.steps, workouts: total.workouts + day.workouts,
    workoutMinutes: total.workoutMinutes + day.workoutMinutes, activeMinutes: total.activeMinutes + day.activeMinutes,
    distanceKm: total.distanceKm + day.distanceKm, calories: total.calories + day.calories,
    challengesCompleted: total.challengesCompleted + day.challengesCompleted,
    goalsCompleted: total.goalsCompleted + day.goalsCompleted,
  }), { xp: 0, steps: 0, workouts: 0, workoutMinutes: 0, activeMinutes: 0, distanceKm: 0,
    calories: 0, challengesCompleted: 0, goalsCompleted: 0 });
  return { ...totals, activeDays: rows.filter((day) => day.workouts > 0 || day.distanceKm > 0 || day.steps > 0).length };
}

export const levelForXp = xpLevel;

/** The app's original four sources are always present; social and daily_goal appear once earned,
 *  so the values still add up to totalXp. */
function xpBySource(byCategory: Record<XpCategory, number>): Record<string, number> {
  const bySource: Record<string, number> = { run: byCategory.run, exercise: byCategory.exercise,
    campus: byCategory.campus, challenge: byCategory.challenge };
  if (byCategory.social !== 0) bySource["social"] = byCategory.social;
  if (byCategory.daily_goal !== 0) bySource["daily_goal"] = byCategory.daily_goal;
  return bySource;
}

/** Compatibility shape consumed by mobile-4 at startup; all totals come from the shared progress derivation. */
export async function xpCompatibilitySummary(userId: string) {
  const data = await readProgress(userId);
  const today = xpDay(new Date(), data.timezone);
  const start = weekStartFor(today);
  const weekDays = Array.from({ length: 7 }, (_, i) => dayRow(data, shiftDay(start, i)));
  return {
    totalXp: data.xp,
    level: levelForXp(data.xp),
    today: data.days.get(today)?.xp ?? data.byDay[today] ?? 0,
    week: progressTotals(weekDays).xp,
    bySource: xpBySource(data.xpBySource),
  };
}

export async function lifetimeProgress(userId: string) {
  const data = await readProgress(userId);
  const rows = [...data.days.values()];
  const totals = progressTotals(rows);
  const today = xpDay(new Date(), data.timezone);
  return { userId, timezone: data.timezone, totalXp: data.xp, level: levelForXp(data.xp),
    totalWorkouts: totals.workouts, totalWorkoutMinutes: totals.workoutMinutes, totalActiveMinutes: totals.activeMinutes,
    totalSteps: totals.steps, totalDistanceKm: totals.distanceKm, totalCalories: totals.calories,
    challengesCompleted: totals.challengesCompleted, streak: data.streak, today: progressDay(data, today, true) };
}

export async function dailyProgress(userId: string, date?: string) {
  const data = await readProgress(userId);
  const today = xpDay(new Date(), data.timezone);
  const requested = isoDate(date, today);
  return progressDay(data, requested, requested === today);
}

export async function weeklyProgress(userId: string, weekStart?: string) {
  const data = await readProgress(userId);
  const today = xpDay(new Date(), data.timezone);
  const start = weekStartFor(isoDate(weekStart, weekStartFor(today)));
  const days = Array.from({ length: 7 }, (_, i) => dayRow(data, shiftDay(start, i)));
  const previous = Array.from({ length: 7 }, (_, i) => dayRow(data, shiftDay(start, i - 7)));
  const currentTotals = progressTotals(days);
  const previousTotals = progressTotals(previous);
  const changeKeys = ["xp", "steps", "workouts", "workoutMinutes", "activeMinutes", "challengesCompleted"] as const;
  const change = Object.fromEntries(changeKeys.map((key) => [key, previousTotals[key] === 0 ? null : (currentTotals[key] - previousTotals[key]) / previousTotals[key]]));
  return { ...currentTotals, weekStart: start, weekEnd: shiftDay(start, 6), streak: data.streak, previous: previousTotals, change, days };
}

export async function progressHistory(userId: string, days: number) {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw Object.assign(new Error("days must be between 1 and 366"), { statusCode: 400 });
  const data = await readProgress(userId);
  const to = xpDay(new Date(), data.timezone);
  const from = shiftDay(to, 1 - days);
  return { from, to, days: Array.from({ length: days }, (_, i) => dayRow(data, shiftDay(from, i))) };
}
