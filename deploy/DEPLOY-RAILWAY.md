# Railway deployment guide

This guide creates a new Railway production environment beside the existing
Render deployment. Render remains live and unchanged during setup and cutover.
Both Supabase databases remain the source of truth; Railway hosts application
services only.

Railway currently recommends TypeScript Infrastructure as Code (IaC) in one
`.railway/railway.ts` file for a project. This repo keeps the file at
`railway/railway.ts` to keep deployment configuration grouped away from
`render.yaml`; invoke it with `--file railway/railway.ts`. Railway evaluates
IaC with its CLI and previews changes before apply. The older per-service
`railway.json` and `railway.toml` format is deprecated.
[IaC overview](https://docs.railway.com/infrastructure-as-code) ·
[IaC TypeScript reference](https://docs.railway.com/infrastructure-as-code/reference) ·
[Dockerfiles](https://docs.railway.com/builds/dockerfiles)

## Before starting

Have access to the `SahebSandhuSingh/Squirrel` GitHub repository on branch
`saheb`, the Railway workspace and subscription, both Supabase projects, the
Vercel project, the email provider, Expo if push access tokens are enabled,
the Social zones JSON, and Supabase's `prod-ca-2021.crt`. Keep actual values in
Railway's dashboard only; this repository contains no secrets or connection
strings.

The four API services use the repository Dockerfiles as follows. Railway's
source root is each build context, and its default `Dockerfile` is at that
root. Run API and worker use the same Run Module Dockerfile and context.

| Railway service | Context / source root | Dockerfile inside context | Health check |
|---|---|---|---|
| `squirrel-exercise` | `Exercise_Mechanics--main/` | `Dockerfile` | `/` |
| `squirrel-run-api` | `run-module/` | `Dockerfile` | `/health` |
| `squirrel-social` | `squirrel-social-profile-social-fixed/social-backend/` | `Dockerfile` | `/healthz` |
| `squirrel-campus` | `campus-service/` | `Dockerfile` | `/healthz` |
| `squirrel-run-worker` | `run-module/` | `Dockerfile` (same build definition as Run API) | none; process worker |
| `squirrel-campus-worker` | `campus-service/` | `Dockerfile` (same build definition as Campus API) | none; process worker |

The API and worker are separate Railway services built independently from the
same Dockerfile and branch; they use the same image definition, with only the
worker's start command changed. Railway may build separate image artifacts for
the two services.

## Create and configure, in order

1. In Railway, create a new project named `squirrel-railway` and a `production`
   environment. Connect the GitHub repository `SahebSandhuSingh/Squirrel` and
   use branch `saheb`. This does not affect Render.
2. In **Project Settings → Shared Variables**, add the four shared variables
   listed below before applying IaC. Generate a fresh high-entropy
   `SOCIAL_INTERNAL_TOKEN`. Set the JWT pair for the RS256 plan before any
   client traffic is routed.
3. From the repository root, install the Railway CLI and IaC SDK, log in, and
   link to the new project/environment. Railway's TypeScript IaC SDK is the
   `railway` npm package; IaC is evaluated locally by the CLI.

   ```powershell
   npm install --prefix railway railway
   npm install --global @railway/cli
   railway login
   railway link
   railway config plan --file railway/railway.ts
   ```

   Review the plan: it should create the six app services, the Redis service,
   and six certificate volumes. It should not delete or edit Render resources.
   After review, apply it:

   ```powershell
   railway config apply --file railway/railway.ts
   ```

   IaC uses `preserve()` for dashboard-entered values. The first deployment can
   remain unhealthy until the required per-service values below are entered;
   add them, then redeploy the affected service. `ctx.shared.*` references
   existing Railway Shared Variables and does not create them.
   [Variables](https://docs.railway.com/variables) ·
   [CLI install](https://docs.railway.com/cli)
4. In each app service's **Variables** tab, enter its values from the map
   below. Seal sensitive credentials such as `MODERATION_TOKEN`, SMTP values,
   Expo token, `SOCIAL_INTERNAL_TOKEN`, and `JWT_PRIVATE_KEY`. The public RSA
   key in `JWT_SECRET` is not a private key.
5. The IaC file creates one separate volume per process that connects to
   Supabase, mounted at `/etc/secrets`. Railway volumes belong to one service,
   so upload a separate copy of `prod-ca-2021.crt` to each of these six
   volumes: Exercise, Run API, Run worker, Social, Campus API, Campus worker.
   Place the file at the volume root so it appears at
   `/etc/secrets/prod-ca-2021.crt`. Railway's volume browser supports file
   upload. Do not put the CA certificate in Git.
   [Volumes and file upload](https://docs.railway.com/volumes) ·
   [Volume CLI](https://docs.railway.com/cli/volume)
6. In each of the seven services, open **Settings → Deploy → Serverless** and
   leave **Enable Serverless** turned off. Railway's serverless sleep is an
   optional per-service toggle; it is not controlled by this IaC SDK. Check
   all seven, especially both worker services. A sleeping worker stops queue
   processing and scheduled jobs.
   [Serverless behavior](https://docs.railway.com/deployments/serverless) ·
   [Cost control settings](https://docs.railway.com/pricing/cost-control)
7. Generate a Railway public domain for each of the four web services in its
   **Settings → Networking** tab. Do not expose the workers or Redis publicly.
   Fill the service URL variables below after the domains exist. Use Railway
   private service DNS for server-to-server calls when the caller and target
   are in this project; use public URLs for the browser, JWKS URL, and public
   WebSocket URL.
   [Private networking](https://docs.railway.com/networking/private-networking)
   · [Railway domains](https://docs.railway.com/networking/domains)
8. Confirm the Redis service is private and that `maxmemory-policy` is
   `noeviction` (`redis-cli CONFIG GET maxmemory-policy`). Railway's Redis
   template runs the upstream Redis image; verify the effective setting before
   routing jobs, since the Run Module queues must not have keys evicted.
   [Railway Redis](https://docs.railway.com/databases/redis)
9. Check the four web health paths return HTTP 2xx, then validate login/JWKS,
   activity publication, Run queue processing, campus PostGIS access and
   realtime WebSocket updates. Railway health checks gate rollout on a 2xx
   response during deployment; they are not continuous monitoring.
   [Health checks](https://docs.railway.com/deployments/healthchecks)
10. Keep the app/web frontend on Vercel. Update its API base URLs only after
    Railway has passed the checks and the owner is ready to cut over. Render
    remains available and untouched as rollback: point Vercel back to the
    existing Render URLs and leave Railway domains unused.

## Shared variables

Create these in **Project Settings → Shared Variables** for `production`.
They are shared with all application services and workers; Railway's Redis
service does not need them.

| Name | Scope | Value source |
|---|---|---|
| `JWT_SECRET` | Shared | RS256 public-key PEM from the new key pair; placeholder here only: `<PUBLIC_RSA_KEY_PEM>` |
| `JWT_ALGORITHM` | Shared | Literal `RS256` |
| `XP_TIMEZONE` | Shared | Literal `Asia/Kolkata` |
| `SOCIAL_INTERNAL_TOKEN` | Shared | Generate a new random high-entropy service-to-service token in Railway |

## Service variables

`<...>` entries are placeholders, not usable values. Copy the actual credential
or URL from its authoritative dashboard into Railway. Use generated Railway
domains/private DNS after services exist. Keep `AUTH_ISSUER` and
`AUTH_AUDIENCE` unset: the Exercise tokens do not contain those claims.

| Service | Variable | Scope / source |
|---|---|---|
| Exercise | `DATABASE_URL` | Service; shared app Supabase project's Session pooler URL (format below), with the CA path |
| Exercise | `CORS_ALLOWED_ORIGINS` | Service; Vercel production origin and required preview origins, comma-separated |
| Exercise | `RUN_MODULE_URL` | Service; Run API HTTP base URL for Partner Hunt, from its generated public domain |
| Exercise | `SOCIAL_API_URL` | Service; Social HTTP base URL, preferably its private Railway address |
| Exercise | `EXERCISE_REQUIRE_AUTH` | Service; literal `1` |
| Exercise | `MODERATION_TOKEN` | Service; new strong random value, kept by owner/moderators |
| Exercise | `SQUIRREL_PUBLIC_BASE_URL` | Service; public web/app link origin, `<VERCEL_APP_ORIGIN>` |
| Exercise | `SQUIRREL_ALLOWED_EMAIL_DOMAINS` | Service; literal `ac.in` or the owner's approved domain list |
| Exercise | `SQUIRREL_EMAIL_VERIFICATION` | Service; literal `on` |
| Exercise | `SMTP_USER`, `SMTP_PASSWORD` | Service; email provider credentials, if using SMTP |
| Exercise | `RESEND_API_KEY`, `EMAIL_FROM` | Service; Resend key and verified sender, if using Resend instead of SMTP |
| Exercise | `JWT_PRIVATE_KEY` | Service-only; private RSA PEM from the new key pair, stored as a sealed multiline variable |
| Run API | `DATABASE_URL` | Service; same shared app Supabase Session pooler URL as Exercise/Social, with CA path |
| Run API | `CORS_ALLOWED_ORIGINS` | Service; Vercel production origin and required preview origins |
| Run API | `REDIS_URL` | Reference to `squirrel-redis`'s Railway-provided `REDIS_URL` |
| Run API | `MIGRATE_ON_START` | Service; literal `1` |
| Run API | `RUN_WORKERS_IN_API` | Service; literal `0` — dedicated worker is the only Run worker process |
| Run API | `SOCIAL_API_URL` | Service; Social HTTP base URL, preferably its private Railway address |
| Run API | `NODE_ENV`, `LOG_LEVEL` | Service; literals `production`, `info` |
| Social | `DATABASE_URL` | Service; same shared app Supabase Session pooler URL as Exercise/Run, with CA path |
| Social | `CORS_ALLOWED_ORIGINS` | Service; Vercel production origin and required preview origins |
| Social | `SOCIAL_RUN_MODULE_URL` | Service; Run API HTTP base URL, preferably private Railway DNS |
| Social | `SOCIAL_HOSTELS` | Service; current approved comma-separated hostel names from the owner |
| Social | `SOCIAL_ZONES` | Service; contents of `campus-zones.json` as JSON text in a sealed/multiline variable; optional |
| Social | `SOCIAL_ZONES_FILE` | Service; leave unset when using `SOCIAL_ZONES`; retained only for the Render file-path option |
| Social | `SOCIAL_APP_URL` | Service; Vercel web app origin, `<VERCEL_APP_ORIGIN>` |
| Social | `EXPO_ACCESS_TOKEN` | Service; Expo project access token if enhanced push security is enabled; otherwise unset |
| Campus API | `DATABASE_URL` | Service; campus PostGIS Supabase project's Session pooler URL, with CA path; never the shared app DB |
| Campus API | `AUTH_JWKS_URL` | Service; public Exercise URL plus `/api/auth/jwks.json` |
| Campus API | `SOCIAL_API_URL` | Service; Social HTTP base URL, preferably private Railway DNS |
| Campus API | `CORS_ORIGINS` | Service; Vercel production origin and required preview origins |
| Campus API | `REALTIME_PUBLIC_URL` | Service; `wss://<CAMPUS_RAILWAY_PUBLIC_DOMAIN>/v1/realtime` |
| Campus API | `NODE_ENV` | Service; literal `production` |
| Campus API | `MIGRATE_ON_START` | Service; literal `1` (only the API applies migrations) |
| Campus API | `SEED_ZONES_ON_START` | Service; literal `1` |
| Campus API | `WORKER_INLINE` | Service; literal `0` — only Campus worker runs verification/realtime jobs |
| Run worker | `DATABASE_URL` | Service; same shared app Supabase Session pooler URL as Run API, with its own CA volume |
| Run worker | `REDIS_URL` | Reference to `squirrel-redis`'s Railway-provided `REDIS_URL` |
| Run worker | `SOCIAL_API_URL` | Service; Social HTTP base URL, preferably private Railway DNS |
| Run worker | `RUN_WORKERS_IN_API` | Service; literal `0` |
| Run worker | `NODE_ENV`, `LOG_LEVEL` | Service; literals `production`, `info` |
| Campus worker | `DATABASE_URL` | Service; same campus PostGIS Session pooler URL as Campus API, with its own CA volume |
| Campus worker | `AUTH_JWKS_URL` | Service; public Exercise URL plus `/api/auth/jwks.json` |
| Campus worker | `SOCIAL_API_URL` | Service; Social HTTP base URL, preferably private Railway DNS |
| Campus worker | `NODE_ENV`, `WORKER_INLINE` | Service; literals `production`, `0` |

Railway injects `PORT`; each Dockerfile/application has its own listening-port
default. Do not add a `PORT` override unless the service's Railway settings
require one.

### Supabase connection strings and CA file

For the shared app database, copy **Connect → Session pooler** from its
Supabase project. For Campus, copy **Connect → Session pooler** from the
separate PostGIS Supabase project. Use the URI shape below with placeholders
only; URL-encode reserved characters in the password:

```text
postgresql://postgres.<PROJECT_REF>:<URL_ENCODED_PASSWORD>@<SESSION_POOLER_HOST>:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/prod-ca-2021.crt
```

Campus-service's own `README.md` explicitly requires session mode: realtime
uses PostgreSQL `LISTEN/NOTIFY`, and its migrator takes a session advisory lock.
The transaction pooler on port `6543` cannot preserve those session features
and breaks both. The other Run and Social processes also keep long-lived
database connections, so use the Session pooler there too. Supabase's current
connection guide identifies shared Session pooler on port `5432` and
Transaction pooler on `6543`.
[Campus production notes](../campus-service/README.md) ·
[Supabase connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)

The `prod-ca-2021.crt` file is mounted at
`/etc/secrets/prod-ca-2021.crt` in each of the six app/worker containers that
connect to Supabase. Railway volumes attach to one service, not a shared
environment group, so the IaC config creates six separate volumes and the
owner uploads one certificate copy to each.

### The three file-based inputs

These are verified against the applications' own source:

* **`jwt-private.pem`:** Exercise `backend/auth/tokens.py` reads the PEM from
  `JWT_PRIVATE_KEY` and accepts escaped newlines. Store the private PEM as a
  sealed, service-scoped `JWT_PRIVATE_KEY`; do not upload this file to a shared
  volume. Its public key PEM is `JWT_SECRET` in the shared group.
* **`prod-ca-2021.crt`:** the repo's `DEPLOY.md` uses
  `sslrootcert=/etc/secrets/prod-ca-2021.crt`; six individual Railway service
  volumes expose that path to each database-using process.
* **`campus-zones.json`:** Social `app/config.py` passes the `SOCIAL_ZONES`
  value to its JSON loader (`app/services/zones.py`); it also supports
  `SOCIAL_ZONES_FILE`. Set the JSON contents as a sealed/multiline `SOCIAL_ZONES`
  variable and leave `SOCIAL_ZONES_FILE` unset.

No real key, CA, zone JSON, database URI, or credential is stored in this
repository.

## Workers, scheduling, and sleep

The Run backend's `package.json` script is:

```text
worker = node --env-file=.env --import tsx/esm src/workers/start.ts
```

The Railway command in IaC is `node --import tsx/esm
src/workers/start.ts`: it invokes the exact same worker entry point while
omitting the local `.env` loader. The Run Dockerfile documents that `.env`
does not exist in the container and that Railway injects variables into the
process environment. Campus `package.json` defines
`start:worker = node dist/worker.js`; IaC runs it as `npm run start:worker`.

Workers must run in exactly one place. The config sets `RUN_WORKERS_IN_API=0`
on Run API and worker, and `WORKER_INLINE=0` on Campus API and worker. Both
dedicated worker services have one replica. If an API's inline worker is also
enabled, scheduled work runs twice; duplicate territory decay can expire
territory that should have survived. Leave migrations and zone seeding on the
API services only.

Railway Serverless is opt-in and per-service. Keep it **off on all seven
services**, especially both workers. The IaC TypeScript reference has no
Serverless setting; this is a required dashboard check in each service's
Settings → Deploy → Serverless page.

## JWT move to RS256

The fresh Railway environment must start with RS256 before it receives live
users. Create a new RSA key pair. Set shared `JWT_ALGORITHM=RS256`, shared
`JWT_SECRET=<PUBLIC_RSA_KEY_PEM>`, and Exercise-only
`JWT_PRIVATE_KEY=<PRIVATE_RSA_KEY_PEM>`. Seal the private key. Set Campus
`AUTH_JWKS_URL` to the Exercise public `/api/auth/jwks.json` endpoint. Social
and Run use the shared public key and RS256 algorithm. Leave token issuer and
audience unset. Verify login and token validation across Exercise, Run, Social,
and Campus before connecting Vercel clients.

This switch is safer in a fresh Railway environment with no live users than
changing the active Render environment: existing HS256 tokens would not verify
after changing algorithms. Render stays online with its current configuration
until the owner approves cutover.

## Health checks and validation

Configure the health paths through IaC. Check each API's Railway deployment
logs and make a request to confirm a 2xx response:

| Service | Path | Source check |
|---|---|---|
| Exercise | `/` | FastAPI mounts `StaticFiles(..., html=True)` at `/`; serves the frontend index |
| Run API | `/health` | `run-module/backend/src/api/routes/health.ts`, registered by `src/api/server.ts`; checks PostgreSQL and Redis |
| Social | `/healthz` | `social-backend/app/main.py` registers the route |
| Campus API | `/healthz` | `campus-service/src/app.ts` registers the route; `/readyz` also checks database access |
| Run worker | process logs | no HTTP server; verify startup and queue processing |
| Campus worker | process logs | no HTTP server; verify startup and verification/realtime processing |
| Redis | Railway service status | run `CONFIG GET maxmemory-policy`; must return `noeviction` |

These path and variable checks are repository inspections, not live Railway
health checks. Railway health checks run during deployment and require a 2xx;
they do not continuously monitor an active deployment.

## Frontend and rollback

The web application stays on Vercel. Only change its API URL variables after
all Railway APIs, workers, Redis, Supabase access, RS256/JWKS, and realtime
checks pass. Keep Render running and untouched throughout migration. To roll
back, restore Vercel's existing Render API URLs and stop routing traffic to
Railway; no database move or Render change is involved.
