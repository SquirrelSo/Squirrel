/**
 * Campus social backend — typed contract (users, zones, territories, activity → zone
 * interactions, crews, events, discovery, challenge invites, leaderboards, meetups, badges).
 *
 * Wire format follows the Run Module's conventions: routes under /v1, snake_case fields,
 * ISO-8601 timestamps, `next_cursor` pagination, errors as `{ code?, detail | message }`.
 * These types ARE the contract the screens consume; if the backend ships a different shape,
 * adapt it in api/campus/http.ts rather than in components.
 *
 * Territory model (never conflate these):
 *   RUN        a GPS route (Run Module owns it)
 *   ZONE       a fixed, named area of campus (Narmada Hostel, CC1, Library…)
 *   TERRITORY  the ownership state of one zone
 * A run *interacts* with zones; the backend decides eligibility; the user claims/steals/defends.
 * Crossing a zone never changes ownership by itself.
 */

import type { BubbleEventName, PersonCard as FeaturePersonCard } from '@/api/featureContracts';

/** [lat, lng] in WGS84. */
export type LatLng = [number, number];

// ---------------------------------------------------------------------------
// Campus, config, stats
// ---------------------------------------------------------------------------

export type Campus = {
  id: string;
  name: string; // "IISER Kolkata"
  short_name: string; // "IISER K"
  /** Sign-up is limited to these institutional domains, e.g. ["iiserkol.ac.in"]. */
  email_domains: string[];
  /** Optional course list for profile building; the app falls back to common programmes. */
  courses?: string[];
  /** Hostels for Hostel vs Hostel, when the backend has no hostel zones (the Social service's list). */
  hostels?: string[];
  center: LatLng;
  launched_at: string | null;
};

export type LaunchStats = {
  users_total: number;
  users_active_now: number;
  zones_total: number;
  zones_claimed: number;
  crews_total: number;
  /** Founding Squirrel spots left, when the backend runs that programme; null otherwise. */
  founding_spots_left: number | null;
  updated_at: string;
};

export type SafetyRequirement = { id: string; label: string; description?: string };

export type AppConfig = {
  campus: Campus;
  features: {
    create_crew: boolean;
    create_event: boolean;
    defend: boolean;
    open_to_meet: boolean;
    /**
     * Date Mode is enabled only when the backend says its safety stack is live
     * (reporting, blocking, verification…). The screen existing is NOT enough.
     */
    date_mode: { available: boolean; reason: string | null; requirements: SafetyRequirement[] };
    meetup_safety_notifications: boolean;
  };
  /** WebSocket endpoint for live updates; null → the app refreshes on focus. */
  realtime_url: string | null;
};

// ---------------------------------------------------------------------------
// People & profiles
// ---------------------------------------------------------------------------

export type ConnectionMode = 'date' | 'friends' | 'crew';

export type PersonLite = {
  user_id: string;
  display_name: string;
  avatar_url: string | null;
  hostel: string | null;
};

export type Verification = {
  email_verified: boolean;
  email_domain: string | null;
  student_verified: boolean;
  phone_verified: boolean;
  selfie_verified: boolean;
};

/** null: the backend doesn't track it yet (the tile is hidden, never shown as 0). */
export type ProfileStats = {
  total_distance_m: number | null;
  month_distance_m: number;
  zones_claimed: number | null;
  territories_defended: number | null;
  territories_stolen: number | null;
  crew_memberships: number;
  events_attended: number | null;
  /** null when the backend doesn't compute streaks. */
  streak_days: number | null;
};

export type ActivityType = 'run' | 'walk';

export type ActivityHistoryItem = {
  id: string;
  type: ActivityType;
  started_at: string;
  distance_m: number;
  duration_s: number;
  zones_count: number;
  status: 'verified' | 'flagged' | 'rejected' | 'processing';
};

export type OwnedTerritory = { zone_id: string; zone_name: string; claimed_at: string; defended_count: number };

export type CrewLite = { id: string; name: string; color: string | null; icon: string | null; role?: 'owner' | 'admin' | 'member' };

