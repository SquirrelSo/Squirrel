# campus-service — API reference

Base URL: `https://<host>` · all routes are under `/v1` · JSON in, JSON out · snake_case keys.

**Auth.** `Authorization: Bearer <jwt>` — the same RS256 token the Run Module accepts; the user id is the token's `sub`. Routes marked 🔒 require it; routes marked 👤 accept it optionally (personalised `actions` / `me` when present). Users are provisioned on first authenticated request.

**User ids.** With the Social identity bridge on (`SOCIAL_API_URL` + `SOCIAL_INTERNAL_TOKEN`), every user id this API returns (`user_id`, `owner_id`, `created_by`, `new_owner_id`, notification `data.user_id`, realtime frames, …) is the user's **Social profile id**, and `display_name` / `avatar_url` (and `hostel` when Social has one) are the Social profile's — so a tapped person opens the right Social profile. Any request field that takes a user id accepts a Social profile id (an existing campus id still works). With the bridge off, user ids are the token `sub`. See README → *Identity bridge to Social*.

**Errors.** Every error is `{ "code": "<stable_code>", "detail": "<human message>", ...extra }`. HTTP status is meaningful:

| status | codes |
|---|---|
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found`, `zone_inactive` |
| 409 | `already_owned`, `not_qualified`, `qualification_pending`, `unclaimed`, `own_zone`, `shielded`, `not_owner`, `not_under_attack`, `territory_conflict`, `idempotency_key_reused`, `activity_finished`, `challenge_conflict`, `crew_name_taken`, `crew_transfer_required`, `meetup_blocked`, `meetup_closed`, `meetup_participant_state`, `open_to_meet_required` |
| 413 | `payload_too_large` |
| 422 | `invalid`, `invalid_gps` |
| 429 | `rate_limited`, `cooldown`, `defend_cooldown` (with `expires_at`) |
| 500 | `internal_error` |
| 503 | `blocks_unreachable` |

**Common shapes**

```jsonc
Person      { "user_id", "display_name", "avatar_url", "hostel" }
LatLng      [lat, lng]
Zone        { "id", "name", "short_name", "description", "kind", "zone_type": "AREA"|"ROUTE",
              "polygon": LatLng[], "centroid": LatLng, "geometry": GeoJSON Polygon,
              "required_route": LatLng[] | null, "hostel", "hostel_id",
              "qualification": { "threshold": 0.6, "metric": "coverage"|"route_completion" },
              "geometry_source": "dev_placeholder"|"survey"|"osm", "is_active", "updated_at" }
Territory   { "zone_id", "owner": Person|null, "owner_type": "NONE"|"USER"|"CREW", "crew": {id,name,color,icon}|null,
              "claimed_at", "defended_count", "claim_count", "last_defended_at",
              "under_challenge": bool, "shield_until", "version", "updated_at",
              "status": "neutral"|"controlled"|"under_attack"|"contested",   // app vocabulary
              "state": "UNCLAIMED"|"CLAIMED"|"CONTESTED",                    // spec vocabulary
              "control": 0..1|null, "xp" }
Actions     { "claim": Avail, "steal": Avail, "defend": Avail }
Avail       { "allowed": bool, "code": string|null, "reason": string|null, "expires_at": iso|null }
Event       { "id", "zone_id", "type": "claimed"|"stolen"|"defended"|"released"|"decayed", "action": "CLAIM"|…,
              "actor": Person, "previous_owner": Person|null, "new_owner_id", "triggered_by_activity_id", "xp_awarded", "at" }
Point       { "seq"?, "lat", "lng", "recorded_at": iso, "accuracy_m", "speed_ms"?, "altitude_m"? }
```

`version` on a territory is monotonic. Clients that keep local state must ignore any update whose `version` is lower than what they already hold.

---

## Config & health

### `GET /healthz` · `GET /readyz`
Liveness / readiness (`readyz` pings the database). `{ "ok": true }`.

### `GET /v1/config` 👤
Campus constants, feature flags, realtime URL and the active game-rule numbers. `campus.center` + `campus.max_radius_m` are the ingest area: a point farther than that from the centre fails `POST /v1/activities` with `invalid_gps` (clients drop such points before uploading).
```json
{ "campus": { "id": "iiser-kolkata", "name": "IISER Kolkata", "short_name": "IISER K", "email_domains": ["iiserkol.ac.in"], "center": [22.9637, 88.5245], "max_radius_m": 4000, "launched_at": null },
  "features": { "create_crew": true, "create_event": false, "defend": true, "open_to_meet": true, "date_mode": { "available": false, "reason": "…", "requirements": [] }, "meetup_safety_notifications": true },
  "realtime_url": "wss://…/v1/realtime", "rules": { "qualification_ttl_hours": 24, "claim_shield_hours": 2, "action_cooldown_seconds": 60 }, "auth_configured": true }
