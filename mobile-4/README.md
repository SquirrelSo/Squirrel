# Squirrel Social — mobile app

A social-fitness app with a neon-city feel. Track runs, complete missions, earn XP, level up, unlock cosmetics, join crews and events, and build a fitness identity with your friends.

Built with Expo SDK 57, React Native 0.86, Expo Router and TypeScript. It runs on iOS, Android and the web from one codebase.

## Run it

```bash
cd mobile-4
npm install
npx expo start          # i = iOS simulator, a = Android, w = web, or scan the QR code with Expo Go
```

Other commands:

```bash
npm run typecheck       # tsc --noEmit
npx expo start --web    # browser preview at phone size
```

With no backend URLs (`.env.example`) every screen shows an honest *Not connected* / *Not live yet* state — there is no demo or sample data and no mock backend in any build. Live workouts (camera pose tracking in a WebView) and push notifications need a development build (`npx expo run:ios|android` or EAS); the web build works in the browser.

## Screens

| Route | Screen |
|---|---|
| `/sign-in` | **Join / sign in with a .ac.in email** (one-time code), demo mode; password and developer token under “Other options”. New accounts go to onboarding |
| `/onboarding` | Wingman intro → **What are you looking for? Date / Friends / Crew** → hostel → Open to Meet → saved to the profile (`PATCH /v1/me`) |
| `/territory` | Redirects to the campus map |
| `/zone/[id]` | One zone: map, owner, territory status, stats, history, and **Claim / Steal / Defend** only where the backend allows |
| `/challenges` | Daily, head-to-head and group challenges (auto-resolve) |
| `/exercise/select` | **Start Exercise** picker (opened from Home). Lists the Exercise backend's catalog (`GET /api/exercises`) with plan, time and estimated calories; Start creates a real session (`POST /api/users/{id}/sessions`) |
| `/exercise/train/[key]` | Active exercise: the backend plan (sets × reps/seconds, rest). Tap each rep, or a real countdown for timed sets; camera mirror; pause/finish. Completion updates missions, XP and Home's Active/kcal rings |
| `/exercise`, `/exercise/profile`, `/exercise/plan/[key]`, `/exercise/session/[id]` | Form Coach hub, coach profile, custom plan, session report (Exercise backend) |
| `/partner-hunt/*` | **Partner Hunt** (locked · Coming soon): "Find your workout buddy". Card on the Social tab; every route (index, preferences, matching, buddy/[id], connect/[id]) shows the locked preview while `LOCKED.partnerHunt` is on |
| `/leaderboard` | **Leaderboards**: Top 10 squirrels (XP, zones held, distance) and **Hostel vs Hostel** (score, territories, activity), daily / weekly / all-time |
| `/welcome` | **Live at IISER Kolkata**: IISER-only messaging, `.ac.in` CTA, live user / zone / crew counters (from the backend), campus map visual, Founding Squirrel |
| `/avatar` | **Make It You**: body, hair, outfit, shoes, accessories, gear, emotes and pet mascot |
| `/home` *(tab)* | Top bar, greeting, activity rings, Start Exercise, Start Run, missions, **your territory** (under-attack alerts), **Active now**, Friend Mode / Challenges shortcuts, today's top squirrels, campus events, crew activity |
| `/explore` *(Map tab)* | **Squirrel Social Map**: full-screen game world (terrain, roads, buildings, POIs), territories by status (neutral / controlled / contested / under attack), your avatar marker, nearby Squirrels with clustering, player / territory / POI sheets, nearby list with search, Poke from any card |
| **＋** *(tab)* | Create menu: start run, post, log workout; log water, log a meal and find an event are locked (coming soon) |
| `/social` *(tab)* | Stories, For You / Following / Nearby feed, **Squirrels near you** (with Poke), suggested people, crews teaser |
| `/profile` *(tab)* | **Campus profile**: photo, name, bio, connection mode, Founding Squirrel, Open to Meet toggle, activity stats (distance, month, zones, defended, stolen, crews, events, streak), territory, crews, badges, activity history, verification. (The offline demo profile when the campus backend is off.) |
| `/edit-profile` | Name, bio, connection mode, hostel |
| `/run` | **Run / Walk**: pick activity, permission handling, live GPS route on the campus map, distance/duration/pace, pause, finish or discard; summary with route, **zones interacted with / eligible**, and the backend-allowed claim action. Upload retry on network failure |
| `/missions` | Daily / Weekly / Special missions with completion and claim states |
| `/progress` | **Your Progress**, in four sections:<br>• **Today:** goal ring, today's XP, activities done, XP left, run XP, streak and a level bar.<br>• **Progress:** Day/Week/Month/Year with Steps/Active/Calories/Workouts, a tap-to-read bar chart and the streak calendar with active days.<br>• **Your performance:** change vs the previous period, campus rank and milestones in reach.<br>• **Next:** the best next action (claim, run, or log a mission). |
| `/crews`, `/crew/[id]`, `/crew/new` | Discover / my crews with search, crew profile (members, crew territory, upcoming events), join / leave, create (when the backend allows) |
| `/events`, `/event/[id]` | Upcoming / going; details with date, place, participants, type, territory-challenge info, RSVP / cancel RSVP |
| `/friends` | **Friend Mode**: activity-based suggestions, shared zones/crews, backend icebreakers, challenge invite |
| `/date` | **Date Mode** behind the backend safety gate; when open: toggle, activity-first profiles, suggested plans, icebreakers |
| `/active` | **Active now** + **Squirrels near you** (coarse proximity only) with the Open to Meet toggle |
| `/invites`, `/invite/new` | **Challenge invites**: incoming / sent, accept · decline · cancel; create (type, person or crew, zone, time, message) |
| `/meetups`, `/meetup/[id]` | Upcoming meetups; **check in**, attendees, optional safety-contact notification (shown as sent only when the API confirms) |
| `/badges` | Badges: unlocked, locked, progress |
| `/level-up` | RPG level-up reveal: rays, mascot, XP bar, staggered reward cards, next unlock |
| `/rewards` | Level road, achievement badges, sticker collection |
| `/shop`, `/item/[id]` | Shop (20+ items, rarities, level locks) and item sheet (buy / equip) |
| `/compose` | Post composer: backdrop, sticker and activity (pre-filled after a run) |
| `/post/[id]` | Post with comments |
| `/highlight/[id]` | Full-screen story viewer for profile highlights |
| `/user/[id]` | Anyone's campus profile: shared context, icebreakers, Challenge |
| `/city` | City picker |
| `/shared`, `/shared/[id]` | **Shared zones**: everyone you share ground with; “You’ve both been here” with one person (zone-level only) |
| `/ambassador` | **Become a Squirrel ambassador**: backend-defined form, then application status |
| `/notifications` | **Pokes & friends** (Poke Back inline) and campus notifications from the backend; demo list when the campus backend is off |