export type Profile = PersonLite & {
  bio: string | null;
  connection_mode: ConnectionMode | null;
  open_to_meet: boolean;
  verification: Verification;
  stats: ProfileStats;
  territories: OwnedTerritory[];
  crews: CrewLite[];
  badges: Badge[];
  recent_activities: ActivityHistoryItem[];
  joined_at: string;
  founding_member: boolean;
  /**
   * A private account you don't follow: only the name and avatar are real. Everything else is
   * withheld by the server (blank or zero), so screens show "private", never those values.
   */
  restricted?: boolean;
};

/** The signed-in user: the public profile plus private settings. */
/** Profile-building details (onboarding "About you"). Private to you — never on your public profile. */
export type Gender = 'female' | 'male' | 'non_binary' | 'undisclosed' | (string & {});
export type ProfileDetails = {
  full_name: string;
  personal_email: string;
  college_email: string;
  /** E.164, e.g. +919876543210. */
  phone: string;
  gender: Gender;
  age: number;
  course: string;
  /** Optional; 0–10 scale. */
  cgpa: number | null;
};

export type Me = Profile & {
  email: string | null;
  /** Absent until the profile-building step has been saved. */
  profile_details?: ProfileDetails | null;
  hostel_zone_id: string | null;
  date_mode_enabled: boolean;
  onboarding_completed: boolean;
  safety_contact_configured: boolean;
};

export type MePatch = Partial<{
  display_name: string;
  bio: string;
  connection_mode: ConnectionMode;
  hostel_zone_id: string;
  onboarding_completed: boolean;
  date_mode_enabled: boolean;
  /** Expected on PATCH /v1/me (frontend contract; the backend validates again). */
  profile_details: ProfileDetails;
}>;

export type OpenToMeet = { enabled: boolean; updated_at: string; visible_until: string | null };

export type Icebreaker = {
  id: string;
  text: string; // rendered verbatim — the backend writes it from real shared data
  kind: 'shared_zone' | 'shared_route' | 'shared_crew' | 'shared_event' | 'challenge' | (string & {});
  zone_id?: string | null;
  crew_id?: string | null;
  /** When present, the chip offers this action (e.g. open a challenge for zone X). */
  action?: { type: 'challenge'; zone_id: string | null } | null;
};

export type SharedContext = {
  /** `activity_count` (optional): how many of your activities crossed the zone — never when, never the route. */
  shared_zones: { zone_id: string; zone_name: string; relation: 'both_claim' | 'both_ran' | 'you_own_they_ran' | 'they_own_you_ran' | (string & {}); activity_count?: number | null }[];
  shared_crews: CrewLite[];
  shared_events: { event_id: string; title: string }[];
  icebreakers: Icebreaker[];
  /**
   * Set when the backend left the context empty on purpose and the screen should say so (e.g.
   * `blocks_unreachable`: it couldn't check blocks). Never set for a block itself: that reads as nothing shared.
   */
  hidden_reason?: string | null;
  hidden_code?: HiddenCode | null;
};

/** A discovery card (Friend Mode, Date Mode, Active Now). Activity-first — never photo-first. */
export type PersonCard = PersonLite & {
  connection_mode: ConnectionMode | null;
  bio: string | null;
  activity: { top_activity: ActivityType | null; runs_30d: number; distance_30d_m: number; usual_time: 'morning' | 'evening' | 'night' | null };
  shared: SharedContext;
  /** One-line reason from the backend ("You both run the Sports Ground Loop"). */
  match_reason: string | null;
  /** Date Mode only: backend-suggested low-pressure activities. */
  suggested_activities?: string[];
};

/** Coarse proximity only — never coordinates, never another person's zone. */
export type Proximity = 'very_close' | 'nearby' | 'on_campus';

export type ActivePerson = {
  person: PersonCard;
  activity: { type: ActivityType | 'workout' | 'event'; started_at: string } | null;
  proximity: Proximity | null;
};

/**
 * Why a people list is hidden or empty, as a code a screen can act on (campus-service's `hidden_reason`):
 * `open_to_meet_off` → Settings (turn Open to Meet on); `blocks_unreachable` → Retry (the block list
 * couldn't be checked, so the list came back empty — fail-closed); `blocked` is never shown. Unknown
 * codes may arrive from a newer server.
 */
