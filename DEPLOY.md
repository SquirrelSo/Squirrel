# Deploying Squirrel (free plans)

| Part | Where | Config |
|---|---|---|
| Web version of the app (`mobile-4/`) | **Vercel** (Hobby) | [`vercel.json`](vercel.json) |
| Exercise backend, Run Module API (with its workers), Social API, Redis | **Render** (free) | [`render.yaml`](render.yaml) |
| Database | **Supabase** (free) | already set up |
| Phone app | **EAS Build**, then the App Store / Play Store | |

Order: the web app first (it runs on sample data until the backends exist), then the backends, then
connect the two.

## What the free plans mean

- **Render free services sleep** after 15 minutes without requests. The next request wakes them in
  about a minute. While the Run Module sleeps, its hourly leaderboard snapshot and nightly territory
  decay wait until it wakes.
- **Their files are wiped** when they sleep or redeploy. Accounts, profiles, runs, territory and XP
  are in Supabase and stay. The Exercise backend's session files do not, so **workout history and
  reports reset**.
- **Render free Redis** keeps no copy on disk: a restart loses queued jobs; the leaderboard can be
  rebuilt from Postgres.
- Render gives **750 free hours a month** across the workspace, plenty for services that sleep.
- **Supabase free** pauses a project after a week without activity (restore it from the dashboard).
- **Vercel Hobby** is for non-commercial use; move to Pro (or Cloudflare Pages) for launch.

## 1. Web app on Vercel

1. vercel.com → sign up with GitHub (Hobby).
2. **Add New… → Project** → import `SahebSandhuSingh/Squirrel`. If it is not listed, **Adjust GitHub
   App Permissions** and give Vercel that repository.
3. **Project Name** decides the address: `squirrel-social` → `https://squirrel-social.vercel.app`.
   Write it down. **Framework Preset:** Other. Leave everything else; no environment variables yet.
   **Deploy.** The first deploy builds `main` and fails or shows nothing; that is expected.
4. **Settings → Environments → Production → Branch Tracking** (older layout: Settings → Git →
   Production Branch): `saheb`. **Settings → Build and Deployment → Node.js Version:** `22.x`, and
   no Build/Output/Install overrides switched on (the root `vercel.json` builds `mobile-4`).
5. **Deployments → Create Deployment →** branch `saheb`. The log shows `cd mobile-4 && npm ci`,
   the Expo export, and ends with `Exported: dist` after 2–4 minutes. (A build that ends in under a
   second built nothing: check the branch.)
6. Open the address: the Squirrel Social welcome screen, on sample data.

## 2. Backends on Render

**You need:**

- The Supabase **Session pooler** URL (port 5432, user `postgres.<project-ref>`, not the 6543
  transaction pooler), with Supabase's CA certificate at `/etc/secrets`:

  ```
  postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:5432/postgres?sslmode=verify-full&sslrootcert=/etc/secrets/prod-ca-2021.crt
  ```

- The certificate: Supabase → Database → SSL Configuration → download `prod-ca-2021.crt`.

**Steps:**

1. render.com → sign up with GitHub → **New → Blueprint** → connect `SahebSandhuSingh/Squirrel`,
   branch **`saheb`**. Render reads `render.yaml`: two free web services, a free Key Value (Redis)
   and an environment group `squirrel-shared` with a generated `JWT_SECRET` both backends share.
2. It asks for:
   - `DATABASE_URL` (twice, same value): the Supabase URL above.
   - `CORS_ALLOWED_ORIGINS` (twice): your Vercel address, plus previews if you like:
     `https://squirrel-social.vercel.app,https://squirrel-social-*.vercel.app`
   - `RUN_MODULE_URL`: `https://squirrel-run-api.onrender.com`
3. **Apply.** The first deploys cannot reach the database yet; that is expected.
4. **Env Groups → `squirrel-shared` → Secret Files → Add:** name `prod-ca-2021.crt`, contents: the
   certificate file. Save.
5. On **squirrel-run-api** and **squirrel-exercise**: **Manual Deploy → Deploy latest commit**. The
   Run Module applies its migrations as it starts, and runs its workers in the same process; the
   Exercise backend applies its own migrations at startup.
