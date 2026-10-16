/**
 * Discover (campus-service GET /v1/discover[/{section}]): the words, filters and paging the screen
 * uses. The server decides who and what is listed; nothing here infers a position or a distance —
 * proximity arrives as a bucket and is only ever turned into words. Pure, so it's unit-tested.
 */
import type { ActivityType, DiscoverHiddenReason, DiscoverZone, Proximity } from '@/api/featureContracts';

export type DiscoverSection = 'nearby' | 'active' | 'challenges' | 'zones' | 'crews';
export const DISCOVER_SECTIONS: DiscoverSection[] = ['nearby', 'active', 'challenges', 'zones', 'crews'];

export const SECTION_TITLE: Record<DiscoverSection, string> = {
  nearby: 'Nearby',
  active: 'Active now',
  challenges: 'Your battles',
  zones: 'Zones',
  crews: 'Crews',
};

/** Coarse buckets only: same ~250 m cell / a touching cell / somewhere on campus. */
export const PROXIMITY_WORDS: Record<Proximity, string> = { very_close: 'Very close', nearby: 'Nearby', on_campus: 'On campus' };
export const proximityWords = (p: Proximity | null | undefined): string | null => (p && p in PROXIMITY_WORDS ? PROXIMITY_WORDS[p] : null);

export const ACTIVITY_WORDS: Record<ActivityType, string> = { run: 'Running', walk: 'Walking', workout: 'Working out' };

/** The filters each section's route accepts (unknown query parameters are a 422 there). */
export type DiscoverFilters = { activity_type?: ActivityType; sort?: string; zone_id?: string; type?: string };
export const SECTION_SORTS: Partial<Record<DiscoverSection, readonly string[]>> = {
  nearby: ['proximity', 'recent'],
  active: ['recent', 'level'],
  zones: ['popular', 'contested', 'unclaimed'],
};
export const SORT_LABEL: Record<string, string> = { proximity: 'Closest', recent: 'Latest', level: 'Level', popular: 'Popular', contested: 'Contested', unclaimed: 'Unclaimed' };
export const BATTLE_TYPES = ['territory', 'weekend_war', 'zone_race', 'group_activity'] as const;
export const BATTLE_TYPE_LABEL: Record<(typeof BATTLE_TYPES)[number], string> = { territory: 'Territory duel', weekend_war: 'Weekend war', zone_race: 'Zone race', group_activity: 'Group activity' };

const ACCEPTS: Record<DiscoverSection, readonly (keyof DiscoverFilters)[]> = {
  nearby: ['activity_type', 'zone_id', 'sort'],
  active: ['activity_type', 'sort'],
  challenges: ['type', 'zone_id'],
  zones: ['sort'],
  crews: [],
};
export const sectionAccepts = (section: DiscoverSection, f: keyof DiscoverFilters) => ACCEPTS[section].includes(f);

/** Query for one page of a section: only the filters it accepts, an unknown sort dropped, plus the cursor. */
export function sectionQuery(section: DiscoverSection, f: DiscoverFilters, cursor?: string | null, limit = 20): Record<string, string | number | undefined> {
  const q: Record<string, string | number | undefined> = { limit };
  for (const k of ACCEPTS[section]) {
    const v = f[k];
    if (!v) continue;
    if (k === 'sort' && !SECTION_SORTS[section]?.includes(v)) continue;
    q[k] = v;
  }
  if (cursor) q.cursor = cursor;
  return q;
}

/** A further page appended to what's shown; an item already listed (by key) keeps its first place. */
export function appendPage<T>(shown: T[], next: T[], key: (t: T) => string): T[] {
  const seen = new Set(shown.map(key));
  return [...shown, ...next.filter((t) => !seen.has(key(t)))];
}

/** Zones present in a list, once each, by name: the choices for a zone filter. */
export function zoneChoices(zones: ({ id: string; name: string } | null | undefined)[]): { id: string; name: string }[] {
  const byId = new Map<string, string>();
  for (const z of zones) if (z && !byId.has(z.id)) byId.set(z.id, z.name || z.id);
  return [...byId].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

export type HiddenAction = 'open_to_meet' | 'bubble' | 'retry' | null;
export type HiddenInfo = { title: string; body: string; action: HiddenAction };

/**
 * Why a section is empty or partial, in words, and what fixes it. `crew_names_unavailable` still
 * lists crews (by id); every other reason means the list was left empty on purpose.
 */
export function hiddenInfo(reason: DiscoverHiddenReason | 'not_in_bubble' | string | null | undefined): HiddenInfo | null {
  switch (reason) {
    case null:
    case undefined:
    case '':
      return null;
    case 'open_to_meet_off':
      return { title: 'Turn on Open to Meet', body: 'People near you are only shown while you’re visible too. Only a rough area is ever shared — never your exact location.', action: 'open_to_meet' };
    case 'location_unknown':
      return { title: 'Campus doesn’t know where you are', body: 'Join your bubble (or open the map) so campus knows your rough area. Nobody sees your exact location.', action: 'bubble' };
    case 'not_in_bubble':
      return { title: 'You’re not in your bubble', body: 'Join to see who’s around you right now. You leave automatically after 15 minutes.', action: 'bubble' };
    case 'blocks_unreachable':
      return { title: 'Can’t show people right now', body: 'Your block list couldn’t be checked, so nobody is shown until it can be.', action: 'retry' };
    case 'crew_names_unavailable':
      return { title: 'Crew names didn’t load', body: 'Crews are listed without their names for now.', action: 'retry' };
    case 'unavailable':
      return { title: 'This section didn’t load', body: 'Something went wrong on our side. Try again in a moment.', action: 'retry' };
    default:
      return { title: 'Nothing to show right now', body: 'This list is hidden for now. Try again in a moment.', action: 'retry' };
  }
}

export const RELATION_WORDS: Record<string, string> = { yours: 'You challenged', incoming: 'Challenged you', crew: 'Your crew' };
/** Discover lists pending, accepted and active battles only. */
export const BATTLE_STATUS_WORDS: Record<string, string> = { pending: 'Waiting for an answer', accepted: 'Accepted', active: 'On now' };

const POPULARITY_WORDS: Record<NonNullable<DiscoverZone['popularity']>, string> = { high: 'Busy this week', medium: 'Popular this week', low: 'A few visitors this week' };
const STATUS_WORDS: Record<string, string> = { unclaimed: 'Unclaimed', claimed: 'Held', contested: 'Contested' };
const OWNER_WORDS: Record<string, string> = { user: 'by a Squirrel', crew: 'by a crew' };

/** "Held by a crew · Busy this week · Battle on". No owner identity or exact counts (the server sends none). */
export function zoneLine(z: DiscoverZone): string {
  const status = STATUS_WORDS[z.territory.status] ?? z.territory.status;
  const owner = z.territory.status === 'claimed' && z.territory.owner_type ? OWNER_WORDS[z.territory.owner_type] : undefined;
  const parts = [owner ? `${status} ${owner}` : status];
  if (z.popularity) parts.push(POPULARITY_WORDS[z.popularity]);
  if (z.contested && z.territory.status !== 'contested') parts.push('Battle on');
  return parts.join(' · ');
}