export type HiddenCode = 'open_to_meet_off' | 'blocks_unreachable' | 'blocked' | (string & {});

/** `hidden_reason` / `hidden_code` (optional): set when the backend hid or emptied the lists — an empty list then says why. */
export type ActiveNow = { active_now: number; active: ActivePerson[]; nearby: ActivePerson[]; as_of: string; hidden_reason?: string | null; hidden_code?: HiddenCode | null };

// ---------------------------------------------------------------------------
// Zones & territory
// ---------------------------------------------------------------------------

export type ZoneKind = 'hostel' | 'academic' | 'sports' | 'food' | 'library' | 'landmark';

export type Zone = {
  id: string;
  name: string;
  short_name: string | null;
  kind: ZoneKind;
  /** Closed ring, [lat, lng]. */
  polygon: LatLng[];
  /** Label anchor. */
  centroid: LatLng;
  /** For hostel zones: the hostel team it belongs to (Hostel vs Hostel). */
  hostel: string | null;
  /**
   * Where the outline comes from (campus-service): 'survey' | 'osm' | 'dev_placeholder'. A
   * 'dev_placeholder' shape is a rough stand-in nobody has surveyed yet — drawn as approximate,
   * still claimable. Absent on backends that don't say.
   */
  geometry_source?: string | null;
};

export type Territory = {
  zone_id: string;
  owner: PersonLite | null;
  crew: CrewLite | null;
  claimed_at: string | null;
  defended_count: number;
  last_defended_at: string | null;
  /** Someone is eligible to steal it right now / an attack is open. */
  under_challenge: boolean;
  /** Can't be stolen before this time (fresh claims get a shield). */
  shield_until: string | null;
  /** Monotonic per zone; the client keeps the highest version it has seen. */
  version: number;
  updated_at: string;
  /**
   * The backend's territory state. Optional for older servers; the app then derives a display
   * state from `owner` + `under_challenge` (neutral / controlled / under attack) — never 'contested'.
   */
  status?: TerritoryStatus;
  /** Owner's control of the zone, 0..1 (drives fill strength). */
  control?: number | null;
  /** XP banked in this zone by the owner/team. */
  xp?: number | null;
};

export type TerritoryStatus = 'neutral' | 'controlled' | 'contested' | 'under_attack';

export type ActionAvailability = { allowed: boolean; code: string | null; reason: string | null; expires_at: string | null };
export type ZoneActions = { claim: ActionAvailability; steal: ActionAvailability; defend: ActionAvailability };

export type TerritoryEventType = 'claimed' | 'stolen' | 'defended' | 'released' | 'decayed';
export type TerritoryEvent = { id: string; type: TerritoryEventType; actor: PersonLite | null; previous_owner: PersonLite | null; at: string };

export type ZoneStats = { runs_7d: number; visitors_7d: number; my_visits_7d: number; distance_7d_m: number };

export type ZoneDetail = { zone: Zone; territory: Territory; actions: ZoneActions; stats: ZoneStats; history: TerritoryEvent[] };

export type TerritoryAction = 'claim' | 'steal' | 'defend';
export type TerritoryActionResult = { territory: Territory; actions: ZoneActions; event: TerritoryEvent | null };

// ---------------------------------------------------------------------------
// Activities → zone interactions
// ---------------------------------------------------------------------------

export type ZoneInteraction = {
  zone_id: string;
  zone_name: string;
  interaction: 'passed_through' | 'looped' | 'visited';
  distance_in_zone_m: number;
  time_in_zone_s: number;
  territory: Territory;
  actions: ZoneActions;
};

export type ActivityZones = {
  activity_id: string;
  /** 'processing' → verification not finished; poll again later. */
  status: 'processing' | 'verified' | 'flagged' | 'rejected';
  zones: ZoneInteraction[];
};

export type ActivityPoint = { lat: number; lng: number; recorded_at: string; accuracy_m: number };
export type ActivitySubmit = { type: ActivityType; started_at: string; ended_at: string; points: ActivityPoint[]; idempotency_key?: string };

