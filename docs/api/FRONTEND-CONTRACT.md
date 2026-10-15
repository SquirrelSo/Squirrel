# Frontend contract: XP, Discover, Bubble, Notifications, Buddies, Shared sessions, Ambassador

One page for the app. Every feature lives in the service that owns it (ADR-032); nothing below is a
second copy. TypeScript shapes: `mobile-4/src/api/featureContracts.ts`. Full per-route detail stays in
each service's own docs, linked per section.

| Service | App env var (base URL) | Auth | Error body |
|---|---|---|---|
| Run Module (XP) | `EXPO_PUBLIC_API_URL` | `Authorization: Bearer <access token>` | `{ error }` (401 `{error:"unauthorized"}`), 429 `{statusCode, error, message}` |
| campus-service (Discover, Bubble) | `EXPO_PUBLIC_CAMPUS_SERVICE_URL` | same token | `{ code, detail, …extra }`; 422 `{ code:"invalid", detail, issues }`; 429 `{ code:"rate_limited" }` |
| Social (Notifications, Ambassador) | `EXPO_PUBLIC_SOCIAL_API_URL` | same token | `{ detail, code }`; 422 field errors in FastAPI's list shape |
| Exercise (Buddies, Shared sessions) | `EXPO_PUBLIC_EXERCISE_API_URL` | same token (`?token=` on WebSockets) | `{ detail: { code, message, …extra } }` |

The access token is the one the app already holds (Exercise signs it; every service verifies it). The
app sees **Social profile ids** for people everywhere except the Run Module's XP board, whose
`user_id` is the login subject (the app shows those rows without names; Social's
`/v1/leaderboards/xp` names the daily and weekly boards).

Requested name → real route, for orientation:

| Requested | Real |
|---|---|
| `GET /api/xp`, `/api/xp/stats`, `/api/xp/history`, `/api/xp/leaderboard` | Run Module `GET /v1/xp`, `/v1/xp/stats`, `/v1/xp/history`, `/v1/leaderboard/xp` |
| `/api/discover*` | campus `GET /v1/discover`, `/v1/discover/{nearby,active,challenges,crews,zones}` |
| `/api/bubble*` | campus `GET /v1/bubble`, `GET /v1/bubble/nearby`, `POST /v1/bubble/{join,leave}` |
| `/api/notifications*` | Social `GET /v1/notifications`, `POST /v1/notifications/{id}/read`, `POST /v1/notifications/read-all`, `GET·PATCH /v1/notifications/preferences` |
| `/api/buddies*` | Exercise Partner Hunt `/api/users/{me}/partner-hunt/…` (buddy = accepted connection) |
| `/api/shared-sessions*` | Exercise `/api/workout-sessions/…` (server-timed race; see §5) |
| `/api/ambassadors*` | Social `/v1/ambassador/…` and `/v1/me/referral` |

---

## 1. XP — Run Module ([README § XP](../../run-module/README.md), [ADR-033](../../run-module/docs/decisions/ADR-033-xp-sources-reversal-and-stats.md))

The app never sends XP. XP comes only from server-verified events: runs, exercise sessions, the daily
goal, challenge wins, and awards other services report after verifying their own action.

| Method · path | Query / body | 200 response |
|---|---|---|
| `GET /v1/xp` | — | `{ totalXp, level, today, week, bySource }` (startup shape, unchanged) |
| `GET /v1/xp/stats` | — | `{ total, level, level_progress: { current_level_xp, next_level_xp, into_level, needed }, today, week, month, by_source }` |
| `GET /v1/xp/history` | `limit` 1–100, `cursor` | `{ items: [{ id, amount, source, reason, source_id, created_at, reversed }], next_cursor }` newest first |
| `GET /v1/leaderboard/xp` | `window=daily\|weekly\|monthly`, `limit` | `{ window, day, entries: [{ rank, user_id, xp }], me, total_ranked }` (challenge wins included) |

Errors: 401; 400 bad query; 429 (per-user read limit). Level = `floor(xp / 2000) + 1`. A level-up
arrives as the Social notification `xp.level_up` (route `/progress`).

XP sources (ADR-033): runs and exercise (ADR-027, unchanged); **daily goal 30** once per day with ≥1
counted activity; challenge win ≤200 per challenge and ≤200/day; territory claim/steal/defend (≤150/day);
meetup check-in 25 (once both came); shared workout finished 20 (≤3/day); buddy connected 20 (once per
pair); ambassador referral 50; ambassador task ≤200; special event ≤100. All reported awards except
territory share a 300 XP/day cap. Awards are idempotent and can be reversed.

## 2. Discover — campus-service ([docs/API.md § Discover](../../campus-service/docs/API.md))

Lists share `{ items, next_cursor, hidden_reason, as_of }`, `limit` 1–50 (default 20), opaque `cursor`.
Never coordinates, distances, exact counts or another person's history. Unknown query params → 422.