## Not launched yet (locked)

`src/data/features.ts` holds the launch switches (`LOCKED`, `COMING_SOON`, `isLocked`). UI reads them through `components/Locked.tsx`: `useLocks()` (`locked`, `notify`, `guard`) and `<FeatureGate feature fallback>`. Lock-aware components (e.g. `EventCard`) handle their own locked state, so no screen can render an interactive locked card. While a flag is on, the feature stays visible as **Coming soon** but can't be used. Every entry point is blocked: buttons, routes and the `AppState` actions.
- `LOCKED.mealWater`: Log water / Log a meal (Create sheet), the water and meal daily missions, and the Hydro Homie badge.
- `LOCKED.stories`: story bubbles on Social show a "Coming soon" toast and open the profile. Posting your own story via the composer still works.
- `LOCKED.partnerHunt`: the Social tab card and every `/partner-hunt` route (the layout renders the locked preview). The future flow and model (preferences by campus, interests, activities, availability and goals; buddy profile; connection status) are in `data/partnerHunt.ts`. There is no matching logic and no buddy data yet.
- `LOCKED.events` is **on** (not launching yet):
  - `/events` and `/event/[id]` render the Coming Soon screen, deep links included.
  - Home hides "Happening on campus" and its Study Break Walk card.
  - Event rows (Crew, Home, Events) and event notifications show the "Events are coming soon" toast.
  - `StudyBreakCard` renders nothing while locked, so JOIN WALK can't be pressed anywhere.
  - Meetups doesn't offer "Browse events". The Create sheet's "Find an event" was already gated.

Locked missions are listed last and left out of the done/XP counters and claimable rewards. Set a flag to `false` at launch.

**Campus, not city.** Each city in `data/cities.ts` has a `campus`, and the leaderboard ranks students on that campus. The Run Module's leaderboard API only offers `scope=global` today, so signed-in rows are labelled as all runners until a campus scope exists.

## Backends today (what is live)

The campus contract below is served by the Social service through an adapter
(`src/api/campus/social.ts`) until a dedicated campus backend exists:

| Live (real data) | Source |
|---|---|
| Profile, name, bio, hostel, founding badge, month km | Social `/v1/users/me/profile`, `/v1/me/membership` |
| Hostels in onboarding and Edit profile | Social `/v1/community/config` (`SOCIAL_HOSTELS`) |
| Crews: list, search, create, join, leave | Social `/v1/crews` |
| Events and RSVP (screens still locked by `LOCKED.events`) | Social `/v1/events` |
| Challenge invites = 7-day distance / workout duels | Social `/v1/challenges` |
| Squirrels board (daily, weekly) and Hostel vs Hostel | Social `/v1/leaderboards/xp`, `/hostels` |
| Notifications (and push on phones) | Social `/v1/notifications`, Expo push |
| Invite friends: code, place in line, "invite 3 to skip the line" | Social `/v1/me/membership`, `/v1/me/referral` (`/referral`) |
| People search and suggestions | Social `/v1/users/search`, `/suggestions` |
| Runs, run XP, XP total | Run Module `/v1/runs`, `/v1/users/me/xp` |
| Exercises: catalog, sessions, camera coaching, reports | Exercise backend `/api/...` |
| "Moving right now" counter | Run Module `/v1/live` + Exercise `/api/live` |

**campus-service (the map world).** Set `EXPO_PUBLIC_CAMPUS_SERVICE_URL` (the `campus-service/` backend,
routes under `/v1`) next to the Social URL and the campus API splits by feature
(`src/api/campus/campusShapes.ts` → `makeHybridCampusApi`, REST in `campusService.ts`):

