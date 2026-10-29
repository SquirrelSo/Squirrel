/**
 * Response shapes for the backend features in docs/api/FRONTEND-CONTRACT.md (XP stats and history,
 * Discover, Bubble, notification preferences, ambassador, shared-workout results). Types only — no
 * calls, no stand-in data. Each service stays the source of truth; when a route here is wired into a
 * screen, its client module imports the shape from this file instead of re-declaring it.
 */

// ── XP — Run Module (EXPO_PUBLIC_API_URL) ───────────────────────────────────────────────

/** Where XP came from (Run Module's XpCategory). */
export type XpSource = 'run' | 'exercise' | 'campus' | 'challenge' | 'social' | 'daily_goal';

/** GET /v1/xp/stats */
export type XpStats = {
  total: number;
  level: number;
  level_progress: { current_level_xp: number; next_level_xp: number; into_level: number; needed: number };
  today: number;
  week: number;
  month: number;
  by_source: Record<XpSource, number>;
};

/** GET /v1/xp/history?limit=&cursor= — newest first. */
export type XpHistoryItem = {
  id: string;
  amount: number;
  source: XpSource;
  reason: string;
  source_id: string | null;
  created_at: string;
  reversed: boolean;
};
export type XpHistoryPage = { items: XpHistoryItem[]; next_cursor: string | null };

export type XpLeaderboardWindow = 'daily' | 'weekly' | 'monthly';
/** GET /v1/leaderboard/xp?window=&limit= */
export type XpLeaderboard = {
  window: XpLeaderboardWindow;
  day: string;
  entries: { rank: number; user_id: string; xp: number }[];
  /** Your own entry when you're ranked. */
  me: { rank: number; user_id: string; xp: number } | null;
  total_ranked: number;
};

// ── Discover and Bubble — campus-service (EXPO_PUBLIC_CAMPUS_SERVICE_URL) ───────────────────

export type ActivityType = 'run' | 'walk' | 'workout';
export type Proximity = 'very_close' | 'nearby' | 'on_campus';
export type PersonState = 'nearby' | 'active_nearby' | 'recently_active' | 'same_zone' | 'same_campus' | 'same_activity';
export type ZoneRef = { id: string; name: string; kind?: string };

/** One person as Discover and Bubble show them. Never coordinates or distances. */
export type PersonCard = {
  person: {
    user_id: string;
    display_name: string;
    avatar_url: string | null;
    hostel: string | null;
    connection_mode: string | null;
    bio: string | null;
    level: number | null;
    xp: number | null;
  };
  /** started_at is null for a type declared on bubble join (no recorded activity). */
  activity: { type: ActivityType; started_at: string | null } | null;
  proximity: Proximity | null;
  zone: ZoneRef | null;
  states: PersonState[];
  last_seen_at: string | null;
};

export type DiscoverHiddenReason = 'open_to_meet_off' | 'location_unknown' | 'blocks_unreachable' | 'crew_names_unavailable' | 'unavailable';

/** Every Discover list: GET /v1/discover/{nearby,active,challenges,crews,zones} */
export type DiscoverPage<T> = { items: T[]; next_cursor: string | null; hidden_reason: DiscoverHiddenReason | null; as_of: string };

export type DiscoverCrew = { crew: { id: string; name: string; color: string | null; icon: string | null }; zones_held: number };
export type DiscoverZone = {
  zone: ZoneRef;
  territory: { status: string; owner_type: string | null };
  popularity: 'low' | 'medium' | 'high' | null;
  contested: boolean;
};

/** GET /v1/discover — battle items keep campus-service's battle shape (only battles you're part of). */
export type DiscoverOverview<Battle = unknown> = {
  nearby: PersonCard[];
  active: PersonCard[];
  challenges: Battle[];
  zones: DiscoverZone[];
  crews: DiscoverCrew[];
  reasons: Partial<Record<'nearby' | 'active' | 'challenges' | 'zones' | 'crews', DiscoverHiddenReason | null>>;
  as_of: string;
};

