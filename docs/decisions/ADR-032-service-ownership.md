# ADR-032: Which service owns each shared concept

| Field          | Value                                             |
|---------------|---------------------------------------------------|
| **Status**     | Accepted (table); open items listed at the end    |
| **Date**       | 2026-10-01                                        |
| **Scope**      | Exercise, Social, Run Module, campus-service, app |
| **Supersedes** | —                                                 |

## Context

An audit found users, crews, challenges, leaderboards and blocking each implemented in two or three
backends with separate databases, and no rule for which copy is the truth. The concrete harm so far:
blocks don't share state, so a person blocked in the app (Social) can still see you on the campus map,
in Nearby and in shared zones, and invite you to a meetup (campus-service checks only its own table).

Every new feature names its owner from this table before it is built. A service that needs a concept
it doesn't own **asks the owner** (service-to-service, internal token) and keeps at most a short-lived
cache — never its own editable copy.

Users are identified everywhere by the login `sub` (the Exercise account id). The app only ever sees
Social profile ids; services translate through Social (`POST /internal/v1/people/resolve`).

## Ownership

| Concept | Owner | Everyone else |
|---|---|---|
| Accounts, sign-in, tokens (email, codes, refresh, RS256 keys) | **Exercise** | Store only `sub`. Verify tokens with the public key / JWKS. |
| Public profile: name, username, avatar, hostel, bio | **Social** | Read through Social (campus-service already does). No own copy. |
| Private personal details: age/date of birth, gender, phone, height, weight, course, CGPA, emails | **Exercise** (decided — see open item 1) | campus-service's `user_profile_details` (004) stops being served and is dropped. |
| Blocking | **Social** (`user_blocks`) | campus-service and Exercise (Partner Hunt) ask Social; their tables are migrated and removed. Checks **fail closed** (see below). |
| Crews (membership, vouching, crew events) | **Social** | campus-service reads membership from Social for crew territory (weekend war) via `POST /internal/v1/crews/memberships` and `/crews/lookup`; its `crews` tables are retired. |
| XP — the one ledger, levels | **Run Module** (XP engine) | campus-service reports claim / steal / defend awards to the Run Module; it and Social keep only a read cache of the total (see **XP reads**). |
| Leaderboards | **The owner of the number**: XP and hostel boards from the Run Module (Social shows them); "zones held" boards from campus-service | No board recomputes another service's number. |
| Progress (XP history, daily rollups) | **Run Module** — absorbs the 8 endpoints the app calls on the planned progress-service | No separate progress-service is built. |
| Named zones, territory, GPS verification, map, presence, Active now, Open to Meet, heatmap, shared zones, meetups (+ post-meetup rating), Discover, Bubble | **campus-service** | Discover and Bubble read people from campus presence, names from Social and blocks from Social; neither stores coordinates. |
| Runs, GPS route points, run territory polygons | **Run Module** | campus-service receives a one-shot copy of a run's points for zone eligibility only. |
| Workouts, rep counting, coaching, Partner Hunt | **Exercise** | — |
| Feed, posts, follows, notifications (incl. preferences and quiet hours), events, waitlist/referrals, Squirrel Dates, badges (incl. rules: Early Bird, Night Owl, Park Regular), ambassador programme (applications, referrals, tasks) | **Social** | Other services send notifications through `POST /internal/v1/notifications`; XP from the ambassador programme is reported to the Run Module. |
| Shared workouts ("workout with a partner") | **Exercise** (decided — see open item 3) | Blocks from Social; names and profile ids through Social's `people/resolve`. |

### "Challenges" is three features

They share a name, not a model. Each stays with its owner under its own name; the app may list them
together.

| Name | What | Owner |
|---|---|---|
| **Duels** | 1-vs-1: most verified km or most workouts in 1–30 days | Social (`social_challenges`) |
| **Goals** | A target (metric, comparator, threshold, window) with an XP reward | Run Module (`challenges`) |
| **Territory battles** | Zone race, territory, weekend war — the winner decided from territory state | campus-service (`challenges`) |

## Blocking contract

- Social exposes a dedicated internal route (not part of `people/resolve`): blocks must be fresh, have
  no side effects, and fail closed, while names may be minutes stale and fail open to a placeholder.
- `GET /internal/v1/blocks/{sub}` (service token) → `{ subject, blocked: [sub…], as_of }`: the full set of
  people blocked **in either direction** for one user. It never writes; a `sub` Social hasn't seen has
  none.
- Callers cache for at most 30 seconds. When Social can't be reached and no fresh answer is cached, the
  check **fails closed**: lists that filter people (Nearby, Active now, map players, shared zones) are
  returned empty with a reason, and actions between two people (meetup invite, challenge) are refused
  with a retryable 503. Fewer people shown, never a blocked person shown.
