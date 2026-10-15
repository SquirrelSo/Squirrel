# ADR-033: XP Sources, Reversal, Stats and Level-ups

| Field          | Value                                                                      |
|----------------|----------------------------------------------------------------------------|
| **Status**     | Accepted                                                                   |
| **Date**       | 2026-10-07                                                                 |
| **Supersedes** | ADR-027 "Not built": the daily-goal bonus is now defined (§4). ADR-027's rules otherwise stand. |

## Context

ADR-032 makes the Run Module the only XP ledger. campus-service already reports territory claim,
steal and defend awards to `POST /internal/v1/xp/award`. Exercise (shared workouts, workout buddies),
campus-service (meetup check-ins) and Social (ambassadors, special events) now need to award XP too,
sometimes take it back, and the app needs XP stats, an XP history and a monthly board. AGENTS.md
requires an ADR before any value is added; the values below were decided by the product owner and
are the cross-service contract's §1.

An audit also found that a challenge's `xp_reward` is chosen by the client that creates it, with no
upper bound: anyone could create a daily challenge worth a million XP and win it.

## Decisions

### 1. Award catalogue
`POST /internal/v1/xp/award` (service token: `SOCIAL_INTERNAL_TOKEN`, or the Exercise service JWT)
accepts only these (source, reason) pairs. Amounts are checked server-side; anything else is **422**.