// ---------------------------------------------------------------------------
// Crews & events
// ---------------------------------------------------------------------------

export type Crew = CrewLite & {
  description: string | null;
  members_count: number;
  territories_count: number;
  meets: string | null;
  tags: string[];
  my_membership: 'owner' | 'admin' | 'member' | null;
  joinable: boolean;
};

export type CrewDetail = Crew & {
  members: PersonLite[];
  territories: OwnedTerritory[];
  upcoming_events: EventSummary[];
};

export type CrewCreate = { name: string; description: string; color?: string; icon?: string };

export type EventType = 'run' | 'walk' | 'territory_battle' | 'weekend_war' | 'social' | 'study_break_walk' | (string & {});

export type EventSummary = {
  id: string;
  title: string;
  type: EventType;
  starts_at: string;
  ends_at: string | null;
  location: { name: string; zone_id: string | null };
  host: { type: 'crew' | 'user' | 'squirrel'; id: string; name: string };
  participants_count: number;
  capacity: number | null;
  my_rsvp: 'going' | null;
  territory_challenge: { zone_ids: string[]; summary: string; reward_xp: number | null } | null;
  /** Dev A: short-duration templates on the Events API (e.g. 'study_break_walk'). Optional; absent on older events. */
  template?: 'study_break_walk' | (string & {}) | null;
  duration_min?: number | null;
  meeting_point?: string | null;
};

/** Planning an event ("Plan a meetup"): a normal event anyone can see and RSVP to. Nobody is invited. */
export type EventCreate = {
  title: string;
  type: 'run' | 'walk' | 'social';
  starts_at: string;
  ends_at?: string | null;
  venue: string;
  capacity?: number | null;
  description?: string;
};

export type EventDetail = EventSummary & {
  description: string | null;
  participants: PersonLite[];
  rsvp_open: boolean;
  meetup_id: string | null;
};

// ---------------------------------------------------------------------------
// Challenge invites
// ---------------------------------------------------------------------------

export type ChallengeTypeInfo = {
  id: 'territory' | 'weekend_war' | 'zone_race' | 'group_activity' | (string & {});
  label: string;
  description: string;
  requires_zone: boolean;
  targets: ('user' | 'crew')[];
};

export type InviteStatus = 'pending' | 'accepted' | 'declined' | 'cancelled' | 'expired' | 'active' | 'completed';

export type ChallengeInvite = {
  id: string;
  type: ChallengeTypeInfo['id'];
  type_label: string;
  from: PersonLite;
  target: { type: 'user'; person: PersonLite } | { type: 'crew'; crew: CrewLite };
  zone: { id: string; name: string } | null;
  starts_at: string;
  message: string | null;
  status: InviteStatus;
  direction: 'incoming' | 'outgoing';
  created_at: string;
  result: { winner: PersonLite | CrewLite | null; summary: string } | null;
  /** campus-service: when the battle ends, if it has a set end. */
  ends_at?: string | null;
  /** campus-service: what the viewer may do now, decided by the server (never inferred here). */
  actions?: ChallengeAction[];
  /** `crew_role_unavailable`: Social couldn't be asked about the viewer's crew role, so `actions`
   *  may be missing some. Offer a retry rather than implying they lack permission. */
  actions_status?: 'ready' | 'crew_role_unavailable';
};

export type ChallengeAction = 'accept' | 'decline' | 'cancel' | 'schedule' | 'start' | 'complete';
/**
 * GET /v1/challenge-invites. `crew_battles_unavailable`: your crews couldn't be checked and nothing
 * was cached, so crew battles were left out rather than shown to everyone.
 */
export type BattleListResponse = { invites: ChallengeInvite[]; crew_battles_unavailable?: boolean };

export type ChallengeInviteCreate = {
  type: ChallengeTypeInfo['id'];
  target: { type: 'user' | 'crew'; id: string };
  zone_id: string | null;
  starts_at: string;
  message?: string;
};

// ---------------------------------------------------------------------------
// Leaderboards
// ---------------------------------------------------------------------------

export type LeaderboardPeriod = 'daily' | 'weekly' | 'alltime';