- During migration campus-service honours the union of Social's answer and its own `blocks` table;
  existing campus and Partner Hunt blocks are copied into Social once with
  `POST /internal/v1/blocks/import` (`{ blocks: [{ blocker, blocked }] }` by `sub`, safe to re-run),
  then the local tables are dropped. Order for campus (WI-07): (1) run
  `social-backend/scripts/import_blocks.py --social-url https://<social> --campus-db … --apply`; (2) set `LEGACY_LOCAL_BLOCKS=0` on
  squirrel-campus and squirrel-campus-worker, so only Social decides (an unblock in the app is no
  longer overridden by a stale local row, and the local block routes answer 410 `blocks_moved`);
  (3) after a release, move `migrations/pending/drop_local_blocks.sql` into `migrations/`.
- campus-service checks blocks wherever two people meet: meetups and their notifications, shared zones,
  Nearby, Active now, map players, a person's context, and territory battles.

## XP reads

The Run Module is the only XP ledger: it derives a person's total on read from `activity_sessions`,
`challenge_participants` and `external_xp_awards` (awards reported by other services, unique on
`(source, idempotency_key)`). Other services may keep a **read cache** of the total, to show level in
lists without one call per person. A cache is not a second ledger as long as:

1. **It is written only from the Run Module's answer.** An award call returns the new total, which the
   cache stores; nothing increments a cached number locally.
