/**
 * XP history and XP-by-source in words. The Run Module sends a `source` (its XP category) and a
 * `reason` code on every XP line (run-module/backend/src/xp/rules.ts XpReason); this turns them into
 * labels, and keeps the "Load more" pages in the server's order. Pure, so it's unit-tested. The app
 * never computes XP: every amount here is the server's.
 */
import type { XpHistoryItem, XpSource } from '@/api/featureContracts';

/** The six sources in the order the Progress screen lists them. */
export const XP_SOURCES: XpSource[] = ['run', 'exercise', 'campus', 'challenge', 'social', 'daily_goal'];

const SOURCE_LABEL: Record<XpSource, string> = {
  run: 'Runs',
  exercise: 'Workouts',
  campus: 'Campus',
  challenge: 'Challenges',
  social: 'Social',
  daily_goal: 'Daily goals',
};

/** Every reason the Run Module writes. Caps are their own (negative) lines. */
const REASON_TEXT: Record<string, string> = {
  run_completed: 'Finished a run',
  run_distance: 'Distance on a run',
  territory_captured: 'Captured territory on a run',
  run_daily_cap: 'Past the daily run XP limit',
  exercise_session: 'Finished a workout',
  exercise_daily_cap: 'Past the daily workout XP limit',
  daily_goal: 'Hit your daily goal',
  'challenge completed': 'Won a challenge',
  challenge_daily_cap: 'Past the daily challenge XP limit',
  territory_claim: 'Claimed a zone',
  territory_steal: 'Took over a zone',
  territory_defend: 'Defended your zone',
  territory_daily_cap: 'Past the daily territory XP limit',
  meetup_checkin: 'Checked in at a meetup',
  shared_workout_finished: 'Finished a workout with a partner',
  shared_workout_daily_limit: 'Past the 3 partner workouts that count a day',
  buddy_connected: 'Connected with a workout buddy',
  ambassador_referral: 'Someone you referred joined',
  ambassador_task: 'Finished an ambassador task',
  special_event: 'Special event',
  campus_awards_daily_cap: 'Past the daily campus XP limit',
  exercise_awards_daily_cap: 'Past the daily workout bonus limit',
  social_awards_daily_cap: 'Past the daily social XP limit',
};

/** "meetup_checkin" → "Meetup checkin": a reason added server-side after this build still reads as words. */
const words = (code: string) => {
  const s = code.replace(/[_.-]+/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'XP';
};

export const sourceLabel = (source: string): string => SOURCE_LABEL[source as XpSource] ?? words(source);
export const reasonText = (reason: string): string => REASON_TEXT[reason] ?? words(reason);

/** "+25 XP", "−20 XP" (a cap cut). A reversed award shows its original amount (struck through). */
export const amountText = (amount: number): string => `${amount < 0 ? '−' : '+'}${Math.abs(amount).toLocaleString('en-IN')} XP`;

/** XP per source, biggest first; sources with no XP are left out. */
export function sourceRows(bySource: Partial<Record<string, number>>): { source: string; label: string; xp: number }[] {
  const known = XP_SOURCES.filter((s) => s in bySource);
  const other = Object.keys(bySource).filter((s) => !(XP_SOURCES as string[]).includes(s));
  return [...known, ...other]
    .map((source) => ({ source, label: sourceLabel(source), xp: bySource[source] ?? 0 }))
    .filter((r) => r.xp !== 0)
    .sort((a, b) => b.xp - a.xp);
}

/** Newest first; ties by id descending, as the server pages them. */
const newestFirst = (a: XpHistoryItem, b: XpHistoryItem) =>
  Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Pages joined in the server's order, without repeats; a later copy of an item wins (e.g. now reversed). */
export function mergeHistory(...pages: XpHistoryItem[][]): XpHistoryItem[] {
  const byId = new Map<string, XpHistoryItem>();
  for (const page of pages) for (const item of page) byId.set(item.id, item);
  return [...byId.values()].sort(newestFirst);
}