| Method · path | Query | Items |
|---|---|---|
| `GET /v1/discover` | — | `{ nearby[≤5], active[≤5], challenges[≤5], zones[≤5], crews[≤5], reasons: { section: reason\|null }, as_of }` |
| `GET /v1/discover/nearby` | `activity_type`, `zone_id`, `sort=proximity\|recent` | `PersonCard` |
| `GET /v1/discover/active` | `activity_type`, `sort=recent\|level` | `PersonCard` |
| `GET /v1/discover/challenges` | `type`, `zone_id` | `DiscoverBattle` (battles you're part of; never others' invites) |
| `GET /v1/discover/crews` | — | `{ crew: { id, name, color, icon }, zones_held }` |
| `GET /v1/discover/zones` | `sort=popular\|contested\|unclaimed` | `{ zone, territory: { status, owner_type }, popularity: low\|medium\|high\|null, contested }` |

`hidden_reason`: `open_to_meet_off`, `location_unknown`, `blocks_unreachable`, `crew_names_unavailable`,
`unavailable`. People appear only with a current Open to Meet; blocked people (either way) never.

## 3. Bubble — campus-service ([docs/API.md § Bubble](../../campus-service/docs/API.md))

Opt-in "who's around me right now". Joining reduces your position to a ~250 m cell and the containing
zone; coordinates are discarded. Membership lasts 15 min; join again to refresh (e.g. every 5 min while
the screen is open). Requires a current Open to Meet.

| Method · path | Body / query | Response | Errors |
|---|---|---|---|
| `POST /v1/bubble/join` | `{ lat, lng, accuracy_m?, activity_type?: run\|walk\|workout\|null }` | `{ accepted, reason: null\|"off_campus", …BubbleState }` | 409 `open_to_meet_required`, 422, 429 (6/min) |
| `POST /v1/bubble/leave` | — | 204 | — |
| `GET /v1/bubble` | — | `BubbleState { in_bubble, zone, expires_at, activity_type, counts: { nearby, active_nearby, same_zone, same_activity }, hidden_reason, as_of }` | — |
| `GET /v1/bubble/nearby` | `state`, `limit`, `cursor` | `{ items: PersonCard[], next_cursor, in_bubble, hidden_reason, as_of }` | 422 |

`PersonCard { person: { user_id, display_name, avatar_url, hostel, connection_mode, bio, level, xp },
activity: { type, started_at } | null, proximity: very_close|nearby|on_campus|null, zone, states[], last_seen_at }`;
`states` ⊂ `nearby, active_nearby, recently_active, same_zone, same_campus, same_activity`.

Realtime (existing WS `realtime_url`, after `auth`; topic `bubble` is added automatically):
`bubble.user_joined`, `bubble.user_left`, `bubble.activity_started`, `bubble.activity_ended` — data is a
PersonCard; only to current neighbours, never blocked people, at most one per person pair per minute.
Notification `bubble.activity` (route `/bubble`) at most once per 6 h.

## 4. Notifications — Social ([README](../../squirrel-social-profile-social-fixed/social-backend/README.md))

| Method · path | Body | Response |
|---|---|---|
| `GET /v1/notifications` | `cursor`, `limit` | `{ items, next_cursor, unread }` (existing) |
| `GET /v1/notifications/unread-count` | — | `{ unread }` |
| `POST /v1/notifications/{id}/read` | — | `{ unread }`; someone else's id → 404 |
| `POST /v1/notifications/read-all` | — | `{ unread }` |
| `POST /v1/notifications/read` | `{ ids? }` | `{ unread }` (existing) |
| `GET /v1/notifications/preferences` | — | `{ categories: { [c]: { push, in_app, mutable } }, quiet_hours_start, quiet_hours_end, timezone, updated_at }` |
| `PATCH /v1/notifications/preferences` | partial: `categories.<c>.push/in_app`, `quiet_hours_start`+`quiet_hours_end` (0–1439, both or both null), `timezone` | same as GET; 422 `not_mutable` for `system` |
| `POST /v1/me/push-tokens` · `DELETE /v1/me/push-tokens/{token}` | `{ token, platform }` | existing device tokens |

Categories: `xp, challenges, territory, buddies, workouts, meetups, bubble, crews, ambassador, social, system`.
In-app off → not stored; push off or quiet hours → stored, no push; >6 pushes/category/hour → stored
silently. New kinds and their tap routes: `xp.level_up` → `/progress`; `shared_workout.invited` →
`/workout/join/{code}`; `shared_workout.finished` → `/workout/{session_id}`; `bubble.activity` →
`/bubble`; `ambassador.task`, `ambassador.reward`, `ambassador.suspended` → `/ambassador`; `system.announcement`.
Realtime: campus-service's existing `notification.created` for campus kinds; others arrive by push and
on the next list refresh.

## 5. Buddies and shared sessions — Exercise ([README](../../Exercise_Mechanics--main/README.md))

**Buddies** = accepted Partner Hunt connections. Under `/api/users/{me}/partner-hunt` (`{me}` = your
own id; any other → 403):

