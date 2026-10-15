import pino from 'pino';
import { config } from '../config.js';
import { query, type Queryable } from '../db/pool.js';

const BACKOFF_MS = 30_000;
let downUntil = 0;
const log = pino({ level: config.logLevel, name: 'run-module' });

export type RunSettings = { url: string; token: string; timeoutMs: number; cacheTtlMs: number };
let override: RunSettings | null | undefined;

function fromEnv(): RunSettings | null {
  const { apiUrl, internalToken, timeoutMs, cacheTtlSeconds } = config.run;
  if (!apiUrl || !internalToken) return null;
  return { url: apiUrl, token: internalToken, timeoutMs, cacheTtlMs: cacheTtlSeconds * 1000 };
}

export function runSettings(): RunSettings | null {
  return override === undefined ? fromEnv() : override;
}

export function configureRunBridge(s: (Partial<RunSettings> & { url: string; token: string }) | null | undefined) {
  override = s === undefined || s === null ? s : { timeoutMs: 3000, cacheTtlMs: 300_000, ...s, url: s.url.replace(/\/+$/, '') };
  downUntil = 0;
}

/** Reasons campus-service reports to the Run Module's XP ledger (source `campus`; limits in the cross-service contract). */
export type XpReason = 'territory_claim' | 'territory_steal' | 'territory_defend' | 'meetup_checkin';

/** XP for a meetup check-in, once per meetup per person (ADR-033 / contract: exactly 25). */
export const MEETUP_CHECKIN_XP = 25;

export async function awardXp(subject: string, amount: number, reason: XpReason, idempotency_key: string,
  extra: { source_id?: string; metadata?: Record<string, unknown> } = {}): Promise<number | null> {
  const s = runSettings();
  if (!s) return null;
  
  let res: Response;
  try {
    res = await fetch(s.url + '/internal/v1/xp/award', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + s.token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ subject, amount, reason, source: 'campus', idempotency_key,
        ...(extra.source_id ? { source_id: extra.source_id } : {}), ...(extra.metadata ? { metadata: extra.metadata } : {}) }),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
  } catch (err) {
    throw new Error('Run Module request failed: ' + (err as Error).message);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('Run Module HTTP ' + res.status);
  }
  let json: unknown;
  try { json = await res.json(); } catch { throw new Error('Run Module invalid JSON'); }
  if (typeof json !== 'number') throw new Error('Run Module response is not a number');
  return json;
}

export async function refreshXpTotals(subjects: string[]): Promise<Record<string, number>> {
  if (!subjects.length) return {};
  const s = runSettings();
  if (!s || Date.now() < downUntil) return {};

  let res: Response;
  try {
    res = await fetch(s.url + '/internal/v1/xp/totals', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + s.token, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ subjects }),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
  } catch (err) {
    downUntil = Date.now() + BACKOFF_MS;
    log.warn({ err: (err as Error).message }, 'Run Module totals failed; backoff ' + BACKOFF_MS + 'ms');
    return {};
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    downUntil = Date.now() + BACKOFF_MS;
    log.warn({ status: res.status }, 'Run Module totals HTTP ' + res.status);
    return {};
  }
  let json: Record<string, number>;
  try { json = (await res.json()) as Record<string, number>; } catch { 
    downUntil = Date.now() + BACKOFF_MS;
    return {}; 
  }
  return json;
}

export async function syncBatchXp<T extends { user_id: string; xp_total: number; xp_synced_at: string | Date }>(rows: T[], q: Queryable): Promise<void> {
  const s = runSettings();
  if (!s) return;
  const now = Date.now();
  const stale = rows.filter(r => now - new Date(r.xp_synced_at).getTime() > s.cacheTtlMs);
  if (!stale.length) return;
  
  const subjects = Array.from(new Set(stale.map(r => r.user_id)));
  const totals: Record<string, number> = {};
  for (let i = 0; i < subjects.length; i += 200) {
    const chunk = subjects.slice(i, i + 200);
    Object.assign(totals, await refreshXpTotals(chunk));
  }
  if (Object.keys(totals).length === 0) return; // failed open
  
  for (const r of stale) {
    if (totals[r.user_id] !== undefined) {
      r.xp_total = totals[r.user_id];
      r.xp_synced_at = new Date().toISOString();
      await query(`UPDATE users SET xp_total = $1, xp_synced_at = now() WHERE id = $2`, [r.xp_total, r.user_id], q);
    }
  }
}

/**
 * Award XP after the caller's own commit and store the returned total in the read cache.
 * Fire-and-forget by contract: never throws, never retries, failures are only logged.
 */
export async function awardXpAfterCommit(subject: string, amount: number, reason: XpReason, idempotency_key: string,
  extra: { source_id?: string; metadata?: Record<string, unknown> } = {}): Promise<void> {
  try {
    const total = await awardXp(subject, amount, reason, idempotency_key, extra);
    if (total !== null) await query(`UPDATE users SET xp_total = $2, xp_synced_at = now(), updated_at = now() WHERE id = $1`, [subject, total]);
  } catch (err) {
    log.warn({ err: (err as Error).message, reason, idempotency_key }, 'XP award to the Run Module failed; action kept');
  }
}
