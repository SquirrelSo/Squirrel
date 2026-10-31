/**
 * Identity bridge to the Social service.
 *
 * campus-service keys users by the JWT `sub` (the Exercise account id). The Social service owns the
 * public identity: a *profile id* (different from `sub`), display name, avatar and hostel. When the bridge
 * is ON (SOCIAL_API_URL + SOCIAL_INTERNAL_TOKEN both set):
 *   - outbound: every user id sent to clients is the Social profile id, names/avatars come from Social
 *     (src/identity/translate.ts, hooked in app.ts `preSerialization` and realtime/ws.ts);
 *   - inbound: user ids sent by clients may be profile ids and are resolved to subs (src/identity/inbound.ts);
 *   - persistence: Social names/avatars are written back to `users` (listener registered by users/repo.ts).
 * When OFF, nothing here is called and the service behaves exactly as before.
 *
 * Social contract (POST {SOCIAL_API_URL}/internal/v1/people/resolve, Bearer SOCIAL_INTERNAL_TOKEN):
 *   body { subjects?: string[≤200], profile_ids?: uuid[≤200] } → { people: SocialPerson[] }
 * Unknown subjects are provisioned by Social (a subject always comes back); unknown profile ids are omitted.
 *
 * Failure policy: Social being slow/down/misconfigured never fails a request. Lookups time out after
 * SOCIAL_TIMEOUT_MS (3 s), a failure pauses calls for BACKOFF_MS, and callers fall back to cached (even stale)
 * entries or to campus data (id = sub, campus display_name).
 */
import pino from 'pino';
import { config } from '../config.js';
import { isUuid } from '../lib/ids.js';

export type SocialPerson = {
  subject: string;
  profile_id: string;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  hostel: string | null;
  level: number | null;
};

export type SocialSettings = { url: string; token: string; timeoutMs: number; cacheTtlMs: number };

const MAX_BATCH = 200;
const BACKOFF_MS = 30_000;          // after a failure, don't call Social again for this long
const NEGATIVE_TTL_MS = 60_000;     // "this uuid is not a Social profile id" (probably a sub)
const MAX_CACHE_ENTRIES = 20_000;

const log = pino({ level: config.logLevel, name: 'identity' });

// ---------------------------------------------------------------------------------------------
// Settings (env by default; tests may override)
// ---------------------------------------------------------------------------------------------
let override: SocialSettings | null | undefined; // undefined → from env

function fromEnv(): SocialSettings | null {
  const { apiUrl, internalToken, timeoutMs, cacheTtlSeconds } = config.social;
  if (!apiUrl || !internalToken) return null;
  return { url: apiUrl, token: internalToken, timeoutMs, cacheTtlMs: cacheTtlSeconds * 1000 };
}

export function socialSettings(): SocialSettings | null {
  return override === undefined ? fromEnv() : override;
}

export function bridgeEnabled(): boolean {
  return socialSettings() !== null;
}

/** Override the env settings (tests). `null` forces the bridge OFF; `undefined` returns to env. Clears caches. */
export function configureSocialBridge(s: (Partial<SocialSettings> & { url: string; token: string }) | null | undefined) {
  override = s === undefined || s === null ? s : { timeoutMs: 3000, cacheTtlMs: 300_000, ...s, url: s.url.replace(/\/+$/, '') };
  resetIdentityState();
}

// ---------------------------------------------------------------------------------------------
// Caches: sub → person, profile_id → sub (both TTL'd); negative cache for unknown profile ids
// ---------------------------------------------------------------------------------------------
const bySub = new Map<string, { person: SocialPerson; at: number }>();
const subByProfile = new Map<string, { sub: string; at: number }>();
const notAProfile = new Map<string, number>();
let downUntil = 0;
let notificationDownUntil = 0;

const blocksCache = new Map<string, { blocked: Set<string>; at: number }>();

export function resetIdentityState() {
  bySub.clear(); subByProfile.clear(); notAProfile.clear(); blocksCache.clear();
  crewMemCache.clear(); crewLookupCache.clear();
  downUntil = 0; notificationDownUntil = 0;
}

function bounded<K, V>(m: Map<K, V>) {
  if (m.size <= MAX_CACHE_ENTRIES) return;
  const drop = m.size - MAX_CACHE_ENTRIES;
  let i = 0;
  for (const k of m.keys()) { if (i++ >= drop) break; m.delete(k); }
}