| Method · path | Body | Response / errors |
|---|---|---|
| `GET /matches` | — | compatible people (anonymous cards; existing) |
| `GET /requests` | — | `{ incoming, outgoing, connections }` |
| `POST /requests` | `{ card_id }` | 201; 409 `already_connected\|already_requested\|they_asked_you`, 429 `too_soon\|daily_limit\|too_many_pending` |
| `POST /requests/{rid}/accept` · `/decline` | — | accept → connection (both earn 20 XP once); decline 204 (silent) |
| `DELETE /requests/{rid}` | — | 204 (withdraw) |
| `DELETE /connections/{rid}` | — | 204 remove buddy (either side, silent; 30-day cooldown); 404 `connection_not_found` |
| `POST /blocks` | `{ card_id }` | block (Social's block list, everywhere) |

**Shared sessions** keep the server-timed race (product decision): 2 players, 1/3/5 minutes, phases
`lobby → countdown → racing → finished` (or `expired`) computed by the server — duration can't be faked.
Under `/api/workout-sessions`:

| Requested | Method · path | Notes |
|---|---|---|
| create | `POST /` `{ exercise_key, duration_s: 60\|180\|300 }` | you are host |
| invite | `POST /{id}/invite` `{ social_profile_id }` | buddy only (403 `not_a_buddy`), host only, lobby only, ≤3 pending (429) |
| accept / join | `POST /invites/{code}/join` | (preview: `GET /invites/{code}`) |
| decline | `POST /invites/{code}/decline` | 204; 404 if not invited |
| start | `PUT /{id}/ready` `{ ready }` | both ready → server starts a 3 s countdown |
| live state | `GET /{id}`, WS `/ws/workout-sessions/{id}?token=` | |
| reps | `POST /{id}/reps` `{ reps, seq }` | 422 `implausible_reps`, 429 `rate_limited` |
| complete | `POST /{id}/complete` `{ reps, seq }` | your final count (same body as reps); idempotent; settlement happens once |
| cancel | `POST /{id}/cancel` | host, before countdown |
| leave | `POST /{id}/leave` | |
| pause / resume | — | not offered: a timed race can't be paused fairly |

Finishing (not leaving, ≥1 rep) earns 20 XP once per race (≤3/day). WS events:
`workout.session.updated`, `workout.reps.updated`, `workout.session.invited`, `workout.session.cancelled`,
`workout.session.completed` (`{ session_id, completed_at, results: [{ user: { user_id, display_name, avatar_url, hostel }, reps, finished, rewarded }] }`; `rewarded` is Exercise's decision, the Run Module's 3/day cap applies after it). Once `completed_at` is set, each seat in the session view (`host`, `partner`) also carries `rewarded: boolean` (`null` before settlement), so a client that polls or opens a settled race still knows.
Notifications: `shared_workout.invited`, `shared_workout.finished`.

## 6. Ambassador — Social ([README § Ambassador programme](../../squirrel-social-profile-social-fixed/social-backend/README.md))

| Requested | Method · path | Response |
|---|---|---|
| apply / status | `GET·POST /v1/ambassador/application` | form, open/closed reason, my application (`pending\|under_review\|approved\|rejected\|suspended`) |
| me | `GET /v1/ambassador/me` | `{ status: active\|suspended, approved_at, suspended_at, suspension_reason, referral_code, invite_url, counts: { referred, verified, activated, rewarded, referral_xp, task_xp } }`; 404 `not_ambassador` |
| referrals | `GET /v1/ambassador/referrals?cursor=&limit=` | `{ items: [{ user: { id, display_name, avatar_look, avatar_url }, signup_at, verified, activated, reward_eligible, rewarded }], next_cursor }` |
| claim a code | `POST /v1/me/referral { code }` | 409 `referral_used`, 422 `own_code\|claim_window` |
| tasks | `GET /v1/ambassador/tasks`, `POST /v1/ambassador/tasks/{id}/submit { evidence }` | 403 suspended, 409 `already_submitted`, 429 |
| leaderboard | `GET /v1/ambassador/leaderboard?limit=` | active ambassadors by activated referrals, then task XP |

A referral earns 50 XP once when the friend claimed the code, verified their email and was active within
30 days, while the ambassador is active (≤20 rewards/day; the rest later). Self-referral, a second code
and late claims are refused. Admin routes (role `admin`): review applications, suspend/reinstate, tasks,
submissions, reward reversal, referral analytics (see the README).

## Realtime summary

| Transport | Events |
|---|---|
| campus WS (`/v1/realtime`) | existing territory/invite/notification events + `bubble.user_joined`, `bubble.user_left`, `bubble.activity_started`, `bubble.activity_ended` |
| Exercise WS (`/ws/workout-sessions/{id}`) | `workout.session.updated`, `workout.reps.updated`, `workout.session.invited`, `workout.session.cancelled`, `workout.session.completed` |
| Push (Social → Expo) | every notification kind above, per the recipient's preferences |

No event carries GPS coordinates.