```

---

## Me & users

### `GET /v1/me` 🔒
Full own profile (public profile + `email`, `hostel_id`, `date_mode_enabled`, `onboarding_completed`, `open_to_meet_until`, `campus_xp`, `level`, `stats`, `territories`, `crews`, `recent_activities`).

### `PATCH /v1/me` 🔒
Body (all optional): `display_name`, `bio`, `avatar_url`, `connection_mode` (`date|friends|crew|null`), `hostel_id` **or** `hostel_zone_id` (a hostel zone id such as `narmada`), `onboarding_completed`, `date_mode_enabled`. Returns the same as `GET /v1/me`. 422 `invalid` on unknown hostel. The whole patch applies in one transaction: if any part is rejected nothing is written.

> **`profile_details` has moved.** Sending `profile_details` to this endpoint now returns 422 `invalid`. Private profile details (`full_name`, `personal_email`, `college_email`, `phone`, `gender`, `age`, `course`, `cgpa`) are now owned by the **Exercise service**: `PUT /api/me/profile-details`. (ADR-032 open item 1, decided.) The `user_profile_details` table still exists; the removal migration lives at `migrations/pending/007_drop_profile_details.sql` and will be applied once the production row count is confirmed 0.

### `PUT /v1/me/open-to-meet` 🔒 (aliases: `PATCH /v1/me/open-to-meet`, `PATCH /v1/users/me/open-to-meet`)
Body `{ "enabled": true, "hours": 12 }` (hours optional, default 12, max 168). Turning it on requires at least one `VERIFIED` run or walk; otherwise the API returns `409 verified_activity_required` with instructions to record and verify a run or walk first. Turning it off is always allowed. This consent gate keeps accounts with no verified activity from appearing to students. Response `{ "enabled", "updated_at", "visible_until" }`. While enabled you appear in others' *nearby* lists and can see theirs.

### `GET /v1/users/:id` 👤
Public profile: `user_id, display_name, avatar_url, hostel, bio, connection_mode, open_to_meet, verification{…}, stats{ total_distance_m, month_distance_m, zones_claimed, territories_defended, territories_stolen, crew_memberships }, territories[], crews[], badges[], joined_at, founding_member, level, campus_xp`. 404 `not_found`.

### `GET /v1/users/:id/context` 🔒
What you have in common: `{ "shared_zones": [{zone_id, zone_name, relation}], "shared_crews": [...], "shared_events": [], "icebreakers": [{id, kind, text, zone_id?, action?}] }`.

A block in either direction returns **404 `not_found`** — the same answer as a user who does not exist, so the route never reveals that a block is the reason. When Social cannot be reached the route returns an empty result with `hidden_reason: "blocks_unreachable"`; that is a different condition and may be shown.

### `POST /v1/users/:id/block` · `DELETE /v1/users/:id/block` 🔒 (legacy)
Create or remove a directed block in the legacy local table; both operations are idempotent. Self-blocking returns 422. With `LEGACY_LOCAL_BLOCKS=0` (after the import), these and `GET /v1/me/blocks` return **410 `blocks_moved`**: block through Social's `POST`/`DELETE /v1/users/{id}/block`.

**Blocks are owned by the Social service** (ADR-032). This service reads the caller's full block set from Social's internal API, caches it for at most 30 seconds, and, while `LEGACY_LOCAL_BLOCKS=1` (the default), unions it with its own local `blocks` table during migration. If Social cannot be reached and no fresh answer is cached, every block check **fails closed**: lists that filter people (Nearby, Active now, map players, shared zones) return empty with `hidden_reason: "blocks_unreachable"`, and actions between two people are refused with a retryable 503. The app's Block button writes to Social, not here. Running without `SOCIAL_API_URL` and `SOCIAL_INTERNAL_TOKEN` in production is refused at startup.

### `GET /v1/me/blocks` 🔒
`{ "blocks": [{ "user_id", "created_at", "person": Person|null }] }` for users the caller has blocked.

## Crews

Crews and crew membership are owned by Social. Campus endpoints that include crew information resolve it from Social; campus-service has no public `/v1/crews` routes or local crew storage.

## Meetups

`Meetup` includes `id, created_by, zone_id, zone, place_text, starts_at, status, created_at, updated_at, participants[]`. Participants include `user_id, role, status, responded_at, person`, with `open_to_meet` shown only as a hint. Status is `proposed|confirmed|cancelled|completed`; `completed` is derived at read time when a confirmed meetup's start time has passed.

### `POST /v1/meetups` 🔒
Body `{ "zone_id"?, "place_text"?, "starts_at": iso, "invitee_ids": [user-id…] }` (provide a zone or place, starts_at must be future, invitees must be distinct and cannot include the host) → `201 Meetup`. A block in either direction prevents invitation.

### `GET /v1/meetups?status=proposed|confirmed|cancelled|completed` 🔒 · `GET /v1/meetups/:id` 🔒
Return meetups the caller participates in. A non-participant or participant blocked by another participant receives 404; the list omits blocked meetups.

### `POST /v1/meetups/:id/accept` · `/decline` · `/cancel` · `/leave` 🔒
Guests accept or decline (decline has no reason field); the host is notified of response status only. The host may cancel before completion. An accepted guest may leave. A block created after invitation hides the meetup from the blocked pair and prevents acceptance.

### `POST /v1/meetups/:id/check-in` 🔒
Body `{ "notify_safety_contact": boolean }` → `{ "meetup_id", "checked_in_at", "safety_notification": { "requested", "status", "contact_label" } }`.
Participants (invited or accepted) and hosts can check in. The check-in window opens 1 hour before `starts_at` and closes 6 hours after. It changes an invited guest to `accepted`. The same request replays safely without creating duplicate check-ins. If `notify_safety_contact` is requested, the status currently returns `not_configured`.
**XP:** once at least two participants of a meetup have checked in, each checked-in participant is awarded `meetup_checkin` XP (25, source `campus`) by the Run Module, once per meetup per person (idempotency key `meetup:{meetupId}:{subject}`): the second check-in awards both, each later one awards only itself. The award is sent after the check-in commits and never delays or fails it; a Run Module failure is only logged.

### `GET /v1/meetups/:id/rating` 🔒
```json
{ "can_rate": true, "reason": null, "already_rated": false,
  "rateable": [Person…],
  "dimensions": [{ "key": "friendly", "label": "Friendly & Welcoming" },
                 { "key": "punctual", "label": "On Time" },
                 { "key": "fun", "label": "Fun to be around" },
                 { "key": "helpful", "label": "Helpful" }],
  "trust_score": { … } | null }
