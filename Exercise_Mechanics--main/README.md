# Exercise Mechanics

Exercise Mechanics is a browser-based live fitness-coaching prototype. MediaPipe pose inference runs in the
React frontend, while FastAPI owns setup, exercise state, form evaluation, scoring and coaching
cues.

The currently usable exercises are **Squat**, **Single / Double Arm Bicep Curl**, **High Knees**, and
**Push-up**. Lunges and Plank appear in the library but are still **Coming Soon**.

> **Push-up is the first SIDE-view exercise.** Elbow bend and hip alignment are both sagittal-plane
> quantities, so the setup flow refuses to start a set until the camera is at the user's side, and it
> keeps checking during the set — a confirmed front-on view pauses the rep machine rather than scoring
> readings the angle cannot support. Its thresholds are `development` and were derived geometrically
> rather than from a rig capture; `backend/workouts/pushup/configs/templates.yaml` records what each
> one needs before it can be promoted to `ready`.
>
> Being side-on changes what the client has to do, not just the server. A profile view occludes the
> far arm and leg, so tracking confidence is scored from the best single side rather than the worst
> joint across both — otherwise a correctly positioned user sits below the confidence floor for the
> whole set. And when `side_view_orientation` invalidates a reading, `tracking.invalidated_by` names
> it, so the HUD can say *"turn side-on, reps are not being counted"* instead of the generic
> *"hold still for tracking"*, which is the opposite of what that user needs to do.
>
> **To watch the push-up rules run**, there is a local OpenCV tool that feeds a camera, a video file
> or a drawn synthetic body through the real setup gate and the real live adapter and draws what
> they return — depth percentage, rep verdicts, sag/pike, the camera check and the cues:
>
> ```bash
> pip install -r backend/tools/requirements-vision.txt
> python backend/tools/live_pushup.py --source synthetic --window   # no camera needed
> python backend/tools/live_pushup.py --source 0 --window           # webcam
> python backend/tools/live_pushup.py --source clip.mp4 --out annotated.mp4
> ```
>
> The requirements file pins MediaPipe to 0.10.21 on purpose: newer releases dropped the legacy
> CPU-only `mp.solutions` API, and their Tasks API aborts on macOS inside a Metal calculator. See
> the note at the top of `backend/tools/requirements-vision.txt`.

> **New here?** [`USER_GUIDE.md`](USER_GUIDE.md) is a plain-language, step-by-step walkthrough of
> installing, starting, and using the app. Start there. This README is the quick technical reference.

## The app currently opens straight on a push-up set

`DEMO_PUSHUP` in `frontend-react/src/App.tsx` is `true`, so loading the app skips the landing page,
the profile choice, the program choice and the workout builder, and mounts the coach directly on a
one-set push-up. `frontend-react/src/flow/demoSession.ts` provisions the identity and the session
non-interactively and hands the coach the same `(session_id, WorkoutConfig)` pair the Solo builder
produces — nothing downstream is stubbed or shortened.

| To get | Do |
|---|---|
| the full flow, once | open `/?demo=off` |
| the full flow, by default | set `DEMO_PUSHUP = false` in `App.tsx` |

Everything below describes the app with the demo switched off, since that is the flow the other
exercises are reached through.

## Supported runtime

| Runtime | Supported version |
|---|---|
| Python | 3.11.9 (Python 3.11 patch releases are expected to work) |
| Node.js | 22.22.3 (Node 22.12 or newer) |
| npm | 10.x |

The repository records the verified versions in `.python-version` and `.nvmrc`.

## Clean setup

Run these commands from the repository root unless a step says otherwise.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r requirements.txt
```

Install the frontend exactly from the committed lock file:

```bash
cd frontend-react
npm ci
cd ..
```

Do not copy another developer's virtual environment or `node_modules`. Those directories contain
machine-specific paths and are intentionally not shipped with this codebase.

## Verification

Backend:

```bash
.venv/bin/python -m pytest -q
```

Frontend:

```bash
cd frontend-react
npm run typecheck
npm run lint
npm run test
npm run build
cd ..
```

`npm run build` writes a fresh production bundle to `frontend-dist/`. That directory is generated and
not shipped; never assume an existing bundle matches the current React source.

## Run the application

Build the frontend first, then start FastAPI from the repository root:

```bash
cd frontend-react
npm run build
cd ..
.venv/bin/python -m uvicorn backend.main:app --reload --port 8000
```

Open [http://localhost:8000](http://localhost:8000). API and WebSocket routes are registered before
the frontend static mount. With `DEMO_PUSHUP` on this lands on the push-up setup screen; append
`?demo=off` for the landing page.

Re-run `npm run build` after every change to `frontend-react/`, including after a `git pull`.
`frontend-dist/` is gitignored, so pulling updates the source but leaves the served bundle exactly
as it was — the symptom is a page that stubbornly shows the previous version of the UI.

### First run — build before you serve

The build step above is not optional on a fresh clone. `frontend-dist/` is generated output and is
not in version control, but `backend/main.py` mounts it as static files at import time. Starting
uvicorn before the first `npm run build` therefore fails immediately with:

```
RuntimeError: Directory '.../frontend-dist' does not exist
```

Run `npm run build` in `frontend-react/` and start uvicorn again.

### Frontend development, with hot reload

Two terminals, two directories. Keep FastAPI running in one:

```bash
# terminal 1, from the repository root
.venv/bin/python -m uvicorn backend.main:app --reload --port 8000
```

```bash
# terminal 2
cd frontend-react
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite serves from source and proxies `/api` and
`/ws` to FastAPI on port 8000, so there is no bundle to rebuild and none to go stale.