export type SquirrelRow = PersonLite & { rank: number; xp: number; zones_claimed: number; distance_m: number | null };
export type SquirrelBoard = { period: LeaderboardPeriod; entries: SquirrelRow[]; me: SquirrelRow | null; updated_at: string };

export type HostelRow = { rank: number; hostel_id: string; name: string; score: number; territories: number; active_members: number; distance_m: number | null };
export type HostelBoard = { period: LeaderboardPeriod; entries: HostelRow[]; my_hostel_id: string | null; updated_at: string };

// ---------------------------------------------------------------------------
// Meetups & badges
// ---------------------------------------------------------------------------

export type Meetup = {
  id: string;
  title: string;
  starts_at: string;
  location: { name: string; zone_id: string | null };
  event_id: string | null;
  /** Everyone who hasn't declined; `rsvp` says who's confirmed and who's still only invited. */
  attendees: (PersonLite & { checked_in: boolean; rsvp?: 'invited' | 'accepted'; host?: boolean })[];
  my_check_in_at: string | null;
  check_in_opens_at: string;
  check_in_closes_at: string;
  /** campus-service: the meetup's state, and your part in it (what you may do: accept/decline/leave/cancel). */
  status?: 'proposed' | 'confirmed' | 'cancelled' | 'completed';
  my_role?: 'host' | 'guest' | null;
  my_rsvp?: 'invited' | 'accepted' | 'declined' | null;
};
/** POST /v1/meetups: a zone and/or a place, a time in the future, 1–50 people (Social profile ids). */
export type MeetupCreate = { zone_id?: string | null; place_text?: string | null; starts_at: string; invitee_ids: string[] };
/** POST /v1/meetups/{id}/{action}: guests accept / decline / leave; the host cancels. */
export type MeetupAction = 'accept' | 'decline' | 'leave' | 'cancel';

export type SafetyNotification = {
  requested: boolean;
  /** Only 'sent' means the backend confirmed delivery to the safety contact. */
  status: 'sent' | 'failed' | 'not_configured' | 'skipped';
  contact_label: string | null;
};

export type CheckInResult = { meetup_id: string; checked_in_at: string; safety_notification: SafetyNotification };

export type Badge = {
  id: 'early_bird' | 'night_owl' | 'park_regular' | 'founding_squirrel' | (string & {});
  name: string;
  description: string;
  unlocked: boolean;
  unlocked_at: string | null;
  /** null when the badge has no measurable progress. */
  progress: { current: number; target: number } | null;
};

// ---------------------------------------------------------------------------
// Map world: base features, points of interest, nearby players
// ---------------------------------------------------------------------------

export type BuildingKind = 'hostel' | 'academic' | 'food' | 'sports' | 'residential' | 'service';
export type TerrainKind = 'green' | 'water' | 'field' | 'woods' | 'track' | 'court' | 'plaza' | 'parking';

/** Stylised base map (drawn by the app — not map tiles). Static; cache aggressively. */
export type MapFeatures = {
  roads: { id: string; kind: 'road' | 'path'; points: LatLng[] }[];
  /** `kind` tints the roof, `levels` sets how tall it's drawn, `label` is a small map caption — all optional. */
  buildings: { id: string; polygon: LatLng[]; kind?: BuildingKind | null; levels?: number | null; label?: string | null }[];
  /** Optional `label` is a small map caption (e.g. "Football ground"). */
  terrain: { id: string; kind: TerrainKind; polygon: LatLng[]; label?: string | null }[];
  pois: Poi[];
  /** campus-service: the active zones behind its features (each with `geometry_source`). */
  zones?: Zone[];
};

export type Poi = {
  id: string;
  name: string;
  kind: 'food' | 'sports' | 'study' | 'hangout' | 'gate' | 'event' | (string & {});
  position: LatLng;
  zone_id: string | null;
  description: string | null;
};

/**
 * Someone the backend lets you see on the map. `position` is APPROXIMATE: the backend snaps it
 * to a coarse cell (see `precision_m`) — never a raw GPS fix, never a home location. Users who
 * blocked you, hid themselves, or aren't allowed to appear are simply absent.
 */