```
Only a participant of a **completed** meetup may rate, and only other participants of that meetup. A blocked pair never appears in `rateable`.

`trust_score` is **the caller's own** — never the score of the person being rated. It is an aggregate (mean stars, rounded to one decimal, with a label) and is `null` below **3 distinct raters**, the same suppression threshold the heatmap uses. Because a rater can only ever read their own score, rating someone cannot reveal the effect of that rating on the other person's score.

### `POST /v1/meetups/:id/ratings` 🔒
Body `{ "ratings": [{ "user_id", "stars": 1-5, "tags": [key…] }], "idempotency_key" }` → `{ "meetup_id", "submitted_at", "trust_score" }` — again, the caller's own score.

`tags` must be dimension keys (`friendly`, `punctual`, `fun`, `helpful`), enforced by the API **and** by a database CHECK, so a free-text tag cannot exist even if a future code path skips validation. `stars` is likewise constrained in both places. One rating per rater per ratee per meetup: the same `idempotency_key` replays, a different key for an already-rated pair is rejected. Ratings between a blocked pair are refused.

**Individual ratings and rater identities are never returned to anyone**, including the person rated. Only the aggregate is exposed, and only to its owner. Ratings are deleted with the user.

### Notifications (Social-owned)
Notifications are stored, listed, marked read, and pushed by Social. campus-service forwards campus events to Social's `POST /internal/v1/notifications`; it no longer serves `/v1/notifications` or `/v1/notifications/read`.

### `GET /v1/me/badges` 🔒 — `{ "badges": [] }` (badges are owned by the Social service — ADR-032).

---

## Zones

### `GET /v1/zones` 👤
All active zones with geometry. Query filters (combine freely): `ownedByMe=true` 🔒, `unclaimed=true`, `contested=true`, `crew=<crew uuid>`, `kind=hostel|academic|sports|food|library|landmark`, `includeInactive=true`, `format=geojson` (FeatureCollection instead of `{zones}`).
```json
{ "zones": [Zone…], "as_of": "2026-09-28T21:56:20.000Z" }
```

**Placeholder geometry.** Every seeded zone carries `geometry_source: "dev_placeholder"` — the outlines are invented and roughly placed, not surveyed. Clients should render them visibly as approximate. The seed only overwrites geometry while that marker is present, so surveyed outlines replace them permanently. See `docs/GEOGRAPHIC_DATA_REQUIRED.md`.

**Zone deletion:** A zone referenced by a meetup cannot be deleted. `meetups.zone_id` uses `ON DELETE RESTRICT`, preserving the meetup's zone association and history; deleting such a zone fails with a foreign-key error. Deactivate it instead by setting `zones.is_active = false`. The service's reads and activity verification exclude inactive zones. There is currently no API route to deactivate a zone, so an operator must make this change through database access.

### `GET /v1/zones/nearby?lat&lng&radius_m=1000` 👤
Zones whose polygon is within `radius_m` (50–10 000) of the point, nearest first, each with `distance_m` and `territory`.

### `GET /v1/zones/:id` 👤
```json
{ "zone": Zone, "territory": Territory, "actions": Actions,
  "stats": { "runs_7d", "visitors_7d", "my_visits_7d", "distance_7d_m" }, "history": [Event…] }