`ModuleNotFoundError: No module named 'backend'` means uvicorn is running from the wrong directory —
`backend.main` is a dotted import, so the current directory must be the one *containing* `backend/`.
Uvicorn prints the directory it is watching on its first line; that line must end in the repository
root, not in `/backend` or `/frontend-react`.

A Vite `http proxy error: ECONNREFUSED` on `/api/...` means terminal 1 is not running.

### Exercise availability

Every enabled exercise uses the standard launch command above; none needs an environment variable.
The backend catalog (`backend/workouts/catalog.yaml`) decides what the library offers — an enabled
entry shows **Add to workout**, a planned one stays unavailable.

## Deployment

`Dockerfile` builds both halves into one image: a Node stage runs `npm run build`, and the Python
stage copies the resulting `frontend-dist/` in beside the backend. Node is not in the final image.
The container serves the API, the WebSockets and the SPA from **one origin**, which is what the
client assumes — `useEngine.ts` builds its socket URL from `location.host`, and every `fetch` is a
relative `/api/...`.

```bash
# from Exercise_Mechanics--main/ — the Dockerfile's COPY paths are relative to it
docker build -t exercise-mechanics .
docker run --rm -p 8000:8000 exercise-mechanics
```

`Bind for 0.0.0.0:8000 failed: port is already allocated` means something else holds the port,
usually a local uvicorn — stop it, or publish elsewhere with `-p 8080:8000`. The app is entirely
same-origin, so any host port works.

The image reads `$PORT` (default 8000) and binds `0.0.0.0`, so it runs unchanged on a container
host. On Render, Railway, Fly.io or Cloud Run:

| Setting | Value |
|---|---|
| Runtime | Docker |
| Root directory | `Exercise_Mechanics--main` |
| Dockerfile path | `Exercise_Mechanics--main/Dockerfile` |
| Build / start command | *leave empty* — the Dockerfile `CMD` already binds `$PORT` |
| Environment variables | optional — see the table below |
| Health check path (optional) | `/api/exercises` |

The core app needs no environment variables beyond `PORT`, which the Dockerfile handles. These are
optional and switch features on:

| Variable | Used by | Without it |
|---|---|---|
| `RUN_MODULE_URL` | Partner Hunt's XP gate: the Run Module's `/v1/users/{id}/xp-gate`, called with a short-lived service token signed with `JWT_SECRET` (`RUN_MODULE_TOKEN` overrides it with a fixed token). Also where XP awards go (`POST /internal/v1/xp/award`, same token): a finished shared workout and a new Partner Hunt connection | Partner Hunt reports the XP service as unavailable; no XP is awarded (logged at debug) |
| `PARTNER_HUNT_DEV_XP` | Local testing only, when `RUN_MODULE_URL` is unset: a fixed XP for every user | — |
| `SOCIAL_API_URL`, `SOCIAL_INTERNAL_TOKEN` | The Social service and its service token. Finished workouts are published to it (`backend/social_publish.py`). **Blocks are Social's** ([ADR-032](../docs/decisions/ADR-032-service-ownership.md)): Partner Hunt and activity matching read each viewer's either-way block set from `GET /internal/v1/blocks/{id}` (cached at most 30 s), and their Block buttons create a Social block through `POST /internal/v1/blocks/import` (`backend/social_blocks.py`). Shared workouts and Partner Hunt Connect show people by their Social profile (`POST /internal/v1/people/resolve`, `backend/social_people.py`), and Connect sends `partner.request` / `partner.accepted` through `POST /internal/v1/notifications` (`backend/social_notify.py`, in the background). Checks fail closed: with Social unreachable (a 404 included), the board is withheld and a block refused, `503 blocks_unreachable` | Workouts are not published; Partner Hunt and activity-matching boards and blocks answer `503 blocks_unreachable` (logged) |
| `MODERATION_TOKEN` | Moderator routes for reports | Moderator routes refuse every request (503) |
| `DATABASE_URL` | **Accounts and profiles are stored here** (sign-in, refresh tokens, profile, skill, profile details, measurements, consents, Partner Hunt preferences). Exercise sessions are also copied into `exercise_sessions`, and into the shared `activity_sessions` that XP is derived from (see below) | Accounts and profiles are files under `data/`, lost on a redeploy without a volume |
| `JWT_SECRET` | Signs Squirrel Social login tokens (HS256 JWTs). The **same value as the Run Module's**, so one sign-in works on both. **Required in production** (`SQUIRREL_AUTH_SECRET`, if set, takes precedence) | A development key is generated once in `data/auth/secret.key` |
| `EXERCISE_REQUIRE_AUTH` | `0` switches off the sign-in check on per-user routes, only to try the password-less browser coach locally | Sign-in required |
| `SQUIRREL_PUBLIC_BASE_URL` | Origin used in QR codes and invite links | `https://squirrelsocial.app` |
| `SQUIRREL_APP_STORE_URL`, `SQUIRREL_PLAY_STORE_URL`, `SQUIRREL_IOS_APP_IDS`, `SQUIRREL_ANDROID_PACKAGE`, `SQUIRREL_ANDROID_CERT_SHA256` | Store links and the Universal/App Link files | Placeholder store listings |

