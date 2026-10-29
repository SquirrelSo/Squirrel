/**
 * The campus contract (api/campus/types.ts) served by the backends that exist today, so the
 * campus screens run live without a dedicated campus backend:
 *
 *   Social service (EXPO_PUBLIC_SOCIAL_API_URL)   profile, membership + founding badge, hostels,
 *       crews, events + RSVP + planning one, people search / suggestions, head-to-head challenges
 *       (as challenge invites), XP and hostel boards, notifications, Squirrel Dates (suggestion
 *       only) and blocking
 *   Run Module + Exercise backend                 the "moving right now" counter (/v1/live, /api/live)
 *   This device                                   connection mode and "onboarding done" (no backend
 *       field yet; kept per account in SecureStore / localStorage)
 *
 * Everything else — named zones and territory (claim / steal / defend), the map's players and
 * presence, pokes and friends, Open to Meet, Active-now people, Date Mode, meetups — has no backend
 * yet and rejects with the "not live" error, so those screens show their Not-live-yet state
 * instead of invented data. The base map is the hand-drawn, approximate IISER layer (api/campus/campusBaseMap.ts), not
 * the campus.
 */
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { ApiError, getApiToken, hasApiToken } from '@/api/client';
import { blocksApi, challengesApi, communityApi, crewsApi, datesApi, eventsApi, liveCounts, notificationsApi, type Challenge, type CrewDetail as SocialCrewDetail, type CrewOut, type EventOut, type Interest, type Membership, type UserSummary } from '@/api/community';
import { profileApi, type Follower, type PublicProfile } from '@/api/social';
import { jwtSubject } from '@/auth/jwt';
import { appRoute } from '@/notifications/routes';
import { kindRoute } from '@/logic/notificationPrefs';
import { CAMPUS_CENTER } from '@/api/campus/campusBaseMap';
import type * as T from '@/api/campus/types';

const NOT_LIVE = 'not_live';

/** The launch campus. Sign-up takes any .ac.in address (the Exercise backend decides). */
const CAMPUS: T.Campus = { id: 'iiser-kolkata', name: 'IISER Kolkata', short_name: 'IISER K', email_domains: ['ac.in'], center: CAMPUS_CENTER, launched_at: null };
const notLive = (what: string) => () => Promise.reject(new ApiError(0, `${what} isn’t live yet`, { code: NOT_LIVE, detail: `${what} isn’t live yet` }));

// ---------------------------------------------------------------------------
// Per-account settings the Social service has no field for yet
// ---------------------------------------------------------------------------

type LocalMe = { connection_mode?: T.ConnectionMode; onboarding_completed?: boolean };
const localKey = () => `squirrel.campus.me.${jwtSubject(getApiToken() ?? '') ?? 'anon'}`;
const local = {
  async get(): Promise<LocalMe> {
    try {
      const raw = Platform.OS === 'web' ? globalThis.localStorage?.getItem(localKey()) : await SecureStore.getItemAsync(localKey());
      return raw ? (JSON.parse(raw) as LocalMe) : {};
    } catch {
      return {};
    }
  },
  async merge(patch: LocalMe) {
    const next = JSON.stringify({ ...(await local.get()), ...patch });
    try {
      if (Platform.OS === 'web') globalThis.localStorage?.setItem(localKey(), next);
      else await SecureStore.setItemAsync(localKey(), next);
    } catch {
      // storage unavailable: the setting lasts this session only
    }
  },
};

// ---------------------------------------------------------------------------
// Shape mapping (Social → campus contract)
// ---------------------------------------------------------------------------

const person = (u: UserSummary & { hostel?: string | null }): T.PersonLite => ({ user_id: u.id, display_name: u.display_name, avatar_url: u.avatar_url, hostel: u.hostel ?? null });

const km = (m: number | null | undefined) => (m == null ? null : Math.round(m * 1000));
const domainOf = (email: string | null) => (email?.includes('@') ? email.split('@')[1] : null);

const INTEREST_ICON: Record<string, string> = { running: 'run', walking: 'walk', cycling: 'bike', yoga: 'yoga', hiit: 'lightning-bolt', climbing: 'image-filter-hdr', nutrition: 'food-apple', other: 'account-group' };

