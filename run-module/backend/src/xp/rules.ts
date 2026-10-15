/**
 * src/xp/rules.ts
 *
 * The XP rules (ADR-027). Pure: activity rows in, XP out. Nothing is stored — XP is always
 * derived from activity_sessions, so a rule change re-scores history consistently and there is
 * no balance to drift out of sync.
 *
 *   Run (source run_module)        50 for a completed run
 *                                  +1 per 100 m
 *                                  +25 if it captured territory
 *                                  rejected runs earn nothing
 *                                  at most 150 XP from runs per day
 *
 *   Exercise (source exercise_module), by the work that counted
 *                                  2 per full-range rep (rep exercises)
 *                                  1 per 2 counted lifts (timed: high knees)
 *                                  at most 70 XP per session
 *                                  at most 150 XP from exercise per day
 *
 * The Exercise Module counts only controlled reps (and high-knee lifts at running pace): too-fast
 * attempts are reported but never counted. A shallow rep counts toward the set, with a warning,
 * but only full-range reps (`good_reps`) earn XP, and idle time earns nothing. So doing it badly
 * on purpose is not faster XP. Rows written before good reps were
 * reported carry `reps` including shallow ones: their good share is `reps × correct_pct`.
 *
 * "Per day" is the person's own calendar day: the time zone their phone recorded the activity in
 * (metrics.timezone, an IANA name, on runs and exercise sessions alike), else XP_TIMEZONE
 * (default Asia/Kolkata), never UTC: a UTC day would reset at 5:30 am for Indian users and put a
 * 00:30 workout on the day before. Within a day, sessions are counted in the order they started,
 * so the cap always cuts the latest ones.
 *
 *   Daily goal (ADR-033)           30 once per XP day with at least one row that earns XP before
 *                                  the caps (a non-rejected run, or an exercise session with
 *                                  counted reps); outside the run and exercise caps
 *
 * Challenge wins and awards reported by other services are scored in ./awards.ts (ADR-033); every
 * source turns into XpEntry lines, and summarize() turns any set of lines into the totals, so the
 * profile, the boards, progress and the history all add up the same lines.
 *
 * Not built, because they are not defined yet: streaks, personal bests and rest-day bonuses.
 */

export const RUN_COMPLETION_XP = 50;
export const RUN_METRES_PER_XP = 100;
export const TERRITORY_XP = 25;
export const DAILY_RUN_XP_CAP = 150;

export const EXERCISE_XP_PER_REP = 2;
export const EXERCISE_LIFTS_PER_XP = 2;
export const EXERCISE_SESSION_XP_CAP = 70;
export const DAILY_EXERCISE_XP_CAP = 150;

export const DAILY_GOAL_XP = 30;

export const XP_PER_LEVEL = 2000;

export const DEFAULT_XP_TIMEZONE = "Asia/Kolkata";

/** One activity_sessions row, as far as XP is concerned. */
export interface ActivityRow {
  id: string;
  type: string;
  source_module: string;
  started_at: Date;
  duration_s: number;
  metrics: Record<string, unknown> | null;
  created_at: Date;
}

export type XpReason =
  | "run_completed"
  | "run_distance"
  | "territory_captured"
  | "run_daily_cap"
  | "exercise_session"
  | "exercise_daily_cap"
  | "daily_goal"
  | "challenge completed"
  | "challenge_daily_cap"
  | "territory_claim"
  | "territory_steal"
  | "territory_defend"
  | "territory_daily_cap"
  | "meetup_checkin"
  | "shared_workout_finished"
  | "shared_workout_daily_limit"
  | "buddy_connected"
  | "ambassador_referral"
  | "ambassador_task"
  | "special_event"
  | "campus_awards_daily_cap"
  | "exercise_awards_daily_cap"
  | "social_awards_daily_cap";

/** Where a line of XP came from, as the app groups it (`by_source`). */
export type XpCategory = "run" | "exercise" | "campus" | "challenge" | "social" | "daily_goal";
export const XP_CATEGORIES: XpCategory[] = ["run", "exercise", "campus", "challenge", "social", "daily_goal"];