| campus-service | Social (unchanged) |
|---|---|
| `zones`, `territories`, `zone`, `territoryAction` (claim / steal / defend) | profiles, `me` / `updateMe`, badges |
| `submitActivity`, `activityZones` (run → zone eligibility) | crews, events, meetups |
| `mapFeatures`, `nearbyPlayers`, `updatePresence` | challenges / invites, leaderboards |
| `activeNow`, `setOpenToMeet`, `sharedContext` | notifications, people search / suggestions, pokes, friends |
| `sharedZones`, `heatmap` (7-day window) — no longer gated | Squirrel Dates, blocking, media, `zonePlayers` (no campus route yet) |
| `config`: `realtime_url`, `features.defend` / `open_to_meet`; `stats`: `zones_total` / `zones_claimed`; `me.open_to_meet` | the rest of `config`, `stats` and `me` (Social's values if campus-service is down) |

User ids are the same on both (campus-service returns Social profile ids and names). Shapes that
differ are adapted in `campusShapes.ts` (map features GeoJSON → `MapFeatures` with an empty base map and
`zones`; heatmap cells; shared zones by person; Active-now cards; `hidden_reason` codes → text).
After a GPS run the Run Module upload happens as before; then the same points go one-shot to
`POST /v1/activities` and the zones panel reads `GET /v1/activities/{id}/zones`, re-checking a few
times while verification is `processing`. campus-service refuses a whole upload for one fix it can't
accept (a jump over 30 m/s, a point outside the campus area it announces in `/v1/config`), so those
fixes are dropped before uploading (`pointsForCampus`); a run that never enters campus says so. A campus
error only shows in the zones panel. If `EXPO_PUBLIC_CAMPUS_SERVICE_URL` is set but can't be used (no
Social URL, or a dedicated `EXPO_PUBLIC_CAMPUS_API_URL`) the console says why. Hostel pickers
use Social's hostel list (the profile lives there). For the web build, allow the app's origin in
campus-service's `CORS_ORIGINS`. Unset: everything behaves exactly as before.

**Approximate zones.** Zones whose `geometry_source` is `dev_placeholder` (unsurveyed outlines; the dev
mock's zones too) are drawn with a dotted outline, a lighter fill and an `≈ APPROXIMATE` label, and the
zone screen / map sheet say "Approximate outline — not surveyed yet". Claiming still works.

**Not live yet** without campus-service (the screens say so, never invented data): named zones and claim / steal / defend,
the campus map's base layer and players, presence, pokes and friends, Open to Meet, Active-now
people, Date Mode, meetups, all-time boards, and the capabilities in `src/api/availability.ts`. Connection mode and "onboarding done" are kept
on the device until the Social service has fields for them.

## Campus social (IISER Kolkata launch)

The IISER-first social layer: **Move → Discover people → Claim territory → Join crews → Meet IRL**.

**Where the data comes from** (`src/api/campus/`):

| Source | When | What the screens show |
|---|---|---|
| `live` — `http.ts` | `EXPO_PUBLIC_CAMPUS_API_URL` (or `EXPO_PUBLIC_API_URL`) is set | The backend's data, with the shared bearer token |
| `off` | No campus URL (any build) | “Not live yet” states — never invented numbers |

Screens only import `campusApi` (typed contract in `types.ts`); no component calls `fetch`. The source is chosen in one place, `api/campus/index.ts`; if the backend's shapes differ, adapt `http.ts`. Routes the app calls:

```
GET  /v1/config                      GET  /v1/campus/stats
GET  /v1/me   PATCH /v1/me           PUT  /v1/me/open-to-meet     GET /v1/me/badges
GET  /v1/users/{id}                  GET  /v1/users/{id}/context   (shared zones/crews + icebreakers)
GET  /v1/zones                       GET  /v1/territories          GET /v1/zones/{id}
POST /v1/zones/{id}/claim | steal | defend   { idempotency_key }
GET  /v1/runs/{run_id}/zones         (zones a verified run interacted with + current eligibility)
GET  /v1/crews  POST /v1/crews       GET  /v1/crews/{id}           POST /v1/crews/{id}/join | leave
GET  /v1/events                      GET  /v1/events/{id}          PUT | DELETE /v1/events/{id}/rsvp
GET  /v1/people/suggested?mode=friends|date                        GET /v1/people/active
GET  /v1/challenge-invites/types     GET | POST /v1/challenge-invites   POST /v1/challenge-invites/{id}/accept | decline | cancel
GET  /v1/leaderboards/squirrels?period=&limit=                     GET /v1/leaderboards/hostels?period=
GET  /v1/meetups                     GET  /v1/meetups/{id}         POST /v1/meetups/{id}/check-in { notify_safety_contact }
WS   realtime_url  →  territory.updated · stats.updated · invite.updated · event.updated · active.updated
```

**Territory model.** RUN (a GPS route, owned by the Run Module) ≠ ZONE (a fixed named area) ≠ TERRITORY (who owns a zone). A run *interacts* with zones; the backend decides eligibility; the user claims, steals or defends. Nothing in the app claims a zone because a route crossed it. Claim/steal/defend buttons appear only when the zone's `actions.*.allowed` says so (otherwise the backend's `reason` is shown), every attempt sends an idempotency key, has loading / success / failure states, and the returned territory replaces local state.

**Live updates and performance.** `state/territoryStore.ts` keeps one territory per zone (highest `version` wins). Each map polygon subscribes to its own zone, so one ownership change repaints one polygon. Pan/zoom is an `Animated` transform (no SVG re-render). Updates arrive over the WebSocket when configured; otherwise screens refresh on focus (at most once a minute) — no tight polling.

**Privacy.** The app never shows another person's exact location or route: the Map draws only the approximate, backend-snapped positions it is given, Active Now uses coarse proximity buckets, and only your own route is drawn. Nearby people are shown only while you're Open to Meet. No secrets in `EXPO_PUBLIC_*`.

**Sign-in.** One account for every backend, on the Exercise backend: `POST /api/auth/email/start {email}` emails a 6-digit code to a .ac.in address (`new_account` says whether it has an account yet), and `POST /api/auth/email/verify {email, code, first_name?, last_name?}` returns tokens (a new address needs a first name and becomes a verified account with no password). Access tokens last 15 minutes and are refreshed with the single-use refresh token (`api/client.ts`). Password sign-in stays under “Other sign-in options” for older accounts. There is no simulated sign-in code: without the account service, codes can't be sent.