function crew(c: CrewOut): T.Crew {
  return {
    id: c.id,
    name: c.name,
    color: null,
    icon: INTEREST_ICON[c.interest] ?? null,
    role: c.my_role ?? undefined,
    description: c.tagline || null,
    members_count: c.members_count,
    territories_count: 0,
    meets: c.meets || null,
    tags: [c.interest, c.scope === 'online' ? 'online' : c.hostel].filter((t): t is string => !!t),
    my_membership: c.my_role,
    joinable: !c.is_member,
  };
}

const EVENT_TYPE: Record<string, T.EventType> = { running: 'run', walking: 'walk' };
const EVENT_KIND: Record<T.EventCreate['type'], Interest> = { run: 'running', walk: 'walking', social: 'other' };

function eventSummary(e: EventOut): T.EventSummary {
  return {
    id: e.id,
    title: e.title,
    type: EVENT_TYPE[e.kind] ?? 'social',
    starts_at: e.starts_at,
    ends_at: e.ends_at,
    location: { name: e.online ? 'Online' : e.venue || 'On campus', zone_id: null },
    host: e.crew ? { type: 'crew', id: e.crew.id, name: e.crew.name } : { type: 'user', id: e.host.id, name: e.host.display_name },
    participants_count: e.going_count,
    capacity: e.capacity,
    my_rsvp: e.my_rsvp === 'going' ? 'going' : null,
    territory_challenge: null,
  };
}

function eventDetail(e: EventOut): T.EventDetail {
  const full = e.capacity != null && e.going_count >= e.capacity && e.my_rsvp !== 'going';
  return {
    ...eventSummary(e),
    description: e.description || null,
    participants: e.attendees.map((a) => person(a)),
    rsvp_open: !e.cancelled && !full && new Date(e.ends_at ?? e.starts_at).getTime() > Date.now(),
    meetup_id: null,
  };
}

function crewDetail(c: SocialCrewDetail): T.CrewDetail {
  return { ...crew(c), members: c.members.map((m) => person(m.user)), territories: [], upcoming_events: c.upcoming_events.map(eventSummary) };
}

function profile(p: PublicProfile, membership: Membership | null, email: string | null): T.Profile {
  const u = p.user;
  const monthM = km(p.stats.month_km) ?? 0;
  return {
    user_id: u.id,
    display_name: u.display_name,
    avatar_url: u.avatar_url,
    hostel: u.hostel,
    bio: u.bio,
    connection_mode: null,
    open_to_meet: false,
    verification: {
      email_verified: membership?.email_verified ?? u.verified,
      email_domain: domainOf(email),
      student_verified: membership?.email_verified ?? u.verified,
      phone_verified: false,
      selfie_verified: false,
    },
    stats: {
      total_distance_m: null,
      month_distance_m: monthM,
      zones_claimed: null,
      territories_defended: null,
      territories_stolen: null,
      crew_memberships: p.crews.length,
      events_attended: null,
      streak_days: p.stats.streak_days,
    },
    territories: [],
    crews: p.crews.map((c) => ({ id: c.id, name: c.name, color: null, icon: INTEREST_ICON[c.interest] ?? null, role: c.role })),
    badges: p.badges.map(badge),
    recent_activities: p.recent_activities
      .filter((a) => a.type === 'run')
      .map((a) => ({ id: a.id, type: 'run' as const, started_at: a.started_at, distance_m: km(a.distance_km) ?? 0, duration_s: Math.round((a.duration_minutes ?? 0) * 60), zones_count: 0, status: a.verified ? ('verified' as const) : ('processing' as const) })),
    joined_at: u.created_at,
    founding_member: !!membership?.founding || p.badges.some((b) => b.kind === 'founding'),
    restricted: p.restricted === true,
  };
}

const badge = (b: PublicProfile['badges'][number]): T.Badge => ({ id: b.id, name: b.title, description: b.description, unlocked: true, unlocked_at: b.awarded_at, progress: null });

function personCard(f: Follower): T.PersonCard {
  return {
    ...person(f),
    connection_mode: null,
    bio: null,
    activity: { top_activity: null, runs_30d: 0, distance_30d_m: 0, usual_time: null },
    shared: { shared_zones: [], shared_crews: [], shared_events: [], icebreakers: [] },
    match_reason: f.area ? `Also in ${f.area}` : null,
  };
}

