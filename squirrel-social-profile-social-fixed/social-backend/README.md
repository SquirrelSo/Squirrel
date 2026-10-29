# Squirrel Social — Profile + Social service

FastAPI + PostgreSQL service that owns **profiles, follows, posts, likes, saves, comments,
badges and activity summaries** for the mobile app (`../mobile`). Routes live under `/v1`, next
to the Run Module's, so both can sit behind one gateway.

It does **not** own runs, XP or authentication:

| Concern | Owner | How Social uses it |
|---|---|---|
| Sign-in / tokens | Account service (RS256 JWT) | Verifies the same bearer token as the Run Module; `sub` identifies the account |
| Runs, GPS, territory | Run Module | Reads `GET /v1/runs/:id` **with the caller's token** when a run is shared; keeps distance + time only |
| XP | Run Module | Your own: `GET /v1/users/me/xp` with your token on every profile read. Everyone else's: a read cache (`user_stats.xp`) refreshed in one `POST /internal/v1/xp/totals` call (service token) when older than `SOCIAL_XP_CACHE_TTL_S`, while a list shows them; never incremented here, and the last figure is shown if the Run Module is down (`app/services/xp_cache.py`, ADR-032) |
| Form-coach workouts | Exercise backend | Can publish finished sessions via `POST /internal/v1/activities` (service token) |

## Architecture

```
app/
  main.py            app factory (settings, DB, verifier, Run Module client, storage, limiter)
  config.py          environment → Settings (fails closed without a JWT key)
  auth.py            RS256 verification, first-request profile provisioning
  models.py          SQLAlchemy models (tables below)
  schemas.py         request/response contract (Pydantic)
  rules.py           username + catalogue rules (mirrored in mobile/src/api/socialRules.ts)
  pagination.py      opaque keyset cursors
  ratelimit.py       per-user sliding-window limits on writes (429 + Retry-After)
  services/
    social.py        visibility, batched serialisation, counters, streaks, badges
    badges.py        activity badge rules: Early Bird, Night Owl, Park Regular
    run_module.py    read-only Run Module client (caller's token)
    media.py         S3-compatible presigned uploads
  routers/           profiles · follows · feed · posts (likes, saves, comments) · media · internal
migrations/          Alembic (0001_profile_social)
tests/               81 tests + 1 PostgreSQL-only concurrency test
scripts/dev_token.py local RS256 keys + tokens for development
```

### Tables (migration `0001_profile_social`)