6. Check:
   - `https://squirrel-run-api.onrender.com/health` → `"status":"ok"`, Postgres and Redis connected.
   - `https://squirrel-exercise.onrender.com/` opens the browser coach.

   If Render added a suffix to a name (because it was taken), use the addresses the dashboard shows,
   and correct `RUN_MODULE_URL` on squirrel-exercise to match.

## 2b. Social service (profiles, follows, posts, feed, crews, events, notifications)

`squirrel-social` (from `squirrel-social-profile-social-fixed/social-backend`) is the third service in
`render.yaml`. It shares the database and the sign-in with the other two: it verifies the same tokens
with the shared `JWT_SECRET`, and `scripts/check_shared_database.py` shows its tables never collide
with theirs. The Exercise backend and the Run Module publish every finished workout and run to it, so
they appear on the member's profile and can be shared as posts.

1. **Blueprints → your Blueprint → Manual Sync** (or it syncs itself on the next push). Render
   creates `squirrel-social` and adds `SOCIAL_INTERNAL_TOKEN` (generated) to `squirrel-shared`.
2. On **squirrel-social → Environment**, fill in:
   - `DATABASE_URL`: the same Supabase URL as the other two.
   - `CORS_ALLOWED_ORIGINS`: the same value as the other two.
   - `SOCIAL_RUN_MODULE_URL`: `https://squirrel-run-api.onrender.com`
3. On **squirrel-exercise** and **squirrel-run-api → Environment**, set `SOCIAL_API_URL` to
   `https://squirrel-social.onrender.com` (the address the dashboard shows). Without it they simply
   do not publish.
4. **Manual Deploy → Deploy latest commit** on all three. The Social service creates its tables as
   it starts.
5. Check `https://squirrel-social.onrender.com/healthz` → `{"ok":true}`. After a workout, the
   profile (`GET /v1/users/me/profile` with your sign-in token) lists it under `recent_activities`.