const personSummary = (f: Follower): T.PersonSummary => ({ ...person(f), level: f.level, xp: 0, proximity: null, relationship: 'none' });

// Head-to-head challenges (Social) as challenge invites.
const CHALLENGE_TYPES: T.ChallengeTypeInfo[] = [
  { id: 'km_duel', label: 'Distance duel', description: 'Most verified km in 7 days wins.', requires_zone: false, targets: ['user'] },
  { id: 'workout_duel', label: 'Workout duel', description: 'Most coached workouts in 7 days wins.', requires_zone: false, targets: ['user'] },
];
const INVITE_STATUS: Record<Challenge['status'], T.InviteStatus> = { pending: 'pending', accepted: 'active', declined: 'declined', finished: 'completed', cancelled: 'cancelled' };

function invite(c: Challenge): T.ChallengeInvite {
  const me = person(c.me.user);
  const them = person(c.opponent.user);
  const type = c.metric === 'km' ? CHALLENGE_TYPES[0] : CHALLENGE_TYPES[1];
  const unit = c.metric === 'km' ? 'km' : 'workouts';
  const winner = c.winner_id == null ? null : c.winner_id === me.user_id ? me : them;
  return {
    id: c.id,
    type: type.id,
    type_label: `${type.label} · ${c.days} days`,
    from: c.i_challenged ? me : them,
    target: { type: 'user', person: c.i_challenged ? them : me },
    zone: null,
    starts_at: c.starts_at ?? c.created_at,
    message: null,
    status: INVITE_STATUS[c.status],
    direction: c.i_challenged ? 'outgoing' : 'incoming',
    created_at: c.created_at,
    result:
      c.status === 'finished' || c.status === 'accepted'
        ? { winner, summary: `You ${+c.me.score.toFixed(1)} ${unit} · ${them.display_name} ${+c.opponent.score.toFixed(1)} ${unit}` }
        : null,
  };
}

const NOTIFICATION_DATA_KEYS = ['user_id', 'event_id', 'zone_id', 'meetup_id'] as const;

function notification(n: Awaited<ReturnType<typeof notificationsApi.list>>['items'][number]): T.AppNotification {
  const data: NonNullable<T.AppNotification['data']> = {};
  for (const k of NOTIFICATION_DATA_KEYS) if (typeof n.data[k] === 'string') data[k] = n.data[k] as string;
  if (typeof n.data.challenge_id === 'string') data.invite_id = n.data.challenge_id;
  // The kinds this build adds open fixed screens (logic/notificationPrefs.ts); the rest follow Social's route.
  const fixed = kindRoute(n.kind, n.data);
  const route = fixed === undefined ? appRoute(n.data.route) : fixed && appRoute(fixed);
  if (route) data.route = route;
  const kind = n.kind.startsWith('challenge') ? 'invite' : n.kind.startsWith('event') ? 'event' : n.kind.startsWith('steal') || n.kind.startsWith('territory') ? 'territory' : n.kind;
  return { id: n.id, type: kind, actor: n.actor ? person(n.actor) : null, text: n.body ? `${n.title} · ${n.body}` : n.title, created_at: n.created_at, read: n.read, data };
}

