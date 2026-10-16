import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Small fetch hook: loading / error / data with cancellation, plus an in-memory cache so a
 * screen you come back to renders its last data instantly while it revalidates.
 * `key = null` skips the request (e.g. not configured or no user yet).
 */
const cache = new Map<string, unknown>();
/** Mounted hooks, told when their key is invalidated so they refetch now (not on their next focus). */
const listeners = new Set<(prefix: string) => void>();

/** Forget every cached value under `prefix`, and have every mounted screen showing one refetch it. */
export function invalidateRemote(prefix: string) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
  listeners.forEach((l) => l(prefix));
}

type Settled<T> = { id: string; data?: T; error: string | null; cause?: unknown };

export function useRemote<T>(key: string | null, fetcher: () => Promise<T>) {
  const [tick, setTick] = useState(0);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const fetchRef = useRef(fetcher);
  useEffect(() => {
    fetchRef.current = fetcher;
  });

  // Invalidated while mounted: refetch now. The last data stays on screen until the new data lands.
  useEffect(() => {
    if (!key) return;
    const onInvalidate = (prefix: string) => key.startsWith(prefix) && setTick((t) => t + 1);
    listeners.add(onInvalidate);
    return () => {
      listeners.delete(onInvalidate);
    };
  }, [key]);

  // One request per (key, reload tick). Loading is derived: the current id hasn't settled yet.
  const id = key ? `${key}#${tick}` : null;
  useEffect(() => {
    if (!key || !id) return;
    let cancelled = false;
    fetchRef.current().then(
      (d) => {
        if (cancelled) return;
        cache.set(key, d);
        setSettled({ id, data: d, error: null });
      },
      (e) => !cancelled && setSettled({ id, error: e instanceof Error ? e.message : 'Something went wrong', cause: e }),
    );
    return () => {
      cancelled = true;
    };
  }, [key, id]);

  const current = settled != null && settled.id === id;
  // While refetching (a reload, or an invalidation that cleared the cache), keep showing this key's last data.
  const last = settled && key && settled.id.startsWith(`${key}#`) ? settled.data : undefined;
  const data = (current && settled.data !== undefined ? settled.data : key ? ((cache.get(key) as T | undefined) ?? last) : undefined) ?? undefined;
  const error = current ? settled.error : null;
  /** The thrown value behind `error` (e.g. an ApiError with its status), for choosing the right state. */
  const cause = current ? settled.cause : undefined;
  const loading = !!key && !current;
  const reload = useCallback(() => setTick((t) => t + 1), []);
  /** Replace the cached value without a request (after a mutation returned the new state). */
  const mutate = useCallback(
    (next: T) => {
      if (!key || !id) return;
      cache.set(key, next);
      setSettled({ id, data: next, error: null });
    },
    [key, id],
  );
  return { data, error, cause, loading, reload, mutate };
}
