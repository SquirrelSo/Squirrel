# AGENTS.md — Run Module

## Scope
You are implementing ONLY the Run Module: GPS tracking, territory
marking (GPS path -> polygon), territory maintenance (storage,
conflict resolution, anti-cheat scoring), and the leaderboard.

## Explicitly out of scope — do not implement, do not stub as if
## it belongs here
- Camera-based pose recognition
- Rep counting / depth analysis / rep timing
- Post-workout correctness analysis
- Calorie calculation
- Matching board / recommendation logic
- Reminders / notifications for the Exercise Module
- Any social feed / posting surface

These belong to the Exercise Module, built separately. If a task
seems to require them, stop and ask rather than building a stub.

## Where to find the spec
- Task list with acceptance criteria: section 5 of
  /docs/Run_Module_Implementation_Guide.pdf — this is the
  authority for every ticket. That PDF is NOT in this repository
  (checked 2026-10-08), and neither are ADR-014 or ADR-028–030.
  Until someone supplies them, the ADRs in docs/decisions/ are the
  only written authority; do not go looking for the PDF.
- A separate Technical Specification is referenced by that guide
  but does NOT exist. Where the guide defers to it (anti-cheat
  thresholds, territory decay policy, leaderboard ranking model),
  the decision is recorded in /docs/decisions/ as an ADR. If no
  ADR covers it, STOP and ask. Do not invent the value.
- Shared data contract with the other module: write to
  activity_sessions only; never read or assume the other
  module's internals. One exception: the XP engine
  (src/xp/, ADR-027) reads activity_sessions, read-only.

## Stack
Backend: Node 22 LTS + TypeScript. Database: PostgreSQL 16 +
PostGIS 3.4. Cache: Redis 7. Queue: BullMQ. Client: the Expo
app in ../mobile-4 (React Native); there is no native Swift or
Kotlin client.

## Definition of done for any ticket
Acceptance criteria for that ticket ID are met and demonstrated by
an automated test, not manual inspection. No out-of-scope files
touched. No columns or logic added to activity_sessions beyond this
repo's write path. Committed on its own branch using the convention
<type>(<scope>): <summary>, and pushed.

## Trust boundary
The mobile client may display values. Any value that gates a
database write — distance, area, score — is recomputed server-side.
Never treat a client-submitted metric as authoritative.