**Serverless hosts (Vercel, Netlify Functions, Lambda) cannot run this.** `/ws/setup` and `/ws/train`
are long-lived WebSockets carrying every pose frame, and the backend writes profiles, sessions and
captured baselines to local disk. Hosting the SPA there and the API elsewhere would additionally
need a configurable backend origin and CORS, neither of which exists today.

### Persistence in a container

With `DATABASE_URL` set, accounts and profiles are in the database and survive a redeploy. The
session captures and calibration baselines are still files: `data/users/` is inside the container and
is **not** in the image (`.dockerignore` excludes it), so without a mounted volume it starts empty and
is wiped on every restart and redeploy. Mount it to keep them:

```bash
docker run --rm -p 8000:8000 -v "$PWD/data:/app/data" exercise-mechanics
```

Running without a volume is survivable rather than broken: a browser holding a cached identity the
server no longer has gets a 404 on session creation, and `demoSession.ts` recovers by creating a
fresh profile. History and saved baselines are lost, a demo still runs.

## Sign-up profile details

Sign-up is two pages:

1. **Page 1** (`Onboarding.tsx` → `POST /api/users`): name, date of birth, gender, height, weight,
   mobile and email. This creates the account. The payload is the same as before.
2. **Page 2** (`ProfileDetails.tsx` → `PUT /api/users/{id}/details`): fitness, activities, physique
   and habits, all optional, with a **Skip for now** button. Physique and habits each have their own
   consent box, and their questions only appear once it's ticked. Everything on the page is saved in
   one request; a refused request saves nothing, and sections left out are left unchanged.

The code is in `backend/profiles/`, and each answer can also be changed later through its own route.
The file names below are the local (no `DATABASE_URL`) layout; with a database, each file is one row
of `user_profiles` / `user_profile_data` holding the same JSON.

| Question | Where it lives | Rule |
|---|---|---|
| Age | `profile.json` → `date_of_birth` | Only the date of birth is stored; age is always worked out from it |
| Gender | `profile.json` → `gender` | One of `female`, `male`, `non_binary`, `other`, `undisclosed` |
| Activities | `activities.json` | Codes from `GET /api/activity-types`; tracked exercises use their workout slugs |
| BMI | `measurements.json` (history) | Never stored: latest height × latest weight. `GET /api/users/{id}` returns the latest values |
| Fitness level, activity level, goal | `skill.json`, `fitness.json` | Fitness level *is* the dashboard skill level, with no second copy |
| Physique (body type, body fat, waist) | `physique.json`, `measurements.json` | **Needs `physique` consent** |
| Habits (workout times, sleep, diet, smoking, alcohol) | `habits.json` | **Needs `habits` consent** |

Consent is an append-only log (`consents.json`, `POST /api/users/{id}/consents`), with three
categories: `physique`, `habits` and `matching` (the opt-in to activity matching, below). Withdrawing
physique or habits consent erases that category's data. If the log can't be read, consent is treated as not given:
sensitive data is hidden and not saved, and the log is never overwritten. Sensitive questions
always offer a "prefer not to say" answer.

Routes: `GET /api/users/{id}/details` (everything, with age and BMI derived);
`PUT /api/users/{id}/details` (page 2, all at once);
`PUT /api/users/{id}/details/{fitness|activities|physique|habits}`;
`GET|POST /api/users/{id}/measurements`; `GET|POST /api/users/{id}/consents`.

### The app's "About you" form

Exercise is the one home of a member's private details (ADR-032). The app's "About you" form is
`GET /api/me/profile-details` and `PUT /api/me/profile-details`, for the signed-in user only: the
user is the bearer token's, a token is always required (401 without one, even with sign-in switched
off), and there is no route by user id. The body is the form as the app sends it:
`{ full_name, personal_email, college_email, phone, gender, date_of_birth, age, course, cgpa }`. Each field has one
source, so nothing is stored twice:

| Field | Source | Rule (the same as campus-service's copy and the app) |
|---|---|---|
| `full_name` | `first_name` + `last_name` | 2–60 characters with a letter. Saved split on the first space; a one-word name is all first name. An unchanged name keeps its split |
| `phone` | `mobile` | Indian mobile in E.164, e.g. `+919876543210` |
| `gender` | `gender` | `female`, `male`, `non_binary` or `undisclosed` |
| `date_of_birth` | `date_of_birth` | `YYYY-MM-DD`. Required when the account has none (code sign-in asks for none): 422 `date_of_birth_required`. It must give an age of 16–99 (422 `age_out_of_range`) |
| `age` | derived from `date_of_birth` | Never stored, so it can't go stale. Optional on `PUT`; if sent it must be the age the date of birth gives (422 `age_mismatch`) |
| `college_email` | the sign-in email | Read-only here: 422 `college_email_read_only` if it differs (case and spaces aside) |
| `personal_email`, `course`, `cgpa` | `user_personal_details` (migration 006), or `personal_details.json` | Valid email, different from the college one; course 1–60 characters; CGPA 0–10, at most 2 decimals, optional |

`PUT` replaces the whole form (a CGPA left out is cleared) and answers with the saved form. `GET`
always answers the same shape: before the first save, with what the account already knows and
`null` for the rest. A refused `PUT` changes nothing; its 422s are in FastAPI's validation shape
(`detail: [{loc, msg, type}]`).

## Workout Score and Activity Rating

Two separate things, never mixed:

| | Workout Score | Activity Rating |
|---|---|---|
| Who produces it | The system | The member |
| From | Measured workout data: reps, depth, technique, duration, consistency | How the member felt about the session and how they'd rate it |
| Field in reports | `workout_score` | `activity_rating` |
| Code | `backend/reports/workout_score.py` | `backend/activity_rating/` |

A rating never changes the score, and the rating is not part of `activity_metrics`.

### Workout Score

Every exercise report (`GET /api/users/{id}/sessions/{sid}/report` and `.../exercises/{ex}/report`)
carries a `workout_score`: one 0–100 number with feedback, built only from what pose detection and
rep analysis captured. The frontend doesn't show it yet.

| Part | Weight | From |
|---|---|---|
| Technique | 40% | Each rep's technique score: 100 minus penalties for flagged form faults |
| Depth | 25% | Each rep's depth factor against the exercise's full-range gate |
| Completion | 20% | Reps done ÷ reps planned (timed: sets completed ÷ planned) |
| Consistency | 15% | Steadiness of rep scores and rep tempo (timed: left/right balance) |

- A rep's form score is already technique × depth, so the two are kept separate here and depth is
  counted once. A part that couldn't be measured is left out and the weights are rescaled.
- Grades: 90+ Excellent · 75+ Strong · 60+ Solid · 40+ Building · below 40 Getting started.
- Feedback: a headline, up to two strengths, and one focus (the weakest part below 85) with a fix.
  A technique focus names the costliest form fault and its coaching text from the exercise
  templates. `trend` compares with the last earlier session of the same exercise.
- At least 3 tracked reps are needed. If most reps had incomplete tracking, the score is marked
  `provisional`.
- `correct_pct` counts reps with form 80+ **and** full depth. The report also carries
  `activity_metrics` (`reps`, `correct_pct`, `avg_depth`, `workout_score`), the `metrics` object
  for the shared `activity_sessions` row in the Integration Contract.
- Session overviews and `/progress` sessions carry `workout_score` too.

### Activity Rating

The member rates a session they did: `PUT /api/users/{id}/sessions/{sid}/activity-rating` with
`rating` (1–5, required), and optionally `feeling` (`great`, `good`, `okay`, `tired`, `bad`),
`effort` (perceived exertion, 1–10) and a `note` of up to 500 characters. `GET` reads it and `DELETE`
removes it. Only the session's own member can rate it; re-rating keeps the first `rated_at`. It is
stored beside the session (`activity_rating.json`) and appears as `activity_rating` in session and
exercise reports, overviews, and (the 1–5 value) in `/progress` sessions.

## Reports (moderation)

Members can report another member, or one of their sessions, for review (`backend/moderation/`).
Each report records who reported, whom or what, the category, a description, when, and a status.

- **Categories:** `harassment`, `fake_profile`, `inappropriate_content`, `spam`, `cheating`
  (manipulated workout data; can name a `session_id`), `other` (needs a description).
- **Status:** `open` → `in_review` → `resolved` or `dismissed`, with every change kept in the
  report's `history`.
- **Members:** `POST /api/users/{id}/reports` files one (201). Re-reporting the same member for the
  same category while it is still under review returns the existing report (200) instead of a
  duplicate. The limit is 20 reports a day. `GET /api/users/{id}/reports` lists your own reports and
  their status, without moderator notes.
- **Privacy:** a reported member is never told who reported them, and no member route lists reports
  made against anyone. Reporting doesn't block; blocking is a separate action.
- **Moderators:** `GET /api/moderation/reports` (filter by `status`, `category`, `reported_user_id`;
  each entry shows how many reports that member has), `GET` and `PATCH /api/moderation/reports/{id}`
  (`status` and an optional `note`). These need `Authorization: Bearer <MODERATION_TOKEN>`. Without
  that variable set, they refuse every request. Unreadable report files are listed under
  `unreadable`, never dropped.
- Reports are stored in `data/moderation/reports/`, which is git-ignored.

## Partner Hunt: options and Connect

**Cards carry a `card_id`, never an account id.** The Exercise account id spells the member's full
name (`priya-sharma-3f2a1c`) and is their login `sub`, so a card that says "Priya S." can't carry it.
Every anonymous card (Partner Hunt's board, requests and connections, and activity matching) names
its member by `card_id`: an HMAC of the viewer, the member and the feature under a key derived from
the signing secret (`backend/card_ids.py`). It is opaque, different for every viewer and feature,
and stable for one viewer across refreshes. Connect (`{ card_id }`) and both Block routes
(`{ card_id }` → `{ blocked_card_id }`) take it, and the server resolves it only among the people
that viewer could have been shown; an account id sent instead is simply unknown (404).

`GET /api/users/{id}/partner-hunt` carries `options`: every vocabulary the preferences form needs
(activities, times, modes, genders, each `{ key, label }`), the partner age range and the minimum
XP, all from `backend/partners/policy.py`, so the app keeps no copy of them.

**Connect** (`backend/partners/connect.py`) lets you ask someone on your board to train together.

- **Anonymous until both say yes.** A request shows the board's card: first name and last initial,
  age band, level, and what you share. No photo, no full name, no profile link, and no account id. Once it's
  accepted, each side gets the other's Social profile id (`social_profile_id`), and nothing more.
- **Sending** needs every board check, and the person must be on your board right now; otherwise
  `404 not_on_board`, which is also what a block gives.
- **Declines are silent.** The sender sees the request as pending until it expires (14 days), then
  as expired, exactly as if it had gone unanswered. Withdrawing a declined request looks the same
  as withdrawing any other.
- **Blocks** (Social's, either direction) refuse sending and accepting, and drop the pair from every
  list, connections included. When Social can't be asked: `503 blocks_unreachable`.
- **Limits:** one live request per pair (`409 already_requested`, `they_asked_you`,
  `already_connected`); one request to the same person per 30 days however it ended (`429
  too_soon` with `retry_after`); 10 new requests a day (`429 daily_limit`); 20 waiting
  (`429 too_many_pending`).
- **Notifications** through Social: `partner.request` to the recipient, naming nobody to Social
  (the card name is in the title; opens `/partner-hunt`), and `partner.accepted` to the sender,
  naming the accepter (opens `/partner-hunt/connect/{request_id}`, the screen that loads the
  requests and finds that connection).
- **Buddies.** An accepted connection is a *buddy*: the people you can invite to a shared workout
  (below). Either person can remove one with `DELETE /api/users/{id}/partner-hunt/connections/{request_id}`
  (204). It's silent: no notification (`partner.disconnected` is never sent), and the connection
  simply disappears from both lists. Removing twice is fine; anyone else, or a request that isn't an
  accepted connection, gets `404 connection_not_found`. The row is kept as `removed` (with
  `removed_at`, `removed_by`; migration 009), and the pair's 30-day cooldown runs from the removal:
  either asking again before then gets `429 too_soon` with `retry_after`.
- **XP.** When a request is accepted, each person earns `buddy_connected` (20 XP) from the Run
  Module, once per pair per person: the idempotency key is `buddy:{min(a,b)}:{max(a,b)}:{subject}`,
  so connecting again after a removal earns nothing more. Sent after the accept is saved,
  fire-and-forget (`backend/xp_awards.py`); a failure is logged and never fails the accept.

Routes, under `/api/users/{id}/partner-hunt`: `GET /requests` (`{ incoming, outgoing, connections }`;
removed connections are gone), `POST /requests` (`{ card_id }`), `POST /requests/{request_id}/accept`,
`POST /requests/{request_id}/decline` (204), `DELETE /requests/{request_id}` (204, the sender takes it
back), `DELETE /connections/{request_id}` (204, either side removes a buddy).

## Activity matching

Members who do the same activities are suggested to each other as possible workout partners: two
runners, two lifters (`backend/activity_matching/`). It's separate from Partner Hunt: no XP gate, no
city and no meeting preferences. The frontend doesn't show it yet.

- **Opt-in:** the `matching` consent (`POST /api/users/{id}/consents`). You only see others while
  you can be seen yourself. Members must be 18+ and have declared at least one activity (sign-up page 2).
- **Score (0–100):** shared activities 60%, weighted by both members' interest (1–5); fitness level
  20% (same, one apart, two apart); workout times 20%, used only when both share their habits.
  Scores are symmetric, and each match comes with plain-language reasons.
- **A match card shows only** first name and last initial, age band, fitness level, the shared
  activities, the score and the reasons, named by an opaque per-viewer `card_id` (see Partner Hunt
  above). Never the account id, gender, body data, contact details, location or interest scores.
- **Blocking** is Social's, the same block as the app's Block button and Partner Hunt's, and works
  both ways. Anyone whose consent can't be read is left out, never shown; if Social can't be asked,
  no matches are shown at all (`503 blocks_unreachable`).

Routes: `GET /api/users/{id}/activity-matching` (status, and exactly what matches see),
`GET /api/users/{id}/activity-matches`, `POST /api/users/{id}/activity-matches/blocks`
(`{ card_id }` → `{ blocked_card_id }`).

## Workout with Partner (shared workouts)

Two people race the same rep exercise for a fixed 1, 3 or 5 minutes (`backend/shared_workouts/`).
One creates a session and shares its invite link (`{SQUIRREL_PUBLIC_BASE_URL}/w/{code}`, which
opens the app at `/workout/join/{code}`), the other joins, both tap ready, and a shared 3-second
countdown starts them together. Exercise owns this feature ([ADR-032](../docs/decisions/ADR-032-service-ownership.md)).

- **The phase is never stored.** It's worked out from timestamps on every read: `lobby` (not
  started, under 10 minutes old), `expired`, `countdown` (before `starts_at`), `racing`, and
  `finished` (after `ends_at = starts_at + duration`, or once every player has finished or left).
- **Leaving.** Before the start, leaving frees your seat: if the host leaves, the partner becomes
  the host and can invite someone else; the lobby closes only when everyone has left. From the
  countdown on, leaving (or 30 seconds with no socket and no request) ends only your own race.
- **Reps** are hand-tapped: `{ reps, seq }`, a running total and a counter, and the highest `seq`
  wins, so retries and undo are safe. Reports count until 5 seconds after `ends_at`. The server
  refuses a total above 4 reps per second of race time so far, plus 5 (`422 implausible_reps`, on
  `reps` and `complete`), and more than 5 reports a second from one person (`429 rate_limited`,
  with `retry_after_ms`; `complete` isn't throttled).
- **Inviting a buddy.** The host can invite one of their Partner Hunt connections from the lobby:
  `POST /{id}/invite { social_profile_id }`. Anyone else is `403 not_a_buddy`, and so is a buddy
  blocked either way (a block is never revealed); blocks fail closed (`503 blocks_unreachable`),
  names too (`503 social_unreachable`). Only the host (`403 not_host`), only in the lobby
  (`409 not_in_lobby`), not with both seats taken (`409 session_full`), and at most 3 invitations
  waiting at once (`429 too_many_invites`). Inviting the same person again changes nothing. The
  invitee gets the Social notification `shared_workout.invited` (data `{ code, session_id }`, route
  `/workout/join/{code}`) and joins with the code as anyone would. An invitee can say no with
  `POST /invites/{code}/decline` (204; `404` if you weren't invited): silent, but the players'
  session view lists every invitation (`invites: [{ user, status: invited | declined, invited_at }]`;
  an invite preview shows none).
- **Cancelling.** The host can close an unstarted lobby for everyone: `POST /{id}/cancel`
  (`left_reason: "cancelled"` for every seat; `403 not_host`, `409 already_started` from the
  countdown on, `409 not_in_lobby` once it expired). Cancelling twice is fine.
- **XP for finishing, not for reps.** When a race reaches `finished` it is settled exactly once
  (`completed_at` in the session; the first write or read after the end does it, and a background
  sweep every 30 seconds settles races nobody looks at any more, e.g. both apps closed). Each player
  who didn't leave before the end (leaving or 30 s disconnected both count as leaving) and reported
  at least one rep earns `shared_workout_finished`: a flat 20 XP from the Run Module, never per rep,
  at most 3 a day (the Run Module's cap), idempotency key `shared:{session_id}:{subject}`. Both
  players get the Social notification `shared_workout.finished` (data `{ session_id }`, route
  `/workout/{session_id}`). Taps in the 5-second grace still change the result shown, not who earned
  XP. Duplicate `complete` calls, replays and later reads never award again. Nothing is written to
  `activity_sessions`.
- **Who sees what.** A session is visible only to the two people in it (404 for anyone else). An
  invite is visible to anyone signed in with the code unless either has blocked the other: the same
  404 as an unknown code, and `503 blocks_unreachable` when Social's blocks can't be checked. Blocks
  are checked again when someone readies up with a partner seated: a blocked pair's lobby closes for
  both, quietly (`left_reason: "closed"`); a race that has started is never cut short. People
  are shown by their Social profile (`POST /internal/v1/people/resolve`, looked up on create and
  join and kept with the session); login ids never leave Exercise.
- **Live updates:** `WS /ws/workout-sessions/{id}?token=<access token>` sends
  `workout.session.updated` and `workout.reps.updated`; `workout.session.invited`
  (`{ session_id, invite }`), `workout.session.cancelled` (`{ session_id, at }`, before the last update
  and the close) and `workout.session.completed` (`{ session_id, completed_at, results: [{ user, reps,
  finished, rewarded }] }`, once); and answers `{"type":"ping"}` with `pong`.
  The app polls `GET` every 2 seconds when there's no socket. Sockets and presence are in-process
  (one worker, as for `/ws/train`).
- **Storage:** `shared_workout_sessions` (migration 007) with `DATABASE_URL`, otherwise
  `data/shared_workouts/<id>.json`. Sessions are deleted a week after they close.

Routes, under `/api/workout-sessions`: `POST` (create `{ exercise_key, duration_s }`), `GET /{id}`,
`GET /invites/{code}` (preview), `POST /invites/{code}/join`, `POST /invites/{code}/decline` (204),
`PUT /{id}/ready` (`{ ready }`), `POST /{id}/reps` and `POST /{id}/complete` (`{ reps, seq }`),
`POST /{id}/leave`, `POST /{id}/invite` (`{ social_profile_id }`), `POST /{id}/cancel`.

## Squirrel Social: accounts, Nearby Discovery, invite links

Phones find each other over Bluetooth and the backend decides when two people are really near each
other. The full design is in [`docs/nearby-discovery.md`](../docs/nearby-discovery.md); the phone
side is in [`backup/mobile-nearby/nearby/`](../backup/mobile-nearby/nearby/) (not built at the moment).

| Module | Routes |
|---|---|
| `backend/auth/` | Code sign-in (the app): `POST /api/auth/email/start` emails a 6-digit code (`new_account` in the reply), `/email/verify` exchanges it for tokens and creates a password-less, verified account for a new address (needs `first_name`). Password flow: `POST /api/auth/email-code` (emails a 6-digit sign-up code), `/register` (needs it), `/login`, `/refresh`. Returns a short-lived access token (`Authorization: Bearer …`; RS256 when `JWT_PRIVATE_KEY_FILE`/`JWT_PRIVATE_KEY` holds an RSA key, public key at `GET /api/auth/jwks.json`, else HS256 with `JWT_SECRET`; with `"ev": true` for an account that verified its email) and a single-use refresh token. Sign-up is open to `SQUIRREL_ALLOWED_EMAIL_DOMAINS` (default `ac.in`: any address ending in .ac.in); codes go out by Gmail SMTP (`SMTP_USER`, `SMTP_PASSWORD`) or Resend (`RESEND_API_KEY`, `EMAIL_FROM`), else to the log (`backend/mailer.py`) |
| `backend/live.py` | `GET /api/live`: how many people are in a coached workout right now |
| `backend/nearby/` | `GET/PUT /api/nearby/settings`, `POST /api/proximity/session`, `/detection`, `/confirm`, `GET /api/nearby`, `POST /api/nearby/connect`, `GET /api/connections`, `POST /api/notifications/nearby` |
| `backend/deeplinks/` | `/join` and `/invite/{token}` (store redirect or landing page), `POST /api/invites`, `/join/qr.svg`, `/join/poster`, `/.well-known/*` |

- **Off by default.** Every proximity route answers 403 until the user turns Nearby on. Turning it off erases their proximity state at once.
- **No proximity history on disk.** Sightings and "who was near whom" live only in memory and expire after 15 minutes. On disk there is only the on/off setting (`nearby.json`) and accepted connections (`connections.json`), without time or place.
- **One process.** That in-memory state is why the server runs a single worker. A restart forgets it, and phones simply open a new session.
- **Accounts.** A registered account's id is a UUID, the form the Run Module also requires. With `DATABASE_URL` set, the account, its refresh tokens (hashed) and its profile are rows in the database (see "PostgreSQL" below). Without it, they are files: the profile in `data/users/<id>/profile.json`, credentials and refresh tokens as hashes under `data/auth/`, which is private and git-ignored, like `data/invites/`.
- **Sign-in limits** (`backend/auth/throttle.py`). 5 wrong passwords lock that account's sign-in for 15 minutes, from any device. Looser per-address limits (50 failed logins per 15 min, 20 sign-ups per hour, 1000 refreshes per 15 min) stop one machine hammering the service without locking out phones that share a carrier address. Over a limit: `429` with `Retry-After`. With `DATABASE_URL` the counters are shared by every instance (`auth_throttle`).
- **Access-token lifetime must stay at 15 minutes or less** (`ACCESS_TOKEN_TTL_SECONDS`). First email verification deletes existing refresh tokens, but access JWTs are stateless and remain usable until expiry; keeping this cap bounds that revocation window.
- **One sign-in, both backends.** Access tokens are HS256 JWTs signed with `JWT_SECRET`, the Run Module's secret, so the Run Module accepts them as they are.
- **Every per-user route is locked to its user.** `/api/users/{user_id}/...` needs `Authorization: Bearer <that user's token>`: 401 without one, 403 with anyone else's. The training sockets take the token as `?token=`. Sign-up (`POST /api/users`) now takes a `password` and returns tokens; an account made elsewhere (e.g. the mobile app, with email and name only) adds its details with `PUT /api/users/{id}/profile`. `backend/tests/test_access.py` checks every per-user route. The private "About you" details are `/api/me/profile-details`, which takes the user from the token alone (see the "About you" section above).

## PostgreSQL: accounts, profiles and exercise sessions

With `DATABASE_URL` set (`backend/db/`):

- **Accounts and profiles live in the database**, not in files (migration 002): sign-in accounts
  (`user_accounts`: email, scrypt password hash), single-use refresh tokens (`user_refresh_tokens`,
  hashes only), profiles (`user_profiles`: the profile as JSON, with `first_name`, `last_name` and
  `email` as columns) and the rest of each profile (`user_profile_data`: skill level, the fitness /
  activities / physique / habits answers, the measurement history and the consent log, one row each).
  Partner Hunt preferences are in `partner_hunt_preferences` (migration 005, one row per member, the
  validated preferences as JSON), and the "About you" form's personal email, course and CGPA are in
  `user_personal_details` (migration 006). Both survive a redeploy. A database that is down means
  sign-in and profiles fail until it is back. Blocks are not stored here: Social owns them (ADR-032).
  Shared workout sessions are in `shared_workout_sessions` (migration 007) and Partner Hunt Connect
  requests in `partner_requests` (migrations 008, and 009 for removed connections).
- **Every exercise session is copied** into `exercise_sessions`, and, for accounts, into the shared
  `activity_sessions` table, which is what earns the session XP (below). Session files stay the
  source of truth.

Without `DATABASE_URL`, all of this is files under `data/` (local development).

**Moving an existing server over:** `python -m backend.db import-files` copies accounts and profiles
from `data/` into the database. Existing users keep their id and password; nobody already in the
database is overwritten, so it is safe to run twice. Refresh tokens are not copied: those users sign
in again once.

The same database also holds the Run Module's tables (one Supabase + PostGIS database for both). Each
module migrates and writes its own tables. The one shared table is `activity_sessions`: the Run Module
creates it, and this backend only inserts and updates its own rows there (`source_module =
'exercise_module'`). See "Both backends on one database" in the [repository README](../README.md).

### `exercise_sessions`

| Column | Meaning |
|---|---|
| `session_id` | The session's id (primary key) |
| `user_id` | The member's id (the account's UUID) |
| `activity_type` | `squat`, `pushup`, `bicep_curl` or `high_knee` (references `activity_types`) |
| `start_time`, `end_time` | When the session was started, and when its last set finished |
| `duration_s` | Active exercise time across its sets, in seconds |
| `calories_kcal` | Empty until calories are calculated |
| `sets`, `reps` | Sets and reps completed (high knees: counted knee lifts) |
| `workout_score` | The system-generated Workout Score (0–100) |
| `activity_rating` | The member's own rating (1–5), if they gave one |

Running measures (distance, steps, pace, speed) are left out on purpose.

### `activity_sessions` rows (XP)

One row per session of an account (`type = 'exercise'`, `subtype` = the exercise), per the Integration
Contract. `duration_s` is the session's length, from its start to the end of its last set; the active
exercise time is in `metrics.active_time_s`, next to reps (counted only), good reps, reps not
counted, correct %, depth, Workout Score and sets. The Run Module turns these rows into XP
([ADR-027](../run-module/docs/decisions/ADR-027-xp-rules-and-endpoints.md)): 2 XP per counted rep
(high knees: 1 per 2 counted lifts), at most 70 a session and 150 from exercise a day. Only
controlled reps count (`configs/fsm.yaml` `min_rep_ms`); a shallow rep counts toward the set with a
warning said at once, but only full-range reps (`good_reps`) earn XP (`count_shallow: true`).

Days and times are the person's own: the app sends the phone's IANA time zone when it creates a
session, and history, reports, the activity calendar, the streak (the current one), "this week"
and the activity row's `metrics.timezone` (the Run Module's XP day) all follow it
(`backend/localtime.py`). Sessions without one use `EXERCISE_DEFAULT_TIMEZONE` (default
`Asia/Kolkata`). Timestamps are still stored in UTC. If the Run
Module's migrations have not run yet, the table is missing: the session's own row is still written
and a warning is logged; a backfill adds the row later.

**When session rows are written:**
- when a set finishes;
- when the training connection closes;
- when a rating is saved or removed;
- by `python -m backend.db backfill`, which writes every stored session.

A write is an upsert, so running it again just refreshes the row. If the database is down, training
and ratings carry on, the failure is logged, and a backfill catches the tables up afterwards.

**Schema:** migrations live in `backend/db/migrations/` and are applied automatically when the app
starts. You can also apply them yourself with `python -m backend.db migrate`. `activity_types`
lists the enabled exercises; enabling a new exercise means adding its row in a new migration.

**Local setup (macOS):**

```bash
brew install postgresql@16 && brew services start postgresql@16
createdb exercise_mechanics
export DATABASE_URL=postgresql://localhost/exercise_mechanics
python -m uvicorn backend.main:app --port 8000     # creates the tables on start
python -m backend.db import-files                  # optional: bring existing accounts/profiles in
python -m backend.db backfill                      # optional: copy existing sessions in
```

**Tests:** the suite never uses your shell's `DATABASE_URL`. `test_database.py` and
`test_accounts_database.py` run against a disposable database named in `TEST_DATABASE_URL` (their
tables are dropped and recreated) and are skipped without it. `TEST_ACCOUNTS_DATABASE_URL` (another
disposable database) runs the **whole** suite with accounts and profiles in PostgreSQL instead of files.

```bash
createdb exercise_test && createdb accounts_test
TEST_DATABASE_URL=postgresql://localhost/exercise_test python -m pytest -q backend/tests
TEST_ACCOUNTS_DATABASE_URL=postgresql://localhost/accounts_test python -m pytest -q backend/tests
```

## Layout

| Path | What it holds |
|---|---|
| `backend/` | FastAPI app, exercise engine, per-exercise rule packages, scoring, tests |
| `frontend-react/` | React + Vite single-page app (source, assets, tests) |
| `frontend-dist/` | Generated SPA bundle — build output, not in version control |
| `data/users/` | Local per-user profiles and sessions, created at runtime (private, not shipped) |
| `Dockerfile` | Two-stage build: SPA + backend in one image, one origin |
| `USER_GUIDE.md` | Plain-language setup and usage walkthrough |
| `LICENSE` | MIT license terms |

## Data & privacy

Runtime profiles, sessions and raw captures are written under `data/users/<user-id>/` and are
**private local data** — they are excluded from version control and must not be shared publicly.
Make changes in the `backend/` and `frontend-react/` codebases only.