2. **It refreshes in batches.** `POST /internal/v1/xp/totals { subjects[] ≤200 }` (the shared
   `SOCIAL_INTERNAL_TOKEN`, like every service's `/internal` routes: only Exercise can sign service JWTs) on the
   Run Module returns `{ subject: total }`; a service refreshes stale rows in one call while serving a
   list. XP is display only, so when the Run Module is unreachable the last cached value is shown
   (fail open, unlike blocks).
3. **Its name says what it is:** `xp_total` with `xp_synced_at` (campus-service's `campus_xp`, which today
   counts only campus-earned XP, becomes this cache; levels shown on the map change once at the switch).
4. **Every cache refreshes the same way.** Social's `user_stats.xp` (profiles, top bar, Squirrel Dates)
   and campus-service's cache (map, Nearby) both refresh from the batch route with the same TTL
   (5 minutes, as the name cache), so one person's level doesn't differ by screen.

Order: Run Module (awards table, totals, intake, batch route) → campus-service cache → Social refresh.

## Order

1. Blocking (safety).
2. Private personal details: one home, campus-service's copy migrated and removed.
3. One XP ledger (with the progress-service endpoints moving into the Run Module).
4. Crews read from Social.
5. Challenges renamed in docs and app labels.

For each, the owner's side ships first; the consumer's side follows.

## Open items

1. **Private details owner.** Decided: **Exercise**. It owns the account and already held date of
   birth (age), gender, phone, height and weight from sign-up; it now also stores personal email,
   course and CGPA (`user_personal_details`, Exercise migration 006). The app's "About you" form is
   `GET /api/me/profile-details` and `PUT /api/me/profile-details` on Exercise (signed-in user from
   the token; the body is the app's `ProfileDetails` unchanged). Each field has one source there:
   `full_name` is first + last name, `phone` the mobile, `age` derived from the date of birth and
   `college_email` the sign-in address (both read-only), so nothing is copied. Field rules are in
   the Exercise README's "About you" section. Status (verified 2026-10-08):
   - **App: done.** Onboarding reads and saves "About you" through `api/profileDetails.ts` on Exercise.
   - **campus-service: code done.** `PATCH /v1/me` rejects `profile_details` with 422 and the last code
     that read or wrote the table (`src/users/details.ts`, unreferenced) was removed. Remaining: an
     operator confirms `SELECT count(*) FROM user_profile_details` is 0 on production, then moves
     `migrations/pending/007_drop_profile_details.sql` into `migrations/`.
2. **Ambassador applications — decided: Social; reviewer unassigned.** Social serves
   `GET`/`POST /v1/ambassador/application`, where the app already sends them (it needs no code change).
   One open application per person, approved is final, and a rejected applicant may apply again after
   30 days (`SOCIAL_AMBASSADOR_REAPPLY_DAYS`). Admins (`users.role = 'admin'`) decide through
   `/v1/admin/ambassador/applications`; there is no screen, so a reviewer uses those routes directly
   (a screen would be app work).
   **No reviewer has been named, so `SOCIAL_AMBASSADOR_OPEN` stays off**: Social answers the form as
   closed and refuses submissions. Don't switch it on until a person is named, given the admin role,
   and has agreed how quickly applicants hear back; otherwise applications sit unanswered. That is a
   company decision.
3. **Shared workouts — decided: Exercise.** Exercise serves them under `/api/workout-sessions`
   (create, get, invite preview, join, ready, reps, complete, leave) with a per-session socket,
   `WS /ws/workout-sessions/{id}`; the app's 2-second polling stays as the fallback. The app's
   `/v1/workout-sessions` routes were written before any backend existed and are replaced; the app
   moves from `CAMPUS_API_URL` to `EXPO_PUBLIC_EXERCISE_API_URL`. The contract:
   - A race lasts a fixed 1, 3 or 5 minutes, chosen at creation. When both players are ready the
     server sets `starts_at = now + 3 s` and `ends_at = starts_at + duration`; there is no client
     "start" call. The phase (`lobby`, `expired`, `countdown`, `racing`, `finished`) is never stored:
     it is worked out from timestamps on every read. Each player has their own `finished_at` and
     `left_at`.
   - Reps are hand-tapped in this version, sent as `{ reps, seq }`; the highest `seq` wins (retries
     and undo). Reports count until 5 seconds after `ends_at`.
   - **Finishing earns a flat 20 XP, not reps** (ADR-033; amended from "no XP"): settlement happens
     once, server-side, and each player who finished (not left) with at least one rep gets one
     `exercise/shared_workout_finished` award of 20, at most 3 a day. The rep count itself still earns
     nothing and nothing is written to `activity_sessions`. The host may also invite a buddy (an accepted
     Partner Hunt connection), and cancel the lobby before the countdown; there is no pause.
   - Joining (and previewing an invite) is refused if either player has blocked the other, by
     Social's block list, and refused when Social can't be checked (as Partner Hunt does). Blocks
     are checked again when a player readies up: a blocked pair's lobby closes quietly for both. A
     race in progress is not cut short; it is bounded at five minutes.
   - An unstarted lobby expires after 10 minutes. Leaving before the start frees the leaver's seat
     (the lobby closes only when everyone has left); from the countdown on, leaving or about 30
     seconds disconnected ends that player's race only.
   Details: the Exercise README, "Workout with Partner". No service in this repository serves
   `/v1/shared-workouts`, so nothing else is retired.
4. **Push-up demo in the browser coach** predates sign-in: with sign-in required it cannot create an
   account (password, allowed email domain, token on later calls). Needs a decision: sign in first, or
   a guest mode.

## Note: switched-off app features that turned out to have backends

The app (mobile-4) switches off each capability it believes has no backend
(`src/api/availability.ts`) and shows "not live yet" instead. Several turned out to be served
already, by the owner this ADR names. State as of 2026-10-08 (re-checked end to end: route, app call, capability, entry screen):

| Feature | Served by | State |
|---|---|---|
| Meetups | campus-service: `POST /v1/meetups`, `GET /v1/meetups[/{id}]`, `POST /v1/meetups/{id}/accept · decline · cancel · leave` | **On and reachable.** Map → zone → "Enter territory" → `zone/[id]` "Plan a meetup here" → `meetup/new` creates it; `meetup/[id]` answers, leaves and cancels; Profile → "Meetups & check-in" lists them; meetup notifications open `/meetup/{id}`. A guest who checks in without tapping Accept now confirms the meetup too (it used to stay `proposed` and could never be rated). |
| Meetup ratings | campus-service: `GET /v1/meetups/{id}/rating`, `POST /v1/meetups/{id}/ratings` | **On and reachable** from a completed meetup, when the map runs on campus-service. |
| Photo uploads | Social: `POST /v1/media/uploads`, `POST /v1/media/{id}/complete` | **On.** Three app-side mismatches kept uploads from ever working (a moderation poll Social has no route for, a `meetup` purpose Social refuses, an unknown `context` field); fixed in the app. Social takes post and avatar photos only. |
| Ambassador applications | Social: `GET`/`POST /v1/ambassador/application` | **On in the app, closed in Social.** `SOCIAL_AMBASSADOR_OPEN` stays off until a reviewer is named (open item 2), so the form shows as closed and submissions are refused. |
| "About you" (private details) | Exercise: `GET`/`PUT /api/me/profile-details` | **On.** Onboarding calls Exercise directly (ungated). The app's `profileDetails` capability only gates the retired `PATCH /v1/me` `profile_details` field and stays off. |
| Meetup check-in | campus-service: `POST /v1/meetups/{id}/check-in` | **On and reachable** from `meetup/[id]` (1 h before to 6 h after the start), when the map runs on campus-service. Once at least two participants have checked in, each checked-in participant gets `meetup_checkin` XP, once per person per meetup; a lone check-in earns nothing. |

Lesson: before building a "missing" backend, search every service for the route. Before switching a
capability on, compare the app's requests and responses with the server's, field by field.

And reachable is not the same as routed. A feature can have a working backend, a route the app calls
and a capability switched on, and still be unreachable, because nothing creates the thing it acts on
(meetups above). Checking that the route exists is not checking that a user can arrive at it: follow
the path from a screen a user can open to the record the feature needs, and confirm something on
that path creates it.
