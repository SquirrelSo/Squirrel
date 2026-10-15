# Squirrel Social — campus-service

Backend for the IISER Kolkata territory / GPS-activity / claims / territory-battles / social-map system.
Node 20+ · TypeScript · Fastify 5 · PostgreSQL 16 + PostGIS 3. No other infrastructure.

* **docs/API.md** — every endpoint, body, response, error code
* **docs/ARCHITECTURE.md** — how verification, qualification and claims work
* **docs/GEOGRAPHIC_DATA_REQUIRED.md** — what must be surveyed before launch
* **docs/decisions/ADR-032-service-ownership.md** (repo root) — which service owns which concept

## Run it locally

```bash
# 1. PostGIS (either)
docker compose up db -d                        # postgis/postgis:16-3.4 on :5432
#   or: createdb campus && psql campus -c 'CREATE EXTENSION postgis'

# 2. Service
cp .env.example .env                           # DATABASE_URL, AUTH_DEV_HS256_SECRET are enough for dev
npm install
npm run migrate                                # applies migrations/*.sql once each
npm run seed                                   # hostels, the 23 OSM zones (src/seed/zones.osm.json), dev users
npm run dev                                    # API on :8080 with the verification worker inline

# 3. A dev token (HS256, dev only)
export T=$(npm run -s dev:token -- u_aanya "Aanya" aanya@iiserkol.ac.in)
curl -s localhost:8080/v1/zones | jq '.zones | length'
curl -s -H "Authorization: Bearer $T" localhost:8080/v1/me | jq .display_name
```

Point the Expo app at it: `EXPO_PUBLIC_CAMPUS_SERVICE_URL=http://<lan-ip>:8080` (the app appends `/v1`); realtime is `ws://<lan-ip>:8080/v1/realtime`. The app routes only the methods listed in `CAMPUS_SERVICE_METHODS` (`mobile-4/src/api/campus/campusShapes.ts`) here — everything else goes to the Social service. **Adding an endpoint here is not enough: it must be added to that list or the app will never call it.**

## Scripts

| command | what |
|---|---|
| `npm run dev` / `npm start` | API (+ inline worker when `WORKER_INLINE=1`) |
| `npm run dev:worker` / `npm run start:worker` | standalone verification worker (run ≥ 1 in prod, set `WORKER_INLINE=0` on the API) |
| `npm run migrate` · `npm run seed` | schema · dev data (seed is idempotent and never overwrites non-placeholder geometry) |
| `npm run seed:zones` | hostels + placeholder zones only (no dev users, no dev crew) |
| `node dist/db/migrate.js` · `node dist/seed/run.js --zones-only` | the same from the production image (no `tsx` there) |
| `npm run typecheck` · `npm run build` | tsc |
| `npm test` | unit tests (no DB) + integration tests (need `TEST_DATABASE_URL`, see below) |

## Tests

```bash
npm run test:unit                                                          # GPS validation, anti-cheat, rules, privacy — 40 tests
TEST_DATABASE_URL=postgres://campus:campus@localhost:5432/campus_test npm run test:integration   # 110 tests, DB is reset per file
```
The test database needs PostGIS available (`CREATE DATABASE campus_test`; the migrations run `CREATE EXTENSION postgis`). Every integration file drops and recreates the `public` schema, so never point `TEST_DATABASE_URL` at a real database.

