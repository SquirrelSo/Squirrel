/**
 * Run Module endpoints — contract verified against the backend schema (25 Sep 2026).
 *
 *   POST /v1/runs                     → { run_id }
 *   POST /v1/runs/:id/points          { idempotency_key, points: [{ seq, lat, lng, recorded_at, accuracy_m }] }
 *                                       · seq = index in the FULL point array (half the primary key)
 *                                       · accuracy_m required, never null · ≤ 1000 points per batch (500 used)
 *   POST /v1/runs/:id/finish          → { status: 'finishing' } — ASYNC; a worker finalises the run
 *   GET  /v1/runs/:id                 → { run_id, status, territory_reason, started_at, stats{}, territory, rejection, score }
 *                                       · poll until status ∈ finalized | flagged | rejected
 *                                       · territory_reason: why a finalized / flagged run claimed no ground
 *                                         (not_closed | no_faces | below_minimum_area), null otherwise
 *   GET  /v1/users/me/xp              → { xp, updated_at, breakdown: [{ reason, xp }] } (XP lives only here)
 *   GET  /v1/leaderboard?scope=global&metric=area&window=daily|weekly|alltime
 *                                     → { entries: [{ rank, user_id, score }], me, next_cursor }
 *
 * Rate limits (per user): 60 point uploads/min, 2000/day, 50 run creations/day, 120 writes/min.
 * 429 responses carry Retry-After and are retried here. GET routes are not limited.
 *
 * Marked ASSUMPTION below = not stated in the contract; confirm against the backend.
 */
import { api, ApiError } from '@/api/client';
import type { Fix } from '@/logic/track';
import { deviceTimeZone } from '@/logic/localDay';
import type { TerritoryReason } from '@/logic/runOutcome';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunStatus = 'active' | 'paused' | 'finishing' | 'finalized' | 'flagged' | 'rejected';
export const TERMINAL_STATUSES: RunStatus[] = ['finalized', 'flagged', 'rejected'];

export type RunCreated = { run_id: string };

export type RunPoint = { seq: number; lat: number; lng: number; recorded_at: string; accuracy_m: number };

/** Server-recomputed stats. Pace isn't sent: derive it from distance and moving time. */
export type RunStats = { distance_m: number; moving_time_s: number; elapsed_time_s: number };

/** Territory captured by the run; `null` when nothing was captured. Flagged runs still grant territory. */
export type RunTerritory = { id: string; area_m2: number; claimed_at: string; geometry: unknown } | null;

export type RunRejection = { reason: string; [k: string]: unknown } | null;

export type RunSummary = {
  run_id: string;
  status: RunStatus;
  /** Why a finalized / flagged run claimed no ground; null when it did (or for rejections). Optional for older backends. */
  territory_reason?: TerritoryReason | null;
  started_at: string;
  stats: RunStats;
  territory: RunTerritory;
  rejection: RunRejection;
  score: RunScore;
};

/** Anti-cheat score. `band` is the verdict: accept | pending | reject. */
export type ScoreBand = 'accept' | 'pending' | 'reject';
export type RunScore = { aggregate: number; band: ScoreBand | (string & {}); decisive_layer: string | null } | null;

export type XpBreakdownLine = { reason: string; xp: number };
export type XpSummary = { xp: number; updated_at: string; breakdown: XpBreakdownLine[] };

export type LeaderboardWindow = 'daily' | 'weekly' | 'alltime';
/** No display names: the Run Module stores no profiles by design. `score` = area for metric=area. */
export type LeaderboardEntry = { rank: number; user_id: string; score: number };
/** `me` has no user_id: match the signed-in user's own id (JWT `sub`) against entries instead. */
export type LeaderboardPage = { entries: LeaderboardEntry[]; me: { rank: number; score: number } | null; next_cursor: string | null };

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true });
  });

/** Retries 429s (honouring Retry-After) and transient network / 5xx errors with backoff. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!(e instanceof ApiError)) throw e;
      const retriable = e.status === 429 || e.status === 0 || e.status >= 500;
      if (!retriable || i === attempts - 1) throw e;
      await sleep(e.retryAfterMs ?? Math.min(8000, 1000 * 2 ** i));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export const POINTS_CHUNK = 500; // backend max is 1000 (413 above that)

/** Convert filtered GPS fixes to wire points. `seq` is the index in the FULL array. */
export function toRunPoints(fixes: Fix[]): RunPoint[] {
  return fixes
    .filter((f) => f.accuracy != null && Number.isFinite(f.accuracy))
    .map((f, i) => ({ seq: i, lat: f.lat, lng: f.lon, recorded_at: new Date(f.t).toISOString(), accuracy_m: f.accuracy as number }));
}

/** Derived from the seq range so a retried batch is byte-identical and the server replays it. */
export const idempotencyKey = (runId: string, batch: RunPoint[]) => `${runId}:points:${batch[0].seq}-${batch[batch.length - 1].seq}`;