**Date Mode** unlocks only when `GET /v1/config` reports `features.date_mode.available`; the requirements list comes from the backend.

## Map & Poke → Poke Back → Friends

The Map is the main way to discover people: see who's around → tap them → **POKE 👋**. When they poke back you're **FRIENDS 🎉**. The backend decides everything that matters: who appears on the map and roughly where, whether a poke is allowed, reciprocity, friendship and territory ownership. The app only displays it.

**Routes** (added to `http.ts`):

```
GET  /v1/map/features               roads, paths, buildings, terrain, POIs (static base map)
GET  /v1/map/players                → { players[], as_of, visible, hidden_reason }  approximate positions only
GET  /v1/zones/{id}/players         GET /v1/people/search?q=
PUT  /v1/map/presence               { lat, lng, accuracy_m }  your own location, throttled (≥ 60 s or ≥ 40 m)
GET  /v1/pokes/status/{user_id}     → { state: none | poked | poked_you | friends, can_poke, reason }
POST /v1/pokes                      { to_user_id, idempotency_key, reply? }  → { relationship, friendship_created, friend }
GET  /v1/pokes/incoming             GET /v1/friends/status/{user_id}
GET  /v1/notifications              POST /v1/notifications/read { ids }
WS   poke.received · relationship.updated · friendship.created · notification.created · players.updated
```

Service functions: `api/campus/map.ts` (getMapData, getNearbyUsers, getTerritories, getUserLocation…) and `api/campus/poke.ts` (getPokeStatus, sendPoke, pokeBack, getIncomingPokes, getFriendshipStatus, notifications).

**State.** It uses the same `useSyncExternalStore` pattern as the territory store, with no new state library:
- `state/socialStore.ts` holds one relationship per user, so a poke re-renders one button, not the map. It also holds the celebration queue and the unread count.
- `state/locationStore.ts` runs one ref-counted GPS watch (only while the Map is focused) and reports presence on a throttle.

**Poke rules in the UI:**
- **POKE** is optimistic (it shows POKED at once) and rolls back if the request fails.
- **POKE BACK** waits for the backend.
- **FRIENDS** and the celebration appear only when the backend confirms it, through `friendship_created`, a realtime `friendship.created`, or a later players list that reports the change.
- A list response never undoes a poke you made while that request was in flight.

**Map rendering** (`components/map/`):
- The base layer is a memoised SVG. Pan and zoom run as a native-driver `Animated` transform, and markers counter-scale so they stay the same size on screen.
- Players are clustered on a screen-space grid, recalculated when a gesture ends. Tapping a cluster zooms in; at maximum zoom it lists the people in it.
- Location updates re-render only the "you" marker and the header.

**Reusable components:**
- `PokeButton`, `NearbyUserCard` and `NearbySquirrels` (in `components/social/`). Poke notifications render inline in `app/notifications.tsx`.
- `SocialHost`, mounted in the root layout, routes realtime events and shows the "You're friends" celebration.

**States:**
- Loading shows the mascot and a scan line.
- An empty map shows “Nobody nearby yet. Your next Squirrel might be closer than you think.”
- If location is off, denied or unavailable, a banner offers Allow or Settings.
- A network failure keeps the last map and markers, with a Retry banner.
- Only one banner is shown at a time, the most important first.

With no GPS (e.g. a desktop browser) there is no position at all — no simulated location. Without a live campus world the map draws the hand-drawn, approximate IISER Kolkata base map (`api/campus/campusBaseMap.ts`): geometry only, no people or owners.

## Light & dark themes

- **Two complete palettes** live in `src/theme.ts`:
  - **Dark** is the original night-campus identity.
  - **Light** is its daytime twin: warm paper canvas, white cards, near-black ink, and deeper lime and pink for text and icons so they stay readable. Filled CTAs keep the neon lime (`primaryFill`) with an ink outline.
