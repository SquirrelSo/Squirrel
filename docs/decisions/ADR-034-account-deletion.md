# ADR-034: Account deletion across the four services

**Status:** DRAFT. Needs product and legal approval before any code is written (context WI-02, §12-Q2).
**Date:** 2026-10-08
**Why now:** Deletion is not built anywhere (runbook p.15). India's Digital Personal Data Protection
Act 2023 gives a person the right to erase their personal data, and the app collects location
histories of students (OPS-6 privacy sign-off is also pending).

## What is decided by the architecture (ADR-032)

These follow from ownership and need no product input:

1. **Exercise owns the account, so Exercise orchestrates.** The app calls one endpoint on Exercise.
   No other service is ever called by the app to delete.
2. **Each owner deletes its own data.** Every service exposes an internal, idempotent
   `DELETE /internal/v1/users/{sub}` guarded by `SOCIAL_INTERNAL_TOKEN` (or the Exercise service JWT on
   the Run Module, `requireService`). A user token can never reach it.
3. **XP needs no separate step.** XP is derived on read from `activity_sessions` and
   `external_xp_awards` (ADR-027/033); deleting those rows removes the XP, and caches (`xp_total` in
   campus and Social) expire within their 5-minute TTL.
4. **Re-running is safe.** A second call for the same `sub` returns 204 and changes nothing.
5. **Identity mapping:** Social's `users.auth_subject` is the `sub`; campus users are keyed by `sub`
   (with Social ids returned to the app). Social must be deleted **last** among the downstream services,
   because campus and Exercise resolve `sub` ↔ profile id through Social while they delete.

## Proposed flow

```text
App ── DELETE /api/me (user token, recent sign-in) ──▶ Exercise
Exercise: mark account `deletion_pending`, revoke refresh tokens (sign-out everywhere)
  ├─▶ Run Module  DELETE /internal/v1/users/{sub}
  ├─▶ campus      DELETE /internal/v1/users/{sub}
  ├─▶ Social      DELETE /internal/v1/users/{sub}      (last: others resolve ids through it)
  └─ Exercise deletes its own rows, then the account
Any failure: the account stays `deletion_pending`, a retry job re-runs the whole fan-out (idempotent).
```

## Data inventory (what exists for one `sub`)

| Service | Tables / objects holding the person's data |
|---|---|
| Exercise (shared DB) | `user_accounts`, `user_refresh_tokens`, `user_profiles`, `user_profile_data`, `user_personal_details`, `email_verification_codes`, `auth_throttle`, `partner_hunt_preferences`, `partner_requests`, `shared_workout_sessions` (participant entries), `exercise_sessions`; file-backed session data under `data/users/` when `DATABASE_URL` is unset |
| Run Module (shared DB) | `runs`, `run_points`, `run_batches`, `run_point_flags`, `run_rejections`, `run_signatures`, `run_scores`, `idempotency_keys`, `territories` + `capture_events` (run polygons), `activity_sessions` (rows for this user, all types), `external_xp_awards`, `challenge_participants`, leaderboard snapshot rows, `notification_outbox` |
| campus-service (campus DB) | `users`, `activities`, `activity_points`, `activity_point_batches`, `qualification_results`, `presence`, `bubble_members`, `territories` (zones owned), `territory_events`, `challenges` (created/targeted), `meetups` (created), `meetup_participants`, `meetup_ratings` (given and received), `idempotency_keys`, legacy `blocks`, `user_profile_details` and `notifications` (all being retired: WI-07, WI-06, `pending/008_drop_notifications.sql`) |
| Social (shared DB + bucket) | `users`, `members` (waitlist, referral, email-verified), `user_stats`, `follows` (both directions), `posts`, `post_likes`, `post_saves`, `comments`, `media` + objects in the `social-media` bucket, `user_badges`, `crew_members`, `crew_vouches`, `crews` (if owner), `events` (if host), `event_rsvps`, `checkins`, `social_challenges`, `notifications` (to and about), `notification_preferences`, `push_tokens`, `push_tickets`, `ambassador_applications`, `ambassador_profiles`, `ambassador_task_submissions`, `ambassador_rewards`, `user_blocks` (both directions), `dates_prefs`, `zone_visits`, `date_dismissals`, `activities` |

## Decisions required (do not implement until answered)

| # | Question | Options | Notes |
|---|---|---|---|
| D1 | Hard delete or anonymise? | (a) hard delete every row; (b) anonymise rows that other people's data depends on (comments in others' threads, meetup ratings, battle history) and delete the rest | (b) keeps other people's threads readable but must remove every identifier |
| D2 | Zones the person holds (campus territory) | (a) become neutral at once; (b) pass to the holding crew if any, else neutral | Territory `version` must still increase monotonically |
| D3 | Crews they own / events they host | (a) delete; (b) transfer to the oldest member / co-host; (c) archive | |
| D4 | Grace period | (a) none; (b) N days `deletion_pending` during which signing in cancels | A grace period needs a scheduled job in Exercise |
| D5 | Blocks they made | Delete (they protect nobody once the account is gone) vs keep as tombstones so a re-registration with the same email stays blocked | Re-registration gets a new `sub`, so tombstones would need an email hash |
| D6 | Retention exceptions | Anti-cheat / moderation evidence (reports, bans) kept for N days? | Legal input needed |
| D7 | Re-authentication | Require an email code within the last N minutes before `DELETE /api/me`? | Recommended |

## Acceptance (once approved)

- After the fan-out, no row in any table above references the `sub` (or its Social profile id), except
  what D1/D6 explicitly keep in anonymised form.
- Every internal endpoint returns 204 on a second call.
- A test per service covers: happy path, re-run, unauthenticated/user token refused (401), and the
  orchestrator retrying after one downstream failure.
- The app gets a "Delete account" entry under Profile → Settings with a confirmation step (needs an APK).
