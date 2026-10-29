# ADR-011: Anti-cheat Aggregation and Routing

## Status
Accepted

## Context
RM-4.6 specifies how the five anti-cheat layers (Platform, Temporal, Statistical, Kinematic, Signal-Quality) combine to produce a final verdict for a run. The combination must route each run to the appropriate band (`accept`, `pending`, `reject`), and ensure that rejected runs never reach the territory-insert path.

## Decision

1. **Score Combination (Minimum Override Logic):**
   - The aggregate score is the `Math.min` of all five layer scores.
   - If *any* layer returns exactly `0.0`, the aggregate is strictly `0.0`, and that layer is recorded as the `decisiveLayer` (the first one at `0.0` in the fixed deterministic order: Platform, Temporal, Statistical, Kinematic, Signal-Quality).
   - *Rationale:* A weighted average allows four clean layers to dilute one decisive signal (e.g., a mock-provider flag), which would defeat RM-4.3 entirely. Minimum makes a decisive signal decisive, and prevents suspicion from several layers compounding into a false rejection.

2. **Bands and Boundaries:**
   - `reject`:  `aggregate < 0.3`
   - `pending`: `0.3 <= aggregate <= 0.7`
   - `accept`:  `aggregate > 0.7`
   - The boundary rules are strictly enforced (e.g., `0.7` itself is `pending`).

3. **Pending Policy (Flagged Runs):**
   - A `pending` run is GRANTED its territory.
   - The run's `status` becomes `flagged` (a new status, in addition to `active`, `paused`, `finishing`, `finalized`, and `rejected`).
   - The score and band are persisted in the `run_scores` table for a future moderation queue.
   - *Rationale:* RM-4.1a and RM-4.4a established that behavior with innocent explanations (e.g., routine route repetition) must not punish honest users. Withholding territory for unproven suspicion, especially with no moderation queue yet built, acts as a silent rejection. A pending run is granted its territory provisionally to preserve trust.

4. **Placement and Ordering:**
   - Scoring runs inside `finalizeRun`, *after* geometry validation succeeds and *before* the territory insert, within the same transaction.
   - *Rationale:* This placement is the only way to mathematically guarantee the spec's requirement that a rejected run never reaches the territory-insert path.
   - A geometrically invalid run is rejected by the geometry layer first. Anti-cheat scoring applies only to geometrically valid runs. Therefore, a geometry rejection produces NO `run_scores` row, as scoring is never reached.

5. **Exposing Scores to the Client:**
   - `GET /v1/runs/:id` returns the `score` object (`aggregate`, `band`, `decisive_layer`) but intentionally excludes the full per-layer signals.
   - *Rationale:* Exposing the underlying signals provides an instruction manual for spoofers to tune around our defenses. The raw evidence is kept server-side for moderation.

## Consequences
- Flagged runs earn leaderboard points like any other run because they successfully capture territory. This is accepted; a leaderboard where some captures silently do not score is confusing.
- The full runs `status` domain is now: `active`, `paused`, `finishing`, `finalized`, `rejected`, and `flagged`.
