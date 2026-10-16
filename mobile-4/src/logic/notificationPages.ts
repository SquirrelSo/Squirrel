/**
 * "Show older" on the notifications screen. The first page (newest 30) stays the cached, live list;
 * everything loaded past it is kept here, in time order. A refresh of the first page can push its
 * oldest rows out of it (new ones arrived), so the rows the first page held when older ones were
 * fetched are kept too: nothing you've already seen falls into a gap. Pure, so it's unit-tested.
 */
import type { AppNotification } from '@/api/campus/types';

/** Newest first; ties by id, as the server pages them. */
const newestFirst = (a: AppNotification, b: AppNotification) =>
  Date.parse(b.created_at) - Date.parse(a.created_at) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

/** Every row loaded so far beyond the live first page: `kept` plus the lists given, later lists winning. */
export function keepOlder(kept: AppNotification[], ...lists: AppNotification[][]): AppNotification[] {
  const byId = new Map(kept.map((n) => [n.id, n]));
  for (const list of lists) for (const n of list) byId.set(n.id, n);
  return [...byId.values()].sort(newestFirst);
}

/** What shows under "Earlier": the kept rows the live first page doesn't already show. */
export function earlierRows(kept: AppNotification[], firstPage: AppNotification[]): AppNotification[] {
  const shown = new Set(firstPage.map((n) => n.id));
  return kept.filter((n) => !shown.has(n.id));
}