export type MapPlayer = PersonLite & {
  level: number;
  xp: number;
  position: LatLng;
  precision_m: number;
  proximity: Proximity | null;
  activity: ActivityType | 'workout' | null;
  last_seen_at: string;
  relationship: RelationshipState;
};

export type NearbyPlayers = { players: MapPlayer[]; as_of: string; visible: boolean; hidden_reason: string | null; hidden_code?: HiddenCode | null };

/** Your own location as reported to the backend for discovery (throttled by the app). */
export type PresenceUpdate = { lat: number; lng: number; accuracy_m: number | null };

/** A person in search / lists with enough to render a card and a Poke button. */
export type PersonSummary = PersonLite & { level: number; xp: number; proximity: Proximity | null; relationship: RelationshipState };

// ---------------------------------------------------------------------------
// Poke → Poke back → Friends
// ---------------------------------------------------------------------------

/**
 * none       — nothing between you
 * poked      — you poked them, waiting for a poke back
 * poked_you  — they poked you; poking back makes you friends
 * friends    — mutual poke confirmed by the backend
 */
export type RelationshipState = 'none' | 'poked' | 'poked_you' | 'friends';

export type Relationship = {
  user_id: string;
  state: RelationshipState;
  /** Whether the backend accepts a poke right now (cooldowns, privacy, blocks). */
  can_poke: boolean;
  reason: string | null;
  poked_at: string | null;
  friends_since: string | null;
};

export type PokeResult = {
  relationship: Relationship;
  /** True only when THIS poke completed a mutual poke. */
  friendship_created: boolean;
  friend: (PersonLite & { level: number; xp: number }) | null;
};

export type IncomingPoke = {
  id: string;
  from: PersonLite & { level: number; xp: number };
  created_at: string;
  status: 'pending' | 'poked_back' | 'expired';
};

export type AppNotification = {
  id: string;
  type: 'poke' | 'friendship' | 'territory' | 'invite' | 'event' | 'ambassador' | 'study_break' | 'media' | 'meetup_rating' | 'shared_zone' | 'date_suggestion' | (string & {});
  actor: (PersonLite & { level?: number; xp?: number }) | null;
  text: string;
  created_at: string;
  read: boolean;
  /** `route`: an app screen to open when nothing more specific applies (the Social service sends these). */
  data: { user_id?: string; zone_id?: string; invite_id?: string; event_id?: string; poke_id?: string; meetup_id?: string; media_id?: string; application_id?: string; suggestion_id?: string; route?: string } | null;
};

// ---------------------------------------------------------------------------
// Shared zones (Dev B) · Heatmap (Dev B) · Squirrel Dates (Dev B)
// ---------------------------------------------------------------------------

/** People you share zones with. Zone-level only — never routes, times or live location. */
export type SharedZonesPerson = { person: PersonLite & { level?: number }; shared_zones_count: number; top_zone: { zone_id: string; zone_name: string } | null };
export type SharedZonesIndex = { people: SharedZonesPerson[]; visible: boolean; hidden_reason: string | null; hidden_code?: HiddenCode | null };

export type HeatLevel = 'low' | 'active' | 'high';
/** One aggregated cell. The backend buckets, thresholds and anonymises; the app only draws it. */
export type HeatCell = { id: string; center: LatLng; radius_m: number; intensity: number; level: HeatLevel; zone_id: string | null };
export type HeatWindow = '1h' | '24h' | '7d';
export type Heatmap = { available: boolean; reason: string | null; window: HeatWindow | (string & {}); generated_at: string; cells: HeatCell[]; min_people_per_cell: number | null };

/**
 * Advisory only: who, where and when. A suggestion never sends anything to anyone; to meet, the
 * member plans an event themselves (createEvent) and shares it.
 */
export type DateSuggestion = {
  id: string;
  person: PersonLite & { level?: number };
  /** Written by the backend from real shared data ("You're both often around Sports Ground Loop."). */
  reason: string;
  zone: { id: string; name: string } | null;
  suggested_time: string | null;
};
/** `available` false: campus zones aren't set up. `enabled`: the viewer's own opt-in (off by default). */
export type DateSuggestions = { available: boolean; enabled: boolean; reason: string | null; suggestions: DateSuggestion[] };
export type DateSettings = { enabled: boolean; zones_ready: boolean };
/** Whether *I* blocked this person. A block works both ways for suggestions, follows and challenges. */
export type BlockState = { user_id: string; blocked: boolean };