export const runsApi = {
  // ASSUMPTION: request body. The contract specifies the response ({ run_id }) only;
  // `activity_type: 'walk'` is our addition, sent only for walks. The phone's time zone: the
  // run's day (daily XP cap) follows it.
  create: (startedAt: string, activityType: 'run' | 'walk' = 'run') =>
    withRetry(() => api<RunCreated>('/v1/runs', { body: { started_at: startedAt, timezone: deviceTimeZone(), ...(activityType === 'walk' ? { activity_type: 'walk' } : {}) } })),
  uploadPoints: (runId: string, batch: RunPoint[]) =>
    withRetry(() => api<unknown>(`/v1/runs/${runId}/points`, { body: { idempotency_key: idempotencyKey(runId, batch), points: batch } })),
  finish: (runId: string) => withRetry(() => api<{ status: RunStatus }>(`/v1/runs/${runId}/finish`, { method: 'POST' })),
  get: (runId: string) => withRetry(() => api<RunSummary>(`/v1/runs/${runId}`)),
};

export const xpApi = {
  me: () => withRetry(() => api<XpSummary>('/v1/users/me/xp')),
};

export const leaderboardApi = {
  get: (window: LeaderboardWindow, cursor?: string | null) =>
    withRetry(() =>
      api<LeaderboardPage>(`/v1/leaderboard?scope=global&metric=area&window=${window}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`),
    ),
};

/**
 * Poll GET /v1/runs/:id until the finish worker reaches a terminal status.
 * Backoff 1s → 2s → 4s → 8s (cap). Finalisation time depends on worker queue load, so the
 * budget is 5 min (same as the Android client); `signal` stops early. Returns the last
 * summary either way — a non-terminal status means "still processing, check back later".
 */
export async function pollRun(
  runId: string,
  { budgetMs = 5 * 60_000, onTick, signal }: { budgetMs?: number; onTick?: (s: RunSummary) => void; signal?: AbortSignal } = {},
): Promise<RunSummary> {
  const deadline = Date.now() + budgetMs;
  let delay = 1000;
  let last = await runsApi.get(runId);
  onTick?.(last);
  while (!TERMINAL_STATUSES.includes(last.status) && Date.now() < deadline && !signal?.aborted) {
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())), signal);
    if (signal?.aborted) break;
    delay = Math.min(8000, delay * 2);
    last = await runsApi.get(runId);
    onTick?.(last);
  }
  return last;
}

/**
 * Upload a finished run: create → points (500-point chunks, full-array seq, seq-range
 * idempotency keys) → finish (async) → poll until terminal. XP is NOT on the run —
 * call xpApi.me() afterwards.
 */
export async function submitRun(
  startedAt: number,
  fixes: Fix[],
  opts: {
    onStage?: (s: 'uploading' | 'finishing' | 'polling') => void;
    signal?: AbortSignal;
    /** Resume a run created by an earlier, failed attempt (point batches replay idempotently). */
    runId?: string;
    onCreated?: (runId: string) => void;
    activityType?: 'run' | 'walk';
  } = {},
): Promise<RunSummary> {
  const points = toRunPoints(fixes);
  const run_id = opts.runId ?? (await runsApi.create(new Date(startedAt).toISOString(), opts.activityType)).run_id;
  opts.onCreated?.(run_id);
  opts.onStage?.('uploading');
  for (let i = 0; i < points.length; i += POINTS_CHUNK) await runsApi.uploadPoints(run_id, points.slice(i, i + POINTS_CHUNK));
  opts.onStage?.('finishing');
  await runsApi.finish(run_id);
  opts.onStage?.('polling');
  return pollRun(run_id, { signal: opts.signal });
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

// not_closed is now a territory_reason on a finalized run (logic/runOutcome.ts); kept here for
// backends that still reject open loops.
const REJECTION_TEXT: Record<string, string> = {
  not_closed: "Your loop didn't close. End near where you started to claim ground.",
};

export function rejectionText(r: RunRejection): string {
  if (!r?.reason) return 'The server rejected this run.';
  return REJECTION_TEXT[r.reason] ?? `Rejected: ${r.reason.replace(/_/g, ' ')}.`;
}

/** ASSUMPTION: leaderboard area scores are square metres. */
export const formatArea = (m2: number) => (m2 >= 100000 ? `${(m2 / 1e6).toFixed(2)} km²` : `${Math.round(m2).toLocaleString('en-IN')} m²`);

/**
 * Is this leaderboard entry the signed-in user? `page.me` carries no user_id, so match the
 * token's own id (JWT `sub`). Only if the token has no `sub`, fall back to `me`'s rank + score.
 */
export const isMyEntry = (e: LeaderboardEntry, userId: string | null, me: LeaderboardPage['me']) =>
  userId ? e.user_id === userId : !!me && e.rank === me.rank && e.score === me.score;

/** No profile service yet: show a short, stable handle for a user id. */
export const shortUserId = (id: string) => `Runner ${id.replace(/-/g, '').slice(0, 6)}`;
