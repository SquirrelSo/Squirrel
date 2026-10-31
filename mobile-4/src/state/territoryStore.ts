/**
 * Territory ownership, keyed by zone. The backend is the source of truth; this store only
 * holds the latest version it has seen (from GET /v1/territories, action responses and
 * realtime pushes). Components subscribe to ONE zone, so a single ownership change
 * re-renders a single polygon/card — never the whole map.
 */
import { useSyncExternalStore } from 'react';
import type { Territory } from '@/api/campus/types';

const byZone = new Map<string, Territory>();
const zoneListeners = new Map<string, Set<() => void>>();
const allListeners = new Set<() => void>();
let snapshot: Territory[] = [];
let loadedAt = 0;

function notify(zoneId: string) {
  zoneListeners.get(zoneId)?.forEach((l) => l());
}
function notifyAll() {
  snapshot = [...byZone.values()];
  allListeners.forEach((l) => l());
}

/** Keep the newest version per zone; stale or repeated pushes (same or lower version) are ignored. */
export function upsertTerritory(t: Territory): boolean {
  const cur = byZone.get(t.zone_id);
  if (cur && cur.version >= t.version) return false;
  byZone.set(t.zone_id, t);
  notify(t.zone_id);
  notifyAll();
  return true;
}

export function hydrateTerritories(list: Territory[]) {
  let changed = false;
  for (const t of list) {
    const cur = byZone.get(t.zone_id);
    if (cur && cur.version >= t.version) continue;
    byZone.set(t.zone_id, t);
    notify(t.zone_id);
    changed = true;
  }
  loadedAt = Date.now();
  if (changed || !snapshot.length) notifyAll();
}

export const territoriesLoadedAt = () => loadedAt;
export const getTerritory = (zoneId: string) => byZone.get(zoneId);

function subscribeZone(zoneId: string, l: () => void) {
  let set = zoneListeners.get(zoneId);
  if (!set) zoneListeners.set(zoneId, (set = new Set()));
  set.add(l);
  return () => set!.delete(l);
}

/** One zone's territory; re-renders only when that zone changes. */
export function useTerritory(zoneId: string | null | undefined): Territory | undefined {
  return useSyncExternalStore(
    (l) => (zoneId ? subscribeZone(zoneId, l) : () => {}),
    () => (zoneId ? byZone.get(zoneId) : undefined),
    () => (zoneId ? byZone.get(zoneId) : undefined),
  );
}

/** Every territory (for counts and lists). Re-renders on any change — use sparingly. */
export function useAllTerritories(): Territory[] {
  return useSyncExternalStore(
    (l) => {
      allListeners.add(l);
      return () => allListeners.delete(l);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** Test/sign-out helper. */
export function resetTerritories() {
  byZone.clear();
  loadedAt = 0;
  notifyAll();
}