| source   | reason                    | amount per award        | limit                                               |
|----------|---------------------------|-------------------------|-----------------------------------------------------|
| campus   | `territory_claim`         | 1–100                   | territory cap 150 XP/day (unchanged)                 |
| campus   | `territory_steal`         | 1–100                   | territory cap 150 XP/day (unchanged)                 |
| campus   | `territory_defend`        | 1–100                   | territory cap 150 XP/day (unchanged)                 |
| campus   | `meetup_checkin`          | 25 exactly              | once per meetup per person: key `meetup:{meetupId}:{subject}` |
| exercise | `shared_workout_finished` | 20 exactly              | only the first 3 awards a day count                  |
| exercise | `buddy_connected`         | 20 exactly              | once per pair per person: key `buddy:{pairKey}:{subject}` |
| social   | `ambassador_referral`     | 50 exactly              | once per referred person (the caller's key)          |
| social   | `ambassador_task`         | 1–200 (set per task)    |                                                      |
| social   | `special_event`           | 1–100 (set per event)   |                                                      |

- **Overall cap:** every **non-territory** award together counts at most **300 XP per user per XP day**.
- The XP day for awards is the calendar day in `XP_TIMEZONE` (default `Asia/Kolkata`) of when the
  award was recorded.
- For `meetup_checkin` and `buddy_connected` the key format above is enforced (422 otherwise), with
  the subject in it, so "once per meetup / pair per person" holds even if a caller retries with a new
  key. The id part may contain `:` (Exercise's pair key is `{low}:{high}`).
- Optional `source_id` (≤ 200 characters: the caller's id for the meetup, task, event…) and
  `metadata` (a JSON object, ≤ 2 KB) are stored with the award for audit; oversized values are 422.
  `idempotency_key` is 1–200 characters (422 otherwise). Missing fields or wrong types are 400.
- Unchanged: the answer is the subject's new total as a bare integer; a replay with the same
  (source, idempotency_key) and identical (subject, amount, reason) answers the same 200 without a
  second row; any other reuse of the key is 409.

### 2. Caps apply on read
As for runs, exercise and territory (ADR-027), nothing is capped at write time. A capped award is
stored like any other and counts 0 beyond the cap; the breakdown shows the cut as a negative line
(`territory_daily_cap`, `shared_workout_daily_limit`, `campus_awards_daily_cap`,
`exercise_awards_daily_cap`, `social_awards_daily_cap`, `challenge_daily_cap`). Within a day, awards
count in the order they were recorded, so a cap always cuts the latest. A 4th shared workout counts 0
and uses none of the 300. The total, `/v1/users/me/xp`, `/v1/xp`, progress, stats, history and the XP
board all add up the same lines (`src/xp/rules.ts` `summarize`), so every number agrees.

### 3. Reversal
`POST /internal/v1/xp/reverse { source, idempotency_key, reason (1–200) }` (service token) marks the
award reversed (`reversed_at`, `reversal_reason`); it is never deleted. A reversed award counts 0
and uses no cap. Answer: the new total as a bare integer. Reversing again answers the same 200 and
keeps the first reason; an unknown award is 404 `{ "error": "not_found" }`. Replaying the original
award does not bring it back. A reversal may lower the user's level; that is allowed and silent.

### 4. Daily goal
**30 XP once per XP day** on any day the user has at least one activity row that earns XP before the
caps: a completed, non-rejected run, or an exercise session with counted reps (`DAILY_GOAL_XP`).
Derived on read like run and exercise XP, on each row's own XP day (ADR-027 §3), and outside the run
and exercise daily caps. Reason `daily_goal`, source `daily_goal`. A session that counted no reps
does not complete the goal, so an empty session cannot farm it.

### 5. Challenge rewards
- `xp_reward` on `POST /v1/challenges` is capped at **200** (422 above; negative stays 400); the
  service function refuses it too.
- Challenge-win XP counts toward a **200 XP per user per XP day** cap on read (by when the challenge
  resolved), which also bounds rewards created before the cap.
- `invitee_id` on `POST /v1/challenges/:id/invite` must be a UUID (400 otherwise).

### 6. Stats, history and board windows
- `GET /v1/xp/stats` (user token) → `{ total, level, level_progress: { current_level_xp,
  next_level_xp, into_level, needed }, today, week, month, by_source }`. A level every 2000 XP (as
  `/v1/xp`). `week` is the Monday-start week (as `/v1/xp` and `/v1/progress/weekly`); `month` is the
  calendar month so far; both in `XP_TIMEZONE`. `by_source` has `run`, `exercise`, `campus`,
  `challenge`, `social`, `daily_goal` and adds up to `total`.
- `GET /v1/xp/history?limit=&cursor=` (user token) → `{ items, next_cursor }`, newest first, one item
  per XP line `{ id, amount, source, reason, source_id, created_at, reversed }`, from activity lines,
  daily goals, challenge wins and awards. Cap cuts are their own negative items; a reversed award is
  listed with `reversed: true` and counts 0, so the non-reversed amounts add up to the total. Keyset
  cursor on (created_at, id); `limit` 1–100 (default 20).
- `GET /v1/leaderboard/xp` gains `window=monthly` (the calendar month so far in `XP_TIMEZONE`);
  `daily` (today) and `weekly` (the last 7 days) are unchanged. The board now includes challenge-win
  XP (it was missing) and awards, with the same caps.
- The three reads are rate-limited per user (`RATE_LIMIT_XP_READ_PER_MIN`, default 120/min).

### 7. Level-up notifications
When an award or a reversal leaves the user at a **higher** level than before, an `xp.level_up` row
(data `{ level, xp }`) goes into the notification outbox and the existing deliverer sends it to
Social (`POST /internal/v1/notifications`, title written by the Run Module, route `/progress`). The
dedupe key is `level:{subject}:{level}` (the outbox id is derived from it, and Social dedupes on it),
so each level is announced once, even if a reversal takes it away and it is reached again. A level
lost to a reversal is not notified. The outbox row is written before the award answers; queueing it
for delivery happens in the background, so Redis can never hold up an award.

## Consequences
- Every user who earned run or exercise XP gains 30 XP for each such day, retroactively (XP is
  derived). Existing totals rise once at deploy.
- Migration 019 adds `source_id`, `metadata`, `reversed_at`, `reversal_reason` and an index on
  `(user_id, created_at)` to `external_xp_awards`; the primary key and the `amount > 0` check stay.
- A territory award above 100 is now 422 (it was 400 from schema validation); campus-service only
  sends valid amounts.
- Callers (campus-service, Exercise, Social) award and reverse fire-and-forget after their own commit.