| Table | Key / constraints | Indexes | Why |
|---|---|---|---|
| `users` | PK `id` (public UUID); unique `auth_subject`, unique `username`; CHECK visibility, role | `(city_id, created_at)` | One profile per account. The JWT `sub` is stored but never returned. No email/password. |
| `user_stats` | PK/FK `user_id`; CHECK counters ≥ 0 | – | Followers/following/posts counters and cached Run Module XP, kept off the profile row |
| `follows` | PK `(follower_id, followee_id)`; CHECK not self; status `accepted`/`pending` | `(follower_id, status, created_at)`, `(followee_id, status, created_at)` | Follow graph; duplicates impossible; pending = request to a private account |
| `activities` | PK `id`; unique `(source, source_ref)`; CHECK type/source | `(user_id, started_at)` | Summary of a finished workout. `source_ref` = Run Module `run_id` / exercise session id, so one run can't become two activities. **No GPS.** |
| `media` | PK `id`; unique `storage_key` | `(owner_id, created_at)` | Uploaded photos (pending → ready) |
| `posts` | PK `id`; unique `activity_id` (one post per activity); FKs to activity/media | `(created_at, id)`, `(author_id, created_at, id)`, `(city_id, created_at, id)` | Normalised post; counters denormalised |
| `post_likes` | PK `(post_id, user_id)` | `(user_id, created_at)` | Likes |
| `post_saves` | PK `(user_id, post_id)` | `(user_id, created_at, post_id)` | Bookmarks (the profile's Saved tab) |
| `comments` | PK `id` | `(post_id, created_at, id)` | Comments |
| `badges` / `user_badges` | PK `id` / PK `(user_id, badge_id)` | – | Catalogue (seeded) + awards |

Counters (`likes_count`, `comments_count`, `followers_count`, …) only move in the same
transaction as the row that justifies them, and only when that row was actually inserted/deleted
(`INSERT … ON CONFLICT DO NOTHING RETURNING`), so double taps and concurrent requests can't skew
them. `tests/test_concurrency.py` hammers this on PostgreSQL.

### Privacy

- Never returned: auth subject, email, password, role, storage keys, GPS, route or territory geometry.
- Posts carry a **city id + area name** only. Shared runs keep distance and moving time.
- `visibility: private`: non-followers see name, avatar and counts only; posts, bio, city,
  college, interests, badges and follower lists are hidden (post URLs return 404). Follows become
  requests that the owner accepts. Switching back to public accepts pending requests.
- Internal ingestion refuses metric keys that look like location data (`lat`, `route`, …).
- Squirrel Dates is the one feature that looks at a route, and only for members who opted in: it
  reads the finished run's points from the Run Module's `run_points` (read-only, shared database)
  and keeps which named campus zone the run passed, on which local day and hour. No point, route or
  minute is stored; opting out deletes those rows, and they are pruned after 56 days.

### Performance

- Every list is **keyset-paginated** (`cursor` + `limit`, max 50), backed by the indexes above.
- A feed page is serialised in a **constant number of queries**: posts + authors + author stats
  + activities in one join, then one `IN (…)` query each for "liked by me", "saved by me",
  "following author" and media URLs. `test_feed_page_query_count_is_constant` enforces this.
- A profile screen needs **one request** (identity, stats, badges, 9 recent posts, 10 recent activities).
- Counts come from maintained counters, not from loading relationships.

## API contract

Auth: `Authorization: Bearer <RS256 JWT>` on every `/v1` route (401 + `WWW-Authenticate: Bearer`
otherwise). Errors are `{ "detail": "<message>", "code": "<machine code>" }` (FastAPI's
validation 422 keeps its `detail: [...]` list). Timestamps are ISO 8601 UTC.

### Shapes

```jsonc
// UserSummary (post author, comment author)
{ "id": "uuid", "username": "aanya.moves", "display_name": "Aanya S.", "avatar_look": {…AvatarLook} | null,
  "avatar_url": "https://…" | null, "level": 13, "verified": false }

// Activity
{ "id": "uuid", "type": "run|ride|workout|yoga|meal", "source": "run_module|exercise|manual", "verified": true,
  "name": "Push Day" | null, "distance_km": 7.2 | null, "duration_minutes": 41 | null, "pace": "5'42\"" | null,
  "calories": 480 | null, "started_at": "…" }

// Post
{ "id": "uuid", "author": UserSummary, "caption": "…", "activity": Activity | null,
  "city_id": "pune" | null, "area": "Koregaon Park" | null, "backdrop": { "scene": "city-sunset", "seed": 9 },
  "media_url": null, "sticker": "one-more-km" | null, "crew_name": null,
  "likes_count": 120, "comments_count": 12, "liked_by_me": false, "saved_by_me": false, "is_mine": false,
  "following_author": true, "requested_author": false, "created_at": "…" }

// Profile (GET /v1/users/me/profile and /v1/users/:id/profile)
{ "user": { "id", "username", "display_name", "avatar_look", "avatar_url", "bio", "city_id", "area", "college",
            "interests": [], "visibility": "public|private", "verified", "created_at" },
  "stats": { "xp": 24750, "level": 13, "level_xp": 750, "xp_per_level": 2000, "xp_synced_at": "…"|null,
             "streak_days": 18, "followers": 240, "following": 180, "posts": 34, "activities": 51 },
  "badges": [ { "id": "first_run", "kind": "first-run", "title": "First Run", "description": "…", "awarded_at": "…" } ],
  "recent_posts": [Post ×≤9], "recent_activities": [Activity ×≤10],
  "is_me": false, "restricted": false,
  "relationship": { "following": true, "followed_by": false, "requested": false } | null,
  "username_confirmed": true | null }   // only on /me

// Follower (followers/following/requests/search/suggestions rows)
UserSummary + { "city_id", "area", "interests": [≤3], "followed_at": "…"|null, "following", "requested", "is_me" }

// Page<T>
{ "items": [T], "next_cursor": "opaque" | null }
```

### Endpoints

| Method & path | Body / query | Response |
|---|---|---|
| `GET /v1/users/me/profile` | – | Profile (provisions on first call; refreshes XP from the Run Module) |
| `PATCH /v1/users/me/profile` | `UpdateProfileRequest`: any of `username`, `display_name`, `bio`, `city_id`, `area`, `college`, `interests[]`, `avatar_look`, `avatar_media_id`, `visibility` (`null` clears optional fields). Unknown fields → 422 | Profile · 409 `username_taken` · 422 `invalid_username` |
| `GET /v1/users/username/:username/availability` | – | `{ username, available, reason }` |
| `GET /v1/users/:id/profile` | – | Profile (restricted when private and not followed) |
| `GET /v1/users/:id/posts` | `cursor`, `limit` | Page<Post> · 403 if private |
| `GET /v1/users/me/saved` | `cursor`, `limit` | Page<Post> |
| `GET /v1/users/me/badges` | – | `{ badges: [{ id, name, description, unlocked, unlocked_at, progress: { current, target } \| null }] }` — every catalogue badge in the app's `Badge` shape; progress for the activity badges only |
| `GET /v1/users/search` | `q` (≥2 chars, `@` optional) | Page<Follower> |
| `GET /v1/users/suggestions` | `limit` (≤20) | Page<Follower> — not yet followed and not blocked either way, same city first |
| `POST /v1/users/:id/follow` | – | `{ following, followed_by, requested, followers, following_count }` — idempotent · 422 `self_follow` |
| `DELETE /v1/users/:id/follow` | – | same — idempotent |
| `GET /v1/users/:id/follow-status` | – | `{ following, followed_by, requested }` |
| `GET /v1/users/:id/followers` · `/following` | `cursor`, `limit` | Page<Follower> · 403 if private |
| `GET /v1/users/me/follow-requests` | `cursor` | Page<Follower> |
| `POST /v1/users/me/follow-requests/:id` / `DELETE …` | – | accept / decline → FollowStatus |
| `GET /v1/feed` | `feed=for_you\|following\|nearby`, `city` (nearby; defaults to profile city), `cursor`, `limit` (≤50) | Page<Post> |
| `POST /v1/posts` | `CreatePostRequest` (below) | 201 Post · 409 `already_shared` / `run_processing` · 422 `run_rejected` / `invalid_media` · 502/503 Run Module |
| `GET /v1/posts/:id` | – | Post · 404 (also for posts you may not see) |
| `DELETE /v1/posts/:id` | – | 204 · 403 unless author or moderator/admin |
| `POST` / `DELETE /v1/posts/:id/like` | – | `{ liked, likes_count }` — idempotent |
| `POST` / `DELETE /v1/posts/:id/save` | – | `{ saved }` — idempotent |
| `GET /v1/posts/:id/comments` | `cursor`, `limit` | `{ items: Comment[], next_cursor, total }` oldest first |
| `POST /v1/posts/:id/comments` | `{ body }` (1–500 chars) | 201 Comment `{ id, post_id, author, body, created_at, can_delete }` |
| `DELETE /v1/comments/:id` | – | 204 · 403 unless comment owner or moderator/admin |
| `POST /v1/media/uploads` | `{ purpose: post\|avatar, content_type: image/jpeg\|png\|webp\|heic, byte_size }` | 201 `{ media_id, upload_url, method: "PUT", headers, expires_at }` · 503 when storage isn't configured |
| `POST /v1/media/:id/complete` | – | `{ media_id, status, url }` after the server verified the object |
| `POST /internal/v1/activities` | service token; `{ user_subject, type, source: run_module\|exercise, source_ref, started_at, name?, distance_m?, duration_s?, calories?, metrics{} }` | 201/200 `{ activity_id, created }` — idempotent on `(source, source_ref)` |

```jsonc
// CreatePostRequest
{ "caption": "≤280 chars",                       // required unless activity or media_id is given
  "backdrop": { "scene": "city-sunset", "seed": 0-999 },
  "sticker": "one-more-km" | null, "crew_name": "≤60" | null,
  "city_id": "pune" | null, "area": "≤60" | null,   // default: profile city/area
  "media_id": "uuid" | null,
  "activity":
      { "source": "run", "run_id": "…" }            // Run Module run; server fetches distance/time
    | { "source": "activity", "activity_id": "uuid" } // published by another module
    | { "source": "manual", "type": "ride|workout|yoga|meal", "name"?, "distance_km"?, "duration_minutes"?, "calories"? } // unverified
    | null }
```

Validation: captions ≤ 280, comments ≤ 500, bio ≤ 160, display name ≤ 40, ≤ 8 interests of ≤ 24
chars, known city/scene/sticker ids, `AvatarLook` enums and `#RRGGBB` colours, and usernames of
3–20 characters (`^[a-z][a-z0-9._]{2,19}$`, no `..`, no trailing `.`, not reserved; stored lowercase).
Runs can't be self-reported (`manual` excludes `run`).

Rate limits (per user, 429 + `Retry-After`): posts 10/min and 100/day, comments 30/min, likes and
saves 120/min, follows 60/min, profile updates 20/min, username checks 60/min, uploads 20/min.

### Community (migration `0002_community`)

| Route | What |
|---|---|
| `GET /v1/me/membership` · `POST /v1/me/referral {code}` | Waitlist place (everyone is admitted; 3 verified friends with your code move you to the front), invite code and link, founding badge (first 15 verified: Founding Squirrel, first 500: Founding 500; "verified" = the token's `ev` claim) |
| `GET /v1/community/config` | Hostels to pick from (`SOCIAL_HOSTELS`), founding and referral rules |
| `GET /v1/stats/daily?days=7` | Campus totals per local day (active members, runs, verified km, workouts) and mine today |
| `GET /v1/leaderboards/xp?window=daily\|weekly` | Top 10 by XP earned in the window (XP from the Run Module's `/v1/leaderboard/xp`), with names and hostels |
| `GET /v1/leaderboards/hostels?window=` | Hostel vs hostel: the XP of each hostel's members |
| `GET·POST /v1/crews`, `GET /v1/crews/{id}`, `POST …/join`, `DELETE …/membership`, `POST·DELETE …/members/{user}/vouch` | Crews, members since when, vouching between members |
| `GET·POST /v1/events`, `GET·DELETE /v1/events/{id}`, `POST·DELETE …/rsvp`, `POST …/checkin`, `POST /v1/checkins` | Events (open or for a crew, capacity, cancel), RSVPs, reminders an hour before, check-ins that tell up to 5 followers or crewmates |
| `GET·POST /v1/challenges`, `POST …/{id}/accept\|decline\|cancel` | Head-to-head: most verified km or most workouts in 1–30 days |
| `GET /v1/notifications`, `/unread-count`, `POST /v1/notifications/read {ids?}` | The in-app list |
| `POST /v1/notifications/{id}/read` · `POST /v1/notifications/read-all` | Mark one of mine read (someone else's id: 404, same as a missing one) · mark all of mine read; both → `{ unread }` |
| `GET·PATCH /v1/notifications/preferences` | `{ categories: { <category>: { push, in_app, mutable } }, quiet_hours_start, quiet_hours_end, timezone, updated_at }`. PATCH sends only what changes: `categories.<c>.push / in_app` (strict booleans), quiet hours as minutes after local midnight 0–1439 sent together (may wrap midnight; both `null` = off), an IANA `timezone` (default `SOCIAL_COMMUNITY_TIMEZONE`). Categories (CONTRACT §2): `xp, challenges, territory, buddies, workouts, meetups, bubble, crews, ambassador, social, system`; `system` can't be muted (422 `not_mutable`) |
| `POST /v1/admin/announcements {title, body?, route?}` | Admin: a `system.announcement` to every user (in batches of 500, keyed by the announcement id so it never lands twice) → `201 { id, recipients }`; 5 per hour |
| `POST /v1/me/push-tokens`, `DELETE /v1/me/push-tokens/{token}` | Expo push tokens; pushes go through Expo's service after the request commits (`app/services/push.py`) |
| `POST /internal/v1/notifications` | Service token: `{ user_subject, kind, actor_subject?, title?, body?, actor_fallback?, data{}, dedupe_key }` → `{ created, notification_id }` (Social's id; a retry with the same `dedupe_key` returns the same id). **Run Module kinds** `territory_lost / territory_captured / territory_expired`: Social writes the text, so `title` / `body` must be left out. **Campus kinds** `territory.stolen / territory.challenged / territory.defended / zone.claimed / challenge.invitation / challenge.reminder / challenge.updated / event.reminder / meetup.check_in / meetup.invited / meetup.accepted / meetup.declined / meetup.cancelled / activity.verification_complete`: the caller sends `title` (required) and `body`, with `{actor}` where the actor's name goes; Social puts in the display name, or `actor_fallback` (default `Someone`) when there is no actor or Social doesn't know them. When the actor and the recipient are blocked either way, the notification never names them and drops `run_id`, `capture_event_id`, `user_id`, `actor_id` and `actor_subject` from `data`. **Exercise kinds** `partner.request / partner.accepted / shared_workout.invited` (data `code`, `session_id`) `/ shared_workout.finished` (data `session_id`), **Run Module** `xp.level_up` (data `level`, `xp`) and **campus** `bubble.activity` (data `zone_id?`; at most one per user per 6 h) are written by the caller the same way. A tap opens `data.route` when it is a path, otherwise one picked from the kind (`/meetup/{meetup_id}`, `/zone/{zone_id}`, `/invites`, `/events`, `/progress`, `/workout/join/{code}`, `/workout/{session_id}`, `/explore`, …). Delivery follows the recipient's preferences (below) |
| `POST /internal/v1/tasks/ambassador-rewards` | Service token: grant referral rewards still due (held back by the daily limit) and retry XP awards / reversals the Run Module hasn't confirmed → `{ settled }` (a cron) |
| `POST /internal/v1/tasks/event-reminders` | Service token: send due event reminders (a cron, while the free plan sleeps) |
| `POST /internal/v1/tasks/push-receipts` | Service token: `{ receipts_read }` — read the Expo receipts of pushes sent ≥15 min ago now (the service also does it every 5 min); failures are logged with Expo's reason and `DeviceNotRegistered` tokens disabled (a cron, while the free plan sleeps) |
| `POST /internal/v1/people/resolve` | Service token (campus-service): `{ subjects[]≤200, profile_ids[]≤200 }` → `{ people: [{ subject, profile_id, username, display_name, avatar_url, hostel, level }] }`; unseen subjects are provisioned, unknown profile ids omitted, each person once. The only place a subject↔profile mapping leaves Social |
| `GET /internal/v1/blocks/{subject}` | Service token (campus-service): `{ subject, blocked: [subject…], as_of }` — everyone blocked **either way** with that person. Never writes; an unseen subject has none. Callers cache ≤30 s and fail closed (ADR-032) |
| `POST /internal/v1/blocks/import` | Service token: `{ blocks: [{ blocker, blocked }]≤1000 }` (subjects) → `{ imported, already, skipped }`. One-time copy of another service's own block table; safe to re-run; provisions unseen subjects; removes follows between the two, like an app block |
| `POST /internal/v1/crews/memberships` | Service token (campus-service): `{ subjects[]≤200 }` → `{ people: [{ subject, crews: [{ id, name, role, joined_at }] }] }`, oldest membership first (the first is the main crew); request order, each subject once. Never writes; an unseen subject has no crews |
| `POST /internal/v1/crews/lookup` | Service token: `{ crew_ids[]≤200 }` → `{ crews: [{ id, name, interest, scope, hostel, members_count, members: [{ subject, role, joined_at }] }] }`; unknown ids are left out (never a 404) |
| `GET /internal/v1/crews/count` | Service token → `{ crews_total, as_of }`: crews with at least one member, counted from the membership rows (campus-service's stats) |

| GET / POST /v1/ambassador/application | Ambassador applications ("apply" / "status"), settings, and rate-limited form submission. Status `pending / under_review / approved / rejected / suspended` |
| GET /v1/admin/ambassador/applications / POST ./decision | Requires `admin` role: list pending/reviewed applications and approve/reject with notifications. Approving creates the ambassador profile (idempotent) |

**Notification delivery** (`app/services/notify.py`, the only store — other services POST `/internal/v1/notifications`): every kind maps to a category. Per recipient: in-app off → nothing stored; push off, or inside quiet hours → stored without a push; more than 6 pushes of one category in an hour → the rest stored silently (simple batching). `dedupe_key` still makes a notification land once, and nobody is notified of their own action.

### Ambassador programme (migration `0009_notifications_ambassadors`)

An approved application makes an ambassador (`ambassador_profiles`, `active | suspended`). Their referral code is their ordinary waitlist code (`members.referral_code`, claimed with `POST /v1/me/referral`). A referral earns the ambassador **50 XP once** when the friend has claimed the code, verified their email and is *activated* (an activity reached Social via `POST /internal/v1/activities` no later than 30 days after joining) and the ambassador is active. At most 20 referral rewards per ambassador per local day; the rest stay eligible and are granted on a later check. XP is the Run Module's: Social keeps a reward row (`ambassador_rewards`, unique idempotency key `referral:{referredUserId}` / `task:{taskId}:{userId}`) and, after its own commit, calls `POST /internal/v1/xp/award` (`source: social`, reason `ambassador_referral` / `ambassador_task`; service token `SOCIAL_INTERNAL_TOKEN`). A failed call is logged and retried on the next check (≤10 attempts); suspended ambassadors' rewards wait. Reversal calls `POST /internal/v1/xp/reverse`. Verifying your email after claiming a code now counts the referral for the referrer (exactly once).

| Route | What |
|---|---|
| `GET /v1/ambassador/me` | `{ status, approved_at, suspended_at, suspension_reason, referral_code, invite_url, counts{referred, verified, activated, rewarded, referral_xp, task_xp} }`; 404 `not_ambassador` otherwise. Also retries due rewards |
| `GET /v1/ambassador/referrals?cursor=&limit=` | People who joined with my code, newest first: `{ user{id, display_name, avatar_look, avatar_url}, signup_at, verified, activated, reward_eligible, rewarded }` — no usernames, emails or other private data |
| `GET /v1/ambassador/tasks` | Open tasks (active, started, not ended) with my submission `{id, status, submitted_at, reviewed_at}` or `null` |
| `POST /v1/ambassador/tasks/{id}/submit {evidence ≤1000}` | Active ambassadors only (suspended: 403), once per task (409 `already_submitted`), 10 per hour |
| `GET /v1/ambassador/leaderboard?limit=` | Active ambassadors by activated referrals, then task XP |
| `POST /v1/admin/ambassadors/{user_id}/suspend {reason}` · `/reinstate` | Admin: pause / restore (the application follows: `suspended` ↔ `approved`); notifies `ambassador.suspended` |
| `POST /v1/admin/ambassador/tasks {title, description?, xp_reward 1–200, starts_at?, ends_at?, active?}` · `PATCH /v1/admin/ambassador/tasks/{id}` | Admin: tasks (a new active task notifies active ambassadors, `ambassador.task`) |
| `GET /v1/admin/ambassador/submissions?status=` · `POST …/submissions/{id}/decision {status: approved\|rejected}` | Admin: review; approval awards the task's XP once |
| `GET /v1/admin/ambassador/referrals/analytics` | Admin: per ambassador referred / verified / activated / rewarded / referral_xp / task_xp, and totals |
| `GET /v1/admin/ambassador/rewards?user_id=` · `POST /v1/admin/ambassador/rewards/{id}/reverse {reason?}` | Admin: rewards; reversing is idempotent and calls the Run Module's reverse |

**Moving existing blocks into Social (once):** `scripts/import_blocks.py` reads campus-service's `blocks` table (`--campus-db`) and/or a copy of the Exercise backend's `data/users/` folder (`--partner-hunt-dir`, Partner Hunt's `partner_blocks.json` files) and sends them to the import route. Dry run by default; `--apply` sends. The service token comes from `SOCIAL_INTERNAL_TOKEN` in the environment, never the command line. Safe to re-run.

Profiles also carry `hostel`, `stats.month_km / month_runs / month_workouts` (verified this month) and
`crews` (member since, vouches).

### Squirrel Dates and blocking (migration `0004_squirrel_dates`)

Suggestion only: a person, a named campus zone and a time. It never invites or notifies anyone. To
meet, the member plans an ordinary event (`POST /v1/events`), which the app opens pre-filled.

| Route | What |
|---|---|
| `GET·PUT /v1/dates/settings {enabled}` | Opt in or out; off by default. Opting in scans the member's runs of the last 28 days; opting out deletes their zone visits |
| `GET /v1/dates/suggestions[?user_id=]` | Up to 3 suggestions: `{available, enabled, reason, suggestions[{id, user, reason, zone{id,name}, suggested_time}]}`. `available` is false until zones are configured |
| `POST /v1/dates/suggestions/{id}/dismiss` | "Maybe later": that person isn't suggested to you for 30 days (`id` is their user id) |
| `GET·POST·DELETE /v1/users/{id}/block`, `GET /v1/users/me/blocks` | Block. It works both ways: never suggested to each other, follows removed, no new follows or challenges |

Rules (`app/services/dates.py`), all in both directions:
- both members opted in, neither blocked the other, and you didn't dismiss them in the last 30 days;
- both passed the same zone at least twice in the last 28 days, on runs the Run Module finalized.

The zone is the one you share most. The time is the next weekday and hour you both use it most
(else the busiest for either of you), between 6 AM and 9 PM and at least 2 hours ahead.

Zones are configuration, never user data: `SOCIAL_ZONES_FILE` (or inline `SOCIAL_ZONES`), a JSON
list of `{"id", "name", "polygon": [[lat, lng], …]}` or `{"id", "name", "center": [lat, lng],
"radius_m"}`. A run visits a zone when at least 2 of its points fall inside. Bad JSON stops the
service at start-up. Zone visits come from `run_points` when the Run Module publishes a finished run
(`POST /internal/v1/activities`, `source_ref` = run id). If that table isn't there, the run is
recorded without zones.

### Activity badges (migration `0005_activity_badges`)

Awarded automatically (`app/services/badges.py`) when a verified activity arrives
(`POST /internal/v1/activities`, or a finalized run shared to the feed), in the same transaction,
with a `badge` notification. Local times are `SOCIAL_COMMUNITY_TIMEZONE`.

| Badge (`id`) | Rule (defaults) |
|---|---|
| Early Bird (`early_bird`) | 5 verified activities that started from 04:00 to before 07:00 |
| Night Owl (`night_owl`) | 5 verified activities that started from 21:00 to before 04:00 (a 1 AM run is a late night, not an early start) |
| Park Regular (`park_regular`) | One named zone visited on 5 different days, on verified runs. Reads Squirrel Dates' zone visits, so it needs zones configured and the member opted in, and the days must fall within the 56 days visits are kept |

Unverified activities (manual, flagged runs) and meals don't count. Counts are read from the
`activities` and `zone_visits` rows, so a re-sent activity counts once; awarding is idempotent. A
failing rule is logged and skipped, never failing the ingest. The catalogue descriptions state the
defaults (Park Regular's says it needs Squirrel Dates on): change them too if you change a threshold.

`GET /v1/users/me/badges` lists every badge a member can work towards, with progress; founding
badges appear only once held. Badge ids are the app's, with underscores (`founding_squirrel`,
`first_run`…); migration `0006_badge_ids` moved the first, hyphenated ids and their awards.

### Exercise/Run → Activity → optional Post

1. The Run Module finalises a run (unchanged).
2. The app's run summary shows **Share to feed** only for runs the server `finalized` or
   `flagged`, and opens the composer with the `run_id`.
3. `POST /v1/posts { activity: { source: "run", run_id } }`: Social fetches the run with the
   user's own token (the Run Module only returns the caller's runs), refuses rejected or
   still-processing runs, and stores one `activities` row (`source=run_module`,
   `source_ref=run_id`, distance, moving time, `verified = status == finalized`).
4. Sharing again returns 409. Deleting the post keeps the activity, so it can be shared again
   and still counts toward streaks.

Other modules publish with `POST /internal/v1/activities`, and the user shares with
`{ source: "activity", activity_id }`. Nothing in the Social backend changes when a new
module starts publishing.

**Assumption (Run Module):** `GET /v1/runs/:id` only returns runs owned by the token's user.
This matches how the app already uses it, but it must be confirmed against the Run Module.

## Environment

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SOCIAL_DATABASE_URL` | yes (prod) | `sqlite:///./social.db` | `postgresql+psycopg://user:pass@host:5432/db` |
| `SOCIAL_JWT_PUBLIC_KEY` / `SOCIAL_JWT_PUBLIC_KEY_FILE` / `SOCIAL_JWKS_URL` | **one of them** | – | Verifies the account service's RS256 tokens; the service won't start without one |
| `SOCIAL_JWT_ALGORITHMS` | no | `RS256` | |
| `SOCIAL_JWT_ISSUER`, `SOCIAL_JWT_AUDIENCE` | no | – | Checked when set |
| `SOCIAL_RUN_MODULE_URL` (or `RUN_MODULE_URL` / `RUN_API_URL`) | recommended | – | XP sync + run sharing + ambassador XP awards. Unset: XP stays at its last synced value, run sharing returns 503 and ambassador rewards stay pending |
| `SOCIAL_RUN_MODULE_TIMEOUT_S` | no | `4` | |
| `SOCIAL_XP_CACHE_TTL_S` | no | `300` | How old other people's cached XP may be before a list asks the Run Module again (needs `SOCIAL_INTERNAL_TOKEN`, which the Run Module must accept on `/internal/v1/xp/totals`) |
| `SOCIAL_INTERNAL_TOKEN` | for ingestion | – | Service token for `/internal/v1/*` (activities, notifications, event reminders, people resolve, blocks, crews); those endpoints 404 when unset |
| `SOCIAL_XP_PER_LEVEL` | no | `2000` | Must match the app |
| `SOCIAL_STREAK_TIMEZONE` | no | `Asia/Kolkata` | Day boundary for streaks |
| `SOCIAL_MEDIA_BUCKET`, `SOCIAL_MEDIA_REGION`, `SOCIAL_MEDIA_ENDPOINT_URL`, `SOCIAL_MEDIA_PUBLIC_BASE_URL`, `SOCIAL_MEDIA_MAX_BYTES` + standard AWS credentials | for photos | – | S3-compatible storage. Unset bucket: uploads return 503 |
| `SOCIAL_CORS_ORIGINS` | for Expo web | – | Comma-separated browser origins |
| `SOCIAL_RATE_LIMITS` | no | `on` | `off` disables limits (tests/dev only) |
| `SOCIAL_HOSTELS` | for hostel vs hostel | – | Comma-separated hostel names members pick from. Unset: the picker and the hostel board stay hidden |
| `SOCIAL_ZONES_FILE` / `SOCIAL_ZONES` | for Squirrel Dates | – | Named campus zones (JSON, see "Squirrel Dates"). Unset: Dates reports the zones aren't set up and suggests nothing |
| `SOCIAL_APP_URL` | for invite links | – | The web app's address; invite links are `…/sign-in?mode=create&invite=CODE` |
| `SOCIAL_FOUNDING_FIRST`, `SOCIAL_FOUNDING_TOTAL` | no | `15`, `500` | Founding Squirrel / Founding 500 places |
| `SOCIAL_REFERRALS_TO_SKIP` | no | `3` | Verified friends needed to skip the line |
| `SOCIAL_COMMUNITY_TIMEZONE` | no | `Asia/Kolkata` | Local day and month for daily stats and "km this month"; local time for the activity badges |
| `SOCIAL_EARLY_BIRD_FROM_HOUR`, `SOCIAL_EARLY_BIRD_HOUR`, `SOCIAL_EARLY_BIRD_ACTIVITIES` | no | `4`, `7`, `5` | Early Bird: activities started from the first hour to before the second, and how many. Night Owl ends where Early Bird begins |
| `SOCIAL_NIGHT_OWL_HOUR`, `SOCIAL_NIGHT_OWL_ACTIVITIES` | no | `21`, `5` | Night Owl: activities started from this hour to before `SOCIAL_EARLY_BIRD_FROM_HOUR`, and how many |
| `SOCIAL_PARK_REGULAR_DAYS` | no | `5` | Park Regular: different days in the same zone |
| `SOCIAL_PUSH` | no | `on` | `off` stores notifications without sending pushes |
| `EXPO_ACCESS_TOKEN` | no | – | Only when the Expo project requires an access token for pushes |
| `SOCIAL_PUSH_RECEIPTS` | no | `on` | `off` stops the in-process receipt check (`POST /internal/v1/tasks/push-receipts` still runs it) |
| `SOCIAL_EVENT_REMINDERS`, `SOCIAL_EVENT_REMINDER_MINUTES` | no | `on`, `60` | The in-process reminder loop and how long before the start it reminds |
| `SOCIAL_AMBASSADOR_OPEN` | no | `off` | When off, ambassador applications are closed with a default message |
| `SOCIAL_AMBASSADOR_REAPPLY_DAYS` | no | `30` | Days to wait after a rejection before reapplying |

## Run it

```bash
cd social-backend
python3.11 -m venv .venv
.venv/bin/pip install -r requirements.txt

# database (PostgreSQL)
createdb social                                   # or: psql -c 'CREATE DATABASE social'
export SOCIAL_DATABASE_URL=postgresql+psycopg://USER:PASS@localhost:5432/social
.venv/bin/alembic upgrade head                    # run migrations

# local dev keys + a token (the account service doesn't exist yet)
.venv/bin/python scripts/dev_token.py init
export SOCIAL_JWT_PUBLIC_KEY_FILE=dev-keys/public.pem
.venv/bin/python scripts/dev_token.py token aanya # paste into the app: Sign in → "Developer: paste a backend token"

# serve
export SOCIAL_RUN_MODULE_URL=https://…            # optional: XP + run sharing
export SOCIAL_CORS_ORIGINS=http://localhost:8081  # only for Expo web
.venv/bin/uvicorn app.main:app --reload --port 8100
```

Docker: `docker build -t squirrel-social . && docker run -p 8100:8100 --env-file .env squirrel-social`
(the image runs `alembic upgrade head` before starting).

### Tests

```bash
.venv/bin/python -m pytest -q                                   # SQLite, via the real migrations
SOCIAL_TEST_DATABASE_URL=postgresql+psycopg://USER:PASS@localhost:5432/social_test \
  .venv/bin/python -m pytest -q                                 # same suite on PostgreSQL (+ concurrency test)
```

`TEST_DATABASE_URL` (the name campus-service and Exercise use) is **not** read here: set on its own,
it stops the run with an error rather than letting the suite quietly test SQLite.

The Run Module and object storage are replaced by in-process doubles in tests. Everything else
is the real code path: HTTP, JWT verification, SQL and migrations.