/** One line of XP: a reason on one row (a run's distance, an award, a cap cut). */
export interface XpEntry {
  /** Stable and unique per user: the history's id and keyset tiebreak. */
  id: string;
  reason: XpReason;
  /** Negative for a cap cut. A reversed award keeps its amount here but counts 0. */
  xp: number;
  category: XpCategory;
  /** The XP day (YYYY-MM-DD) the line counts on. */
  day: string;
  /** When the row behind the line was recorded. */
  created_at: Date;
  /** The activity row, challenge or caller's own id the line is for. */
  source_id: string | null;
  /** The row behind this line earned XP after the caps (it moves updated_at). */
  counts: boolean;
  /** An external award that was reversed: shown in the history, counts 0. */
  reversed: boolean;
}

export interface XpLine {
  reason: XpReason;
  xp: number;
}

export interface XpSummary {
  xp: number;
  /** When XP last went up: the latest row that earned any. Null for a user with no XP yet. */
  updated_at: Date | null;
  /** Totals per reason, in a fixed order; they add up to `xp`. Caps appear as negative lines. */
  breakdown: XpLine[];
  /** XP awarded per calendar day (YYYY-MM-DD, in each row's own time zone), after the caps. */
  byDay: Record<string, number>;
}

const REASON_ORDER: XpReason[] = [
  "run_completed",
  "run_distance",
  "territory_captured",
  "run_daily_cap",
  "exercise_session",
  "exercise_daily_cap",
  "daily_goal",
  "challenge completed",
  "challenge_daily_cap",
  "territory_claim",
  "territory_steal",
  "territory_defend",
  "territory_daily_cap",
  "meetup_checkin",
  "shared_workout_finished",
  "shared_workout_daily_limit",
  "buddy_connected",
  "ambassador_referral",
  "ambassador_task",
  "special_event",
  "campus_awards_daily_cap",
  "exercise_awards_daily_cap",
  "social_awards_daily_cap",
];

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** XP a single exercise session earns before the daily cap, from its activity metrics. */
export function exerciseSessionXp(metrics: Record<string, unknown> | null): number {
  const m = metrics ?? {};
  let xp: number;
  const lifts = count(m["lifts"]);
  if (lifts !== null) {
    xp = Math.floor(lifts / EXERCISE_LIFTS_PER_XP);
  } else {
    let good = count(m["good_reps"]);
    if (good === null) {
      const reps = count(m["reps"]) ?? 0;
      const correct = typeof m["correct_pct"] === "number" && Number.isFinite(m["correct_pct"]) ? m["correct_pct"] : 0;
      good = Math.floor((reps * Math.min(100, Math.max(0, correct))) / 100);
    }
    xp = good * EXERCISE_XP_PER_REP;
  }
  return Math.min(EXERCISE_SESSION_XP_CAP, xp);
}

/** The lines a single run earns before the daily cap (empty for a rejected run). */
export function runLines(metrics: Record<string, unknown> | null): XpLine[] {
  const m = metrics ?? {};
  // finalize.ts writes rejection_reason: null for accepted and flagged runs, a reason otherwise.
  if (m["rejection_reason"] !== null && m["rejection_reason"] !== undefined) return [];
  const distance = typeof m["distance_m"] === "number" && Number.isFinite(m["distance_m"]) ? m["distance_m"] : 0;
  const lines: XpLine[] = [
    { reason: "run_completed", xp: RUN_COMPLETION_XP },
    { reason: "run_distance", xp: Math.floor(Math.max(0, distance) / RUN_METRES_PER_XP) },
  ];
  if (m["territory_claimed"] === true) lines.push({ reason: "territory_captured", xp: TERRITORY_XP });
  return lines;
}

