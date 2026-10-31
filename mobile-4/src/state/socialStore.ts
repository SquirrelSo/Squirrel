/**
 * Poke / friendship state, keyed by user. The backend is the source of truth:
 *   - POKE is optimistic (shows POKED at once) and rolls back if the request fails;
 *   - POKE BACK / FRIENDS are never optimistic — FRIENDS appears only after the backend
 *     confirms the mutual poke (response or realtime push).
 * Components subscribe to one user's entry, so a poke re-renders one card, not the map.
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { PersonLite, Relationship, RelationshipState } from '@/api/campus/types';
import { getPokeStatus, pokeBack, sendPoke } from '@/api/campus/poke';

export type RelEntry = {
  state: RelationshipState;
  can_poke: boolean;
  reason: string | null;
  /** In flight: 'poke' (optimistic POKED) or 'poke_back' (waiting for the backend). */
  pending: 'poke' | 'poke_back' | null;
  /** Where the entry came from — a full status beats a list hint. */
  source: 'status' | 'list';
  at: number;
};

export type Friend = PersonLite & { level?: number; xp?: number };

const rels = new Map<string, RelEntry>();
const listeners = new Map<string, Set<() => void>>();
const inflight = new Map<string, Promise<void>>();

function emit(userId: string) {
  listeners.get(userId)?.forEach((l) => l());
}
function set(userId: string, e: RelEntry) {
  rels.set(userId, e);
  emit(userId);
}
export const getRelationship = (userId: string) => rels.get(userId);

/** Authoritative update (status call, poke response, realtime). */
export function applyRelationship(r: Relationship) {
  set(r.user_id, { state: r.state, can_poke: r.can_poke, reason: r.reason, pending: null, source: 'status', at: Date.now() });
}

/**
 * Hints from list endpoints (map players, search). Never overrides a pending action, or a change
 * made after the list was requested (`requestedAt`). When a list is the first to report that a
 * poke was returned (no realtime channel), the friendship is celebrated from it.
 */
export function seedRelationships(list: (Friend & { relationship: RelationshipState })[], requestedAt = 0) {
  const now = Date.now();
  for (const p of list) {
    const cur = rels.get(p.user_id);
    if (cur && (cur.pending || cur.at > requestedAt)) continue;
    if (cur && cur.state === p.relationship) continue;
    set(p.user_id, { state: p.relationship, can_poke: p.relationship === 'none' || p.relationship === 'poked_you', reason: null, pending: null, source: 'list', at: now });
    if (cur?.state === 'poked' && p.relationship === 'friends' && p.display_name) celebrate(p);
  }
}

function fetchStatus(userId: string) {
  if (inflight.has(userId)) return;
  const p = getPokeStatus(userId)
    .then(applyRelationship)
    .catch(() => undefined)
    .finally(() => inflight.delete(userId));
  inflight.set(userId, p);
}

/** One user's relationship. Fetches it from the backend when nothing is known yet. */
export function useRelationship(userId: string | null | undefined, seed?: RelationshipState): RelEntry | undefined {
  const entry = useSyncExternalStore(
    (l) => {
      if (!userId) return () => {};
      let s = listeners.get(userId);
      if (!s) listeners.set(userId, (s = new Set()));
      s.add(l);
      return () => s!.delete(l);
    },
    () => (userId ? rels.get(userId) : undefined),
    () => (userId ? rels.get(userId) : undefined),
  );
  useEffect(() => {
    if (!userId) return;
    if (seed && !rels.has(userId)) set(userId, { state: seed, can_poke: seed === 'none' || seed === 'poked_you', reason: null, pending: null, source: 'list', at: 0 });
    else if (!rels.has(userId)) fetchStatus(userId);
  }, [userId, seed]);
  return entry;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type PokeOutcome = { ok: true; friends: boolean } | { ok: false; error: unknown };

/**
 * POKE (optimistic) or POKE BACK (confirmed-only), depending on the current state.
 * Returns the outcome; on failure the previous state is restored.
 */
export async function pokeUser(user: Friend): Promise<PokeOutcome> {
  const prev = rels.get(user.user_id);
  if (prev?.pending) return { ok: false, error: new Error('Already sending') };
  const back = prev?.state === 'poked_you';
  const base: RelEntry = prev ?? { state: 'none', can_poke: true, reason: null, pending: null, source: 'list', at: Date.now() };
  // Optimistic POKED only for a first poke; poke-back waits for the backend.
  set(user.user_id, back ? { ...base, pending: 'poke_back' } : { ...base, state: 'poked', can_poke: false, pending: 'poke' });
  try {
    const r = back ? await pokeBack(user.user_id) : await sendPoke(user.user_id);
    applyRelationship(r.relationship);
    if (r.friendship_created && r.relationship.state === 'friends') celebrate(r.friend ?? user);
    return { ok: true, friends: r.relationship.state === 'friends' };
  } catch (error) {
    if (prev) set(user.user_id, { ...prev, pending: null });
    else {
      rels.delete(user.user_id);
      emit(user.user_id);
      fetchStatus(user.user_id); // re-sync with the server's view
    }
    return { ok: false, error };
  }
}

// ---------------------------------------------------------------------------
// Friendship celebration (one at a time)
// ---------------------------------------------------------------------------

let celebrationQueue: Friend[] = [];
const celebrationListeners = new Set<() => void>();
const emitCelebration = () => celebrationListeners.forEach((l) => l());

export function celebrate(friend: Friend) {
  if (celebrationQueue.some((f) => f.user_id === friend.user_id)) return;
  celebrationQueue = [...celebrationQueue, friend];
  emitCelebration();
}
export function dismissCelebration() {
  celebrationQueue = celebrationQueue.slice(1);
  emitCelebration();
}
export function useCelebration(): Friend | null {
  return useSyncExternalStore(
    (l) => {
      celebrationListeners.add(l);
      return () => celebrationListeners.delete(l);
    },
    () => celebrationQueue[0] ?? null,
    () => celebrationQueue[0] ?? null,
  );
}

// ---------------------------------------------------------------------------
// Unread notifications (badge on bells)
// ---------------------------------------------------------------------------

let unread: number | null = null;
const unreadListeners = new Set<() => void>();
export function setUnread(n: number | ((cur: number) => number)) {
  unread = typeof n === 'function' ? n(unread ?? 0) : n;
  unreadListeners.forEach((l) => l());
}
export function useUnread(): number | null {
  return useSyncExternalStore(
    (l) => {
      unreadListeners.add(l);
      return () => unreadListeners.delete(l);
    },
    () => unread,
    () => unread,
  );
}