Integration coverage: verified → qualified → claim; duplicate claim; unverified/pending/insufficient → cannot claim; steal (shield, unqualified, owner, success + notification); defend (owner-only, under-attack-only, spends attackers' eligibility); 4 concurrent claimers → exactly one owner; 5 identical requests → one write; ROUTE zone loop vs cut-through; invalid GPS payloads (malformed, backwards time, teleport, accuracy, off-campus); batch upload + idempotent batches + finish; presence never exposes coordinates, nearby needs mutual open-to-meet; territory-battle lifecycle with server-decided winner; auth/404 behaviour; crews, meetups, shared zones, Squirrel Dates, heatmap, post-meetup ratings; blocks read from Social (union with the local table, 404 and outage both fail closed, the 30-second cache expiring); the Social identity bridge against a fake Social server (profile ids out and in, Social names, realtime frames, Social down/timeout/401 fallback, bridge off).

## Identity bridge to Social

Users are keyed by the JWT `sub` internally. The Social service owns the public identity: a **profile id** (≠ `sub`), display name, avatar, hostel. Set `SOCIAL_API_URL` **and** `SOCIAL_INTERNAL_TOKEN` to turn the bridge on (either unset = off in development, and the service refuses to start in production):

* **Out** — user ids in campus HTTP responses and realtime frames (incl. `auth.ok`) are the Social profile id; `display_name`/`avatar_url` come from Social, `hostel` from Social when it has one. Notifications are owned and rendered by Social; campus sends actor subjects and `{actor}` templates rather than actor names. One central step (`src/identity/translate.ts`) runs in the `preSerialization` hook and in `realtime/ws.ts`; it rewrites the fields listed in `USER_ID_KEYS` and every person-shaped object (`user_id` + `display_name`).
* **In** — ids clients send (`/v1/users/:id`, `…/context`, `…/block`, meetup `invitee_ids`, challenge `target.id`, crew `transfer_to`) may be profile ids; `src/identity/inbound.ts` resolves them to subs before the handler runs. An id that doesn't resolve is used as-is (existing campus ids keep working; unknown ids 404 as before).
* **Stored names** — first sight of a user and every cache refresh write Social's name/avatar into `users`, so server-built text ("Aanya stole CC1 from you") uses real names. With the bridge on, `PATCH /v1/me` `display_name`/`avatar_url` are overridden by Social on the next refresh — edit the Social profile instead.
* **Failure (names)** — `POST {SOCIAL_API_URL}/internal/v1/people/resolve`, batched (≤ 200), cached 5 min both ways, 3 s timeout, 30 s back-off after a failure. Social down / 401 / 404 → a warning is logged and campus data is used (id = sub, campus name); a request never fails because of Social. Names may be stale; that is harmless.

## Blocking (owned by Social)

ADR-032 makes **Social** the owner of blocks. The app's Block button writes there, not here. This service reads the caller's full block set from `GET {SOCIAL_API_URL}/internal/v1/blocks/{sub}` (internal token), caches it for **at most 30 seconds**, and unions it with its own local `blocks` table during migration.

**Block checks fail closed**, unlike the name lookup above. If Social cannot be reached and no answer under 30 seconds old is cached:

* lists that filter people — Nearby, Active now, map players, shared zones — return **empty** with `hidden_reason: "blocks_unreachable"`;
* actions between two people (meetup invite, territory battle) are refused with a retryable **503 `blocks_unreachable`**.

There is no stale-cache fallback. Fewer people shown is correct; a blocked person shown is not. A 404 from Social counts as unreachable, not as "no blocks" — the route returns 200 with an empty list for a person Social has not seen, so a 404 only ever means the route is missing or the token is wrong.

Two things deliberately do **not** check blocks: stealing a zone (blocking a rival must not make your territory unstealable, and a refusal would tell the blocked person they are blocked), and `/v1/users/:id/context`, which returns a plain 404 for a blocked pair — the same answer as a user who does not exist.

Deploy order: Social first, then this service.

## Production checklist

1. `NODE_ENV=production`, `AUTH_JWKS_URL` (or `AUTH_PUBLIC_KEY_PEM`) — the API refuses to start without a key source. For the Exercise backend's tokens use `AUTH_JWKS_URL=https://<exercise-host>/api/auth/jwks.json` and leave `AUTH_ISSUER`/`AUTH_AUDIENCE` **empty** (those tokens carry neither claim). `AUTH_DEV_HS256_SECRET` is ignored in production.
2. `SOCIAL_API_URL` + `SOCIAL_INTERNAL_TOKEN` — **required in production**; the API exits at start-up without both. Unset would mean every block check silently passing, so this fails loudly instead.
3. Replace placeholder zone geometry (docs/GEOGRAPHIC_DATA_REQUIRED.md). Until then every zone carries `geometry_source: "dev_placeholder"` and clients should render it as approximate.
4. Run ≥ 1 worker process; `WORKER_INLINE=0` on API instances. On a single-service deployment `WORKER_INLINE=1` is the documented compromise — the worker then sleeps when the service does.
5. `REALTIME_PUBLIC_URL=wss://…/v1/realtime`, `CORS_ORIGINS` for any web origins (comma-separated; `https://squirrel-*.vercel.app` style patterns allowed, `*` = letters, digits, hyphens).
   The JWKS is fetched at start-up and kept 12 h (an unknown key id refetches at once). If it can't be fetched (`AUTH_JWKS_TIMEOUT_MS`, default 15000) requests get `503 auth_unreachable`, not 401, so clients keep their session and retry.
6. TLS termination and WebSocket pass-through at the load balancer; `trustProxy` is on.
7. Backups; `pg_stat_statements` on; retention job for `idempotency_keys` (> 7 days), a trivial `DELETE` to schedule. (`presence` and `bubble_members` are swept every minute by `src/sweeper.ts`, in the worker and in the API when `WORKER_INLINE`.)

Container: `docker build -t campus-service .` — API by default, worker with `node dist/worker.js`.

### Deployment (Railway)

Docker runtime, source root `campus-service/` with the Dockerfile inside it, health check path `/healthz` (`/readyz` also pings the database). Env: `NODE_ENV=production`, `DATABASE_URL` (its own PostGIS database — not the shared app database), `AUTH_JWKS_URL` (above; `AUTH_ISSUER`/`AUTH_AUDIENCE` unset), `SOCIAL_API_URL`, `SOCIAL_INTERNAL_TOKEN`, `MIGRATE_ON_START=1`, `SEED_ZONES_ON_START=1`, `WORKER_INLINE` per the checklist, `CORS_ORIGINS`, `REALTIME_PUBLIC_URL=wss://<host>/v1/realtime`. The platform sets `PORT`.

Start-up runs migrations (each once, advisory-locked), then upserts the halls and the **23 OpenStreetMap zones** from `src/seed/zones.osm.json` (`geometry_source: "osm"`; the 16 hand-placed `dev_placeholder` zones in `src/seed/zones.ts` are only used, and switched off again, when that file is empty), then listens. `/v1/zones` should therefore return 23 zones, all `osm` (runbook health check).

Use a **session-mode** connection, not a transaction pooler: the realtime fan-out and worker use `LISTEN/NOTIFY`, and the migrator takes a session advisory lock. On Supabase that is the Session pooler on port 5432, not the Transaction pooler on 6543. The CA certificate referenced by `sslrootcert` must exist in the container — on Railway that means a volume mounted at `/etc/secrets` with `prod-ca-2021.crt` uploaded into it.

## In transit (ADR-032)

These live here today and are documented as moving:

| concept | moving to | state |
|---|---|---|
| Crews | Social | campus-service will read membership from Social; local crew tables retired |
| XP (`campus_xp`) | Run Module | claim / steal / defend awards reported to the Run Module's single ledger |
| Private profile details (`user_profile_details`) | Exercise | ADR-032 open item 1, decided — Exercise owns `PUT /api/me/profile-details`; campus-service rejects the field with 422; removal migration is at `migrations/pending/007_drop_profile_details.sql` — move it to `migrations/` and deploy once the production row count is confirmed 0 and this has been live for a release cycle |
| Badges | Social | `GET /v1/me/badges` returns an empty list here |

"Challenges" in this service are **territory battles** — zone race, territory, weekend war — distinct from Social's **Duels** and the Run Module's **Goals**. The routes and table keep the `challenges` name.
