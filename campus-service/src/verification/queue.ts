/**
 * Postgres-backed job queue (no extra infrastructure). Producers insert; workers claim with
 * FOR UPDATE SKIP LOCKED so several workers never process the same job. A partial unique index
 * guarantees one live verify job per activity.
 */
import type pg from 'pg';
import { query, one, getPool } from '../db/pool.js';
import { config } from '../config.js';

export type Job = { id: number; kind: string; payload: Record<string, unknown>; attempts: number };

export async function enqueueVerification(activityId: string, q: pg.PoolClient | pg.Pool = getPool()) {
  await query(`INSERT INTO jobs (kind, payload) VALUES ('verify_activity', $1) ON CONFLICT DO NOTHING`, [{ activity_id: activityId }], q);
  // Wake any in-process worker immediately.
  await query(`SELECT pg_notify('campus_jobs', $1)`, [activityId], q).catch(() => undefined);
}

export async function claimJob(q: pg.PoolClient | pg.Pool = getPool()): Promise<Job | null> {
  return one<Job>(
    `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
     WHERE id = (
       SELECT id FROM jobs
       WHERE (status = 'queued' AND run_after <= now()) OR (status = 'running' AND locked_at < now() - interval '10 minutes')
       ORDER BY run_after LIMIT 1 FOR UPDATE SKIP LOCKED
     ) RETURNING id, kind, payload, attempts`,
    [], q,
  );
}

export async function completeJob(id: number, q: pg.PoolClient | pg.Pool = getPool()) {
  await query(`UPDATE jobs SET status = 'done', updated_at = now() WHERE id = $1`, [id], q);
}

export async function failJob(job: Job, err: unknown, q: pg.PoolClient | pg.Pool = getPool()) {
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const dead = job.attempts >= config.worker.maxAttempts;
  const backoffS = Math.min(600, 5 * 2 ** job.attempts);
  await query(
    `UPDATE jobs SET status = $2, last_error = $3, run_after = now() + ($4 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
    [job.id, dead ? 'dead' : 'queued', msg.slice(0, 2000), String(backoffS)], q,
  );
  return dead;
}
