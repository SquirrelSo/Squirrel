/**
 * src/xp/query.ts
 *
 * Reads what a user's XP is made of and scores it (ADR-027, ADR-033): their activity_sessions rows,
 * their resolved challenge wins and the awards other services reported (external_xp_awards). This is
 * the one place the Run Module reads activity_sessions; it reads every module's rows for that user,
 * because XP counts runs and exercise sessions alike, and never writes anything.
 *
 * Every number (the total, the boards, progress, stats and history) comes from the same XP lines
 * (rules.ts summarize), so the caps apply identically everywhere.
 */

import { pool } from "../db/pool.js";
import {
  activityEntries,
  DEFAULT_XP_TIMEZONE,
  summarize,
  validTimeZone,
  xpDay,
  type ActivityRow,
  type XpEntry,
  type XpSummary,
} from "./rules.js";
import { challengeEntries, externalEntries, type ChallengeWinRow, type ExternalAwardRow } from "./awards.js";

const SELECT_ACTIVITY = `
  SELECT id, type, source_module, started_at, duration_s, metrics, created_at
  FROM   activity_sessions
  WHERE  user_id = $1
`;

const SELECT_CHALLENGE_WINS = `
  SELECT c.id AS challenge_id, cp.xp_awarded, c.resolved_at
  FROM   challenge_participants cp
  JOIN   challenges c ON c.id = cp.challenge_id
  WHERE  cp.user_id = $1
    AND  cp.is_winner IS TRUE
    AND  cp.xp_awarded > 0
    AND  c.state = 'resolved'
    AND  c.resolved_at IS NOT NULL
`;

const SELECT_EXTERNAL = `
  SELECT source, idempotency_key, amount, reason, source_id, created_at, reversed_at
  FROM   external_xp_awards
  WHERE  user_id = $1
`;

/** The IANA time zone XP days follow for rows that do not carry their own. An unknown zone falls
 *  back to the default rather than failing every XP read. */
export function xpTimeZone(): string {
  return validTimeZone(process.env["XP_TIMEZONE"]?.trim()) ?? DEFAULT_XP_TIMEZONE;
}

/** Every XP line of one user, from all three sources, after the caps. */
export async function getUserXpEntries(userId: string): Promise<XpEntry[]> {
  const tz = xpTimeZone();
  const [activity, challenges, external] = await Promise.all([
    pool.query<ActivityRow>(SELECT_ACTIVITY, [userId]),
    pool.query<ChallengeWinRow>(SELECT_CHALLENGE_WINS, [userId]),
    pool.query<ExternalAwardRow>(SELECT_EXTERNAL, [userId]),
  ]);
  return [
    ...activityEntries(activity.rows, tz),
    ...challengeEntries(challenges.rows.map((r) => ({ ...r, xp_awarded: Number(r.xp_awarded) })), tz),
    ...externalEntries(external.rows.map((r) => ({ ...r, amount: Number(r.amount) })), tz),
  ];
}

export async function getUserXp(userId: string): Promise<XpSummary> {
  return summarize(await getUserXpEntries(userId));
}

export async function meetsXpGate(userId: string, minXp: number): Promise<boolean> {
  return (await getUserXp(userId)).xp >= minXp;
}

export type XpBoardWindow = "daily" | "weekly" | "monthly";
export const XP_BOARD_WINDOWS: XpBoardWindow[] = ["daily", "weekly", "monthly"];
/** Days the rolling windows cover; monthly is the calendar month so far (at most 31 days). */
export const XP_BOARD_DAYS: Record<XpBoardWindow, number> = { daily: 1, weekly: 7, monthly: 31 };

export interface XpBoardEntry {
  rank: number;
  user_id: string;
  xp: number;
}

export interface XpBoard {
  window: XpBoardWindow;
  /** Today, in XP_TIMEZONE: the last day of the window. */
  day: string;
  /** Everyone who earned XP in the window, most first; equal XP shares a rank. */
  entries: XpBoardEntry[];
}