function remember(people: SocialPerson[]) {
  const at = Date.now();
  for (const p of people) {
    bySub.delete(p.subject); bySub.set(p.subject, { person: p, at });
    subByProfile.delete(p.profile_id); subByProfile.set(p.profile_id, { sub: p.subject, at });
    notAProfile.delete(p.profile_id);
  }
  bounded(bySub); bounded(subByProfile); bounded(notAProfile);
}

/** Cached person for a sub (fresh or stale), without calling Social. */
export function cachedPerson(sub: string): SocialPerson | null {
  return bySub.get(sub)?.person ?? null;
}

// ---------------------------------------------------------------------------------------------
// Listeners: fresh data from Social (users/repo.ts persists names/avatars to `users`)
// ---------------------------------------------------------------------------------------------
type FreshListener = (people: SocialPerson[]) => Promise<void>;
const listeners: FreshListener[] = [];
export function onFreshSocialPeople(fn: FreshListener) { listeners.push(fn); }

async function emitFresh(people: SocialPerson[]) {
  if (!people.length) return;
  for (const fn of listeners) {
    try { await fn(people); } catch (err) { log.warn({ err }, 'failed to persist Social profile data'); }
  }
}

// ---------------------------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------------------------
class SocialUnavailable extends Error {}

function parsePerson(x: unknown): SocialPerson | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o.subject !== 'string' || !o.subject || typeof o.profile_id !== 'string' || !o.profile_id) return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    subject: o.subject, profile_id: o.profile_id, username: str(o.username),
    display_name: str(o.display_name)?.trim() ?? '', avatar_url: str(o.avatar_url) || null, hostel: str(o.hostel)?.trim() || null,
    level: typeof o.level === 'number' ? o.level : null,
  };
}

