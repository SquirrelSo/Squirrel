# Squirrel Social — Agent Progress

## Overall Status

Current Phase: 10 — Final Deployment Readiness (complete)
Overall Status: All code work items that need no product/ops decision are done and tested.
Deployment Readiness: **Code: ready to ship to `saheb`. Launch to real students: NOT READY** until the
ops/legal blockers in "Deployment Blockers" are closed by a human (password rotation, account
deletion policy, privacy sign-off, test-domain removal).

Last updated: 2026-10-08.

---

# Phase 0 — Baseline & Repository Provenance

Status: Complete
Summary: Provenance established by direct comparison (no git metadata exists locally); baseline test
counts recorded for every suite before any change.

### Current Git State

- No `.git` anywhere in the workspace. `git status` fails in every folder. Production deploys from
  GitHub `SquirrelSo/Squirrel`, branch `saheb` (runbook p.4, p.8). This workspace is an extracted copy.
- Commit hashes in the brief (`map-calm.patch` → `2302e72`) cannot be verified here; `map-calm.patch`
  is not in the workspace (a copy exists in the user's Downloads folder, outside the project; untouched).
- The pristine archive of this tree exists at `C:\Users\taher\Downloads\squirrel-features\`; it was
  used read-only to diff and to restore three files the editor had auto-reformatted (see Phase 1).

### Repository Structure

Workspace root at the start:

| Path                                            | What it was                                    | Outcome                           |
| ----------------------------------------------- | ---------------------------------------------- | --------------------------------- |
| `squirrel-features/squirrel-features/`          | Canonical app (double nesting from extraction) | Flattened to `squirrel-features/` |
| `squirrel-backend-features/backend-features/`   | Older duplicate snapshot                       | Deleted (evidence below)          |
| `iiser-kolkata-map/mobile-4/` + 2 PNGs          | Abandoned campus-map experiment                | Deleted (evidence below)          |
| 16 `*.txt` audit scratch files                  | Audit output (WI-17)                           | Deleted                           |
| `CLAUDE_OPUS_IMPLEMENTATION_CONTEXT.md`, 2 PDFs | Hand-off docs                                  | Kept (outside the repo)           |

### Canonical Source

`squirrel-features/` (formerly `squirrel-features/squirrel-features/`): the only complete `mobile-4`,
all four backends, patches 0001–0007 all applied.

### Duplicate/Reference Sources

**`squirrel-backend-features/backend-features/` — deleted.** `diff -rq` (excluding node_modules etc.):
0 files unique to it; its `mobile-4` held only `featureContracts.ts`; all 10 differing files were older
versions (pre-patch 0006 `/explore` routes, pre-0007 contract types, re-exported patches 0001–0005).
No reference to it in any code, script, manifest or doc.

**`iiser-kolkata-map/` — deleted, nothing ported.** Its `src/features/campus` ran an on-device seeded
"Preview Season" (invented game state, forbidden by `mobile-4/AGENTS.md`), used a backend contract
(`/zones/:id/attack|capture|challenge`, `/territories`, `/crews`) that campus-service does not serve, and
client-side rules contradicting `campus-service/src/territory/rules.ts`. It imported
`features/world`, which exists nowhere. The canonical Map tab already replaced it with the
backend-driven map, and the canonical README had dropped those sections. Geometry: the canonical app
already has `api/campus/campusOsm.json` and `scripts/campus-osm.mjs`; campus-service seeds **23** OSM
zones (`src/seed/zones.osm.json`), matching the runbook's health check. The export's 24 zones were a
different, hand-derived geometry. This answers context Q5 from evidence: **23**.

### Patch Inventory

| Patch | Subject                                                             | State   |
| ----- | ------------------------------------------------------------------- | ------- |
| 0001  | run-module: XP award sources, reversal, stats and history           | applied |
| 0002  | campus-service: Discover, Bubble, meetup check-in XP                | applied |
| 0003  | social: notification preferences, quiet hours                       | applied |
| 0004  | exercise: shared-workout invites, cancel, once-only                 | applied |
| 0005  | docs: frontend contract                                             | applied |
| 0006  | campus-service, social: bubble.activity opens /bubble               | applied |
| 0007  | mobile-4: XP stats/history, Discover, Bubble, notification settings | applied |

Method: a scratch copy reverted 0007→0001 sequentially with zero failures; forward `--check` fails
for all seven. Nothing was (re)applied. `patches/` and `DIFFSTAT.txt` were then removed (the tree
contains every change; see Phase 1).

### Existing Tests (baseline, before any change)

| Suite                                               | Baseline                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------- |
| Run Module (vitest, fresh PostGIS)                  | 40 files, **367 passed**                                                    |
| campus-service (vitest unit + integration, PostGIS) | 31 files, **239 passed**                                                    |
| Social (pytest on PostgreSQL)                       | **259 passed**                                                              |
| Exercise (pytest, PostgreSQL)                       | **1268 passed, 1 failed, 33 errors** (stale test fixture, fixed in Phase 1) |
| mobile-4 (node tests / tsc / lint)                  | **174 passed** / clean / 0 errors, 16 warnings                              |
| Run Module lint                                     | 1092 errors, 149 warnings (pre-existing; not addressed)                     |

### Existing Build State

No dependencies were installed anywhere. Installed: `npm ci` (run-module/backend, campus-service,
mobile-4, Exercise frontend-react), Python venvs (Social, Exercise; gitignored). Docker Desktop was
started; `run-module/infra/docker-compose.yml` provides PostGIS on 5434 and Redis on 6379. Test DBs
created: `campus_test`, `social_test`, `exercise_test`, `exercise_accounts_test`.

### Initial Risks

1. No git: no history or rollback in the workspace (mitigated: verified copy-then-delete, pristine archive).
2. Service folder names are Railway root directories (runbook p.9): renaming breaks deploys.
3. Several P0/P1 items are gated on ops actions or product decisions (context §8, §12).

## Phase 0 Summary

### What was done

Provenance, patch verification, dependency install, local infra, baseline counts for all suites.

### Architecture changes

None.

### Files added

`agent_progress.md`.

### Files modified / removed / moved / consolidated

None in this phase.

### Bugs fixed

None.

### Tests run / results

All suites (table above).

### Remaining issues

None for this phase.

### Human decisions required

None.

### Deployment impact

None.

---

# Phase 1 — Architecture & Repository Refactor

Status: Complete
Summary: One canonical tree with obvious ownership; duplicates, applied patches, scratch files and
dead modules removed; a root README now maps the repository.

### Folder Changes

- `squirrel-features/squirrel-features/*` → `squirrel-features/*` (removes the extraction nesting; the
  repo root now matches `SquirrelSo/Squirrel`'s root, where `mobile-4/`, `run-module/` etc. live).
- Service folders **kept as-is** (`Exercise_Mechanics--main/`,
  `squirrel-social-profile-social-fixed/social-backend/`, `run-module/`, `campus-service/`,
  `mobile-4/`): each is a Railway service's configured root directory. See Human Decision 9.

### Files Moved

The whole canonical tree (one level up). `mobile-4/` and `run-module/` hit a Windows directory lock
and were moved by copy → `diff -rq` verified identical → delete.

### Files Consolidated

- Exercise test fixtures: three hand-maintained `DROP TABLE` lists (`test_database.py` ×2,
  `test_accounts_database.py`) → one `backend/tests/db_reset.py`. The lists had drifted (missing
  `shared_workout_sessions`, `partner_requests`), which caused the baseline's 1 failure + 33 errors.

### Files Removed

| Path                                                                                                                 | Evidence                                                                    |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `../squirrel-backend-features/`                                                                                      | Older duplicate; 0 unique files (Phase 0)                                   |
| `../iiser-kolkata-map/`                                                                                              | Superseded experiment with invented data (Phase 0)                          |
| `../*.txt` (16 audit scratch files)                                                                                  | WI-17                                                                       |
| `patches/` (0001–0007), `DIFFSTAT.txt`                                                                               | All applied and contained in the tree                                       |
| root `FRONTEND-CONTRACT.md`                                                                                          | Byte-identical copy of `docs/api/FRONTEND-CONTRACT.md`; unreferenced        |
| `run-module/backend/{evidence,test,test-script}.ts`                                                                  | Ad-hoc scripts; outside tsconfig/lint/vitest globs; unreferenced            |
| `mobile-4/src/art/Reward.tsx` (+ `RewardArtKind` type)                                                               | No importer anywhere                                                        |
| `mobile-4/src/components/social/PokeNotificationCard.tsx`                                                            | No importer; pokes render inline in `app/notifications.tsx`                 |
| `mobile-4/src/hooks/useResponsive.ts`                                                                                | No importer                                                                 |
| `campus-service/src/users/details.ts`                                                                                | No importer; last reader/writer of `user_profile_details` (WI-06 code part) |
| 6 unused `useRef` imports (mobile-4)                                                                                 | Lint warnings 16 → 10                                                       |
| `mobile-4/src/api/progress.ts` `leaderboard` + `PROGRESS_API_URL` / `PROGRESS_API_CONFIGURED` / `.env.example` entry | Never-set base URL, zero callers (WI-10)                                    |

Each deletion was checked for imports, dynamic imports, routes, scripts, manifests, Docker/Railway
config, docs and tests before removal.

### Duplicate Implementations Removed

- Duplicate repository tree, duplicate contract doc, duplicate (stale) test-table lists.
- Investigated and **kept** (not duplicates): `api/community.ts` (Social routes) vs
  `api/campus/community.ts` (campusApi façade); `api/campus/discover.ts` (campus Discover) vs
  `discovery.ts` (shared zones/heatmap/dates); `campusApi` is a deliberate composite adapter routing
  each method to campus-service or Social (the test suite asserts ambassador calls never reach campus).

### Tests

Exercise 1268+1F+33E → **1302 passed** after the fixture consolidation. mobile-4 174 passed, tsc clean.

### Remaining Issues

- `mobile-4/vercel.json` kept: the runbook says the Vercel project was deleted, but the file is the
  only record of the web build config (WI-14 says leave it).
- Run Module ESLint baseline (1092 errors) is pre-existing and was not addressed.

## Phase 1 Summary

### What was done

Flattened, removed duplicates/stale artefacts/dead modules, consolidated test fixtures, added root README.

### Architecture changes

Repo root = deployable monorepo root; ownership table in `README.md`.

### Files added

`README.md`, `Exercise_Mechanics--main/backend/tests/db_reset.py`.

### Files modified

`Exercise_Mechanics--main/backend/tests/test_database.py`, `test_accounts_database.py`; `mobile-4/src/types.ts`,
`mobile-4/README.md`; 6 mobile components (imports).

### Files removed / moved / consolidated

See tables above.

### Bugs fixed

Exercise DB-backed tests could not run against a migrated database (stale drop lists).

### Tests run / results

Exercise 1302 passed; mobile 174 passed.

### Remaining issues

None blocking.

### Human decisions required

Decision 9 (service folder renames).

### Deployment impact

None to services. The local tree must be carried into `saheb` by a human.

---

# Phase 2 — Security & Data Integrity

Status: Complete (code); ops/legal items handed to humans
Summary: Decompression bomb closed, token-type confusion closed in three verifiers, ambassador
gating made fail-safe, account deletion designed (ADR draft), repository scanned for secrets.

### Security Fixes

1. **WI-03 gzip bomb (Run Module).** `run-module/backend/src/api/routes/runs.ts`: `parseJsonBody`
   inflates with `zlib.gunzip(..., { maxOutputLength: route bodyLimit })` (10 MB on `/points`, 1 MB
   default elsewhere) → 413 `Payload Too Large` with a warning log; bad gzip / bad JSON → 400 (was a
   500); unknown `Content-Encoding` → 415 (was silently parsed as JSON); empty header = none.
   `requireAuth` moved from `preHandler` to `onRequest` on all four run routes, so unauthenticated
   clients are refused **before** a body is read or inflated; rate limits still run after auth, keyed
   by user id. The app never sends gzip (verified), so behaviour for it is unchanged.
2. **Token-type confusion.** Run Module `requireAuth`, campus `verifyBearer`, Social `TokenVerifier`
   now refuse any JWT whose `typ` is present and not `"access"`. Exercise issues only `access`
   (users) and `service` (`sub: exercise_module`, used only on the Run Module's `requireService`).
   Defence in depth: before, campus and Social would have provisioned a user named `exercise_module`
   from a service token.
3. **Ambassador gate fail-safe (Social).** `SOCIAL_AMBASSADOR_OPEN` opened applications for any value
   except off/0/false — including empty or misspelled. Now only on/1/true/yes opens.
4. **Secrets scan.** Private keys, AWS keys, Resend keys, JWTs, Supabase URLs with passwords, GitHub
   tokens, Google API keys, keystores, service-account files: **none committed**.
5. **Reviewed, no change needed:** CORS in all four services (explicit allow-lists, `*` never
   crosses a dot, no credentials); Social media uploads (content-type allow-list, size cap, verified on
   complete); campus refuses to start in production without JWKS/PEM and the Social bridge; dev HS256
   tokens disabled in production.

### Data Integrity Fixes

- campus: a meetup check-in on a **cancelled** meetup used to succeed, mark the guest accepted, notify
  others and could award `meetup_checkin` XP. Now 409 `meetup_closed`.
- campus: an invited guest checking in (implicit accept) now confirms a `proposed` meetup, as
  `/accept` does; before, such meetups never became `completed` and could never be rated.

### Migration Changes

- Added `campus-service/migrations/pending/drop_local_blocks.sql` (not applied; instructions inside).
- No applied migration was edited; no history rewritten.

### Tests

New: `runs.gzip.test.ts` (7), `verify-jwt.typ.test.ts` (3), campus `test/unit/auth-typ.test.ts` (2),
Social `tests/test_token_types.py` (2), `test_shared_settings.py` ambassador parse (10 cases),
meetup check-in tests (2). All pass.

### Remaining Issues

- **WI-01** `squirrelsocial.in` still accepted by `mobile-4/src/logic/accessSignup.ts` and by the
  server env lists — decision-gated (Decision 1).
- **WI-02** account deletion: design in `docs/decisions/ADR-034-account-deletion.md`; policy needed (Decision 2).
- OPS-1/2/3/4/5/6 (password rotation, access code, domain removal, storage keys, reviewer, privacy).

## Phase 2 Summary

### What was done

WI-03 fixed and tested; token-type hardening; ambassador gate; meetup data-integrity fixes; ADR-034 draft; secrets scan.

### Architecture changes

None (auth model unchanged: Exercise RS256 → JWKS; `requireAuth` vs `requireService` preserved).

### Files added

`run-module/backend/src/api/routes/runs.gzip.test.ts`, `run-module/backend/src/auth/verify-jwt.typ.test.ts`,
`campus-service/test/unit/auth-typ.test.ts`, `social-backend/tests/test_token_types.py`,
`docs/decisions/ADR-034-account-deletion.md`.

### Files modified

`run-module/backend/src/api/routes/runs.ts`, `run-module/backend/src/auth/verify-jwt.ts`,
`campus-service/src/auth/jwt.ts`, `campus-service/src/meetups/routes.ts`, `social-backend/app/auth.py`,
`social-backend/app/config.py`, related tests.

### Bugs fixed

Decompression bomb; 500 on malformed bodies; service-token-as-user; ambassador gate opening on bad config; cancelled-meetup check-in.

### Tests run / results

Run Module 375/375; campus 246/246; Social 270 passed (1 skipped by design).

### Remaining issues / Human decisions

Decisions 1, 2; OPS items.

### Deployment impact

Run Module: clients sending a non-gzip `Content-Encoding` now get 415 (none known). Social: if
`SOCIAL_AMBASSADOR_OPEN` is set to something other than on/1/true/yes it now reads as closed.

---

# Phase 3 — Backend Integration

Status: Complete
Summary: Every app↔backend contract was verified field by field by three parallel reviewers
(Exercise, campus, Social + Run Module); all mismatches found were fixed.

### Exercise

- Shared workouts: base URL is Exercise; all 11 routes + WS events match; 2 s polling fallback present.
  **Fixed:** who earned the finish XP only reached clients over the WebSocket; the session view now
  carries per-seat `rewarded` once settled (`backend/shared_workouts/model.py`), so polling clients
  and later visits show "+20 XP".
- Partner Hunt, profile details, sign-in: all match. Removal (`DELETE …/connections/{id}`) is silent by design.

### Social

- Named XP board, notification preferences, ambassador routes: match. Ambassador gate fixed (Phase 2).

### Run Module

- `/v1/xp/stats`, `/history`, `/v1/leaderboard/xp`, progress reads, Goals: match. WI-03 fixed.
- WI-12 (batched point insert) not done: optional perf item; current suite passes; see P2.

### Campus

- Meetups, Discover (no unknown query params are sent; server 422s them), Bubble, shared zones,
  heatmap, Open to Meet: match.
- **WI-07** `LEGACY_LOCAL_BLOCKS` switch added (default on = current behaviour). After the import, set
  it to 0: Social alone decides (fixes "unblock in the app is overridden by a stale campus row"); local
  block routes then answer 410 `blocks_moved`. Only an explicit off value disables the union.
- **WI-06** code part done (dead `details.ts` removed); the drop migration waits for a row count.
- Fixed: invitee 404 message read "… hasn't used the campus map yet not found".

### Workers

- Run worker (`src/workers/start.ts`) and campus worker (`dist/worker.js`): start commands match
  runbook p.9; covered by existing finalize/outbox and verification tests (all passing).

### Cross-Service APIs

- Block checks fail closed in both `LEGACY_LOCAL_BLOCKS` modes (tested with a fake Social: up, down, 404).
- XP awards (territory, meetup check-in, buddy, shared workout) keep their idempotency keys; tests pass.

### Tests

All backend suites green (Phase 8 table).

### Remaining Issues

- campus `POST /v1/activities` (one-shot zone copy) has no idempotency key; a retried upload after a
  lost response could store a duplicate activity (cannot grant extra XP or ownership). P2.

## Phase 3 Summary

### What was done

Contract verification of every live feature; fixes for shared-workout rewards, blocks retirement switch, meetup bugs.

### Architecture changes

None; ownership per ADR-032 preserved.

### Files added

`campus-service/migrations/pending/drop_local_blocks.sql`.

### Files modified

`Exercise_Mechanics--main/backend/shared_workouts/model.py`, `campus-service/src/{config.ts,blocks/service.ts,blocks/routes.ts,meetups/routes.ts}`, `.env.example`, tests.

### Files removed

`campus-service/src/users/details.ts`.

### Bugs fixed

Rewards invisible to polling clients; stale local blocks (switch); check-in/meetup lifecycle; doubled 404 text.

### Tests run / results

Exercise 1303; campus 246; Run 375; Social 270.

### Remaining issues

P2 activity idempotency; WI-12 optional.

### Human decisions required

OPS-8 (block import, row count).

### Deployment impact

New optional env `LEGACY_LOCAL_BLOCKS` on campus (default keeps today's behaviour).

---

# Phase 4 — Frontend Integration

Status: Complete
Summary: Leaderboard names, dead base URL removal, ambassador re-apply, sign-in validation, meetup
errors, capability reconciliation.

### Navigation (Home → feature, verified)

| Feature               | Path                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| Shared workout        | Home → Start Exercise → partner icon → `/workout/new` → `/workout/[id]`                            |
| Partner Hunt          | Social tab → Partner Hunt card (also from an empty shared-workout lobby)                           |
| Meetups               | Map → zone → Enter territory → "Plan a meetup here"; Profile → "Meetups & check-in"; notifications |
| Discover / Bubble     | Home → Map → Discover / Bubble chips                                                               |
| Leaderboard           | Home → "All boards", or Stats → "Campus XP rank"                                                   |
| XP history            | Home → Stats → "XP history"                                                                        |
| Notification settings | Bell → gear                                                                                        |
| Ambassador            | Avatar / Profile tab → "Become an ambassador"                                                      |

### API Clients

- **WI-04** verified: shared workouts call Exercise `/api/workout-sessions/*` + WS. No change needed.
- **WI-10** done: `progress.ts` now only has Run Module reads; `EXPO_PUBLIC_PROGRESS_API_URL` removed.
- **WI-09** done: `leaderboard.tsx` XP tab uses Social's named board for daily/weekly (names, avatars,
  hostels, tap → profile) and the Run Module board for monthly (ids only, "Squirrel", not tappable).
  Pure mapping in `src/logic/xpBoard.ts` with node tests. Social outage → retryable error, not "empty".

### Authentication

Sign-in code must be exactly 6 digits (non-digits stripped) — before, 4/5/7/8-digit codes produced a raw
validation error.

### Capabilities (WI-08 reconciliation)

| Capability                                                                           | Route / owner                          | App ↔ server fields        | Entry screen                  | Decision                                                                         |
| ------------------------------------------------------------------------------------ | -------------------------------------- | -------------------------- | ----------------------------- | -------------------------------------------------------------------------------- |
| sharedWorkout, sharedWorkoutInvites, buddyRemove                                     | Exercise                               | match                      | Start Exercise / Partner Hunt | on (unchanged)                                                                   |
| xpStats                                                                              | Run Module                             | match                      | Progress, XP history, boards  | on                                                                               |
| discover, bubble                                                                     | campus                                 | match                      | Map chips                     | on                                                                               |
| notificationPrefs                                                                    | Social                                 | match                      | Bell → gear                   | on                                                                               |
| ambassador, ambassadorProgramme                                                      | Social                                 | match (+`suspended` added) | Profile                       | on (Social keeps it closed until OPS-5)                                          |
| media, dateSuggestions                                                               | Social                                 | match (per ADR-032 note)   | compose / dates               | on                                                                               |
| sharedZones, heatmap, meetupRating, meetupCheckIn                                    | campus                                 | match                      | zone, map, meetup             | opted in automatically when campus-service is configured (`api/campus/index.ts`) |
| profileDetails                                                                       | retired `PATCH /v1/me profile_details` | campus returns 422         | —                             | stays off; About-you uses Exercise directly                                      |
| LOCKED events, stories, mealWater                                                    | —                                      | —                          | —                             | stay locked (Decision 4)                                                         |
| No capability needed flipping; `availability.test.mjs` unchanged (comments updated). |

### State / Error Handling

- Ambassador: a rejected applicant can re-apply once Social reopens the form; cooldown text shown;
  `suspended` no longer renders as "Pending".
- Meetup creation: distinct messages for unknown invitees vs an inactive zone.

### Feature Integration

Stale comments corrected (`meetup/[id].tsx` decline behaviour, `campusService.ts` `my_check_in_at`,
`availability.ts` capability notes).

### Tests

mobile-4: **179 passed** (+5 xpBoard), `tsc --noEmit` clean, lint 0 errors / 10 warnings (cosmetic
array-type style), Android production bundle exported (`npx expo export -p android`).

### Remaining Issues

- XP board now shows Social names; Social's board does not filter blocked users (same data the
  Squirrels tab already showed). Decision 7.
- Progress "#N this week" is a rolling 7 days while "This week" is Monday-start (wording, P2).
- On Social-only sources the Squirrels/Hostel tabs show 0 zones/territories (no source), P2.

## Phase 4 Summary

### What was done / Files

`mobile-4/src/app/leaderboard.tsx`, `src/logic/xpBoard.ts` (+test), `src/api/progress.ts`, `src/api/config.ts`,
`src/auth/AuthProvider.tsx`, `.env.example`, `src/app/ambassador.tsx`, `src/api/campus/types.ts`,
`src/app/sign-in.tsx`, `src/app/meetup/new.tsx`, `src/app/meetup/[id].tsx`, `src/api/campus/campusService.ts`,
`src/api/availability.ts`, `src/logic/sharedWorkout.ts`, `src/app/workout/[id].tsx`, `README.md`.

### Bugs fixed

Unnamed XP board; dead base URL; ambassador re-apply/suspended; sign-in code; meetup error text; rewards on poll.

### Deployment impact

**Needs a new APK** (`eas build --platform android --profile preview`), fresh install for sign-in testing.

---

# Phase 5 — Cross-Service Workflows

Status: Complete (verified by code trace + automated tests; no live production environment available)
Summary: Each workflow traced screen → client → base URL → auth → route → DB → worker/event → UI.

| Workflow                                             | Verified by                                | Status                     |
| ---------------------------------------------------- | ------------------------------------------ | -------------------------- |
| Authentication (email code, access code, refresh)    | Exercise tests; contract trace             | OK                         |
| Profiles (public via Social; About-you via Exercise) | Social + Exercise tests; trace             | OK                         |
| Social (follows, feed, blocks)                       | Social suite (270)                         | OK                         |
| Runs (create → points → finish → finalize)           | Run Module suite incl. E2E AC9             | OK                         |
| XP (derived; awards from campus/Exercise; caps)      | Run Module xp tests; campus/Exercise fakes | OK                         |
| Campus verification → territory claim/steal/defend   | campus territory tests                     | OK                         |
| Discover / Bubble                                    | campus discover/bubble tests; app trace    | OK                         |
| Meetups (create → accept/check-in → XP → rating)     | campus meetup tests (+2 new)               | OK (2 bugs fixed)          |
| Workouts / Partner Hunt / Shared workouts            | Exercise suite (1303)                      | OK (rewards-on-poll fixed) |
| Notifications (preferences, quiet hours, routes)     | Social tests                               | OK                         |

**WI-11 finding (GPS ingestion):** the app uploads a run's points to the Run Module (batches, during
finish) and then sends the same points once to campus `POST /v1/activities` for zone eligibility. Each
service receives them exactly once; campus never receives the Run Module run id. This is the
"one-shot copy" ADR-032 describes, but delivered by the app rather than by a service, so two
anti-cheat pipelines judge the same track independently. Decision 3.

## Phase 5 Summary

No code changes beyond those listed in Phases 2–4. Human decision: 3.

---

# Phase 6 — Missing Features

Status: Complete (classification)

### Implemented

WI-03, WI-04 (verified), WI-05 (meetups reachable end to end + 2 server fixes), WI-06 (code), WI-07
(code + switch), WI-08, WI-09, WI-10, WI-13 (recorded in `run-module/AGENTS.md`), WI-14, WI-15, WI-17.

### Already Implemented But Broken (fixed)

Meetup check-in lifecycle; shared-workout reward visibility; ambassador re-apply; sign-in code length.

### Still Missing

- Account deletion (WI-02) — ADR-034 draft, awaiting policy.
- Meetup safety-contact notifications: campus always answers `not_configured` (no contact storage exists anywhere). Product scope.
- Step counting (no pedometer source).
- Admin screen for ambassador review (reviewers use API routes).

### Human Decisions Required

See "Human Decisions Required" below (1–9).

---

# Phase 7 — Database & Migration Validation

Status: Complete

### Schema / Migrations

| Service        | Check                                                              | Result                      |
| -------------- | ------------------------------------------------------------------ | --------------------------- |
| Run Module     | `npm run migrate` on a fresh PostGIS (19 migrations)               | applied cleanly             |
| campus-service | migrator on fresh `campus_test` (001–012) via the test harness     | applied cleanly             |
| Social         | `alembic upgrade head` on a fresh DB (0001–0009) + `alembic check` | applied; **no model drift** |
| Exercise       | `backend/db/migrate.py` (001–009) on fresh DB via tests            | applied cleanly             |

### Indexes / Constraints

No changes made. Existing constraint tests pass (Exercise `test_the_database_itself_rejects_impossible_values`, etc.).

### Production Safety

- No applied migration edited. Pending (never run automatically): campus `007_drop_profile_details.sql`,
  `008_drop_notifications.sql`, new `drop_local_blocks.sql` — each with preconditions in its header.
- campus migrator tracks files by name, so a pending file can be promoted with any free number.

### Tests

All suites run against freshly migrated databases.

---

# Phase 8 — Testing & Quality Hardening

Status: Complete

| Suite                                    | Baseline                    | Final                                                                          |
| ---------------------------------------- | --------------------------- | ------------------------------------------------------------------------------ |
| Run Module typecheck / build             | clean / clean               | clean / clean                                                                  |
| Run Module vitest                        | 40 files, 367               | **42 files, 377 passed** (+10 new)                                             |
| campus typecheck / build                 | clean / clean               | clean / clean                                                                  |
| campus vitest (unit + integration)       | 31 files, 239               | **32 files, 246 passed**                                                       |
| Social pytest                            | 259 (Postgres)              | **270 passed, 1 skipped** (SQLite; +12 new; the skip is a Postgres-only guard) |
| Exercise pytest (Postgres)               | 1268 + 1 failed + 33 errors | **1303 passed**                                                                |
| Exercise web coach (vitest + vite build) | not run                     | **151 passed**, build OK                                                       |
| mobile-4 node tests / tsc / lint         | 174 / clean / 0E 16W        | **179** / clean / 0E 10W                                                       |
| mobile-4 production bundle               | not run                     | `expo export -p android` OK                                                    |

### Runtime Checks

Services were not started against production infrastructure (no credentials). Startup guards were
read (campus refuses prod without auth/Social; Social refuses without a verifier).

### Remaining Failures

None deterministic. `run-module/backend/src/workers/finalize_run/capture.test.ts` is intermittently
flaky in full-suite runs (seen in 3 of ~12 runs: 8, 8 and 2 failures, one of them while other suites
shared the Postgres container); it passes alone (8/8) and the final 5 consecutive full runs were
377/377. `run-module/AGENTS.md` already documents expected failures in `capture.test.ts` /
`snapshot.test.ts` from shared DB state; no capture or territory code was changed. Worth a follow-up
(isolate its fixtures). Run Module ESLint baseline (1092 errors) is pre-existing.

---

# Phase 9 — Production Hardening

Status: Complete (repo side)

### Environment

| Service                                                                                               | New / changed variables                                                                                                                   |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| squirrel-campus, squirrel-campus-worker                                                               | `LEGACY_LOCAL_BLOCKS` (optional; default = today's behaviour; set `0` after the block import)                                             |
| squirrel-social                                                                                       | `SOCIAL_AMBASSADOR_OPEN` now needs `on`/`1`/`true`/`yes` to open                                                                          |
| mobile-4 (EAS env)                                                                                    | `EXPO_PUBLIC_PROGRESS_API_URL` removed (was never set). `EXPO_PUBLIC_DEV_MOCKS` (runbook p.7) is read by nothing; can be deleted from EAS |
| Naming inconsistency documented, not changed: campus `CORS_ORIGINS` vs others `CORS_ALLOWED_ORIGINS`. |

### Deployment

Dockerfiles and Railway start commands reviewed against runbook p.9: unchanged and consistent.
Root directories unchanged.

### Health Checks

Exercise `/docs`; Social `/healthz`; campus `/healthz`, `/readyz`, `/v1/zones` (expect **23**, all
`geometry_source = osm`), `/v1/config` (`realtime_url` non-null); Run Module `/health`.

### Workers

Run worker `node --import tsx/esm src/workers/start.ts`; campus worker `npm run start:worker` (needs
`WORKER_INLINE=0` on the API).

### Mobile Build

New APK required for: leaderboard, ambassador, sign-in, meetup errors, shared-workout reward fallback.

### Security

See Phase 2. Confirm in Railway that `JWT_ALGORITHM=RS256` on every verifier (ADR-003); the Run Module
defaults to HS256 when unset.

### Observability

Gzip-limit hits log a warning with compressed size and limit. No new metrics infrastructure.

---

# Phase 10 — Final Deployment Readiness

Status: Complete
Summary: An independent reviewer re-read the full diff against the pristine archive: no P0/P1; its 12
P2 findings were fixed (9) or recorded (3: blocked users on boards, activity idempotency, ADR folders note).

### Final Validation

All suites green (Phase 8). Production bundles build.

### P0 Issues (launch blockers; all need humans)

1. OPS-1: rotate both Supabase DB passwords (exposed in chat).
2. WI-02 / ADR-034: account deletion (legal requirement) — policy decisions D1–D7.
3. OPS-6: privacy sign-off for student location data.

### P1 Issues

1. OPS-3 + WI-01: remove `squirrelsocial.in` from `SQUIRREL_ALLOWED_EMAIL_DOMAINS`, `CAMPUS_EMAIL_DOMAINS` and `accessSignup.ts` (Decision 1).
2. OPS-2: rotate `SIGNUP_ACCESS_CODE` before public launch.
3. OPS-4: set Social storage keys + `SOCIAL_MEDIA_PUBLIC_BASE_URL` (photo uploads).
4. OPS-8: run the block import, then `LEGACY_LOCAL_BLOCKS=0`; confirm `user_profile_details` count.
5. Build and install a new APK.

### P2 Issues

1. campus `POST /v1/activities` lacks an idempotency key (possible duplicate activity on retry).
2. WI-12 batched point insert (performance).
3. Social XP board shows blocked users (Decision 7).
4. Progress week wording; Social-only boards show 0 zones/territories.
5. Run Module ESLint baseline; 10 cosmetic mobile lint warnings.
6. Meetup safety-contact feature has no backend (always `not_configured`).
7. Run Module `capture.test.ts` is intermittently flaky in full-suite runs (shared DB state); isolate its fixtures.

### Deployment Blockers

Code: none. Launch: the P0 list above.

### Human Decisions

See below.

### Final Decision

**Ship the code to `saheb` (it is safe to deploy and backward compatible). Do not open to real
students until P0 1–3 are closed.**

---

# Repository Cleanup Summary

## Removed

`squirrel-backend-features/`, `iiser-kolkata-map/`, 16 audit `.txt` files, `patches/`, `DIFFSTAT.txt`,
root `FRONTEND-CONTRACT.md` duplicate, 3 run-module scratch scripts, 3 orphan mobile modules,
`campus-service/src/users/details.ts`, dead `progressApi.leaderboard` + `PROGRESS_API_*`, 6 unused imports.

## Consolidated

Exercise test table-drop lists → `backend/tests/db_reset.py`.

## Moved

`squirrel-features/squirrel-features/*` → `squirrel-features/*`.

## Renamed

None (service roots are Railway root directories).

## Retained For Reason

| Item                                                          | Why                                                                                              |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Service folder names                                          | Railway root directories (Decision 9)                                                            |
| `mobile-4/vercel.json`                                        | Only record of the web build config; no live project (WI-14)                                     |
| `campusApi` composite / `community.ts` pairs                  | Deliberate adapter layers, not duplicates                                                        |
| `profileDetails` capability                                   | Gates the retired field; test-covered; harmless                                                  |
| campus pending migrations                                     | Need production row counts / import first                                                        |
| `Exercise_Mechanics--main/frontend-react/src/engine/dummy.ts` | Static exercise descriptors for the browser coach (display config, not user data); WI-16 pending |
| Run Module antimeridian TODOs                                 | Legitimate future work; irrelevant at IISER's longitude                                          |
| `run-module/backend/.env` (local, gitignored)                 | Local test values only, needed to run the suite                                                  |

---

# Human Decisions Required

## Decision 1

Question: When is the `squirrelsocial.in` test domain removed (WI-01, OPS-3)?
Why required: It is the team's own sign-up path today; removing it locks the team out of direct sign-up.
Possible options: (a) now, team uses access codes; (b) at public launch.
Recommended option: (b) at launch, in one change: env vars on Exercise and campus + `mobile-4/src/logic/accessSignup.ts` + new APK.

## Decision 2

Question: Account deletion policy (ADR-034 D1–D7: hard delete vs anonymise, held zones, crews/events owned, grace period, block tombstones, retention, re-auth).
Why required: Legal requirement; product/legal values must not be invented.
Possible options: listed in ADR-034.
Recommended option: hard delete + anonymise only rows inside others' threads; zones neutral; no grace period; re-auth within 10 min.

## Decision 3

Question: GPS ingestion (WI-11): keep the app sending a one-shot copy to campus, or have the Run Module forward it?
Why required: Two anti-cheat pipelines judge the same track; architecture change.
Possible options: (a) keep as is; (b) Run Module worker posts finalized points to campus; (c) campus pulls from the Run Module.
Recommended option: (a) for launch (works, tested), (b) later.

## Decision 4

Question: Which locked features (events, stories, meal/water, date mode) are approved to unlock?
Why required: Product approval.
Recommended option: keep locked for launch.

## Decision 5

Question: Does `Run_Module_Implementation_Guide.pdf` exist? Did ADR-014/028–030 ever exist?
Why required: `run-module/AGENTS.md` names the PDF as authority (now annotated as missing).

## Decision 6

Question: Browser push-up demo: guest mode or sign-in first (WI-16)?

## Decision 7

Question: Should leaderboards hide people the viewer has blocked?
Why required: Social's `/v1/leaderboards/xp` does not filter blocks; ADR-032 does not list boards among block-checked surfaces.
Recommended option: yes — filter in Social's `_board` using `user_blocks`.

## Decision 8

Question: Should all guests declining cancel a meetup?
Why required: campus has unreachable code for it (`cancelledByResponses` is never set) and a "cancelled because everyone declined" notification that can never fire. Today the meetup stays `proposed`.
Recommended option: product call; then either implement or delete the dead branch.

## Decision 9

Question: Rename service folders (`Exercise_Mechanics--main` → `exercise/`, `squirrel-social-profile-social-fixed/social-backend` → `social/`)?
Why required: Clearer layout, but each is a Railway root directory; renaming without updating Railway stops deploys.
Recommended option: do it in one maintenance window: rename + update each service's Root Directory in Railway + update docs, then verify health URLs.

---

# Final Deployment Checklist

- [x] Repository structure cleaned
- [x] Duplicate repositories removed
- [x] Duplicate implementations consolidated
- [x] Unused files removed
- [x] Stale files removed
- [x] Security issues fixed (code); OPS-1/2/3/4 pending humans
- [x] Authentication verified
- [x] Backend integration verified
- [x] Frontend integration verified
- [x] Cross-service workflows verified (automated + trace; no production environment)
- [x] Database migrations verified
- [x] Workers verified (tests; start commands)
- [x] Critical tests passing
- [x] Production builds verified (web coach, Android bundle, TS builds)
- [x] Environment configuration verified (documented changes above)
- [x] Documentation updated
- [ ] No P0 blockers — 3 remain, all ops/legal (password rotation, deletion policy, privacy sign-off)
- [x] No P1 code blockers (P1 ops items listed)
- [x] Final deployment decision made: ship code; hold student launch on P0