/** The name if it is a valid IANA time zone, else null. */
export function validTimeZone(zone: unknown): string | null {
  if (typeof zone !== "string" || !zone.trim() || zone.length > 64) return null;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** Calendar day (YYYY-MM-DD) of a moment in the given IANA time zone. */
export function xpDay(moment: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(moment);
}

type Kind = { lines: (row: ActivityRow) => XpLine[]; cap: number; capReason: XpReason; category: XpCategory };

const KINDS: Record<string, Kind> = {
  // A row counts only when the module that owns its type wrote it.
  "run/run_module": { lines: (row) => runLines(row.metrics), cap: DAILY_RUN_XP_CAP, capReason: "run_daily_cap", category: "run" },
  "exercise/exercise_module": {
    lines: (row) => {
      const xp = exerciseSessionXp(row.metrics);
      return xp > 0 ? [{ reason: "exercise_session", xp }] : [];
    },
    cap: DAILY_EXERCISE_XP_CAP,
    capReason: "exercise_daily_cap",
    category: "exercise",
  },
};

/**
 * The XP lines a user's activity rows earn: each row's lines, a negative line where a daily cap cuts
 * it, and the daily goal on each day with a row that earns XP. Rows count in the order they started.
 */
export function activityEntries(rows: ActivityRow[], timeZone: string = DEFAULT_XP_TIMEZONE): XpEntry[] {
  const ordered = [...rows].sort(
    (a, b) =>
      a.started_at.getTime() - b.started_at.getTime() ||
      a.created_at.getTime() - b.created_at.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const entries: XpEntry[] = [];
  const usedToday = new Map<string, number>(); // "<kind>|<day>" -> XP already awarded
  const goalDays = new Set<string>();

  for (const row of ordered) {
    const key = `${row.type}/${row.source_module}`;
    const kind = KINDS[key];
    if (!kind) continue;
    const lines = kind.lines(row);
    const raw = lines.reduce((sum, line) => sum + line.xp, 0);
    if (raw <= 0) continue;

    const zone = validTimeZone(row.metrics?.["timezone"]) ?? timeZone;
    const day = xpDay(row.started_at, zone);
    const bucket = `${key}|${day}`;
    const used = usedToday.get(bucket) ?? 0;
    const awarded = Math.min(raw, Math.max(0, kind.cap - used));
    usedToday.set(bucket, used + awarded);

    const base = { category: kind.category, day, created_at: row.created_at, source_id: row.id, counts: awarded > 0, reversed: false };
    for (const line of lines) entries.push({ ...base, id: `activity:${row.id}:${line.reason}`, reason: line.reason, xp: line.xp });
    if (awarded < raw) entries.push({ ...base, id: `activity:${row.id}:${kind.capReason}`, reason: kind.capReason, xp: awarded - raw });

    // The first row of the day always earns something (its kind has the whole cap left), so the
    // goal never lands on a day that earned nothing.
    if (!goalDays.has(day)) {
      goalDays.add(day);
      entries.push({ ...base, id: `daily_goal:${day}`, reason: "daily_goal", category: "daily_goal", xp: DAILY_GOAL_XP, counts: true });
    }
  }
  return entries;
}

/** Totals for any set of lines: reversed awards count 0, caps are already negative lines. */
export function summarize(entries: XpEntry[]): XpSummary {
  const totals = new Map<XpReason, number>();
  const byDay: Record<string, number> = {};
  let updatedAt: Date | null = null;
  for (const entry of entries) {
    if (entry.reversed) continue;
    totals.set(entry.reason, (totals.get(entry.reason) ?? 0) + entry.xp);
    byDay[entry.day] = (byDay[entry.day] ?? 0) + entry.xp;
    if (entry.counts && (updatedAt === null || entry.created_at > updatedAt)) updatedAt = entry.created_at;
  }
  for (const [day, xp] of Object.entries(byDay)) if (xp === 0) delete byDay[day];
  const known = REASON_ORDER.filter((reason) => totals.has(reason));
  const other = [...totals.keys()].filter((reason) => !REASON_ORDER.includes(reason));
  const breakdown = [...known, ...other].map((reason) => ({ reason, xp: totals.get(reason)! }));
  return { xp: breakdown.reduce((sum, line) => sum + line.xp, 0), updated_at: updatedAt, breakdown, byDay };
}

/** XP per category (the app's `by_source`); the values add up to the total. */
export function xpByCategory(entries: XpEntry[]): Record<XpCategory, number> {
  const out = Object.fromEntries(XP_CATEGORIES.map((c) => [c, 0])) as Record<XpCategory, number>;
  for (const entry of entries) if (!entry.reversed) out[entry.category] += entry.xp;
  return out;
}

export function computeXp(rows: ActivityRow[], timeZone: string = DEFAULT_XP_TIMEZONE): XpSummary {
  return summarize(activityEntries(rows, timeZone));
}

/** Level from total XP: a level every XP_PER_LEVEL, starting at 1. */
export interface LevelInfo { level: number; currentXP: number; xpForCurrentLevel: number; xpForNextLevel: number; progress: number }

export function levelForXp(totalXp: number): LevelInfo {
  const level = Math.floor(Math.max(0, totalXp) / XP_PER_LEVEL) + 1;
  const xpForCurrentLevel = (level - 1) * XP_PER_LEVEL;
  const xpForNextLevel = level * XP_PER_LEVEL;
  return { level, currentXP: totalXp, xpForCurrentLevel, xpForNextLevel,
    progress: (totalXp - xpForCurrentLevel) / (xpForNextLevel - xpForCurrentLevel) };
}
