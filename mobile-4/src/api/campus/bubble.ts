/**
 * Your bubble — campus-service's ephemeral "who's around me right now" (ADR-032). Never Social.
 *
 *   POST /v1/bubble/join   { lat, lng, accuracy_m?, activity_type? }   6/min; 409 open_to_meet_required;
 *                                                                  off campus → 200 { accepted: false, reason: 'off_campus' }
 *   POST /v1/bubble/leave                                            204
 *   GET  /v1/bubble                                                  your own state only
 *   GET  /v1/bubble/nearby?state=&limit=&cursor=                     members in your 3×3 cell neighbourhood
 *   WS   bubble.user_joined | user_left | activity_started | activity_ended (topic `bubble`, after auth)
 * Your position is reduced to a ~250 m cell and a zone on join, then discarded by the server. No
 * response or event carries anyone's coordinates or distance.
 *
 * Gated by the 'bubble' capability (api/availability.ts) and a configured campus-service, as Discover.
 */
import { EndpointUnavailableError, isEndpointAvailable } from '@/api/availability';
import { CAMPUS_API_URL, CAMPUS_SERVICE_URL, DEDICATED_CAMPUS_API } from '@/api/config';
import { qs, restClient } from '@/api/campus/http';
import type { BubbleJoin, BubbleJoinResult, BubbleNearbyPage, BubbleState, PersonState } from '@/api/featureContracts';

const BASE = CAMPUS_SERVICE_URL || (DEDICATED_CAMPUS_API ? CAMPUS_API_URL : '');
export const bubbleLive = () => isEndpointAvailable('bubble') && BASE.length > 0;

const { get, send } = restClient(BASE);
const live = <R,>(fn: () => Promise<R>): Promise<R> => (bubbleLive() ? fn() : Promise.reject(new EndpointUnavailableError('bubble')));

export const bubbleApi = {
  state: () => live(() => get<BubbleState>('/v1/bubble')),
  nearby: (state: PersonState | null, cursor?: string | null) => live(() => get<BubbleNearbyPage>(`/v1/bubble/nearby${qs({ state: state ?? undefined, cursor: cursor ?? undefined })}`)),
  // Not retried (6/min): the screen handles 429 and re-joins on its own schedule.
  join: (body: BubbleJoin) => live(() => send<BubbleJoinResult>('/v1/bubble/join', 'POST', body)),
  leave: () => live(() => send<void>('/v1/bubble/leave', 'POST', {})),
};