// ---------------------------------------------------------------------------
// Post-meetup rating (Dev A)
// ---------------------------------------------------------------------------

export type RatingDimension = { key: string; label: string };
export type TrustScore = { value: number; label: string };
export type MeetupRatingState = {
  meetup_id: string;
  can_rate: boolean;
  /** Why rating isn't possible (not ended yet, you didn't check in, window closed…). */
  reason: string | null;
  already_rated: boolean;
  /** Other attendees you can rate — never yourself. */
  rateable: PersonLite[];
  /** Optional structured feedback; empty when the backend doesn't support it. */
  dimensions: RatingDimension[];
  trust_score: TrustScore | null;
};
export type MeetupRatingInput = { ratings: { user_id: string; stars: 1 | 2 | 3 | 4 | 5; tags: string[] }[] };
export type MeetupRatingResult = { meetup_id: string; submitted_at: string; trust_score: TrustScore | null };

// ---------------------------------------------------------------------------
// Ambassador application (Dev A) — the backend owns the form's fields
// ---------------------------------------------------------------------------

export type AmbassadorField = { key: string; label: string; type: 'text' | 'multiline' | 'select'; required: boolean; max_length: number | null; options?: string[] | null; placeholder?: string | null; prefill?: string | null };
export type AmbassadorStatus = 'pending' | 'under_review' | 'approved' | 'rejected' | 'suspended';
export type AmbassadorApplication = { id: string; status: AmbassadorStatus; submitted_at: string; decided_at: string | null; message: string | null };
export type AmbassadorState = { open: boolean; closed_reason: string | null; application: AmbassadorApplication | null; fields: AmbassadorField[] };

// ---------------------------------------------------------------------------
// Realtime
// ---------------------------------------------------------------------------

export type RealtimeMessage =
  | { type: 'territory.updated'; data: Territory }
  | { type: 'stats.updated'; data: LaunchStats }
  | { type: 'invite.updated'; data: ChallengeInvite }
  | { type: 'event.updated'; data: { event_id: string; participants_count: number } }
  | { type: 'active.updated'; data: { active_now: number } }
  | { type: 'poke.received'; data: IncomingPoke }
  | { type: 'relationship.updated'; data: Relationship }
  | { type: 'friendship.created'; data: { friend: PersonLite & { level: number; xp: number }; relationship: Relationship } }
  | { type: 'notification.created'; data: AppNotification }
  | { type: 'players.updated'; data: { as_of: string } }
  | { type: BubbleEventName; data: BubbleEvent };

/**
 * campus-service bubble.* (topic `bubble`, added on auth): one neighbour's card as you'd see it,
 * without `states` (the server doesn't know your zone or activity when it sends it). Never a position.
 */
export type BubbleEvent = Pick<FeaturePersonCard, 'person' | 'activity' | 'proximity' | 'zone'> & {
  state: 'joined' | 'left' | 'activity_started' | 'activity_ended';
  at: string;
};

// ---------------------------------------------------------------------------
// The service interface both implementations satisfy
// ---------------------------------------------------------------------------

export type Page<T> = { items: T[]; next_cursor: string | null };

export interface CampusApi {
  config(): Promise<AppConfig>;
  stats(): Promise<LaunchStats>;

  me(): Promise<Me>;
  updateMe(patch: MePatch): Promise<Me>;
  setOpenToMeet(enabled: boolean): Promise<OpenToMeet>;
  profile(userId: string): Promise<Profile>;
  sharedContext(userId: string): Promise<SharedContext>;
  badges(): Promise<Badge[]>;

  zones(): Promise<Zone[]>;
  territories(): Promise<{ territories: Territory[]; as_of: string }>;
  zone(zoneId: string): Promise<ZoneDetail>;
  territoryAction(zoneId: string, action: TerritoryAction, idempotencyKey: string): Promise<TerritoryActionResult>;

