/**
 * src/xp/awards.ts
 *
 * XP reported by other services and challenge wins (ADR-033). Pure: rows in, XP lines out.
 *
 * Other services report awards to POST /internal/v1/xp/award; each (source, reason) has a fixed or
 * bounded amount, checked when the award arrives. The caps are applied on read, like the run and
 * exercise caps, so a capped award is kept for audit and simply counts 0 beyond the cap:
 *
 *   campus territory_claim | steal | defend   1..100 each, at most 150 XP a day (unchanged, ADR-027 era)
 *   campus meetup_checkin                     25 exactly, once per meetup per person
 *   exercise shared_workout_finished          20 exactly, only the first 3 a day count
 *   exercise buddy_connected                  20 exactly, once per pair per person
 *   social ambassador_referral                50 exactly, once per referred person
 *   social ambassador_task                    1..200
 *   social special_event                      1..100
 *   every non-territory award together        at most 300 XP a day
 *   challenge wins                            at most 200 XP a day (xp_reward is capped at 200 too)
 *
 * The day is the XP day in XP_TIMEZONE of when the award was recorded (resolved, for challenges).
 * Awards count in the order they were recorded, so a cap always cuts the latest ones.
 * A reversed award counts 0 and uses none of the caps.
 */

import type { XpCategory, XpEntry, XpReason } from "./rules.js";
import { xpDay } from "./rules.js";

export const TERRITORY_DAILY_CAP = 150;
export const EXTERNAL_DAILY_CAP = 300;
export const SHARED_WORKOUTS_PER_DAY = 3;
export const CHALLENGE_DAILY_CAP = 200;
export const MAX_CHALLENGE_XP_REWARD = 200;

export const MAX_SOURCE_ID_LENGTH = 200;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
export const MAX_METADATA_BYTES = 2048;

export interface AwardRule {
  source: "campus" | "exercise" | "social";
  reason: XpReason;
  min: number;
  max: number;
  /** Counts toward the territory cap instead of the 300/day cap for everything else. */
  territory?: boolean;
  /** Only this many awards of the reason count per day. */
  perDay?: number;
  /** The idempotency key the contract fixes, so "once per ..." holds whatever the caller sends. */
  keyPrefix?: string;
}

const rule = (r: AwardRule): [string, AwardRule] => [`${r.source}/${r.reason}`, r];

export const AWARD_RULES: ReadonlyMap<string, AwardRule> = new Map([
  rule({ source: "campus", reason: "territory_claim", min: 1, max: 100, territory: true }),
  rule({ source: "campus", reason: "territory_steal", min: 1, max: 100, territory: true }),
  rule({ source: "campus", reason: "territory_defend", min: 1, max: 100, territory: true }),
  rule({ source: "campus", reason: "meetup_checkin", min: 25, max: 25, keyPrefix: "meetup" }),
  rule({ source: "exercise", reason: "shared_workout_finished", min: 20, max: 20, perDay: SHARED_WORKOUTS_PER_DAY }),
  rule({ source: "exercise", reason: "buddy_connected", min: 20, max: 20, keyPrefix: "buddy" }),
  rule({ source: "social", reason: "ambassador_referral", min: 50, max: 50 }),
  rule({ source: "social", reason: "ambassador_task", min: 1, max: 200 }),
  rule({ source: "social", reason: "special_event", min: 1, max: 100 }),
]);

export interface AwardInput {
  subject: string;
  source: string;
  reason: string;
  amount: number;
  idempotency_key: string;
  source_id?: string | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
}

/** Why an award cannot be accepted (the route answers 422), or null when it can. */
export function checkAward(input: AwardInput): string | null {
  const r = AWARD_RULES.get(`${input.source}/${input.reason}`);
  if (!r) return `unknown source/reason: ${input.source}/${input.reason}`;
  if (!Number.isInteger(input.amount) || input.amount < r.min || input.amount > r.max) {
    return r.min === r.max
      ? `amount for ${input.reason} must be exactly ${r.max}`
      : `amount for ${input.reason} must be between ${r.min} and ${r.max}`;
  }
  const key = input.idempotency_key;
  if (key.length < 1 || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    return `idempotency_key must be 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`;
  }
  if (r.keyPrefix) {
    // {prefix}:{id}:{subject}; the id may itself contain ':' (Exercise's pair key is low:high).
    const prefix = `${r.keyPrefix}:`;
    const suffix = `:${input.subject.toLowerCase()}`;
    const lower = key.toLowerCase();
    if (!key.startsWith(prefix) || !lower.endsWith(suffix) || key.length <= prefix.length + suffix.length) {
      return `idempotency_key for ${input.reason} must be ${r.keyPrefix}:{id}:{subject}`;
    }
  }
  if (input.source_id !== undefined && input.source_id !== null && input.source_id.length > MAX_SOURCE_ID_LENGTH) {
    return `source_id must be at most ${MAX_SOURCE_ID_LENGTH} characters`;
  }
  if (input.metadata !== undefined && input.metadata !== null &&
      Buffer.byteLength(JSON.stringify(input.metadata), "utf8") > MAX_METADATA_BYTES) {
    return `metadata must be at most ${MAX_METADATA_BYTES} bytes of JSON`;
  }
  return null;
}

