/**
 * src/social/publish.ts
 *
 * Publishes finalized runs to the Social service, so they show on the runner's profile and can be
 * shared as posts: POST {SOCIAL_API_URL}/internal/v1/activities with the service token
 * SOCIAL_INTERNAL_TOKEN (squirrel-social-profile-social-fixed/social-backend/app/routers/internal.py).
 *
 * Fire-and-forget after the finalize transaction commits: the long timeout lets a sleeping free-plan
 * service wake up, and a failure is logged, never thrown, so publishing can never fail a run. The
 * Social service is idempotent on the run id. Without both settings it does nothing.
 */

export const SOCIAL_TIMEOUT_MS = 90_000;

export interface FinalizedRun {
  runId: string;
  userId: string;
  startedAt: Date;
  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  areaM2: number | null;
}

/** The Social service's InternalActivityIn for one finalized run. */
export function runActivityPayload(run: FinalizedRun): Record<string, unknown> {
  const km = run.distanceM / 1000;
  return {
    user_subject: run.userId,
    type: "run",
    source: "run_module",
    source_ref: run.runId,
    started_at: run.startedAt.toISOString(),
    name: km >= 0.1 ? `${km.toFixed(1)} km run` : "Run",
    distance_m: Math.max(0, Math.round(run.distanceM)),
    duration_s: Math.max(0, Math.round(run.movingTimeS)),
    metrics: {
      elapsed_time_s: Math.max(0, Math.round(run.elapsedTimeS)),
      ...(run.areaM2 != null ? { territory_m2: Math.round(run.areaM2) } : {}),
    },
  };
}

/** Send one finalized run in the background. Resolves when done (tests await it); never rejects. */
export function publishRun(
  run: FinalizedRun,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const url = (env["SOCIAL_API_URL"] ?? "").trim().replace(/\/+$/, "");
  const token = (env["SOCIAL_INTERNAL_TOKEN"] ?? "").trim();
  if (!url || !token) return Promise.resolve();
  return fetchImpl(`${url}/internal/v1/activities`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(runActivityPayload(run)),
    signal: AbortSignal.timeout(SOCIAL_TIMEOUT_MS),
  })
    .then(async (res) => {
      if (!res.ok) console.warn(`Social rejected run ${run.runId}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    })
    .catch((err: unknown) => {
      console.warn(`Could not publish run ${run.runId} to Social: ${err instanceof Error ? err.message : String(err)}`);
    });
}