Photo uploads need S3-compatible storage (`SOCIAL_MEDIA_*` in `social-backend/.env.example`, e.g.
Cloudflare R2's free tier); without it everything else works and uploads answer 503. The app reaches
the service through `EXPO_PUBLIC_SOCIAL_API_URL` (section 3).

## 2c. Sign-up emails, community and push notifications

**Sign-up is for college addresses only.** An account needs an address ending in `.ac.in` (any
Indian college: `iiserkol.ac.in`, `iitb.ac.in`, …) and the 6-digit code emailed to it (`SQUIRREL_ALLOWED_EMAIL_DOMAINS`,
`SQUIRREL_EMAIL_VERIFICATION` on squirrel-exercise). Existing accounts keep signing in as before.

The code has to reach the inbox. On **squirrel-exercise → Environment**, set one of:

- **Gmail:** `SMTP_USER` = the Gmail address, `SMTP_PASSWORD` = an *app password* (Google Account →
  Security → 2-Step Verification → App passwords). Gmail sends about 500 a day.
  **Render's free plan blocks outgoing email ports (25, 465, 587)**, so Gmail works only on a paid
  instance or another host.
- **Resend** (works on the free plan, over HTTPS): `RESEND_API_KEY`, and `EMAIL_FROM` on a domain
  you verified with Resend, e.g. `Squirrel Social <no-reply@squirrelsocial.in>`.

With neither, codes are only written to the service log (**Logs**, search "would send to"): fine
for a test, not for real sign-ups. Check: sign up in the app; the code email arrives within a
minute.

**On squirrel-social → Environment:**

- `SOCIAL_HOSTELS`: the hostel names, comma-separated (`Hostel A,Hostel B,...`). Until it is set
  the hostel picker and the hostel vs hostel board stay hidden.
- `SOCIAL_APP_URL`: the Vercel address, for invite links (`…/sign-in?mode=create&invite=CODE`).
- `SOCIAL_ZONES_FILE` (Squirrel Dates): the named campus zones. Write `campus-zones.json` (format in
  `squirrel-social-profile-social-fixed/social-backend/README.md`, "Squirrel Dates"), add it under
  **Secret Files**, and set `SOCIAL_ZONES_FILE=/etc/secrets/campus-zones.json`. Until then the
  Squirrel Dates section stays hidden in the app. Use surveyed outlines: the dev mock's zones in
  `mobile-4/src/api/campus/mock/geo.ts` are hand-placed sketches.

Everything else is automatic: the waitlist and invite codes, the Founding Squirrel (first 15
verified members) and Founding 500 badges, crews, events, check-ins, challenges, the daily stats,
the XP boards and the notification list. Event reminders go an hour before the start while the
service is awake; on the free plan it sleeps, so for reliable reminders have a cron (e.g.
cron-job.org, every 10 minutes) POST to `https://squirrel-social.onrender.com/internal/v1/tasks/event-reminders`
with the header `Authorization: Bearer <SOCIAL_INTERNAL_TOKEN>` (the value from the
`squirrel-shared` group).

**Push notifications** (steals, challenges, events, check-ins) go to the phone app only, not the
website:

1. In `mobile-4/`: `npx eas-cli@latest init` once. It writes `extra.eas.projectId` into
   `app.json`; commit that.
2. Android: add the FCM (Firebase) key, iOS: the APNs key, with `npx eas-cli@latest credentials`.
3. Build the app (section 4). It asks for permission after sign-in and registers the phone.

Without these the in-app notification list still works.

## 2d. Switch sign-in tokens to RS256 (before real users)

Today the Exercise backend signs sign-in tokens with a shared secret (HS256) that the Run Module and
the Social service also hold. With RS256 only the Exercise backend holds the private key; the other
two verify with the public key. Everything below is one change: Render redeploys a service when its
variables change, so do steps 2 and 3 back to back; sign-in fails in between (a few minutes). Nobody has to sign in again: the app's next request gets a 401 once, refreshes, and receives
an RS256 token.

1. On your computer (keep the private key off chat, email and the repository):

   ```bash
   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out jwt-private.pem
   openssl pkey -in jwt-private.pem -pubout -out jwt-public.pem
   ```

2. Render → **squirrel-exercise → Environment → Secret Files → Add**: name `jwt-private.pem`,
   contents of `jwt-private.pem`. Then add the variable
   `JWT_PRIVATE_KEY_FILE` = `/etc/secrets/jwt-private.pem`. (Sign-up codes are then hashed with a
   key derived from the private key, never with JWT_SECRET, which becomes public in step 3.)
3. Render → **Env Groups → squirrel-shared**: `JWT_SECRET` = the whole contents of
   `jwt-public.pem` (from `-----BEGIN PUBLIC KEY-----` to `-----END PUBLIC KEY-----`), and
   `JWT_ALGORITHM` = `RS256`. The Run Module and the Social service read both from this group.
4. Redeploy squirrel-exercise, squirrel-run-api and squirrel-social (Manual Deploy → Deploy latest
   commit). The Exercise log says `[auth] tokens are signed with RS256`;
   `https://squirrel-exercise.onrender.com/api/auth/jwks.json` lists the public key.
5. Check: sign in on the website, open Profile (Social) and start a run (Run Module).

To go back: remove `JWT_PRIVATE_KEY_FILE` from squirrel-exercise, set the group's `JWT_SECRET` to a
new random secret and `JWT_ALGORITHM` to `HS256`, redeploy all three.

## 2e. Campus service (zones, territory, map) — after the RS256 switch

`campus-service/` accepts RS256 tokens only, so do §2d first. Created earlier it rejects every
token and looks broken while it isn't. Nothing else depends on it: the app uses it only once
`EXPO_PUBLIC_CAMPUS_SERVICE_URL` is set on Vercel (§3).

1. **Its own database:** supabase.com → New project (free, same region as the first). Database →
   Extensions → enable **postgis**. Copy its **Session pooler** URL (as in §2) with
   `?sslmode=verify-full&sslrootcert=/etc/secrets/prod-ca-2021.crt`; the CA file already on the
   `squirrel-shared` group is the same for every Supabase project.
2. **Render:** Blueprint → sync (or New → Web Service from `render.yaml`'s `squirrel-campus`). It asks for:
   - `DATABASE_URL`: the NEW project's URL from step 1 (never the shared one).
   - `AUTH_JWKS_URL`: `https://squirrel-exercise.onrender.com/api/auth/jwks.json`. Leave
     `AUTH_ISSUER` / `AUTH_AUDIENCE` unset.
   - `SOCIAL_API_URL`: `https://squirrel-social.onrender.com` (names and profile ids come from there,
     with `SOCIAL_INTERNAL_TOKEN` from the group).
   - `CORS_ORIGINS`: the Vercel address, plus previews if you like, comma-separated:
     `https://squirrel-social.vercel.app,https://squirrel-social-*.vercel.app` (`*` matches one
     name part: letters, digits, hyphens).
   - `REALTIME_PUBLIC_URL`: `wss://squirrel-campus.onrender.com/v1/realtime`.
3. First start applies its migrations and seeds the hostels and **placeholder** zones
   (`geometry_source: dev_placeholder`, shown dashed and labelled approximate in the app). Surveyed
   outlines replace them permanently when loaded (`campus-service/docs/GEOGRAPHIC_DATA_REQUIRED.md`).
4. Check: `https://squirrel-campus.onrender.com/healthz` and `/readyz` answer, and `/v1/zones` lists
   the zones.
5. **Vercel:** add `EXPO_PUBLIC_CAMPUS_SERVICE_URL=https://squirrel-campus.onrender.com` and redeploy.
   Map, zones, territory, presence, heatmap and shared zones then come from campus-service;
   everything else stays on squirrel-social.

**If it doesn't work**, check in this order (each first request may take a minute while a free
service wakes):

| Open | If you see | Fix |
|---|---|---|
| `https://squirrel-exercise.onrender.com/api/auth/jwks.json` | `{"keys":[]}` | RS256 isn't done: §2d first. campus-service accepts RS256 only |
| `https://squirrel-campus.onrender.com/healthz` | no answer / error page | Service didn't start: Render → squirrel-campus → Logs (usually `AUTH_JWKS_URL` missing, or a build error) |
| `https://squirrel-campus.onrender.com/readyz` | fails while `/healthz` works | Database: PostGIS off, not the **Session** pooler URL, wrong password, or the `squirrel-shared` group (CA file) not linked |
| the app, browser console | "CORS" | `CORS_ORIGINS` doesn't match the address in the browser bar |
| the app | names like "Squirrel a1b2c3" | `SOCIAL_API_URL` wrong, or the group (`SOCIAL_INTERNAL_TOKEN`) not linked |
| the app | map unchanged | Vercel not redeployed after adding `EXPO_PUBLIC_CAMPUS_SERVICE_URL` |

A sleeping Exercise backend no longer signs anyone out: campus-service fetches its key once at
start-up, keeps it 12 h, and answers `503 auth_unreachable` ("try again") rather than 401 if the
key can't be fetched.

Note: with campus-service on, a finished run's GPS is also sent to it (it verifies runs itself to
decide who may claim a zone), so GPS is stored in two databases. Include that in the privacy review.

