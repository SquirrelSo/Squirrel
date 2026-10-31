/**
 * Outbound translation — the single place where campus user ids become Social profile ids.
 *
 * Applied to every HTTP JSON response (app.ts `preSerialization` hook) and every realtime frame
 * (realtime/ws.ts), so route code keeps working with JWT subs internally. It walks the payload and:
 *   - replaces the value of every USER_ID_KEYS field that holds a known campus user id with the profile id;
 *   - for "person" objects (have both `user_id` and `display_name`: Person, public profile, /v1/me,
 *     leaderboard entries, map players, …) sets display_name/avatar_url from Social, and hostel from Social
 *     when Social has one (else the campus hostel stays).
 * Stored JSON (idempotent replays, notification `data`) is translated the same way on the way out.
 * Ids Social cannot resolve (Social down, unknown user) are left as they are: id = sub, campus names.
 * Never throws: on any error the payload goes out untranslated.
 */
import pino from 'pino';
import { config } from '../config.js';
import { many } from '../db/pool.js';
import { bridgeEnabled, cachedPerson, lookupBySubs, type SocialPerson } from './index.js';

/** Response fields that hold a campus user id. Keep in sync when adding a new user-id field to a response. */
export const USER_ID_KEYS = new Set([
  'user_id', 'owner_id', 'created_by', 'actor_id', 'new_owner_id', 'previous_owner_id',
  'responded_by', 'target_user_id', 'winner_user_id', 'blocked_id', 'blocker_id',
]);

const MAX_DEPTH = 32;
const log = pino({ level: config.logLevel, name: 'identity' });

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

function collect(v: unknown, out: Set<string>, depth = 0) {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(v)) { for (const x of v) if (x !== null && typeof x === 'object') collect(x, out, depth + 1); return; }
  if (!isPlainObject(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string') { if (x && USER_ID_KEYS.has(k)) out.add(x); }
    else if (x !== null && typeof x === 'object') collect(x, out, depth + 1);
  }
}

function rewrite(v: unknown, people: Map<string, SocialPerson>, depth = 0): unknown {
  if (depth > MAX_DEPTH) return v;
  if (Array.isArray(v)) {
    // Coordinate arrays etc. contain no objects: return them untouched.
    return v.some((x) => x !== null && typeof x === 'object') ? v.map((x) => rewrite(x, people, depth + 1)) : v;
  }
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' && USER_ID_KEYS.has(k)) out[k] = people.get(x)?.profile_id ?? x;
    else out[k] = x !== null && typeof x === 'object' ? rewrite(x, people, depth + 1) : x;
  }
  const p = typeof v.user_id === 'string' ? people.get(v.user_id) : undefined;
  if (p && 'display_name' in v) {
    if (p.display_name) out.display_name = p.display_name;
    if ('avatar_url' in v) out.avatar_url = p.avatar_url;
    if ('hostel' in v && p.hostel) out.hostel = p.hostel;
  }
  return out;
}

/** Social people for the subs referenced in a payload. Uncached ids are only sent to Social if they are real campus users. */
async function peopleFor(ids: string[]): Promise<Map<string, SocialPerson>> {
  const cached: string[] = [];
  const unknown: string[] = [];
  for (const id of ids) (cachedPerson(id) ? cached : unknown).push(id);
  // Social provisions a profile for every subject it has never seen, so never send it arbitrary strings
  // (e.g. an unresolvable id echoed back from a request): only ids that exist in `users`.
  const existing = unknown.length ? (await many<{ id: string }>(`SELECT id FROM users WHERE id = ANY($1::text[])`, [unknown])).map((r) => r.id) : [];
  return lookupBySubs([...cached, ...existing]);
}

export async function translateOutbound<T>(payload: T): Promise<T> {
  if (!bridgeEnabled() || payload === null || typeof payload !== 'object') return payload;
  try {
    const ids = new Set<string>();
    collect(payload, ids);
    if (!ids.size) return payload;
    const people = await peopleFor([...ids]);
    if (!people.size) return payload;
    return rewrite(payload, people) as T;
  } catch (err) {
    log.warn({ err }, 'identity translation failed; sending campus ids');
    return payload;
  }
}
