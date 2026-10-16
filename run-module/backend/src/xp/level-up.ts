/**
 * src/xp/level-up.ts
 *
 * Level-up notifications (ADR-033). When an XP award (or reversal) moves a user to a higher level,
 * an `xp.level_up` row goes into the notification outbox, which the existing deliverer sends to
 * Social. Only an increase notifies; a level lost to a reversal is silent.
 *
 * Dedupe key level:{subject}:{level}: the outbox id is derived from it, so a level is written once
 * however many concurrent awards cross it, and reaching it again after a reversal does not repeat it.
 * The row is written before the award route answers; putting it on the delivery queue happens in the
 * background so Redis can never hold up the award (a row left pending is picked up by the next
 * emitPending sweep).
 */

import crypto from "node:crypto";
import { pool } from "../db/pool.js";
import { levelForXp } from "./rules.js";

/** A UUID derived from the dedupe key (same key, same id). */
export function outboxIdFor(dedupeKey: string): string {
  const h = crypto.createHash("sha256").update(`run_module:${dedupeKey}`).digest("hex");
  // Shape it as a version-5-style UUID so it fits the uuid column.
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Write an xp.level_up outbox row when `afterXp` is a higher level than `beforeXp`. Returns the
 *  outbox id when a new row was written. Never throws: a failed notification must not fail an award. */
export async function recordLevelUp(subject: string, beforeXp: number, afterXp: number): Promise<string | null> {
  const before = levelForXp(beforeXp).level;
  const after = levelForXp(afterXp).level;
  if (after <= before) return null;
  const dedupeKey = `level:${subject}:${after}`;
  const id = outboxIdFor(dedupeKey);
  try {
    const res = await pool.query(
      `INSERT INTO notification_outbox (id, user_id, event_type, payload)
       VALUES ($1, $2, 'xp.level_up', $3)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, subject, JSON.stringify({ level: after, xp: afterXp, dedupe_key: dedupeKey })],
    );
    if ((res.rowCount ?? 0) === 0) return null;
    void import("../notifications/emitter.js")
      .then(({ enqueueOutboxIds }) => enqueueOutboxIds([id]))
      .catch((err: unknown) => console.warn(`[xp] level-up ${id} left pending: ${err instanceof Error ? err.message : String(err)}`));
    return id;
  } catch (err) {
    console.warn(`[xp] could not record level-up for ${subject}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
