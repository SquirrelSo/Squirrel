/**
 * Data hooks for the campus screens. They wrap the shared useRemote cache and the realtime
 * channel so screens stay declarative: `const me = useMe()` → { data, error, cause, loading, reload }.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { campusApi, CAMPUS_MAP_ON_SERVICE, CAMPUS_SOURCE, featureUnavailable, realtimeMode, setRealtimeUrl, subscribeRealtime, type RealtimeMessage } from '@/api/campus';
import { invalidateRemote, useRemote } from '@/api/useRemote';
import { useAuth } from '@/auth/AuthProvider';
import { hydrateTerritories, territoriesLoadedAt, upsertTerritory } from '@/state/territoryStore';

/**
 * The campus backend needs a signed-in user, except for public endpoints (config, stats, zones).
 */
export function useCampusSession() {
  const { mode } = useAuth();
  // 'off': let requests run so they fail with "not live yet" (more honest than "sign in").
  const signedIn = CAMPUS_SOURCE === 'off' ? true : mode === 'live';
  return { source: CAMPUS_SOURCE, signedIn };
}

/** Keyed campus request; `needsAuth` requests are skipped (and report unauthorized) until signed in. */
export function useCampus<T>(key: string, fetcher: () => Promise<T>, { needsAuth = true, enabled = true }: { needsAuth?: boolean; enabled?: boolean } = {}) {
  const { signedIn } = useCampusSession();
  const run = enabled && (!needsAuth || signedIn);
  const r = useRemote<T>(run ? `campus:${key}` : null, fetcher);
  return { ...r, signedOut: needsAuth && !signedIn };
}

export const invalidateCampus = (prefix = '') => invalidateRemote(`campus:${prefix}`);

export function useConfig() {
  const r = useCampus('config', () => campusApi.config(), { needsAuth: false });
  const url = r.data?.realtime_url ?? null;
  useEffect(() => setRealtimeUrl(url), [url]);
  return r;
}

export const useMe = () => useCampus('me', () => campusApi.me());
export const useZones = () => useCampus('zones', () => campusApi.zones(), { needsAuth: false });
/**
 * Hostels to pick from: the backend's hostel zones, or the campus's hostel list when it has no
 * zones (the Social service). With campus-service serving zones, the profile (and its hostel) still
 * lives on Social, which only accepts its own list — so that list wins when it has one.
 * `none`: neither has any yet; `error`: a real failure to show.
 */
export function useHostelOptions() {
  const zones = useZones();
  const config = useConfig();
  const fromZones = (zones.data ?? []).filter((z) => z.kind === 'hostel').map((z) => ({ id: z.id, label: z.hostel ?? z.name }));
  const fromConfig = (config.data?.campus.hostels ?? []).map((h) => ({ id: h, label: h }));
  const options = CAMPUS_MAP_ON_SERVICE && fromConfig.length ? fromConfig : fromZones.length ? fromZones : fromConfig;
  const zonesSettled = !!zones.data || !!zones.error;
  const loading = !options.length && (!zonesSettled || config.loading);
  const failed = !options.length && !loading && !!zones.error && !featureUnavailable(zones.cause);
  return { options, loading, none: !options.length && !loading && !failed, error: failed ? zones : null };
}

/** Stylised base map (roads, buildings, terrain, POIs). Public and static — cached for the session. */
export const useMapFeatures = () => useCampus('map:features', () => campusApi.mapFeatures(), { needsAuth: false });

/**
 * Run `fn` for every realtime message while the component is mounted. The socket's address comes
 * from /v1/config, so it's loaded here too (cached): a screen opened straight from a link or a
 * notification is live without passing through Home first.
 */
export function useRealtime(fn: (m: RealtimeMessage) => void) {
  useConfig();
  const ref = useRef(fn);
  useEffect(() => {
    ref.current = fn;
  });
  useEffect(() => subscribeRealtime((m) => ref.current(m)), []);
}

/**
 * Refresh when the screen regains focus, at most every `minMs`. With a realtime channel this
 * is only a safety net; without one it's how data stays fresh — never a tight polling loop.
 */
export function useRefreshOnFocus(reload: () => void, minMs = 60_000) {
  const last = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (last.current && now - last.current < minMs) return;
      if (last.current) reload();
      last.current = now;
    }, [reload, minMs]),
  );
}

/**
 * Keeps the territory store in sync: a full load on first use and on focus (when stale),
 * then per-zone updates from realtime pushes. Ownership is always the server's.
 */
export function useTerritorySync() {
  const { signedIn } = useCampusSession();
  const [state, setState] = useState<{ loading: boolean; error: unknown }>({ loading: territoriesLoadedAt() === 0, error: null });
  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: territoriesLoadedAt() === 0 }));
    try {
      const r = await campusApi.territories();
      hydrateTerritories(r.territories);
      setState({ loading: false, error: null });
    } catch (e) {
      setState({ loading: false, error: e });
    }
  }, []);
  const staleMs = realtimeMode() === 'focus' ? 60_000 : 5 * 60_000;
  // Wait for the session (the stored token is restored asynchronously) — never fire unauthenticated.
  useFocusEffect(
    useCallback(() => {
      if (signedIn && Date.now() - territoriesLoadedAt() > staleMs) void load();
    }, [load, staleMs, signedIn]),
  );
  useRealtime((m) => {
    if (m.type === 'territory.updated') upsertTerritory(m.data);
  });
  return { ...state, reload: load };
}

export type ActionState<R> = { status: 'idle' | 'loading' | 'success' | 'error'; data: R | null; error: unknown };

/**
 * A mutation with explicit loading / success / failure. It never retries on its own:
 * ownership-changing calls must be re-confirmed by the user and reconciled with the response.
 */
export function useAction<A extends unknown[], R>(fn: (...args: A) => Promise<R>) {
  const [state, setState] = useState<ActionState<R>>({ status: 'idle', data: null, error: null });
  const busy = useRef(false);
  const lastErr = useRef<unknown>(null);
  const fnRef = useRef(fn);
  useEffect(() => {
    fnRef.current = fn;
  });
  const run = useCallback(async (...args: A): Promise<R | null> => {
    if (busy.current) return null;
    busy.current = true;
    setState({ status: 'loading', data: null, error: null });
    try {
      const data = await fnRef.current(...args);
      setState({ status: 'success', data, error: null });
      return data;
    } catch (error) {
      lastErr.current = error;
      setState({ status: 'error', data: null, error });
      return null;
    } finally {
      busy.current = false;
    }
  }, []);
  const reset = useCallback(() => setState({ status: 'idle', data: null, error: null }), []);
  /** The error from the most recent failed run (readable right after `await run()`). */
  const lastError = useCallback(() => lastErr.current, []);
  return { ...state, run, reset, lastError };
}

/** Random per-attempt idempotency key for ownership actions. */
export const actionKey = (prefix: string) => `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
