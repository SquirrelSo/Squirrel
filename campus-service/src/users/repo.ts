import type { JWTPayload } from 'jose';
import { one, many, query, getPool, type Queryable } from '../db/pool.js';
import { bridgeEnabled, lookupBySubs, onFreshSocialPeople, type SocialPerson } from '../identity/index.js';

export type UserRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  email: string | null;
  email_domain: string | null;
  hostel_id: string | null;
  connection_mode: 'date' | 'friends' | 'crew' | null;
  open_to_meet: boolean;
  open_to_meet_updated_at: string | null;
  open_to_meet_until: string | null;
  date_mode_enabled: boolean;
  onboarding_completed: boolean;
  founding_member: boolean;
  xp_total: number;
  xp_synced_at: string;
  last_territory_action_at: string | null;
  is_banned: boolean;
  created_at: string;
  updated_at: string;
};

export type PersonLite = { user_id: string; display_name: string; avatar_url: string | null; hostel: string | null; level?: number; xp?: number; };

const CACHE = new Map<string, { row: UserRow; at: number }>();
const CACHE_TTL = 5_000;

/**
 * JIT provisioning: the account service owns identity; we only need a profile row to hang data on.
 * With the Social identity bridge ON, the stored name/avatar are the user's Social ones (looked up once per
 * cache TTL; Social down → the token's name claim or a placeholder, as before), so server-built text such as
 * notifications uses real names.
 */
export async function ensureUser(userId: string, claims: JWTPayload): Promise<UserRow> {
  const c = CACHE.get(userId);
  if (c && Date.now() - c.at < CACHE_TTL) return c.row;
  const email = typeof claims.email === 'string' ? claims.email : null;
  const social = bridgeEnabled() ? (await lookupBySubs([userId])).get(userId) ?? null : null;
  const useSocial = !!social?.display_name;
  const name = useSocial ? social!.display_name
    : typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 60) : `Squirrel ${userId.replace(/[^a-z0-9]/gi, '').slice(-6)}`;
  const domain = email?.includes('@') ? email.split('@')[1]!.toLowerCase() : null;
  const row = await one<UserRow>(
    `INSERT INTO users (id, display_name, email, email_domain, avatar_url)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::boolean THEN $6 ELSE NULL END)
     ON CONFLICT (id) DO UPDATE SET
       email = COALESCE(users.email, EXCLUDED.email),
       email_domain = COALESCE(users.email_domain, EXCLUDED.email_domain),
       display_name = CASE WHEN $5::boolean THEN EXCLUDED.display_name ELSE users.display_name END,
       avatar_url = CASE WHEN $5::boolean THEN EXCLUDED.avatar_url ELSE users.avatar_url END
     RETURNING *`,
    [userId, name, email, domain, useSocial, social?.avatar_url ?? null],
  );
  CACHE.set(userId, { row: row!, at: Date.now() });
  return row!;
}

/** Write Social names/avatars back to `users` when they differ, so server-built text uses real names. */
export async function syncSocialProfiles(people: SocialPerson[]) {
  const rows = people.filter((p) => p.display_name);
  if (!rows.length) return;
  const changed = await many<{ id: string }>(
    `UPDATE users u SET display_name = v.display_name, avatar_url = v.avatar_url, updated_at = now()
     FROM unnest($1::text[], $2::text[], $3::text[]) AS v(id, display_name, avatar_url)
     WHERE u.id = v.id AND (u.display_name IS DISTINCT FROM v.display_name OR u.avatar_url IS DISTINCT FROM v.avatar_url)
     RETURNING u.id`,
    [rows.map((p) => p.subject), rows.map((p) => p.display_name), rows.map((p) => p.avatar_url)],
  );
  for (const r of changed) invalidateUserCache(r.id);
}
onFreshSocialPeople(syncSocialProfiles);

export function invalidateUserCache(userId: string) { CACHE.delete(userId); }

export async function getUser(userId: string, q?: Queryable) {
  return one<UserRow>('SELECT * FROM users WHERE id = $1', [userId], q);
}

export async function getPersonLite(userId: string | null, q?: Queryable): Promise<PersonLite | null> {
  if (!userId) return null;
  const r = await one<{ id: string; display_name: string; avatar_url: string | null; hostel: string | null }>(
    `SELECT u.id, u.display_name, u.avatar_url, h.short_name AS hostel FROM users u LEFT JOIN hostels h ON h.id = u.hostel_id WHERE u.id = $1`,
    [userId], q,
  );
  return r ? { user_id: r.id, display_name: r.display_name, avatar_url: r.avatar_url, hostel: r.hostel } : null;
}

export async function getPeopleLite(ids: string[], q?: Queryable): Promise<Map<string, PersonLite>> {
  const out = new Map<string, PersonLite>();
  const uniq = [...new Set(ids.filter(Boolean))];
  if (!uniq.length) return out;
  const rows = await many<{ id: string; display_name: string; avatar_url: string | null; hostel: string | null; xp_total: number; xp_synced_at: string }>(
    `SELECT u.id, u.display_name, u.avatar_url, h.short_name AS hostel, u.xp_total, u.xp_synced_at FROM users u LEFT JOIN hostels h ON h.id = u.hostel_id WHERE u.id = ANY($1)`,
    [uniq], q,
  );
  const { syncBatchXp } = await import('../run/index.js');
  await syncBatchXp(rows.map(r => ({ user_id: r.id, xp_total: r.xp_total, xp_synced_at: r.xp_synced_at })), q ?? getPool());

  for (const r of rows) {
    out.set(r.id, { user_id: r.id, display_name: r.display_name, avatar_url: r.avatar_url, hostel: r.hostel, level: Math.floor(r.xp_total / 2000) + 1, xp: r.xp_total });
  }
  return out;
}

export async function updateUser(userId: string, patch: Record<string, unknown>, q?: Queryable) {
  const keys = Object.keys(patch);
  if (!keys.length) return getUser(userId, q);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ');
  const row = await one<UserRow>(`UPDATE users SET ${sets}, updated_at = now() WHERE id = $1 RETURNING *`, [userId, ...keys.map((k) => patch[k])], q);
  invalidateUserCache(userId);
  return row;
}

export async function touchTerritoryAction(userId: string, q: Queryable) {
  await query('UPDATE users SET last_territory_action_at = now(), updated_at = now() WHERE id = $1', [userId], q);
  invalidateUserCache(userId);
}

export async function createMissingUsersFromSocial(userIds: string[], q?: Queryable): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!bridgeEnabled() || !userIds.length) return map;

  // UUIDs in this array are profile_ids that failed to resolve in resolveInboundIds.
  // If we pass them to lookupBySubs, Social will provision them as new subs, which is wrong.
  const validSubs = userIds.filter(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  if (!validSubs.length) return map;

  const socialMap = await lookupBySubs(validSubs);
  const toInsert: SocialPerson[] = [];
  
  for (const id of validSubs) {
    const p = socialMap.get(id);
    if (p) {
      map.set(id, p.display_name);
      toInsert.push(p);
    }
  }

  if (toInsert.length > 0) {
    await query(
      `INSERT INTO users (id, display_name, avatar_url) 
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
       ON CONFLICT (id) DO NOTHING`,
      [toInsert.map(p => p.subject), toInsert.map(p => p.display_name), toInsert.map(p => p.avatar_url)],
      q ?? getPool()
    );
  }
  return map;
}