/** Shift a YYYY-MM-DD calendar day by whole days. */
export function shiftDay(date: string, offset: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

/** Monday of the week the day is in (the app's week, as /v1/xp and /v1/progress/weekly). */
export const weekStartFor = (date: string): string => shiftDay(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** The calendar days (YYYY-MM-DD, XP_TIMEZONE) of the window ending today, newest first. Daily and
 *  weekly are rolling (today; the last 7 days); monthly is the calendar month so far. */
export function windowDays(window: XpBoardWindow, now: Date, timeZone: string): string[] {
  const today = xpDay(now, timeZone);
  const days: string[] = [];
  if (window === "monthly") {
    for (let day = today; day.slice(0, 7) === today.slice(0, 7); day = shiftDay(day, -1)) days.push(day);
    return days;
  }
  for (let i = 0; i < XP_BOARD_DAYS[window]; i++) days.push(shiftDay(today, -i));
  return days;
}

/** Rank users by the XP they earned in the window's days (after the daily caps). */
export function rankXp(byUser: Map<string, Record<string, number>>, days: string[]): XpBoardEntry[] {
  const totals = [...byUser.entries()]
    .map(([user_id, byDay]) => ({ user_id, xp: days.reduce((sum, d) => sum + (byDay[d] ?? 0), 0) }))
    .filter((e) => e.xp > 0)
    .sort((a, b) => b.xp - a.xp || (a.user_id < b.user_id ? -1 : 1));
  let rank = 0;
  return totals.map((e, i) => {
    if (i === 0 || e.xp !== totals[i - 1]!.xp) rank = i + 1;
    return { rank, user_id: e.user_id, xp: e.xp };
  });
}

function groupBy<T extends { user_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const list = out.get(row.user_id) ?? [];
    list.push(row);
    out.set(row.user_id, list);
  }
  return out;
}

export async function getXpBoard(window: XpBoardWindow, now: Date = new Date()): Promise<XpBoard> {
  const timeZone = xpTimeZone();
  const days = windowDays(window, now, timeZone);
  // Two extra days: activity rows are bucketed by their own time zone, which can be a day off
  // XP_TIMEZONE. Caps are per day, so whole days inside the window always score exactly.
  const cutoff = new Date(now.getTime() - (days.length + 2) * 86_400_000);
  const [activity, challenges, external] = await Promise.all([
    pool.query<ActivityRow & { user_id: string }>(
      `SELECT user_id, id, type, source_module, started_at, duration_s, metrics, created_at
       FROM   activity_sessions
       WHERE  started_at >= $1`,
      [cutoff],
    ),
    pool.query<ChallengeWinRow & { user_id: string }>(
      `SELECT cp.user_id, c.id AS challenge_id, cp.xp_awarded, c.resolved_at
       FROM   challenge_participants cp
       JOIN   challenges c ON c.id = cp.challenge_id
       WHERE  cp.is_winner IS TRUE AND cp.xp_awarded > 0 AND c.state = 'resolved'
         AND  c.resolved_at >= $1`,
      [cutoff],
    ),
    pool.query<ExternalAwardRow & { user_id: string }>(
      `SELECT user_id, source, idempotency_key, amount, reason, source_id, created_at, reversed_at
       FROM   external_xp_awards
       WHERE  created_at >= $1`,
      [cutoff],
    ),
  ]);

  const perActivity = groupBy(activity.rows);
  const perChallenge = groupBy(challenges.rows);
  const perExternal = groupBy(external.rows);
  const users = new Set([...perActivity.keys(), ...perChallenge.keys(), ...perExternal.keys()]);
  const byUser = new Map<string, Record<string, number>>();
  for (const userId of users) {
    const entries = [
      ...activityEntries(perActivity.get(userId) ?? [], timeZone),
      ...challengeEntries((perChallenge.get(userId) ?? []).map((r) => ({ ...r, xp_awarded: Number(r.xp_awarded) })), timeZone),
      ...externalEntries((perExternal.get(userId) ?? []).map((r) => ({ ...r, amount: Number(r.amount) })), timeZone),
    ];
    byUser.set(userId, summarize(entries).byDay);
  }

  return { window, day: days[0]!, entries: rankXp(byUser, days) };
}