- **Theme-aware tokens:** `panel`, `backdrop` and `mapColors` (the campus map's base layer), plus `alpha(color, a)` for tints and `statusBarStyle`.
- **Artwork stays as it is** (scenes, the title screen, the camera and story views), and so does text drawn over it (`onImage`).
- **Switching:** Profile → More → **Appearance** (Dark / Light).
  - The choice is saved on the device: SecureStore on phones (read synchronously at start-up), localStorage on web.
  - The app then reloads once (`reloadAppAsync`, or `location.reload` on web), so every screen, sheet and module-level style is rebuilt with the new palette. On web you return to Profile; on phones the app restarts at Home.
- **No hardcoded colours:** every colour in `app/` and `components/` goes through tokens, except imagery-bound overlays, which are dark on purpose.

## Profile building (onboarding → About you)

- **Step 1 of the existing onboarding** collects the profile details:
  - **Required:** full name, personal email, college email (must match the campus domain from `/v1/config`), phone (+91, normalised to E.164), gender, age (16–99) and course (from `campus.courses` if the backend sends them, otherwise common programmes, plus "Other").
  - **Optional:** CGPA (0–10, up to 2 decimals).
- **Blocking and errors:** Continue is blocked until every required field is valid. Errors show inline once a field is left, or after Continue is tried. Each field uses the right keyboard.
- **Rules:** they live in `logic/profileValidation.ts`, unit-tested in `logic/profileValidation.test.mjs` (`npm test`).
- **Saving:** the details are sent as `profile_details` on the existing `PATCH /v1/me` (a frontend contract; the backend should validate again). They stay private and never appear on the public profile.
- **Not live yet:** the `profile_details` field has no backend (capability `profileDetails`). While it's unavailable, step 1 shows "Profile details · Not live yet" instead of collecting details it can't store. Finish still saves mode, hostel and onboarding (the rest of `PATCH /v1/me` is live) and says the details weren't saved. If the backend is opted in but answers 404 `no_route`/501, the save retries without `profile_details` and says so. Real errors (401, 422, 5xx, offline) are shown as errors.

## Workout with partner (shared rep workout)

- **Flow:** Start Exercise → pick an exercise → **Start** (solo) or the pink **partner** icon → `/workout/new` → create the session → share the invite link (native share sheet or Copy) → partner opens it (`squirrelsocial://workout/join/{code}`, or `/w/{code}` on web) → waiting room → both tap **I'm ready** → shared countdown → rep race (your reps, their reps, progress, connection status, pause, undo, finish, exit) → completion screen.
- **Contract:** `SharedWorkoutSession` / `WorkoutParticipant` in `api/campus/types.ts`, the service in `api/sharedWorkout.ts` and state in `hooks/useSharedWorkout.ts`.
  - The countdown uses the server's `starts_at` and `server_time`, so both phones start together.
  - Your reps are counted on your phone (tap each rep, the same as solo) and reported, throttled to one report every 0.5 s. Your partner's reps only ever come from the backend (`workout.reps.updated` on the realtime socket, or a 2 s poll without one).
- **Edge states covered:** partner leaves (before or during), you leave, invite expired, session full, not found, already finished, reconnecting, and connection lost.
- **Not built (backend):** the routes listed at the top of `api/sharedWorkout.ts`. Until they exist (capability `sharedWorkout` in `api/availability.ts`) every call rejects with `EndpointUnavailableError`, and every build shows "Shared workouts aren't live yet". Even when opted in, it only calls a **live** campus API. There is no simulated partner, sync or realtime.
- **Design preview:** `/workout/preview` (dev builds only) renders every state from static props for design review. It is clearly labelled and is not a session.

## Map engine

The campus map is Squirrel Social's own renderer: react-native-svg with a pan/zoom transform. It uses no Mapbox, no API key and no tile server. It draws both themes from `mapColors`. MapLibre isn't used today; switching the engine is a separate decision (it needs a development build and a tile source).

## Campus loop features: shared zones, heat, walks, dates, ratings, photos, ambassadors

Everything below is frontend. The backend work belongs to Dev A and Dev B, and none of it is claimed as done here.

- Screens import feature adapters in `api/campus/`: `discovery.ts`, `community.ts` and `media.ts`. They never call `fetch` directly.
- **Availability is per endpoint, not per service** (`api/availability.ts`, wired in `api/campus/index.ts`). The six campus endpoints with no backend yet are gated in *every* mode (live or off): shared zones, heatmap, media, meetup rating, ambassador, and `profile_details` on `PATCH /v1/me`. With `EXPO_PUBLIC_CAMPUS_SERVICE_URL` set (on top of Social), shared zones and heatmap are served by campus-service and opted in (`optedInWith`); tests in `src/api/campusService.test.mjs`. Squirrel Dates is built (Social service) and is no longer gated. A gated call rejects with `EndpointUnavailableError` (`code: <capability>_unavailable`). All other campus calls go straight through, so one missing endpoint never fails another.
- **Four states, kept distinct:** data, empty (`[]` — "nothing yet"), **unavailable** ("<Feature> · Not live yet", layout kept, only the dependent action disabled, no retry) and **error** (401/403/400/422/5xx/offline — shown as errors with retry or sign-in). `featureUnavailable()` is true only for `EndpointUnavailableError`, campus off, 404 `no_route`/no code, 501, or 503 `*_unavailable`.
- **No fake success anywhere:** there is no mock backend; a gated call never invents heat cells, uploads, ratings, ambassador forms, stored profile details or notifications. The gating doesn't depend on any mock — it wraps whichever real source is active.
- **When a backend ships:** set it to `true` in `BUILT` in `api/availability.ts`, or opt it in without a code change with `EXPO_PUBLIC_LIVE_ENDPOINTS=heatmap,ambassador` (comma-separated capability names: `sharedZones, heatmap, dateSuggestions, media, meetupRating, ambassador, profileDetails, sharedWorkout`). Tests: `src/api/availability.test.mjs` (`npm test`).

| Feature | Where | API (status) |
|---|---|---|
| **Shared Zones** | Profile → People & places → Shared zones (`/shared`), someone's profile → shared-zones row (`/shared/[id]`), notifications | `GET /v1/users/{id}/context` (existing overlap API, Dev B; optional `activity_count` per zone), `GET /v1/me/shared-zones` (**expected, Dev B**) |
| **Activity Heatmap** | Map → 🔥 toggle; window 1h / 24h / 7d, legend in words, privacy line | `GET /v1/map/heatmap?window=` → aggregated cells `{center, radius_m, intensity, level}` (**expected, Dev B**). The app only draws them |
| **Study-Break Walk** | Home (leads "Happening on campus"), Events (featured on Upcoming), event page (JOIN WALK / YOU'RE IN) | Existing Events API. Optional fields `template: 'study_break_walk'`, `duration_min`, `meeting_point` (**expected, Dev A**) |
| **Squirrel Dates** | Social tab section (opt-in card, then one suggestion at a time, "Turn off"), someone's profile (only when there's a suggestion), Block on profiles | `GET·PUT /v1/dates/settings`, `GET /v1/dates/suggestions[?user_id=]`, `POST …/{id}/dismiss`, `GET·POST·DELETE /v1/users/{id}/block` (**live, Social**). Suggestion only: no invite endpoint. "Plan a meetup" opens `/event/plan` pre-filled with the zone and time, which creates a normal event (`POST /v1/events`) |
| **Post-meetup rating** | Meetup page, after it ends; notification reminder | `GET /v1/meetups/{id}/rating` (eligibility, rateable people excluding you, optional dimensions, trust score), `POST /v1/meetups/{id}/ratings` (**expected, Dev A**) |
| **Photo upload** | New Post, Meetup page (`<PhotoUpload purpose=…>`) | Social service's presigned flow: `POST /v1/media/uploads` → PUT → `POST /v1/media/{id}/complete`, plus `GET /v1/media/{id}` with `moderation` (**expected, Dev A**) |
| **Ambassador** | Profile → More → Become an ambassador (`/ambassador`) | `GET /v1/ambassador/application` (open flag, fields, existing application), `POST` answers (**expected, Dev A**) |

**Rules the UI keeps:**
- Shared zones and heat are zone-level or aggregated only, and the copy says so.
- A photo isn't shown on a post until the backend reports `status: ready` and `moderation: approved`. Photos are resized on the device to ≤ 1600 px JPEG, with a 480 px preview.
- You can't rate yourself, and ratings are private. A trust score appears only if the API returns one.
- The ambassador form renders only the fields the backend sends, and the status replaces the form once you've applied.
- Squirrel Dates are opt-in on both sides, optional and dismissible ("Maybe later"), and never send anything to the other person: the card says so. The copy makes no romantic assumptions.
- "Plan a meetup" follows the Events lock (`data/features.ts`): while Events is locked it shows the "coming soon" toast.

**What each one shows until its backend ships:**

| Endpoint | UI while unavailable |
|---|---|
| Shared zones (`GET /v1/me/shared-zones`) | `/shared` keeps its header; the list is "Shared zones · Not live yet". The per-person overlap (`/v1/users/{id}/context`) is live and unaffected. |
| Heatmap | The Heat panel opens and says "Heatmap · Not live yet"; the 1h/24h/7d picker is disabled. The map, players and zones keep working. |
| Squirrel Dates | Live. Without campus zones on the server (`SOCIAL_ZONES_FILE`) the Social section is hidden; if the endpoint is missing it reads "Squirrel Dates · Not live yet". The per-profile card stays hidden. |
| Media | The photo tile reads "Photo uploads · Not live yet" and can't be tapped; posting without a photo still works. |
| Meetup rating | The meetup page works (check-in etc.); the rating block reads "Meetup ratings · Not live yet". |
| Ambassador | Profile row detail reads "Not live yet"; `/ambassador` keeps its title and shows the Not live yet card instead of the form. |
| Profile details | See "Profile building" above. |

**Runs:**
- `logic/track.ts` is the verified `saheb` version with the GPS noise gate, byte for byte. A phone left stationary for about 2 minutes stays at 0.00 m. The tests are in `logic/track.test.mjs`: `node --experimental-strip-types --test src/logic/track.test.mjs`.
- The demo route starts at `DEMO_START = 0` (0.00 km, 0:00) and is offered only where GPS can't exist (the web preview).
- Denied location shows **Location required**, "Turn on location permission to track your run." and **Open settings**. Approximate location is blocked too.
- A real run never starts without precise permission.
- Leaving mid-run (close, back gesture, hardware back) asks before discarding.

## Look & feel: a cinematic campus world

The goal is a GTA-inspired campus world, not a GTA clone: no GTA assets, logos, characters or layouts. Someone opening the app should feel they've entered their campus, not opened another fitness app.


- **Colours:** from the Squirrel Social website (www.squirrelsocial.in):
  - **Canvas:** near-black `#060606`, with graphite panels (`#111113` / `#17171A`) and `#27272B` lines.
  - **Neon is a signal, not a surface.** Large areas stay dark; selected tabs and filters are a raised dark surface with an accent underline or outline, not a lime block.
  - **Lime `#D7FF1F`:** primary action, progress, ownership and confirmation (claimed zones, FRIENDS).
  - **Pink `#FF2D9B`:** social, interaction and challenge (POKE, POKE BACK, challenges).
  - **Purple `#A855F7`:** game systems and secondary states (level chips).
  - **Orange / sunset:** atmosphere only (skies and street light in the art).
  - **Yellow `#FFD21F`:** coins and defend.
  - **Text:** muted text is `#A9A9AE`.
- **Type (GTA VI style):**
  - **Anton:** heavy condensed headlines and big numbers, slanted −6° like GTA title cards.
  - **Barlow Condensed:** labels, buttons and italic callouts.
  - **Inter:** body text.
  - GTA VI's own typeface is proprietary; these are the closest free Google Fonts.
- **Art:** the illustrations use the website palette (neon lime and pink city).
  - `art/CampusScene.tsx` is the campus at dusk: hostel blocks with lit windows, the lecture hall, a floodlit sports ground and a lamp-lit path.
  - It's the title-screen backdrop and the Home "your world" card that opens the Map.
- **The squirrel is scarce on purpose.** It appears on the title screen, onboarding, level-ups, missions, run results, meetup check-in, locked features and empty states. It doesn't appear on everyday surfaces such as Home, the Create sheet or your profile header.
- **First impression:** the title screen reads SQUIRREL SOCIAL → YOUR CAMPUS. YOUR GAME. → the campus with the squirrel → ENTER IISER KOLKATA / EXPLORE DEMO. One live line ("23 moving right now") shows the world is active; it's hidden when the backend isn't reachable.
- **Game feel, kept subtle:**
  - Map markers spring in the first time they appear.
  - A claim, steal or defend confirmed by the backend shows a short "ZONE CLAIMED" stamp that clears itself (`components/game/CaptureMoment.tsx`).
  - Poke has a ripple and haptics; friendship has its celebration.
  - Claiming mission rewards opens the reward screen.

All UI tokens live in `src/theme.ts`; illustration colours live in `src/art/palette.ts`.

## Backend integration (Run Module)

This follows the *Frontend ↔ Backend Compatibility Assessment*.

| Area | State in the app |
|---|---|
| **Install** | `package.json` pins Expo SDK 57 / expo-router 57; the stray `"undefined"` dependency is gone |
| **Auth** | `src/auth/AuthProvider.tsx`: sign-in by emailed code against Exercise (`EXPO_PUBLIC_AUTH_URL`, default `EXPO_PUBLIC_EXERCISE_API_URL`), token in SecureStore, `Authorization: Bearer` on every call to every backend |
| **API layer** | `src/api/`, matched to the verified Run Module contract: `POST /v1/runs` → `{run_id}`; points in batches of 500 with `seq` (index in the full array), `lng`, `recorded_at`, required `accuracy_m`, and a seq-range `idempotency_key`; `/finish` is async, so the app polls `GET /v1/runs/:id` with backoff until `finalized` / `flagged` / `rejected`. XP comes from `GET /v1/users/me/xp`; the leaderboard uses `scope=global&metric=area&window=…` with `me` + `next_cursor`. 429s are retried after `Retry-After`. Your own leaderboard row is matched by the token's `sub` (`page.me` has no `user_id`). Verification polls for up to 5 min, with a "Don't wait" button after 15 s. Still marked `ASSUMPTION` in `endpoints.ts`: the create request body and leaderboard score units (m²) |
| **Runs** | Real GPS via `expo-location` (accuracy/jump filtering, auto-pause). Signed in, the run uploads and the **server's** distance, status and territory are shown; XP earned is the before/after difference from `/users/me/xp`. Without GPS (web, or permission denied), a clearly labelled demo simulation runs |
| **XP** | Local estimate uses the backend's rules (50 + 10/km + 25 territory, 150/day run cap). Signed in, the server total replaces it. Levels are derived client-side (2,000 XP each) |
| **Anti-cheat** | Run summary shows *accepted / flagged / rejected* (server verdict when live, local plausibility check otherwise) |
| **Territory** | New `/territory` screen (zones, control %, rivals, contested, 14-day decay) and area-based leaderboard (`/leaderboard`). *Not live yet* until the territory endpoints are wired |
| **Challenges** | `/challenges` screen: the Run Module's Goals (`GET /v1/challenges/mine`, accept/decline; `src/api/runChallenges.ts`). Missions stay a separate frontend feature (company decision, §4.3) |
| **Still frontend-only** | Coins, cosmetics, social feed, crews/events, badges. They need backend models (§5) |

To point the app at a backend, copy `.env.example` to `.env`, then set `EXPO_PUBLIC_API_URL` (and `EXPO_PUBLIC_AUTH_URL` when the account service exists).

## Progress, XP and boards (ADR-032 owners)

There is no progress-service (ADR-032 cancelled it). Every read goes to the owner of the number; the app never computes XP.

| Area | Owner and route | App |
|---|---|---|
| **Your Progress** (`/progress`) | Run Module `GET /v1/progress`, `/v1/progress/weekly`, `/v1/progress/history?days=366`; `GET /v1/xp/stats` | `src/api/progress.ts`, `src/api/xp.ts`, `src/logic/progressStats.ts` |
| **Daily progress** (Home, Missions) | Run Module `GET /v1/progress/daily` | `src/hooks/useDailyProgress.ts` |
| **XP history** (`/xp-history`) | Run Module `GET /v1/xp/history` (keyset cursor) | `src/logic/xpHistory.ts` |
| **XP board** (`/leaderboard` → XP) | Today / last 7 days: Social `GET /v1/leaderboards/xp` (Run Module numbers + names). This month: Run Module `GET /v1/leaderboard/xp` (ids only, shown as "Squirrel") | `src/logic/xpBoard.ts` |
| **Goals** (`/challenges`) | Run Module `GET /v1/challenges/mine`, accept/decline | `src/api/runChallenges.ts` |
| **XP total / level** | Run Module `GET /v1/xp` | `src/state/AppState.tsx` |

Workouts earn XP through Exercise's own session row and runs through the Run Module; the phone never reports activity for XP. Steps have no source yet, so step goals stay at 0.

## Architecture

```
src/
  app/                 Expo Router routes (every file is a screen)
    (tabs)/            Home · Explore · Social · Profile, plus the custom tab bar with a central Create button
  art/                 Original vector illustration library (react-native-svg)
    Mascot.tsx         Squirrel mascot: 9 poses (idle, run, celebrate, drink, lift, sit, cheer, sleep, wave) + accessories
    Character.tsx      Parametric human avatars (AvatarLook) in 6 poses, plus circular Portrait
    Scene.tsx          13 cinematic scenes (city sunset/night/dawn, run, yoga, cafe, brunch, crew, hiit…)
    Product.tsx        20 shop items (hoodie, tee, shoes, bag, bottle, sunglasses, watch…)
    Badge.tsx          12 achievement badges (plus locked state)
    Sticker.tsx        8 die-cut stickers
    CityMap.tsx        Stylised city map + animated run route
    palette.ts         Shared art palette so everything belongs to one visual universe
  components/          ui.tsx (primitives + motion), cards.tsx, Avatar, TopBar, TabBar, Sheet, Toast
  data/                Static app data only: exercises, feature locks, icons, avatar options (no sample people, posts or stats)
  state/AppState.tsx   App state: your identity and look, server XP / level, exercise tracking, toasts
  types.ts             Shared domain types (AvatarLook, SceneKind, ProductKind…)
  theme.ts             Colour, gradient, font and radius tokens
assets/                App icon, splash, and PNG exports of the illustration set (see assets/README.md)
```

**Real data only.** Every person, post, crew, event, stat and score on screen comes from a backend (Social service, Exercise, Run Module, campus-service). There are no sample users, posts, missions, shop, rewards or cities, and no mock backend; screens without their backend show *Not connected* (configure it / sign in) or *Not live yet* (the endpoint isn't built). The one labelled simulation is the Run Module's demo route for devices with no GPS, which is never uploaded.

**Art is code.** Illustrations are React components, so they're crisp at any size, themeable, animatable and tiny to ship. PNG exports in `assets/` are for store listings, marketing and a future backend.

## Notes

- Without GPS (web, or permission denied) run distance is simulated from pace.
- The Explore map is illustrative. A real tile map (`react-native-maps`) would need a development build.
- State is in memory and resets on reload.

## Movement Alarm (frontend only)

> **Status:** complete on-device; no backend, nothing synced. Alarms, wake-up history and the streak live only on the phone. **Not yet a real alarm:** on iOS / Android it rings as a scheduled notification, which can be swiped away and can't open the app by itself — so it can be silenced without doing the challenge. Closing that gap needs the native system-alarm integration (point 1 below, development build).

An alarm that only stops once you move: **Dance** or **Shake it** (keep moving for N seconds) or **Squats** / **Jumps** (N reps). Entry points: Create sheet → *Movement alarm*, Profile → More → *Movement alarm*. Routes: `/alarm` (your alarms), `/alarm/edit` (new / `?id=` edit), `/alarm/ring/[id]` (the full-screen challenge; `id=practice` for a practice round).

| Layer | File | Job |
|---|---|---|
| AlarmService | `features/alarm/AlarmService.ts` | Alarms on this device, scheduling, "alarm went off → open the challenge", wake-up history / streak |
| MovementDetectionService | `features/alarm/MovementDetectionService.ts` | The only code that touches sensors: status, permission, sample stream |
| Challenge engine | `logic/movementEngine.ts` + `logic/movementChallenges.ts` | Samples → seconds / reps, pause vs reset rules (unit-tested). Add a challenge = one entry in `CHALLENGES` |
| UI | `app/alarm/*`, `components/alarm/*`, `features/alarm/useMovementChallenge.ts` | Setup, ring flow, permission / failure states, backup challenge |

Rules: no dismiss and no snooze before the challenge is beaten (hardware back is blocked too). Dance pauses when you stop; Shake starts over after 3 s still; reps are never taken away. If movement can't be detected (no sensor, access refused or turned off in Settings, the sensor dies mid-way), the app says why and offers **Allow access / Open Settings / Try again** and a **backup challenge** (catch the hopping squirrel N times) — never a blank screen or a free dismiss.

What's real today:
- **Motion detection:** real, through the phone's motion sensors (expo-sensors DeviceMotion on iOS / Android; the browser's `devicemotion` on mobile web, with iOS Safari's permission prompt). Desktop browsers have no motion sensor → "Can't feel your moves here" + backup.
- **Ringing:** iOS / Android schedule a daily local notification (expo-notifications) that rings with the notification sound and opens the challenge when tapped, or straight away if the app is open. Web rings only while the app is open in a tab.
- **XP:** shown as "Alarm XP · Not live yet" — no server counts alarm XP, so none is invented. The streak is local.
- **Development simulator:** `__DEV__` builds only, offered on the "can't sense movement" screen and labelled "Simulated movement, not real detection". Production builds never include it as an option.

Native integration points (need a development build + config plugin / native module; marked `NATIVE INTEGRATION POINT` in the code):
1. **True system alarm** — `AlarmScheduler` in `AlarmService.ts`: Android `AlarmManager.setAlarmClock` + a full-screen-intent notification that launches straight into `/alarm/ring/{id}`; iOS AlarmKit (iOS 26+) or a critical-alert / time-sensitive notification. Today's notification can be swiped away and can't force the app open.
2. **Camera movement tracking** — `CameraPoseDetector` in `MovementDetectionService.ts`: a pose model (e.g. MediaPipe / ML Kit through a camera frame processor) emitting the same samples or rep events. Not bundled, so it reports "unsupported" and the camera is never used.
3. **Looping alarm sound in the challenge** — needs an audio module (e.g. expo-audio) on the ring screen; today the phone vibrates in a loop until you start moving.

Notification taps: `notifications/push.ts` (`openRoute`) hands alarm notifications (`data.kind === 'movement-alarm'`) to `AlarmService.fire`, which waits for the navigator and won't stack a challenge that's already on screen; every other notification is routed as before. `features/alarm/useAlarmTriggers.ts` (mounted in the root layout) re-registers alarms at start-up and opens the challenge when an alarm rings while the app is open.

The camera pose tracker in `src/workout/tracker/*` is not wired into the alarm yet; it is the natural candidate for `CameraPoseDetector` (integration point 2).

## Launch splash

- `components/LaunchSplash.tsx`, overlaid on the root layout (not a route: it can't be navigated back to, and deep links mount underneath it).
- Logo (the official logo, framed as an app-icon tile) → **SQUIRREL SOCIAL** → "Backed by" with the RISE Foundation and SplitLabs VC logos and names (exact supplied files in `assets/brand/backers/`, shown as-is), then a fade into whatever start-up picked.
- It lifts only when **both** at least 3 s (`SPLASH_MIN_MS`) have passed since launch **and** the app is ready (fonts loaded, saved session restored). Reduce Motion skips the animation, not the content. Shown once per launch; after a theme-switch reload on web it is skipped (`isThemeReload` in `components/ThemeToggle.tsx`).
