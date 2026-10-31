# campus-service — architecture

## Where it sits

```
Expo app ──── Run Module (existing)        live run recording, XP, global anti-cheat
   │
   ├──────── progress-service (existing)   XP/levels/challenges of the fitness product
   │
   └──────── campus-service (THIS)         zones · territory · campus GPS activities · verification
                │                          qualification · claim/steal/defend · challenges · presence
                │                          leaderboards · notifications · realtime
                ▼
           PostgreSQL 16 + PostGIS 3       single datastore: tables, geo queries, job queue, pub/sub
```

The app uploads a finished run **twice**: once to the Run Module (fitness) and once to this service (`POST /v1/activities`), which runs its own GPS pipeline. The two are independent; this service never trusts anything the client says about distance, zones or eligibility. Identity comes from the shared RS256 bearer token; the account service is not part of this repo (see Production blockers in the README).

## Process model

* **API** (`src/index.ts`) — Fastify 5, one process per instance. Stateless apart from short in-process caches (user rows 5 s, leaderboards 30 s).
* **Worker** (`src/worker.ts`, or inline in the API with `WORKER_INLINE=1`) — pulls `verify_activity` jobs from the `jobs` table with `FOR UPDATE SKIP LOCKED`, so any number of workers can run. Wakes instantly via `NOTIFY campus_jobs`, otherwise polls.
* **Realtime** — every API instance holds one `LISTEN campus_events` connection; events published on one node are re-emitted on all. No Redis needed at launch scale.

### Deployment decision: inline worker for now

The verification worker deliberately runs in-process with the API (`WORKER_INLINE=1`). The current deployment is a single free-tier Render service, so a separate worker service is not available. On the free tier, the web service sleeps after inactivity; verification and every other task handled by the inline worker stop while it sleeps and resume when the service next wakes.

Revisit this decision as soon as a dedicated worker service exists. At that point the worker must run in **one place only**: disable the inline worker when running the standalone worker, or jobs can run twice.

## Data model (migrations/001_init.sql)

| table | purpose |
|---|---|
| `hostels`, `users` | JIT-provisioned profile rows keyed by JWT `sub`; `campus_xp`, `open_to_meet`, cooldown timestamp |
| Social | owns crews and memberships; campus-service stores Social crew ids on territories and challenges |
| `zones` | fixed polygons (SRID 4326, GiST), `zone_type` AREA/ROUTE, optional `required_route`, per-zone thresholds, `geometry_source` |
| `territories` | **one row per zone (PK = zone_id)** — single owner by construction; `version` monotonic; shield; counts |
| `territory_events` | append-only history: CLAIM/STEAL/DEFEND/RELEASE/DECAY with actor, previous owner, activity, XP, version |
| `activities`, `activity_points`, `activity_point_batches` | uploads; raw & cleaned LineString; server-derived stats; anti-cheat outcome; idempotent batches |
| `qualification_results` | one per (activity, zone): metric values, QUALIFIED/NOT_QUALIFIED/CLAIMED/EXPIRED, `expires_at`, `consumed_by_event_id` |
| `idempotency_keys` | stored responses for ownership writes |
| `jobs` | Postgres-backed queue |
| `presence` | last fix per user (never exposed raw), TTL 15 min; expired rows deleted every minute (`src/sweeper.ts`) |
| `bubble_members` | ephemeral proximity: ~250 m grid cell + containing zone, **no coordinates**, TTL 15 min, swept every minute |
| `challenges` | as named; notification records are owned by Social |

## The activity pipeline