```
`actions` is the server's decision for the caller (all `allowed:false` with code `unauthorized` when anonymous). 404 `not_found`.

### `GET /v1/zones/:id/territory` 👤 — `{ "territory": Territory, "actions": Actions }`
### `GET /v1/zones/:id/history?limit=20` — `{ "history": [Event…] }` (max 100)

### `POST /v1/zones/:id/claim` 🔒 · `POST /v1/zones/:id/steal` 🔒 · `POST /v1/zones/:id/defend` 🔒
Body `{ "idempotency_key": "<client uuid>" }` — required. Rate limit 20/min per user.

The server re-derives eligibility inside a transaction with the zone row locked; nothing in the request other than the key is trusted. Rules:

| action | allowed when | otherwise (`code`) |
|---|---|---|
| claim | zone unclaimed **and** caller holds a live `QUALIFIED` result for the zone (verified activity, < 24 h old, unspent) | `already_owned`, `not_qualified`, `qualification_pending`, `cooldown`, `zone_inactive` |
| steal | zone owned by someone else, shield lapsed, caller qualified | `unclaimed`, `own_zone`, `shielded` (+`expires_at`), `not_qualified`, `qualification_pending`, `cooldown` |
| defend | caller is the owner (or a member of the holding crew), zone `under_challenge`, caller qualified, no defend cooldown | `not_owner`, `not_under_attack`, `not_qualified`, `defend_cooldown` (+`expires_at`), `cooldown` |

A block between two users does **not** affect stealing. Blocking a rival must not make your zones unstealable, and a refusal would tell the blocked person they are blocked.

Effects: ownership/version/shield update, a `territory_events` row, the qualification is marked `CLAIMED` (spent), XP awarded (claim 25 / steal 40 / defend 15), user cooldown starts. Defend also expires every rival's live qualification on the zone.

> ADR-032 makes the **Run Module** the single XP ledger. campus-service will report claim / steal / defend awards to it and stop keeping `campus_xp`.

Response `200`:
```json
{ "territory": Territory, "actions": Actions, "event": Event, "replayed": false }
```
Replaying the same key returns the original response with header `Idempotent-Replayed: true`. The same key with a different action/zone → 409 `idempotency_key_reused`.

Example:
```bash
curl -X POST $API/v1/zones/cc1/claim -H "Authorization: Bearer $T" -H 'content-type: application/json' \
     -d '{"idempotency_key":"7c1c…"}'
# 200 {"territory":{"zone_id":"cc1","owner":{"user_id":"u_aanya",…},"status":"controlled","version":2,"shield_until":"…"},"actions":{…},"event":{"action":"CLAIM",…}}
# 409 {"code":"not_qualified","detail":"Run or walk through CC1 to unlock this.","expires_at":null}
```

---

## Territories

### `GET /v1/territories` 👤 — `{ "territories": [Territory…], "as_of" }` — ownership of every active zone (no geometry; join with `/v1/zones` on `zone_id`). Same filters as `/v1/zones`.
### `GET /v1/territories/my` 🔒 — `{ "territories": [{ "zone": Zone, "territory": Territory, "actions": Actions }] }`
### `GET /v1/territories/contested` — owned zones that are under attack or in an active territory battle.
### `GET /v1/territories/:zoneId` — `{ "territory": Territory }`

---

## Activities (runs / walks)

An activity goes `RECORDING → PENDING → PROCESSING → VERIFIED | PARTIALLY_VERIFIED | REJECTED`. Verification is asynchronous (a worker); poll `GET /v1/activities/:id/verification` or listen for `activity.verified` on the realtime feed. Users only ever see their own activities (others' → 404).

### `POST /v1/activities` 🔒 — rate limit 50/day
Two modes:
1. **One-shot** (what the app does): include `points` (≤ 20 000) → the activity is stored and finished immediately, status `PENDING`.
2. **Streaming**: omit `points` → status `RECORDING`; then upload batches and call `/finish`.

Body: `{ "type": "run"|"walk", "started_at": iso, "ended_at"?: iso, "points"?: Point[], "client_distance_m"?, "client_duration_s"?, "device"?: {} }`
Response `201`: `{ "activity_id", "run_id", "id", "user_id", "type", "status", "started_at", "ended_at", "distance_m": null, … , "verification": { "status", "band": null, "reason": null, "verified_at": null, "app_status": "processing" } }`.
Errors: 422 `invalid` (dates), 422 `invalid_gps` (see GPS rules), 413 `payload_too_large`.

### `POST /v1/activities/:id/points` 🔒 — rate limit 60/min
Body `{ "idempotency_key"?: string, "points": Point[] }` — 1…1000 points; `seq` optional (server assigns sequentially after the last stored point). A batch whose key was already seen, or whose seq range is already fully stored, is acknowledged as `replayed:true` without changes.
Response `{ "accepted": n, "replayed": bool, "point_count": total }`. 409 `activity_finished` once finished.

### `POST /v1/activities/:id/finish` 🔒
Body (optional) `{ "ended_at"?, "client_distance_m"?, "client_duration_s"?, "device"? }` → `{ "activity_id", "status": "PENDING", "replayed": false }` and the verification job is queued. 422 if longer than 6 h.

### GPS validation rules (422 `invalid_gps`)
* lat ∈ [-90,90], lng ∈ [-180,180], finite; `accuracy_m` ≤ 100 (the app filters at 20 m before uploading)
* `recorded_at` parseable, not in the future (> 2 min), not before `started_at` (− 1 min), **non-decreasing** within and across batches; `seq` strictly increasing
* no segment faster than 30 m/s (a teleport), no two positions > 50 m apart with the same timestamp
* every point within `CAMPUS_MAX_RADIUS_M` (4 km) of the campus centre
* ≤ 1000 points per batch, ≤ 20 000 per activity, body ≤ 2 MB

### `GET /v1/activities?limit=20&cursor=<started_at>` 🔒
`{ "items": [Activity + "zones_count"], "next_cursor": iso|null }` — newest first.

### `GET /v1/activities/:id` 🔒
Activity summary with **server-derived** `distance_m`, `duration_s`, `moving_time_s`, `point_count`, plus `track` (GeoJSON LineString of the cleaned track after verification, else null). The raw anti-cheat score and signal breakdown are never returned.

### `GET /v1/activities/:id/verification` 🔒
```json
{ "activity_id", "status": "VERIFIED", "band": "accept"|"review"|"reject"|null, "reason": "Looks good. Every metre counted.", "verified_at", "app_status": "verified"|"flagged"|"rejected"|"processing", "attempts": 1 }
```

### `GET /v1/activities/:id/zones` 🔒 (alias `GET /v1/runs/:id/zones`, used by the app)
Zones the activity interacted with, from the verification pipeline, with **live** territory and actions:
```json
{ "activity_id", "run_id", "status": "verified", "verification": {…},
  "zones": [{ "zone_id": "cc1", "zone_name": "CC1", "interaction": "visited"|"looped"|"passed_through",
              "distance_in_zone_m": 812, "time_in_zone_s": 254,
              "qualification": { "status": "QUALIFIED"|"NOT_QUALIFIED"|"CLAIMED"|"EXPIRED", "metric": "coverage", "value": 0.83, "threshold": 0.6, "expires_at": iso },
              "zone": Zone, "territory": Territory, "actions": Actions }] }