  /** campus-service's one-shot copy of a run's points (zone eligibility); the Run Module keeps its own. */
  submitActivity(input: ActivitySubmit): Promise<{ activity_id: string }>;
  activityZones(activityId: string): Promise<ActivityZones>;

  crews(params: { q?: string; scope?: 'all' | 'mine' }): Promise<Page<Crew>>;
  crew(crewId: string): Promise<CrewDetail>;
  joinCrew(crewId: string): Promise<Crew>;
  leaveCrew(crewId: string): Promise<Crew>;
  createCrew(input: CrewCreate): Promise<Crew>;

  events(params: { scope?: 'upcoming' | 'mine' }): Promise<Page<EventSummary>>;
  event(eventId: string): Promise<EventDetail>;
  rsvp(eventId: string, going: boolean): Promise<EventDetail>;
  createEvent(input: EventCreate): Promise<EventDetail>;

  suggestedPeople(mode: 'friends' | 'date'): Promise<PersonCard[]>;
  activeNow(): Promise<ActiveNow>;

  challengeTypes(): Promise<ChallengeTypeInfo[]>;
  invites(box: 'incoming' | 'outgoing' | 'all'): Promise<ChallengeInvite[]>;
  createInvite(input: ChallengeInviteCreate): Promise<ChallengeInvite>;
  respondInvite(inviteId: string, action: 'accept' | 'decline' | 'cancel'): Promise<ChallengeInvite>;

  squirrelBoard(period: LeaderboardPeriod, limit?: number): Promise<SquirrelBoard>;
  hostelBoard(period: LeaderboardPeriod): Promise<HostelBoard>;

  // Map world
  mapFeatures(): Promise<MapFeatures>;
  nearbyPlayers(): Promise<NearbyPlayers>;
  zonePlayers(zoneId: string): Promise<PersonSummary[]>;
  updatePresence(p: PresenceUpdate): Promise<{ accepted: boolean }>;
  searchPeople(q: string): Promise<PersonSummary[]>;

  // Poke → friends
  pokeStatus(userId: string): Promise<Relationship>;
  sendPoke(userId: string, idempotencyKey: string): Promise<PokeResult>;
  pokeBack(userId: string, idempotencyKey: string): Promise<PokeResult>;
  incomingPokes(): Promise<IncomingPoke[]>;
  friendshipStatus(userId: string): Promise<{ user_id: string; friends: boolean; since: string | null }>;

  // Notifications
  /** Newest first, a page at a time: pass `next_cursor` back for the next page (null on the last). */
  notifications(cursor?: string | null): Promise<{ items: AppNotification[]; unread: number; next_cursor: string | null }>;
  markNotificationsRead(ids: string[]): Promise<{ unread: number }>;

  // Dev B
  sharedZones(): Promise<SharedZonesIndex>;
  heatmap(window: HeatWindow): Promise<Heatmap>;
  dateSuggestions(forUserId?: string): Promise<DateSuggestions>;
  dismissDateSuggestion(suggestionId: string): Promise<{ dismissed: true }>;
  dateSettings(): Promise<DateSettings>;
  setDateSettings(enabled: boolean): Promise<DateSettings>;
  blockStatus(userId: string): Promise<BlockState>;
  setBlocked(userId: string, blocked: boolean): Promise<BlockState>;
  // Dev A
  meetupRating(meetupId: string): Promise<MeetupRatingState>;
  rateMeetup(meetupId: string, input: MeetupRatingInput, idempotencyKey: string): Promise<MeetupRatingResult>;
  ambassador(): Promise<AmbassadorState>;
  applyAmbassador(answers: Record<string, string>, idempotencyKey: string): Promise<AmbassadorApplication>;

  meetups(): Promise<Meetup[]>;
  meetup(meetupId: string): Promise<Meetup>;
  createMeetup(input: MeetupCreate): Promise<Meetup>;
  respondMeetup(meetupId: string, action: MeetupAction): Promise<Meetup>;
  checkIn(meetupId: string, notifySafetyContact: boolean): Promise<CheckInResult>;
}
