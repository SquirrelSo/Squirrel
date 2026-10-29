# ADR-027: XP Rules and Endpoints

| Field          | Value                                                        |
|----------------|--------------------------------------------------------------|
| **Status**     | Accepted                                                     |
| **Date**       | 2026-09-26                                                   |
| **Supersedes** | ADR-005 §1 "no SELECT on activity_sessions", for XP reads only |

## Context

The Integration Contract says XP is derived from the shared `activity_sessions` table, and that
Partner Hunt (Exercise Module) calls `meetsXPGate(userId, minXP)` and `getUserXP(userId)`. The app
reads `GET /v1/users/me/xp`. None of this existed in this repository. The rules below were
confirmed by the product owner on 2026-09-26; the run rules match the ones the app already shows.

## Decisions

### 1. XP is derived, never stored
Every read scores the user's `activity_sessions` rows (`src/xp/rules.ts`, pure). There is no balance
column or ledger to drift, and a rule change re-scores history consistently. An index on
`(user_id, started_at)` (migration 012) keeps the per-user read cheap. No columns were added to
`activity_sessions`.

This is the one place the Run Module reads `activity_sessions`, and it reads the rows of every
module for that user, because XP counts both. It never writes through this path. ADR-005's
write-only rule still holds for everything else.

### 2. Rules
| Activity (type / source_module)     | XP                                                          |
|-------------------------------------|-------------------------------------------------------------|
| `run` / `run_module`                | 50 completed + 1 per whole 100 m + 25 if territory claimed |
| rejected run (`rejection_reason` set) | 0                                                         |
| `exercise` / `exercise_module`      | 2 per full-range rep (`metrics.good_reps`; shallow reps count toward the set but earn none) · timed: 1 per 2 counted lifts (`metrics.lifts`) · at most 70 a session. Amended after field testing: the first rule paid by `duration_s` (<10 min 0 · 10–20 min 30 · 20–45 min 50 · 45 min+ 70), which paid shallow and idle time the same as good work |
| anything else                       | 0                                                           |

- **Daily caps:** 150 XP from runs and, separately, 150 XP from exercise, per day. The company gave
  the exercise cap as "100–150"; 150 was chosen to match runs. It is one constant
  (`DAILY_EXERCISE_XP_CAP`).
- **Flagged runs** (anti-cheat band `pending`) earn XP like accepted runs: they keep their territory,
  so they keep their XP. Only rejected runs earn nothing.
- **Ownership check:** a row counts only when the module that owns its type wrote it, so neither
  module can mint the other's XP.

### 3. The day is local, not UTC
Caps use the person's own calendar day: the IANA time zone the phone sent with the activity
(`metrics.timezone`, on runs and exercise sessions), else `XP_TIMEZONE` (default `Asia/Kolkata`).
A UTC day would reset at 5:30 am for Indian users and put a 00:30 workout on the day before;
one server-wide zone would do the same for anyone outside it. Within a day, sessions count in the order they started, so the cap cuts
the latest ones and the result does not depend on read order. (The leaderboard keeps its UTC
buckets, ADR-016; that is a separate ranking concern.)

### 4. Endpoints
- `GET /v1/users/me/xp` (user token) → `{ xp, updated_at, breakdown: [{ reason, xp }] }`. The
  breakdown totals per reason and adds up to `xp`; a cap shows as a negative line.
- `GET /v1/users/:userId/xp` (service token) → `{ xp, updatedAt }`. `xp` is 0 for a new user, never null.
- `GET /v1/users/:userId/xp-gate?minXP=N` (service token) → `true | false`. `minXP` is the caller's.

`updated_at` is when the latest row that earned XP was recorded (null when none has).

### 5. Service token
Partner Hunt asks about other users, so a user token cannot be used. The Exercise Module (which
issues the account tokens) signs a short-lived token with the same key:
`{ sub: "exercise_module", typ: "service", exp }`. `requireService` requires that exact subject, that
typ and an `exp`. A user token (UUID sub, `typ: "access"`) cannot pass it, and a service token cannot
pass `requireAuth` (its sub is not a UUID). No new secret to manage; moving to RS256 (ADR-003)
keeps working, since the issuer holds the signing key either way.

## Not built (not defined yet)
Streaks, personal bests, challenges, the daily-goal and rest-day bonuses. (Since defined: challenges
(ADR-032 "Goals") and the daily goal, awards from other services, reversal and the challenge reward
cap: ADR-033.) Streaks need a day
boundary decided (§3 is a candidate); personal bests span both modules.

## Consequences
- Partner Hunt's gate opens as soon as a user has earned `minXP` (100 today, set by the Exercise Module).
- Exercise sessions earn XP as soon as the Exercise Module writes its `activity_sessions` rows.
- Every XP read scans one user's rows. Fine at this scale; a per-day rollup can come later without
  changing the endpoints.