/** POST /v1/bubble/join body. lat/lng are reduced to a ~250 m cell and discarded. */
export type BubbleJoin = { lat: number; lng: number; accuracy_m?: number; activity_type?: ActivityType | null };

/** GET /v1/bubble */
export type BubbleState = {
  in_bubble: boolean;
  zone: ZoneRef | null;
  expires_at: string | null;
  activity_type: ActivityType | null;
  counts: { nearby: number; active_nearby: number; same_zone: number; same_activity: number };
  hidden_reason: DiscoverHiddenReason | null;
  as_of: string;
};
/** POST /v1/bubble/join → 200 */
export type BubbleJoinResult = BubbleState & { accepted: boolean; reason: null | 'off_campus' };
/** GET /v1/bubble/nearby?state=&limit=&cursor= */
export type BubbleNearbyPage = { items: PersonCard[]; next_cursor: string | null; in_bubble: boolean; hidden_reason: DiscoverHiddenReason | 'not_in_bubble' | null; as_of: string };

export type BubbleEventName = 'bubble.user_joined' | 'bubble.user_left' | 'bubble.activity_started' | 'bubble.activity_ended';

// ── Notifications — Social (EXPO_PUBLIC_SOCIAL_API_URL) ─────────────────────────────────────

export type NotificationCategory = 'xp' | 'challenges' | 'territory' | 'buddies' | 'workouts' | 'meetups' | 'bubble' | 'crews' | 'ambassador' | 'social' | 'system';

/** GET·PATCH /v1/notifications/preferences. `system` is never mutable. Quiet hours are minutes 0–1439. */
export type NotificationPreferences = {
  categories: Record<NotificationCategory, { push: boolean; in_app: boolean; mutable: boolean }>;
  quiet_hours_start: number | null;
  quiet_hours_end: number | null;
  timezone: string;
  updated_at: string | null;
};
export type NotificationPreferencesPatch = {
  categories?: Partial<Record<Exclude<NotificationCategory, 'system'>, { push?: boolean; in_app?: boolean }>>;
  quiet_hours_start?: number | null;
  quiet_hours_end?: number | null;
  timezone?: string;
};

/** New kinds this build adds (routes the app opens on tap). */
export type FeatureNotificationKind =
  | 'xp.level_up'
  | 'shared_workout.invited'
  | 'shared_workout.finished'
  | 'bubble.activity'
  | 'ambassador.task'
  | 'ambassador.reward'
  | 'ambassador.suspended'
  | 'system.announcement';

// ── Ambassador — Social ─────────────────────────────────────────────────────────────────────

export type AmbassadorStatus = 'pending' | 'under_review' | 'approved' | 'rejected' | 'suspended';

/** GET /v1/ambassador/me (404 not_ambassador otherwise). The profile's own status, not the application's. */
export type AmbassadorMe = {
  status: 'active' | 'suspended';
  approved_at: string;
  suspended_at: string | null;
  suspension_reason: string | null;
  referral_code: string;
  invite_url: string | null;
  counts: { referred: number; verified: number; activated: number; rewarded: number; referral_xp: number; task_xp: number };
};

/** GET /v1/ambassador/referrals?cursor=&limit= */
export type AmbassadorReferralPage = {
  items: {
    user: { id: string; display_name: string; avatar_look: unknown; avatar_url: string | null };
    signup_at: string;
    verified: boolean;
    activated: boolean;
    reward_eligible: boolean;
    rewarded: boolean;
  }[];
  next_cursor: string | null;
};

// ── Shared sessions — Exercise (EXPO_PUBLIC_EXERCISE_API_URL) ───────────────────────────────

/** WS `workout.session.completed` data. `user` is the player's Social PersonLite (service.py
 * _on_completed sends `p["person"]`: user_id is the Social profile id), not a bare id. */
export type SharedWorkoutCompleted = {
  session_id: string;
  completed_at: string;
  results: { user: { user_id: string; display_name: string; avatar_url: string | null; hostel: string | null }; reps: number; finished: boolean; rewarded: boolean }[];
};