async function callResolve(s: SocialSettings, body: { subjects?: string[]; profile_ids?: string[] }): Promise<SocialPerson[]> {
  let res: Response;
  try {
    res = await fetch(`${s.url}/internal/v1/people/resolve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
  } catch (err) {
    throw new SocialUnavailable(`request failed: ${(err as Error).name === 'TimeoutError' ? `timed out after ${s.timeoutMs} ms` : (err as Error).message}`);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    const hint = res.status === 401 ? ' (SOCIAL_INTERNAL_TOKEN rejected)' : res.status === 404 ? ' (Social internal token unset or wrong SOCIAL_API_URL)' : '';
    throw new SocialUnavailable(`HTTP ${res.status}${hint}`);
  }
  let json: unknown;
  try { json = await res.json(); } catch { throw new SocialUnavailable('invalid JSON'); }
  const people = (json as { people?: unknown }).people;
  if (!Array.isArray(people)) throw new SocialUnavailable('response has no people[]');
  return people.map(parsePerson).filter((p): p is SocialPerson => p !== null);
}

function available(): SocialSettings | null {
  const s = socialSettings();
  if (!s || Date.now() < downUntil) return null;
  return s;
}

function markDown(err: unknown, operation = 'people lookup') {
  downUntil = Date.now() + BACKOFF_MS;
  log.warn({ err: (err as Error).message }, `Social ${operation} failed; backing off for ${BACKOFF_MS / 1000} s`);
}

export type SocialNotificationResult = { created: boolean; notification_id: string | null };

/** Post to Social with the identity bridge's shared credentials, timeout, and back-off policy. */
export async function postSocialNotification(payload: Record<string, unknown>, options: { bypassBackoff?: boolean } = {}): Promise<SocialNotificationResult | null> {
  const s = socialSettings();
  if (!s || (!options.bypassBackoff && Date.now() < notificationDownUntil)) return null;
  try {
    const res = await fetch(`${s.url}/internal/v1/notifications`, {
      method: 'POST',
      headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(s.timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new SocialUnavailable(`HTTP ${res.status}`);
    }
    const body = await res.json() as Record<string, unknown>;
    if (typeof body.created !== 'boolean' || !(body.notification_id === null || typeof body.notification_id === 'string')) {
      throw new SocialUnavailable('invalid notification response');
    }
    return { created: body.created, notification_id: body.notification_id };
  } catch (err) {
    notificationDownUntil = Date.now() + BACKOFF_MS;
    log.warn({ err: (err as Error).message }, `Social notification forwarding failed; backing off for ${BACKOFF_MS / 1000} s`);
    return null;
  }
}

const chunks = <T,>(xs: T[]) => Array.from({ length: Math.ceil(xs.length / MAX_BATCH) }, (_, i) => xs.slice(i * MAX_BATCH, (i + 1) * MAX_BATCH));

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/**
 * Social people for these subs (JWT `sub` / campus users.id). Only pass subs of real campus users:
 * Social provisions a profile for every subject it has not seen. Missing entries = fall back to campus data.
 */
export async function lookupBySubs(subs: string[]): Promise<Map<string, SocialPerson>> {
  const s = socialSettings();
  const out = new Map<string, SocialPerson>();
  if (!s) return out;
  const now = Date.now();
  const need: string[] = [];
  for (const sub of new Set(subs.filter(Boolean))) {
    const c = bySub.get(sub);
    if (c && now - c.at < s.cacheTtlMs) out.set(sub, c.person);
    else need.push(sub);
  }
  if (need.length && available()) {
    const fresh: SocialPerson[] = [];
    try {
      for (const chunk of chunks(need)) fresh.push(...(await callResolve(s, { subjects: chunk })));
    } catch (err) { markDown(err); }
    remember(fresh);
    await emitFresh(fresh);
  }
  for (const sub of need) {
    const c = bySub.get(sub); // fresh, or stale when Social failed (better than campus placeholders)
    if (c) out.set(sub, c.person);
  }
  return out;
}

/** Profile id → sub for the given ids (only uuid-shaped ids are asked). Unknown ids are absent. */
export async function resolveProfileIds(ids: string[]): Promise<Map<string, string>> {
  const s = socialSettings();
  const out = new Map<string, string>();
  if (!s) return out;
  const now = Date.now();
  const need: string[] = [];
  for (const id of new Set(ids.filter((x) => typeof x === 'string' && isUuid(x)))) {
    const c = subByProfile.get(id);
    if (c && now - c.at < s.cacheTtlMs) { out.set(id, c.sub); continue; }
    const neg = notAProfile.get(id);
    if (neg && now - neg < NEGATIVE_TTL_MS) continue;
    const known = bySub.get(id);
    if (known && now - known.at < s.cacheTtlMs) continue; // it's a sub we already know, not a profile id
    need.push(id);
  }
  if (need.length && available()) {
    const fresh: SocialPerson[] = [];
    let ok = true;
    try {
      for (const chunk of chunks(need)) fresh.push(...(await callResolve(s, { profile_ids: chunk })));
    } catch (err) { ok = false; markDown(err); }
    remember(fresh);
    if (ok) {
      const found = new Set(fresh.map((p) => p.profile_id));
      for (const id of need) if (!found.has(id)) notAProfile.set(id, Date.now());
    }
    await emitFresh(fresh);
  }
  for (const id of need) {
    const c = subByProfile.get(id);
    if (c) out.set(id, c.sub);
  }
  return out;
}

/**
 * Inbound: a user id from a client (path param or body) → campus user id (sub).
 * A Social profile id resolves to its sub; anything else is returned unchanged, so an existing campus
 * users.id (dev tokens, bridge off, or ids handed out while Social was down) keeps working and an unknown
 * id reaches the route's own 404.
 */
export async function resolveInboundIds(ids: string[]): Promise<Map<string, string>> {
  const out = new Map(ids.map((id) => [id, id]));
  if (!bridgeEnabled()) return out;
  const resolved = await resolveProfileIds(ids);
  for (const [pid, sub] of resolved) out.set(pid, sub);
  return out;
}

export async function resolveInboundId(id: string): Promise<string> {
  return (await resolveInboundIds([id])).get(id) ?? id;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

export type SocialBlocks = {
  subject: string;
  blocked: string[];
  as_of: string;
};

export class BlocksUnavailableError extends Error {
  constructor() {
    super('Social_Blocks_Unavailable');
    this.name = 'BlocksUnavailableError';
  }
}

export async function lookupBlocks(sub: string): Promise<Set<string>> {
  const s = socialSettings();
  if (!s) return new Set(); // bridge is OFF

  const now = Date.now();
  const c = blocksCache.get(sub);
  if (c && now - c.at < 30_000) return c.blocked;

  if (now < downUntil) throw new BlocksUnavailableError();

  try {
    const res = await fetch(`${s.url}/internal/v1/blocks/${encodeURIComponent(sub)}`, {
      headers: { authorization: `Bearer ${s.token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(s.timeoutMs),
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json() as SocialBlocks;
    const blockedSet = new Set(data.blocked || []);
    blocksCache.set(sub, { blocked: blockedSet, at: Date.now() });
    return blockedSet;
  } catch (err) {
    markDown(err);
    throw new BlocksUnavailableError();
  }
}

// ---------------------------------------------------------------------------------------------
// Crews
// ---------------------------------------------------------------------------------------------

export type SocialCrewRef = { id: string; name: string; role: string; joined_at: string };
export type SocialCrewMember = { subject: string; role: string; joined_at: string };
export type SocialCrew = { id: string; name: string; interest: string; members_count: number; members: SocialCrewMember[] };

const crewMemCache = new Map<string, { crews: SocialCrewRef[]; at: number }>();
const crewLookupCache = new Map<string, { crew: SocialCrew; at: number }>();

export type CrewMembershipStatus = 'fresh' | 'stale' | 'unknown';

export async function lookupCrewMembershipsWithStatus(subs: string[]): Promise<{
  memberships: Map<string, SocialCrewRef[]>;
  statuses: Map<string, CrewMembershipStatus>;
  unavailable: boolean;
}> {
  const s = socialSettings();
  const out = new Map<string, SocialCrewRef[]>();
  const statuses = new Map<string, CrewMembershipStatus>();
  if (!s) {
    for (const sub of new Set(subs.filter(Boolean))) {
      const cached = crewMemCache.get(sub);
      if (cached) {
        out.set(sub, cached.crews);
        statuses.set(sub, 'stale');
      } else statuses.set(sub, 'unknown');
    }
    return { memberships: out, statuses, unavailable: subs.some(Boolean) };
  }

  const now = Date.now();
  const need: string[] = [];
  
  for (const sub of new Set(subs.filter(Boolean))) {
    const c = crewMemCache.get(sub);
    if (c && now - c.at < s.cacheTtlMs) {
      out.set(sub, c.crews);
      statuses.set(sub, 'fresh');
    } else {
      need.push(sub);
    }
  }

  let unavailable = false;
  const canFetch = need.length > 0 && available();
  if (need.length && !canFetch) unavailable = true;
  if (canFetch) {
    try {
      for (const chunk of chunks(need)) {
        const res = await fetch(`${s.url}/internal/v1/crews/memberships`, {
          method: 'POST',
          headers: { authorization: `Bearer ${s.token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ subjects: chunk }),
          signal: AbortSignal.timeout(s.timeoutMs),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json() as { people: { subject: string; crews: SocialCrewRef[] }[] };
        for (const person of data.people) {
          crewMemCache.set(person.subject, { crews: person.crews, at: Date.now() });
          out.set(person.subject, person.crews);
          statuses.set(person.subject, 'fresh');
        }
      }
    } catch (err) {
      unavailable = true;
      markDown(err);
    }
  }
  
  for (const sub of need) {
    if (!statuses.has(sub)) {
      const c = crewMemCache.get(sub);
      if (c) {
        out.set(sub, c.crews);
        statuses.set(sub, 'stale');
      } else statuses.set(sub, 'unknown');
    }
  }
  
  return { memberships: out, statuses, unavailable };
}

export async function lookupCrewMemberships(subs: string[]): Promise<Map<string, SocialCrewRef[]>> {
  return (await lookupCrewMembershipsWithStatus(subs)).memberships;
}

export async function lookupCrewsWithStatus(crewIds: string[]): Promise<{ crews: Map<string, SocialCrew>; unavailable: boolean }> {
  const s = socialSettings();
  const out = new Map<string, SocialCrew>();
  if (!s) return { crews: out, unavailable: crewIds.some(Boolean) };

  const now = Date.now();
  const need: string[] = [];
  
  for (const id of new Set(crewIds.filter(Boolean))) {
    const c = crewLookupCache.get(id);
    if (c && now - c.at < s.cacheTtlMs) {
      out.set(id, c.crew);
    } else {
      need.push(id);
    }
  }

  let unavailable = false;
  const canFetch = need.length > 0 && available();
  if (need.length && !canFetch) unavailable = true;
  if (canFetch) {
    try {
      for (const chunk of chunks(need)) {
        const res = await fetch(`${s.url}/internal/v1/crews/lookup`, {
          method: 'POST',
          headers: { authorization: `Bearer ${s.token}`, accept: 'application/json', 'content-type': 'application/json' },
          body: JSON.stringify({ crew_ids: chunk }),
          signal: AbortSignal.timeout(s.timeoutMs),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json() as { crews: SocialCrew[] };
        for (const crew of data.crews) {
          crewLookupCache.set(crew.id, { crew, at: Date.now() });
          out.set(crew.id, crew);
        }
      }
    } catch (err) {
      unavailable = true;
      markDown(err);
    }
  }
  
  for (const id of need) {
    if (!out.has(id)) {
      const c = crewLookupCache.get(id);
      if (c) out.set(id, c.crew);
    }
  }
  
  return { crews: out, unavailable };
}

export async function lookupCrews(crewIds: string[]): Promise<Map<string, SocialCrew>> {
  return (await lookupCrewsWithStatus(crewIds)).crews;
}