const boardWindow = (period: T.LeaderboardPeriod) => {
  if (period === 'alltime') throw new ApiError(0, 'All-time boards aren’t live yet', { code: NOT_LIVE, detail: 'All-time boards aren’t live yet' });
  return period;
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

async function me(): Promise<T.Me> {
  const [p, membership, saved] = await Promise.all([profileApi.me(), communityApi.membership().catch(() => null), local.get()]);
  const email = signedInEmail;
  const base = profile(p, membership, email);
  return {
    ...base,
    connection_mode: saved.connection_mode ?? null,
    email,
    profile_details: null,
    hostel_zone_id: p.user.hostel,
    date_mode_enabled: false,
    // An account that already picked a hostel or confirmed a username has been through setup.
    onboarding_completed: !!saved.onboarding_completed || !!p.user.hostel || p.username_confirmed,
    safety_contact_configured: false,
  };
}

/** The email the account signed in with (not in the token); AuthProvider keeps it current. */
let signedInEmail: string | null = null;
export const setCampusEmail = (email: string | null) => {
  signedInEmail = email;
};

export const socialCampusApi: T.CampusApi = {
  config: async () => {
    const cfg = hasApiToken() ? await communityApi.config().catch(() => null) : null;
    return {
      campus: { ...CAMPUS, hostels: cfg?.hostels ?? [] },
      features: {
        create_crew: true,
        create_event: true,
        defend: false,
        open_to_meet: false,
        date_mode: { available: false, reason: 'Date Mode opens once its safety features are live.', requirements: [] },
        meetup_safety_notifications: false,
      },
      realtime_url: null,
    };
  },
  stats: async () => {
    const live = await liveCounts();
    const moving = (live.running ?? 0) + (live.workingOut ?? 0);
    const members = hasApiToken() ? await communityApi.membership().then((m) => m.members_total, () => null) : null;
    return { users_total: members ?? 0, users_active_now: moving, zones_total: 0, zones_claimed: 0, crews_total: 0, founding_spots_left: null, updated_at: new Date().toISOString() };
  },

  me,
  updateMe: async (patch) => {
    const { connection_mode, onboarding_completed, display_name, bio, hostel_zone_id } = patch;
    if (connection_mode !== undefined || onboarding_completed !== undefined) await local.merge({ connection_mode, onboarding_completed });
    const body = { ...(display_name !== undefined ? { display_name } : {}), ...(bio !== undefined ? { bio } : {}), ...(hostel_zone_id !== undefined ? { hostel: hostel_zone_id } : {}) };
    if (Object.keys(body).length) await profileApi.update(body);
    return me();
  },
  setOpenToMeet: notLive('Open to Meet'),
  profile: async (userId) => profile(await profileApi.get(userId), null, null),
  sharedContext: notLive('Shared context'),
  badges: async () => (await profileApi.me()).badges.map(badge),

  zones: notLive('Campus zones'),
  territories: notLive('Territory'),
  zone: notLive('Campus zones'),
  territoryAction: notLive('Territory'),

  submitActivity: notLive('Activity upload'),
  activityZones: notLive('Zone interactions'),

  crews: async ({ q, scope }) => {
    const page = await crewsApi.list({ mine: scope === 'mine', q });
    return { items: page.items.map(crew), next_cursor: page.next_cursor };
  },
  crew: async (crewId) => crewDetail(await crewsApi.get(crewId)),
  joinCrew: async (crewId) => crew(await crewsApi.join(crewId)),
  leaveCrew: async (crewId) => {
    await crewsApi.leave(crewId);
    return crew(await crewsApi.get(crewId));
  },
  createCrew: async (input) => crew(await crewsApi.create({ name: input.name, interest: 'other', tagline: input.description })),

  events: async ({ scope }) => {
    const page = await eventsApi.list(scope ?? 'upcoming');
    return { items: page.items.map(eventSummary), next_cursor: page.next_cursor };
  },
  event: async (eventId) => eventDetail(await eventsApi.get(eventId)),
  rsvp: async (eventId, going) => eventDetail(await (going ? eventsApi.rsvp(eventId) : eventsApi.unrsvp(eventId))),
  createEvent: async (input) =>
    eventDetail(await eventsApi.create({
      title: input.title,
      kind: EVENT_KIND[input.type],
      starts_at: input.starts_at,
      ends_at: input.ends_at ?? null,
      venue: input.venue,
      capacity: input.capacity ?? null,
      description: input.description ?? '',
    })),

  suggestedPeople: async (mode) => {
    if (mode === 'date') return notLive('Date Mode')();
    return (await profileApi.suggestions(20)).items.map(personCard);
  },
  activeNow: async () => {
    const live = await liveCounts();
    return { active_now: (live.running ?? 0) + (live.workingOut ?? 0), active: [], nearby: [], as_of: new Date().toISOString() };
  },

  challengeTypes: async () => CHALLENGE_TYPES,
  invites: async (box) => {
    const all = (await challengesApi.list()).items.map(invite);
    return box === 'all' ? all : all.filter((i) => i.direction === box);
  },
  createInvite: async (input) => {
    if (input.target.type !== 'user') return notLive('Crew challenges')();
    return invite(await challengesApi.create(input.target.id, input.type === 'workout_duel' ? 'workouts' : 'km', 7));
  },
  respondInvite: async (inviteId, action) => invite(await challengesApi[action](inviteId)),

  squirrelBoard: async (period, limit = 10) => {
    const b = await communityApi.xpBoard(boardWindow(period));
    // The Run Module is down, not missing: an outage code, so screens say "couldn't load · try again",
    // never "not live yet" (a 503 code ending in `unavailable` means not deployed; featureUnavailable).
    if (!b.available) throw new ApiError(503, 'The XP board couldn’t load right now', { code: 'leaderboard_unreachable' });
    const row = (e: (typeof b.entries)[number]): T.SquirrelRow => ({ ...person({ ...e.user, hostel: e.hostel }), rank: e.rank, xp: e.xp, zones_claimed: 0, distance_m: null });
    return { period, entries: b.entries.slice(0, limit).map(row), me: b.me ? row(b.me) : null, updated_at: new Date().toISOString() };
  },
  hostelBoard: async (period) => {
    const b = await communityApi.hostelBoard(boardWindow(period));
    if (!b.enabled) return notLive('Hostel vs Hostel')();
    // Run Module unreachable: Social still lists every hostel, at 0 XP. Never show that as standings.
    if (!b.available) throw new ApiError(503, 'Hostel standings couldn’t load right now', { code: 'leaderboard_unreachable' });
    return {
      period,
      entries: b.entries.map((e) => ({ rank: e.rank, hostel_id: e.hostel, name: e.hostel, score: e.xp, territories: 0, active_members: e.active, distance_m: null })),
      my_hostel_id: b.entries.find((e) => e.is_mine)?.hostel ?? null,
      updated_at: new Date().toISOString(),
    };
  },

  mapFeatures: notLive('The campus map'),
  nearbyPlayers: notLive('Squirrels on the map'),
  zonePlayers: notLive('Squirrels on the map'),
  updatePresence: notLive('Map presence'),
  searchPeople: async (q) => (await profileApi.search(q)).items.map(personSummary),

  pokeStatus: notLive('Pokes'),
  sendPoke: notLive('Pokes'),
  pokeBack: notLive('Pokes'),
  incomingPokes: notLive('Pokes'),
  friendshipStatus: notLive('Friends'),

  notifications: async (cursor) => {
    const page = await notificationsApi.list(cursor);
    return { items: page.items.map(notification), unread: page.unread, next_cursor: page.next_cursor ?? null };
  },
  // The contract's "empty = all": Social marks all only when `ids` is left out (an empty list marks none).
  markNotificationsRead: (ids) => notificationsApi.markRead(ids.length ? ids : undefined),

  sharedZones: notLive('Shared zones'),
  heatmap: notLive('The activity heatmap'),
  // Squirrel Dates: suggestion only. A suggestion's id is the suggested person's id.
  dateSuggestions: async (forUserId) => {
    const r = await datesApi.suggestions(forUserId);
    return {
      available: r.available,
      enabled: r.enabled,
      reason: r.reason,
      suggestions: r.suggestions.map((d) => ({ id: d.id, person: { ...person(d.user), level: d.user.level }, reason: d.reason, zone: d.zone, suggested_time: d.suggested_time })),
    };
  },
  dismissDateSuggestion: async (suggestionId) => {
    await datesApi.dismiss(suggestionId);
    return { dismissed: true };
  },
  dateSettings: () => datesApi.settings(),
  setDateSettings: (enabled) => datesApi.setEnabled(enabled),
  blockStatus: (userId) => blocksApi.status(userId),
  setBlocked: (userId, blocked) => (blocked ? blocksApi.block(userId) : blocksApi.unblock(userId)),
  meetupRating: notLive('Meetup ratings'),
  rateMeetup: notLive('Meetup ratings'),
  ambassador: () => communityApi.ambassador(),
  applyAmbassador: (answers, key) => communityApi.applyAmbassador(answers, key),

  meetups: notLive('Meetups'),
  createMeetup: notLive('Meetups'),
  respondMeetup: notLive('Meetups'),
  meetup: notLive('Meetups'),
  checkIn: notLive('Meetups'),
};