## 3. Connect the web app

1. Vercel → **Settings → Environment Variables** (Production and Preview):

   | Name | Value |
   |---|---|
   | `EXPO_PUBLIC_EXERCISE_API_URL` | `https://squirrel-exercise.onrender.com` |
   | `EXPO_PUBLIC_API_URL` | `https://squirrel-run-api.onrender.com` |
   | `EXPO_PUBLIC_SOCIAL_API_URL` | `https://squirrel-social.onrender.com` (profile, crews, events, duels, boards, notifications; unset: the campus screens say "not live yet") |

   `https://`, no trailing slash. Never set `EXPO_PUBLIC_POSE_DEBUG` here: it is a development
   switch for the pose debug overlay and logs (see `mobile-4/.env.example`). Locally, rebuild with
   `--clear` after changing it, or Metro reuses the old value. They are built into the app, so:
2. **Deployments → latest → ⋯ → Redeploy.**
3. Open the site, join with a .ac.in email (a 6-digit code arrives by email), check that the profile and XP load. The first request after a
   quiet spell can take a minute while Render wakes the backend.
   "Cannot reach the server" → the Vercel address is missing from `CORS_ALLOWED_ORIGINS` on Render,
   or an address has a typo.

A custom domain goes in Vercel → Domains, and into `CORS_ALLOWED_ORIGINS` on both Render services.

## 4. Phone app

Set the same two `EXPO_PUBLIC_*` values as EAS environment variables, then
`npx eas-cli@latest build`. The phone app is not a browser and needs no CORS.

## Later, on paid plans

A disk for the Exercise backend (keeps workout history), the Run Module worker as its own service
(`node --import tsx/esm src/workers/start.ts`, without `RUN_WORKERS_IN_API`), migrations as a
pre-deploy command, and no sleeping. Before real users: RS256 tokens (run-module ADR-003).