```

---

## Presence — Active Now / Nearby

Exact positions are stored for distance math but **never returned**. Others see proximity buckets (`very_close` ≤ 150 m, `nearby` ≤ 500 m, `on_campus`) or grid-snapped cells (100 m).

### `PUT /v1/map/presence` 🔒 — rate limit 10/min
Body `{ "lat", "lng", "accuracy_m"? }` → `{ "accepted": true }` (or `{ accepted:false, reason:"off_campus" }`). Presence expires after 15 min; a sweep every minute (worker, and the API when `WORKER_INLINE`) deletes expired rows, so an exact fix is not kept past its TTL.

**Consent.** Wherever another person is listed (map players, Nearby, proximity in Active, shared zones, Bubble, Discover), "open to meet" means `open_to_meet` is on **and** `open_to_meet_until` is unset or in the future. A lapsed window counts as off at once, before any sweep.

### `GET /v1/people/active` 🔒 (aliases `GET /v1/activity/active`, `GET /v1/activity/nearby` → nearby only)
```json
{ "active_now": 7,
  "active":  [{ "person": Person+{connection_mode,bio}, "activity": { "type": "run", "started_at" }|null, "proximity": "nearby"|null }],
  "nearby":  [{ "person": …, "activity": …, "proximity": "very_close" }],
  "as_of", "visible": true, "hidden_reason": null|"open_to_meet_off"|"blocks_unreachable" }
```
* `active`: anyone on campus with a live activity. `proximity` is only filled when **both** people are open to meet.
* `nearby`: empty unless the caller is open to meet; contains only others who are open to meet and within 800 m.
* Both lists come back empty with `hidden_reason: "blocks_unreachable"` when the block set cannot be read from Social — showing nobody is correct; showing a blocked person is not.

### `GET /v1/map/players` 🔒
Grid-snapped positions (`position: [lat,lng]`, `precision_m: 100`) of people who are open to meet (consent current); empty with `hidden_reason: "open_to_meet_off"` if the caller is not, or `"blocks_unreachable"` if the block set cannot be read.

### `GET /v1/map/heatmap` 🔒
Aggregated activity intensity cells for `window=7d|30d` (default `7d`). Cells use a fixed 100 m grid and are returned only when at least 3 distinct, non-banned users have fully verified activity in the window. Response intensities are coarse `low` / `medium` / `high` buckets; exact user counts, identities, timestamps and GPS points are never returned. At most 500 cells are returned.

### `GET /v1/me/shared-zones` 🔒
Zones the caller and other people have both been active in. Verified activity only, blocked users excluded in either direction, and only people whose `open_to_meet` consent is current. Frequency is a coarse `sometimes` / `often` bucket; no timestamps, coordinates or exact counts are returned. Capped at 10 zones and 5 people per zone.

### `GET /v1/squirrel-dates/suggestions` 🔒
Returns up to 10 advisory suggestions for people already visible through shared zones. It reuses the shared-zones verified-activity, active-zone, consent-expiry, banned-user and bidirectional block filters, and preserves the shared-zones `sometimes` / `often` activity bucket. Each item contains the existing public person fields, a shared zone, the next Thursday as a date-only value, and a coarse one-hour slot. The slot is the most active campus-local hour in that zone over the last 30 days only when at least 3 distinct users were active in that hour; otherwise it uses `18:00–19:00`. Activity history contributes only to this zone-wide aggregate, never an individual's routine. Suggestions are read-only: they do not create meetups, invitations, notifications, or stored rows. Dismissals are not remembered; persistence would require a separate product and privacy decision.

### `GET /v1/map/features` 👤
A GeoJSON `FeatureCollection` of active zones for the map layer: zone geometry, `geometry_source`, and a territory summary (state and a generic owner type). Contains no owner identity, no presence and no user positions.

### `GET /v1/activity/active-count` — `{ "active_now": n, "as_of" }`

---

## Bubble — ephemeral proximity

An opt-in layer for "who is around me right now". Joining reduces the caller's position to a **~250 m grid cell** and the zone containing it (PostGIS `ST_Contains`); the coordinates are then discarded — never stored, logged or returned. Members see other members in their own cell and the 8 cells around it (3×3). Membership lasts 15 min (`BUBBLE_TTL_MINUTES`) and is refreshed by joining again; a sweep every minute deletes expired members and members whose Open to Meet has lapsed. Turning Open to Meet off leaves the bubble at once.

Nobody is listed unless their Open to Meet is current, and nobody blocked in either direction (Social's list ∪ the local table) is ever listed or sent an event. If the block set cannot be read, lists are empty with `hidden_reason: "blocks_unreachable"` and no events are sent.

```jsonc
PersonCard { "person": { "user_id", "display_name", "avatar_url", "hostel", "connection_mode", "bio", "level", "xp" },
             "activity": { "type": "run"|"walk"|"workout", "started_at": iso|null } | null,
             "proximity": "very_close" | "nearby" | "on_campus" | null,   // bubble: same cell | touching cell
             "zone": { "id", "name" } | null,
             "states": ["nearby"|"active_nearby"|"recently_active"|"same_zone"|"same_campus"|"same_activity"],
             "last_seen_at": iso }
