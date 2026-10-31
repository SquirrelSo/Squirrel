# Squirrel Social

A campus social-fitness app for IISER Kolkata: GPS runs and walks, camera-coached workouts, XP and
levels, campus zone territory (claim, steal, defend), Discover/Bubble/Open to Meet, workout buddies
and shared workout races, a feed, crews, notifications and an ambassador programme.

One Expo app talks directly to four backends (no gateway). Production deploys from
`SquirrelSo/Squirrel`, branch `saheb`, to the Railway project `dazzling-analysis`.

## Where things live

| Directory | What | Stack | Railway service(s) (root directory = this folder) |
|---|---|---|---|
| [`mobile-4/`](mobile-4/README.md) | The app (Android APK via EAS, web) | Expo SDK 57, React Native 0.86, Expo Router, TS | — (`eas build --platform android --profile preview`) |
| [`Exercise_Mechanics--main/`](Exercise_Mechanics--main/README.md) | **Exercise**: accounts, sign-in, RS256 tokens + JWKS, private profile details, workouts and rep counting, coaching, Partner Hunt, shared workouts. `frontend-react/` is the browser coach | Python, FastAPI | `squirrel-exercise` |
| [`squirrel-social-profile-social-fixed/social-backend/`](squirrel-social-profile-social-fixed/social-backend/README.md) | **Social**: public profiles, follows, feed, posts, media, notifications + push, blocks, crews, events, dates, duels, badges, ambassador | Python, FastAPI, Alembic | `squirrel-social` |
| [`run-module/`](run-module/README.md) | **Run Module**: runs, GPS points, anti-cheat, run polygons, the single XP ledger, XP/hostel boards, Goals | Node 22, TS, Fastify, raw SQL, BullMQ | `squirrel-run-api`, `squirrel-run-worker` |
| [`campus-service/`](campus-service/README.md) | **Campus**: zones, zone territory, GPS verification for zones, presence, Discover, Bubble, Open to Meet, heatmap, shared zones, meetups, territory battles, realtime WS | Node 20+, TS, Fastify 5, zod, PostGIS | `squirrel-campus`, `squirrel-campus-worker` |
| [`docs/`](docs/) | Cross-service docs: [`api/FRONTEND-CONTRACT.md`](docs/api/FRONTEND-CONTRACT.md), [`decisions/`](docs/decisions/) (ADR-032 ownership, ADR-034 account deletion draft) | — | — |

The service folder names are kept as they are because each Railway service's **root directory** points at
them (runbook p.9). Renaming one means changing that Railway setting in the same deploy.

Architecture decisions live in two places: cross-service ones in [`docs/decisions/`](docs/decisions/)
(ADR-032 ownership, ADR-034 deletion draft) and the Run Module's in `run-module/docs/decisions/`
(ADR-001…027, 031, 033; numbers 014 and 028–030 do not exist in this repository).

## Ownership in one paragraph

Each service owns its data and asks the owner for the rest ([ADR-032](docs/decisions/ADR-032-service-ownership.md)).
Exercise issues RS256 JWTs (`sub` = account id); every other service verifies them via JWKS/public key.
Service-to-service calls use `SOCIAL_INTERNAL_TOKEN` or an Exercise-signed service JWT, never a user token.
The app only sees Social profile ids for people. Block checks fail closed; XP and name reads fail open
to the last cached value. "Challenges" are three different features (Social duels, Run Module Goals,
campus territory battles) and "territory" is two different models (Run Module run polygons vs campus
zone ownership). Never merge them.

## Databases

| Database | Used by | Migrations |
|---|---|---|
| Shared (Supabase, ap-southeast-1) | Exercise, Social, Run Module | `Exercise_Mechanics--main/backend/db/migrations/`, `social-backend/migrations/` (Alembic), `run-module/db/migrations/` (node-pg-migrate) |
| Campus (Supabase, ap-south-1, PostGIS) | campus-service only | `campus-service/migrations/` (`pending/` never runs) |

Both use the Supabase **Session pooler (port 5432)**. Migrations run on service start.

## Running every test suite locally

```bash
docker compose -f run-module/infra/docker-compose.yml up -d     # PostGIS on 5434, Redis on 6379
# then create the test databases once:
docker exec run_module_postgres psql -U postgres -c "CREATE DATABASE campus_test" \
  -c "CREATE DATABASE social_test" -c "CREATE DATABASE exercise_test" -c "CREATE DATABASE exercise_accounts_test"
```

| Service | Command (from the service folder) |
|---|---|
| Run Module | `cd backend && npm ci && npm run migrate && npm run typecheck && npm run build && npm test` (needs `backend/.env`, see `run-module/.env.example`) |
| campus-service | `npm ci && npm run typecheck && npm run build && DATABASE_URL=postgres://postgres:postgres@localhost:5434/campus_test TEST_DATABASE_URL=$DATABASE_URL npm test` |
| Social | `pip install -r requirements.txt && pytest -q` (SQLite by default; `SOCIAL_TEST_DATABASE_URL=postgresql+psycopg://postgres:postgres@localhost:5434/social_test` for PostgreSQL) |
| Exercise | `pip install -r requirements.txt && TEST_ACCOUNTS_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/exercise_accounts_test TEST_DATABASE_URL=postgresql://postgres:postgres@localhost:5434/exercise_test python -m pytest -q` |
| mobile-4 | `npm ci && npm test && npx tsc --noEmit && npx expo lint` |

## Shipping a feature

A working backend is not a reachable feature. All five, in order (runbook p.11):

1. The backend route exists and is deployed.
2. The app calls it at the right base URL (`mobile-4/src/api/*`).
3. The capability is on (`mobile-4/src/api/availability.ts`, `mobile-4/src/data/features.ts`).
4. A screen leads a user to it, starting from Home.
5. A new APK is built and installed.

Deployment status, open decisions and the engineering log are in [`agent_progress.md`](agent_progress.md).