/** One external_xp_awards row, as far as XP is concerned. */
export interface ExternalAwardRow {
  source: string;
  idempotency_key: string;
  amount: number;
  reason: string;
  source_id: string | null;
  created_at: Date;
  reversed_at: Date | null;
}

const SOURCE_CATEGORY: Record<string, XpCategory> = { campus: "campus", exercise: "exercise", social: "social" };
const capReasonFor = (category: XpCategory): XpReason =>
  category === "exercise" ? "exercise_awards_daily_cap" : category === "social" ? "social_awards_daily_cap" : "campus_awards_daily_cap";

/** The XP lines external awards earn, after the territory, shared-workout and 300/day caps. */
export function externalEntries(rows: ExternalAwardRow[], timeZone: string): XpEntry[] {
  const ordered = [...rows].sort(
    (a, b) =>
      a.created_at.getTime() - b.created_at.getTime() ||
      (a.source < b.source ? -1 : a.source > b.source ? 1 : 0) ||
      (a.idempotency_key < b.idempotency_key ? -1 : a.idempotency_key > b.idempotency_key ? 1 : 0),
  );
  const territoryUsed = new Map<string, number>();
  const externalUsed = new Map<string, number>();
  const perDayCount = new Map<string, number>();
  const entries: XpEntry[] = [];

  for (const row of ordered) {
    const r = AWARD_RULES.get(`${row.source}/${row.reason}`);
    const category = SOURCE_CATEGORY[row.source] ?? "campus";
    const day = xpDay(row.created_at, timeZone);
    const id = `award:${row.source}:${row.idempotency_key}`;
    const base = { category, day, created_at: row.created_at, source_id: row.source_id, reversed: false };
    const reason = row.reason as XpReason;
    if (row.reversed_at) {
      entries.push({ ...base, id, reason, xp: row.amount, counts: false, reversed: true });
      continue;
    }

    let awarded: number;
    let capReason: XpReason;
    if (r?.territory) {
      const used = territoryUsed.get(day) ?? 0;
      awarded = Math.min(row.amount, Math.max(0, TERRITORY_DAILY_CAP - used));
      territoryUsed.set(day, used + awarded);
      capReason = "territory_daily_cap";
    } else {
      const countKey = `${row.reason}|${day}`;
      const seen = perDayCount.get(countKey) ?? 0;
      if (r?.perDay !== undefined && seen >= r.perDay) {
        awarded = 0;
        capReason = "shared_workout_daily_limit";
      } else {
        perDayCount.set(countKey, seen + 1);
        const used = externalUsed.get(day) ?? 0;
        awarded = Math.min(row.amount, Math.max(0, EXTERNAL_DAILY_CAP - used));
        externalUsed.set(day, used + awarded);
        capReason = capReasonFor(category);
      }
    }
    entries.push({ ...base, id, reason, xp: row.amount, counts: awarded > 0 });
    if (awarded < row.amount) {
      entries.push({ ...base, id: `${id}:${capReason}`, reason: capReason, xp: awarded - row.amount, counts: awarded > 0 });
    }
  }
  return entries;
}

/** One resolved challenge win. */
export interface ChallengeWinRow {
  challenge_id: string;
  xp_awarded: number;
  resolved_at: Date;
}

/** The XP lines challenge wins earn, at most CHALLENGE_DAILY_CAP a day (by when they resolved). */
export function challengeEntries(rows: ChallengeWinRow[], timeZone: string): XpEntry[] {
  const ordered = [...rows].sort(
    (a, b) => a.resolved_at.getTime() - b.resolved_at.getTime() || (a.challenge_id < b.challenge_id ? -1 : 1),
  );
  const used = new Map<string, number>();
  const entries: XpEntry[] = [];
  for (const row of ordered) {
    if (!(row.xp_awarded > 0)) continue;
    const day = xpDay(row.resolved_at, timeZone);
    const before = used.get(day) ?? 0;
    const awarded = Math.min(row.xp_awarded, Math.max(0, CHALLENGE_DAILY_CAP - before));
    used.set(day, before + awarded);
    const id = `challenge:${row.challenge_id}`;
    const base = { category: "challenge" as const, day, created_at: row.resolved_at, source_id: row.challenge_id, counts: awarded > 0, reversed: false };
    entries.push({ ...base, id, reason: "challenge completed", xp: row.xp_awarded });
    if (awarded < row.xp_awarded) entries.push({ ...base, id: `${id}:challenge_daily_cap`, reason: "challenge_daily_cap", xp: awarded - row.xp_awarded });
  }
  return entries;
}