```
`level` comes from the XP read cache. `states`: `nearby` in my 3×3 neighbourhood; `active_nearby` nearby with a live activity (recorded, or declared on join); `recently_active` no live activity but one started in the last 2 h; `same_zone` in my zone; `same_campus` always; `same_activity` the same activity type as mine. No coordinates, distances or cells appear in any response or event.

### `POST /v1/bubble/join` 🔒 — rate limit 6/min
Body `{ "lat", "lng", "accuracy_m"?, "activity_type"?: "run"|"walk"|"workout"|null }` (unknown fields → 422). Requires a current Open to Meet: otherwise **409 `open_to_meet_required`**. Off campus → `200 { accepted: false, reason: "off_campus", …state }` and the caller leaves the bubble. Idempotent upsert: joining again refreshes the TTL, moves the cell, and changes `activity_type` only when the field is sent.
→ `{ "accepted": true, "reason": null, …BubbleState }`

### `POST /v1/bubble/leave` 🔒 → `204` (also when not a member)

### `GET /v1/bubble` 🔒 — the caller's own state (no parameters; there is no way to read someone else's)
```jsonc
BubbleState { "in_bubble": bool, "zone": { id, name }|null, "expires_at": iso|null, "activity_type": …|null,
              "counts": { "nearby", "active_nearby", "same_zone", "same_activity" },   // after block filtering
              "hidden_reason": null|"open_to_meet_off"|"blocks_unreachable", "as_of" }
