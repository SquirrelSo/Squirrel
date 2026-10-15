/**
 * Discover — campus-service's read-only overview of who and what is around (ADR-032). Never Social.
 *
 *   GET /v1/discover                                five of each section; `reasons[section]` when one is held back
 *   GET /v1/discover/nearby?activity_type=&zone_id=&sort=proximity|recent
 *   GET /v1/discover/active?activity_type=&sort=recent|level
 *   GET /v1/discover/challenges?type=&zone_id=    territory battles you're part of (never others' invites)
 *   GET /v1/discover/crews                          ranked by zones held
 *   GET /v1/discover/zones?sort=popular|contested|unclaimed
 * Lists are `{ items, next_cursor, hidden_reason, as_of }` (limit ≤ 50, opaque cursor). No response
 * carries coordinates, distances or exact counts.
 *
 * Gated by the 'discover' capability (api/availability.ts) and a configured campus-service: until
 * both, every call rejects with EndpointUnavailableError and the screen says "not live yet".
 */
import { EndpointUnavailableError, isEndpointAvailable } from '@/api/availability';
import { CAMPUS_API_URL, CAMPUS_SERVICE_URL, DEDICATED_CAMPUS_API } from '@/api/config';
import { qs, restClient } from '@/api/campus/http';
import type { ChallengeInvite } from '@/api/campus/types';
import type { DiscoverCrew, DiscoverOverview, DiscoverPage, DiscoverZone, PersonCard } from '@/api/featureContracts';
import { sectionQuery, type DiscoverFilters, type DiscoverSection } from '@/logic/discover';

/** campus-service, or a dedicated campus backend with the same contract (as api/campus/battles.ts). */
const BASE = CAMPUS_SERVICE_URL || (DEDICATED_CAMPUS_API ? CAMPUS_API_URL : '');
export const discoverLive = () => isEndpointAvailable('discover') && BASE.length > 0;

/** A territory battle as Discover lists it: the battle plus how it concerns you. */
export type DiscoverBattle = ChallengeInvite & { relation: 'yours' | 'incoming' | 'crew'; zone_qualified: boolean; near_you: boolean };
export type DiscoverItem = { nearby: PersonCard; active: PersonCard; challenges: DiscoverBattle; zones: DiscoverZone; crews: DiscoverCrew };

const { get } = restClient(BASE);
const call = <R,>(path: string): Promise<R> => (discoverLive() ? get<R>(path) : Promise.reject(new EndpointUnavailableError('discover')));

export const discoverApi = {
  overview: () => call<DiscoverOverview<DiscoverBattle>>('/v1/discover'),
  section: <S extends DiscoverSection>(section: S, filters: DiscoverFilters = {}, cursor?: string | null) =>
    call<DiscoverPage<DiscoverItem[S]> & { crew_battles_unavailable?: boolean }>(`/v1/discover/${section}${qs(sectionQuery(section, filters, cursor))}`),
};
