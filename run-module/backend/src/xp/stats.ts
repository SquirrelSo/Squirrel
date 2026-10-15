/**
 * src/xp/stats.ts
 *
 * The app's XP stats and XP history (ADR-033), from the same XP lines as every other XP number.
 *
 *   stats:   total, level, progress through the level, XP today, this week (Monday start, as
 *            /v1/xp) and this calendar month (XP_TIMEZONE), and XP per source.
 *   history: one item per XP line, newest first, keyset-paginated on (created_at, id). Cap cuts are
 *            their own negative items; a reversed award is listed with reversed: true and counts 0.
 *            The non-reversed amounts add up to the total.
 */

import { getUserXpEntries, shiftDay, weekStartFor, xpTimeZone } from "./query.js";
import { levelForXp, summarize, xpByCategory, xpDay, type XpCategory, type XpEntry } from "./rules.js";

export interface XpStats {
  total: number;
  level: number;
  level_progress: { current_level_xp: number; next_level_xp: number; into_level: number; needed: number };
  today: number;
  week: number;
  month: number;
  by_source: Record<XpCategory, number>;
}

export async function xpStats(userId: string, now: Date = new Date()): Promise<XpStats> {
  const entries = await getUserXpEntries(userId);
  const summary = summarize(entries);
  const tz = xpTimeZone();
  const today = xpDay(now, tz);
  const weekStart = weekStartFor(today);
  const week = Array.from({ length: 7 }, (_, i) => shiftDay(weekStart, i))
    .reduce((sum, day) => sum + (summary.byDay[day] ?? 0), 0);
  const month = Object.entries(summary.byDay)
    .filter(([day]) => day.slice(0, 7) === today.slice(0, 7) && day <= today)
    .reduce((sum, [, xp]) => sum + xp, 0);
  const level = levelForXp(summary.xp);
  return {
    total: summary.xp,
    level: level.level,
    level_progress: {
      current_level_xp: level.xpForCurrentLevel,
      next_level_xp: level.xpForNextLevel,
      into_level: summary.xp - level.xpForCurrentLevel,
      needed: level.xpForNextLevel - summary.xp,
    },
    today: summary.byDay[today] ?? 0,
    week,
    month,
    by_source: xpByCategory(entries),
  };
}

export interface XpHistoryItem {
  id: string;
  amount: number;
  source: string;
  reason: string;
  source_id: string | null;
  created_at: string;
  reversed: boolean;
}

export const MAX_HISTORY_LIMIT = 100;
export const DEFAULT_HISTORY_LIMIT = 20;

/** Opaque keyset cursor: the (created_at, id) of the last item of the page. */
export function encodeCursor(item: { created_at: string; id: string }): string {
  return Buffer.from(`${item.created_at}|${item.id}`, "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { at: number; id: string } | null {
  if (!/^[A-Za-z0-9_-]{1,800}$/.test(cursor)) return null;
  const raw = Buffer.from(cursor, "base64url").toString("utf8");
  const bar = raw.indexOf("|");
  if (bar < 1) return null;
  const at = Date.parse(raw.slice(0, bar));
  const id = raw.slice(bar + 1);
  if (Number.isNaN(at) || !id) return null;
  return { at, id };
}

const newestFirst = (a: XpEntry, b: XpEntry): number =>
  b.created_at.getTime() - a.created_at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

export async function xpHistory(
  userId: string, limit: number, cursor: { at: number; id: string } | null,
): Promise<{ items: XpHistoryItem[]; next_cursor: string | null }> {
  const entries = (await getUserXpEntries(userId)).sort(newestFirst);
  const after = cursor
    ? entries.filter((e) => e.created_at.getTime() < cursor.at || (e.created_at.getTime() === cursor.at && e.id < cursor.id))
    : entries;
  const page = after.slice(0, limit).map((e): XpHistoryItem => ({
    id: e.id,
    amount: e.xp,
    source: e.category,
    reason: e.reason,
    source_id: e.source_id,
    created_at: e.created_at.toISOString(),
    reversed: e.reversed,
  }));
  const next_cursor = after.length > limit && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null;
  return { items: page, next_cursor };
}