```

### `GET /v1/bubble/nearby?state=&limit=20&cursor=` 🔒
`{ "items": [PersonCard], "next_cursor": string|null, "in_bubble", "hidden_reason": null|"open_to_meet_off"|"not_in_bubble"|"blocks_unreachable", "as_of" }`. Ordered same cell first, then most recently refreshed. `state` filters by one of the states above; `limit` 1–50; `cursor` is the opaque `next_cursor` (keyset; it carries no user id).

---

## Discover

Read-only aggregation of campus-owned data. All routes 🔒, block- and consent-filtered, never return coordinates, distances, exact visitor counts or another person's history. Lists share one shape: `{ "items": […], "next_cursor": string|null, "hidden_reason": string|null, "as_of" }` with `limit` 1–50 (default 20) and keyset `cursor`; unknown query parameters → 422.

### `GET /v1/discover`
`{ "nearby": [PersonCard ≤5], "active": [PersonCard ≤5], "challenges": [DiscoverBattle ≤5], "zones": [DiscoverZone ≤5], "crews": [DiscoverCrew ≤5], "reasons": { "<section>": null|reason }, "as_of" }`. A section that cannot be served is `[]` with its reason (`open_to_meet_off`, `location_unknown`, `blocks_unreachable`, `crew_names_unavailable`, or `unavailable`); the response never fails as a whole.

### `GET /v1/discover/nearby?activity_type=&zone_id=&sort=proximity|recent`
People near the caller who opted in: bubble members in the 3×3 neighbourhood plus people whose presence is within 800 m of the caller's (each listed once). Requires the caller's own Open to Meet (`hidden_reason: "open_to_meet_off"`) and a bubble membership or live presence (`"location_unknown"`). Items are PersonCards; proximity is a bucket only.

### `GET /v1/discover/active?activity_type=&sort=recent|level`
People with a live recorded activity whose Open to Meet is current. `proximity` is filled only when the caller is open to meet too (as on `/v1/people/active`).

### `GET /v1/discover/challenges?type=territory|weekend_war|zone_race|group_activity&zone_id=`
Territory battles (`pending|accepted|active`) the caller is part of: created by them, targeting them, or targeting a crew they belong to (Social membership). Never other people's invites; battles with someone blocked either way are left out. `DiscoverBattle` = `Challenge` + `{ "relation": "yours"|"incoming"|"crew", "zone_qualified": bool, "near_you": bool }`, ordered near-you first, then zones the caller qualifies in, then `starts_at`. Also returns `crew_battles_unavailable` (as the battles list).

### `GET /v1/discover/crews`
`DiscoverCrew { "crew": { id, name, color, icon }, "zones_held" }`, ranked by zones held (campus owns that number). Names come from Social; no member lists. While Social is unreachable crews are listed by id with an empty name and `hidden_reason: "crew_names_unavailable"`.

### `GET /v1/discover/zones?sort=popular|contested|unclaimed`
`DiscoverZone { "zone": { id, name, kind }, "territory": { "status": "unclaimed"|"claimed"|"contested", "owner_type": "none"|"user"|"crew" }, "popularity": "low"|"medium"|"high"|null, "contested": bool }`. Popularity = distinct verified users with a non-pass-through visit in the last 7 days, shown only as a bucket and only when at least 3 users (k-anonymity, as the heatmap); `popular` lists only those zones, ordered by bucket then name. `contested` = contested, under challenge, or an accepted/active battle there. No owner identity.

---

## Territory battles (routes: `challenges` / `challenge-invites`)

Named **territory battles** per ADR-032, to distinguish them from two other features that share the word "challenge" in the app's vocabulary but are different things owned by different services:

| name | what | owner |
|---|---|---|
| **Duels** | 1-vs-1: most verified km or most workouts in 1–30 days | Social |
| **Goals** | a target (metric, comparator, threshold, window) with an XP reward | Run Module |
| **Territory battles** | zone race, territory, weekend war — the winner decided from territory state | campus-service (this API) |

The routes and the table here keep the `challenges` name; only the documented vocabulary changes.

Types: `territory` (needs zone; user or crew), `weekend_war` (crew), `zone_race` (needs zone; user), `group_activity` (user or crew).
States: `pending → accepted → active → completed`; `pending → declined | cancelled | expired`; `accepted → cancelled`.
All routes exist under both `/v1/challenge-invites` and `/v1/challenges`.

### `GET …/types` — `{ "types": [{ id, label, description, requires_zone, targets }] }`
### `GET …?box=incoming|outgoing|all` 🔒 — `{ "invites": [Challenge…], "challenges": [same], "crew_battles_unavailable": boolean }`
```jsonc
Challenge { "id", "type", "type_label", "from": Person, "target": { "type": "user", "person": Person } | { "type": "crew", "crew": {…} },
            "zone": { id, name }|null, "starts_at", "ends_at", "message", "status", "direction": "incoming"|"outgoing",
            "created_at", "started_at", "completed_at", "result": { "winner": Person|Crew|null, "summary" }|null,
            "actions": ["accept"|"decline"|"cancel"|"schedule"|"start"|"complete"],
            "actions_status": "ready"|"crew_role_unavailable" }
