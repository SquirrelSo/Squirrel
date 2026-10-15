/**
 * Keyset pagination over a deterministic sort key.
 *
 * Every list is ordered ascending by a tuple key (descending fields are negated), and the cursor is the
 * key of the last item returned, base64url-encoded. Keys must never carry anything a client may not see:
 * no user ids (use `tiebreak`, a one-way hash), no exact counts that are otherwise suppressed, no distances.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { errors } from './errors.js';

export type SortKey = (string | number)[];

export const LimitQuery = z.coerce.number().int().min(1).max(50);
export const CursorQuery = z.string().min(1).max(512);

/** A stable, opaque tie-breaker for an id (never the id itself). */
export function tiebreak(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 20);
}

export function encodeCursor(key: SortKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string | undefined): SortKey | null {
  if (!cursor) return null;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(v) && v.length > 0 && v.length <= 8 && v.every((x) => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) return v as SortKey;
  } catch { /* fall through */ }
  throw errors.invalid('cursor: invalid cursor');
}

export function compareKeys(a: SortKey, b: SortKey): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!, y = b[i]!;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1;
    if (typeof x === 'string' && typeof y === 'string') return x < y ? -1 : 1;
    return typeof x === 'number' ? -1 : 1; // mixed types: numbers first (only from tampered cursors)
  }
  return a.length - b.length;
}

/** Sort by key, keep what comes after the cursor, take `limit`. */
export function paginate<T>(items: T[], keyOf: (t: T) => SortKey, limit: number, cursor?: string): { items: T[]; next_cursor: string | null } {
  const after = decodeCursor(cursor);
  const keyed = items.map((item) => ({ item, key: keyOf(item) })).sort((a, b) => compareKeys(a.key, b.key));
  const rest = after ? keyed.filter((k) => compareKeys(k.key, after) > 0) : keyed;
  const page = rest.slice(0, limit);
  return { items: page.map((k) => k.item), next_cursor: rest.length > limit && page.length ? encodeCursor(page[page.length - 1]!.key) : null };
}