```
POST /v1/activities (+points) ─┐
POST …/points ×N → POST …/finish┘→ activities.status = PENDING, raw_track = LineString, job queued
                                   │
                                   ▼  worker: verifyActivity()
      PROCESSING ─► scoreActivity() (pure, src/verification/anticheat.ts)
                     hard fails: no_points · too_long (> 6 h) · too_fast (raw avg > 6.5 m/s run / 2.5 walk)
                                 gps_jumps (> 25 % teleport segments) · too_short (< 200 m or < 60 s)
                     soft signals (weighted): jump ratio 0.25 · accuracy 0.15 · timestamp gaps 0.15 ·
                                 speed profile 0.20 · straightness · client/server distance ratio ·
                                 declared-vs-recorded window · device speed agreement · point density
                     score ≥ 0.75 VERIFIED · ≥ 0.45 PARTIALLY_VERIFIED (jump segments dropped, rest credited) · else REJECTED
                  ─► cleaned track (teleport endpoints removed) stored as activities.track
                  ─► computeZoneInteractions() (PostGIS, src/verification/geo.ts) for every zone the track intersects
                  ─► evaluateQualification() (pure, src/territory/rules.ts) → qualification_results
                  ─► realtime activity.verified · notification · territory.contested to owners of unshielded zones
```

**Zone qualification**

* *AREA* — `coverage = area(buffer(track ∩ zone, 15 m) ∩ zone) / area(zone)` ≥ threshold (default 0.6; per-zone override). Plus a minimum interaction: ≥ 30 s inside **or** ≥ 80 m inside (else `passed_through`).
* *ROUTE* — `route_completion = length(required_route ∩ buffer(track, 20 m)) / length(required_route)` ≥ threshold (default 0.8). Coverage of the surrounding polygon is irrelevant.
* An unverified (REJECTED) activity produces `NOT_QUALIFIED` rows only.
* A QUALIFIED result is valid for 24 h (`expires_at`) and is spent (`CLAIMED`) by exactly one claim/steal/defend.

## Ownership writes (src/territory/service.ts)

```
BEGIN
  SELECT users WHERE id=actor FOR UPDATE          -- serialises one user's actions; idempotency re-check
  SELECT territories WHERE zone_id=z FOR UPDATE   -- serialises all actions on the zone
  SELECT live QUALIFIED result FOR UPDATE         -- consumed exactly once
  computeActions(locked state)                    -- the same pure function every read endpoint uses
  UPDATE territories … WHERE version = <locked>   -- optimistic check on top of the lock
  INSERT territory_events; UPDATE qualification → CLAIMED; users.campus_xp += xp; cooldown; idempotency row
COMMIT → publish realtime + notifications
```
Lock order (user → zone) is fixed, so concurrent actors never deadlock. Two owners of one zone are impossible because `territories.zone_id` is the primary key. Integration tests fire 4 users at one zone in parallel and 5 identical requests from one user; exactly one write lands each time.

**Derived state** — `under_challenge` is computed at read time (`a rival holds a live QUALIFIED result AND the shield has lapsed`), never stored, so it can't go stale. `status` (`neutral / controlled / under_attack / contested`) is derived the same way.

**Rules** (all env-tunable): qualification TTL 24 h · shield after claim/steal/defend 2 h · user cooldown 60 s between actions · defend cooldown 60 min · XP 25/40/15.

## Privacy

* Presence stores an exact point but every read returns buckets (`very_close/nearby/on_campus`) or 100 m grid cells.
* Nearby lists require **mutual** open-to-meet; `active` lists never include location.
* Activities and their tracks are visible only to their owner. Zone statistics are aggregates.
* Anti-cheat internals (`anti_cheat_score`, `verification_signals`, machine reason) are server-only; clients get a band and a friendly sentence.

## Security

* JWT verified against JWKS or PEM (RS256); dev HS256 only outside production. Banned users get 403 everywhere.
* Every ownership-changing write: authenticated, idempotent, transactional, rate-limited, re-validated server-side.
* Zod validation on every body/query; body limit 2 MB; global + per-route rate limits keyed by user.
* Nothing the client sends about eligibility, distance, verification, winners or zones is ever read.

## Extending

* **New zone** — insert into `zones` (+ a `territories` row); the seed shows the shape. Geometry source should be `survey`/`osm`.
* **New rule** — add to `config.rules`, thread through `computeActions` (pure) and its unit tests.
* **New event** — add the type to `RealtimeEvent`, map it to a topic in `ws.ts`, publish from the service.
* **Notifications and push delivery** — Social owns the list and Expo push delivery. campus-service forwards notification events and relays Social's id over realtime; its local notifications table is pending removal.