```
`actions` lists the actions this caller may take now; it is also enforced by the action routes. `actions_status: "crew_role_unavailable"` means Social could not confirm crew membership, so role-dependent actions may be missing; retry after Social is reachable. This keeps the client from treating unavailable role data as a confirmed lack of permission.
Crew-targeted rows are returned only when the caller's membership is known (from a fresh or stale cached lookup); membership is never guessed during an outage. On a cold start with no cached membership, crew rows are omitted and `crew_battles_unavailable` is `true`, so the client can show a retry state without exposing another crew's challenge or message.
### `POST …` 🔒 — rate limit 20/h
Body `{ "type", "target": { "type": "user"|"crew", "id" }, "zone_id"?, "starts_at": iso, "ends_at"?: iso, "message"? }` → `201 Challenge`. 422 on bad combos (self-challenge, missing zone, past start), 404 unknown target/zone, 409 `challenge_conflict` if an open challenge already exists for the same target+zone. A block in either direction prevents creating one against a user (`404 not_found`, as the person is hidden), and fails closed (503 `blocks_unreachable`) when the block set cannot be read.
### `PATCH …/:id/schedule` 🔒 — creator only while `pending|accepted`; body `{ "starts_at", "ends_at"? }`.
### `POST …/:id/accept` · `/decline` 🔒 — invited side only (crew: owner/admin). 403 otherwise, 409 unless `pending`. Accepting a battle from someone blocked in either direction is refused as `404 not_found` (503 `blocks_unreachable` when the block set cannot be read); declining stays possible.
### `POST …/:id/cancel` 🔒 — creator only; `pending|accepted`.
### `POST …/:id/start` 🔒 — any participant; `accepted` and within 15 min of `starts_at` (accepted challenges also auto-activate at `starts_at`).
### `POST …/:id/complete` 🔒 — any participant; `active` and past `ends_at`. **The winner is decided by the server** from territory state (`territory`/`zone_race`: whoever holds the zone; `weekend_war`: crew zone counts). Body is ignored.

Every transition emits `challenge.created|updated` (and app alias `invite.updated`) to all participants and a notification to the other side.

---

## Leaderboards & stats

### `GET /v1/leaderboards/squirrels?period=daily|weekly|alltime&limit=10&metric=xp|zones|distance` 👤
`{ "period", "metric", "entries": [{ user_id, display_name, avatar_url, hostel, xp, zones_claimed, distance_m, rank }], "me": entry|null, "updated_at" }`. XP for `daily/weekly` is XP earned in the window; `alltime` uses lifetime campus XP. Cached 30 s.

### `GET /v1/leaderboards/hostels?period=` 👤
`{ "entries": [{ hostel_id, name, territories, active_members, distance_m, xp, score, rank }], "my_hostel_id" }`. `score = territories×100 + xp + distance_m/100 + active_members×5`.

> ADR-032: a board belongs to the owner of the number it ranks. The "zones held" boards are this service's; XP boards move to the Run Module's ledger once campus XP is reported there.

### `GET /v1/campus/stats` (app) — users_total, users_active_now, zones_total, zones_claimed, crews_total, zones_claimed_today, territory_changes_today, activities_today, active_squirrels_today, challenges_today, challenges_open, meetups_today, founding_spots_left (null). `crews_total` comes from Social, is cached for 60 seconds, and uses the last known count during a Social outage (zero before the first successful lookup).
### `GET /v1/stats/daily` (spec) — `{ date, active_squirrels, zones_claimed_today, crews, activities, territory_changes, meetups, challenges, users_active_now }`.

---

## Realtime — `GET /v1/realtime` (WebSocket)

```jsonc
→ { "type": "auth", "token": "<jwt>" }                      // optional; unlocks private topics
→ { "type": "subscribe", "topics": ["territories","stats","invites","activities","active","notifications","bubble"] }
→ { "type": "ping" }
← { "type": "auth.ok" | "auth.error" | "subscribed" | "pong", "data": … }
← { "type": "<event>", "data": … }
```
Default topics: `territories`, `stats`, `active`; after `auth` also `invites`, `activities`, `notifications`, `bubble`. Private events are only delivered to the users they concern.

| event | topic | data | note |
|---|---|---|---|
| `territory.claimed` / `territory.stolen` / `territory.defended` | territories | Territory | each also emits `territory.updated` (app alias) |
| `territory.contested` | territories | `{ zone_id, under_challenge: true }` | a rival became eligible while unshielded |
| `territory.released` | territories | Territory | reserved for future decay/release |
| `zone.updated` | territories | Zone | zone metadata/geometry changed |
| `challenge.created` / `challenge.updated` | invites (private) | Challenge | also `invite.updated` |
| `activity.verified` | activities (private) | `{ activity_id, status, app_status, zones:[{zone_id, qualified}] }` | |
| `active.updated` | active | `{ active_now }` | |
| `stats.updated` | stats | reserved | |
| `notification.created` | notifications (private) | notification item | |
| `bubble.user_joined` / `bubble.user_left` | bubble (private) | `{ person, activity, proximity, zone, state: "joined"|"left", at }` | to current, unblocked members of the member's 3×3 neighbourhood; on join of a new member (or moving into the neighbourhood), leave, expiry sweep, or moving out |
| `bubble.activity_started` / `bubble.activity_ended` | bubble (private) | same, `state: "activity_started"|"activity_ended"` | when the declared `activity_type` changes or a recorded activity starts/ends |

Bubble events never carry coordinates or distances, and at most one is sent per (member, recipient) per 60 s (`BUBBLE_EVENT_THROTTLE_S`); a client should refetch `/v1/bubble/nearby` on focus.

Events fan out across API instances via Postgres `LISTEN/NOTIFY`; a page that misses events should simply refetch on focus.

---

## Notification catalogue (forwarded to Social)

`territory.stolen` (to previous owner) · `territory.challenged` (to owner when a rival qualifies on an unshielded zone) · `territory.defended` (to repelled attackers) · `zone.claimed` (to crew mates) · `challenge.invitation` · `challenge.updated` · `meetup.invited` · `meetup.accepted` · `meetup.declined` (status only) · `meetup.cancelled` · `activity.verification_complete` · `bubble.activity` (to a user who joins a bubble with ≥3 other visible members; at most once per user per 6 h, dedupe key per 6-hour window; route `/bubble`) · reserved: `challenge.reminder`, `event.reminder`, `meetup.check_in`.

Social resolves `{actor}` and anonymizes it when the actor is unknown or either person has blocked the other. campus-service publishes `notification.created` only after Social returns a non-null notification id, and that id matches Social's list entry.

## Rate limits
Global 300 req/min per user (or IP when anonymous). Ownership writes 20/min. Point batches 60/min. Activity creation 50/day. Presence 10/min. Bubble join 6/min. Challenge creation 20/h. Exceeding → 429 `rate_limited`.
