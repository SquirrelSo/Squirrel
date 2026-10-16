# ADR-009: Statistical Scoring Layer (Duplicate Run Detection)

## Status
Accepted

## Context
RM-4.4 requires statistical evaluation to detect machine-generated tracks (which often feature perfectly uniform, unnatural speed) and "duplicate runs" (replays of a user's own previous GPX traces). A fraudulent user might capture a territory perfectly, save the payload, and submit it repeatedly to reclaim it effortlessly. Due to floating-point noise and GPS jitter added by some spoofing applications, a simple exact equality check is insufficient to catch all replays. However, cross-comparing every run against the entire database is computationally infeasible.

During testing, a false positive path was identified: the original near-duplicate logic relied solely on geometric comparison (`ST_HausdorffDistance` and area tolerance). This would incorrectly penalize a highly common real-world behavior: a runner repeating their favorite local park route on different days at different paces (e.g., an easy Monday jog vs. a Thursday tempo run). Because the route was identical, the system flagged it as a near-duplicate, which erodes trust for honest users.

## Decision

1. **Two-Mechanism Approach:**
   - We utilize two mechanisms: Exact Hashing and Near Duplicate spatial comparison. One mechanism is not enough because floating-point precision differences (e.g. from GPX serialization/deserialization) or simple spoofing apps adding small sub-5m noise easily defeat simple hash matches, while pure spatial checks are too expensive to run unconditionally.

2. **Decisive vs. Suspicious Comparisons:**
   - **Exact Hash Matches (Decisive):** If the `point_hash` matches a previous run, the score drops to `0.0` immediately. The hash operates on coordinates rounded to 5 decimal places (roughly ~1.1 meters at the equator). This eliminates trivial floating-point serialization noise while remaining deterministic. The exact-hash path is unchanged by the pace guard because a bit-for-bit point hash match already proves an identical pace profile (it's literally the same file).
   - **Near Duplicates (Suspicious):** To prevent false positives from honest route repetition, a near-duplicate match now requires four conjunctive conditions:
     - Hausdorff distance < `DUPLICATE_HAUSDORFF_M`
     - Area within `DUPLICATE_AREA_TOLERANCE`
     - Duration within `DUPLICATE_DURATION_TOLERANCE`
     - Mean speed within `DUPLICATE_PACE_TOLERANCE`
   
   If the geometry matches but pace or duration does not, it is NOT a near-duplicate. It is instead reported as `same_route_different_pace_run_id` without any score penalty, serving as context for RM-4.6. 

3. **Handling Legacy Signatures:**
   - A prior signature with a `NULL` `duration_s` or `mean_speed_ms` (written before the migration) does not produce a near-duplicate match. Absent data is not evidence; thus a NULL pace means "cannot compare" rather than "matches".

4. **Same-User Only:**
   - We only compare a run's signature against previous runs belonging to the SAME `user_id`. Comparing across users would flag legitimate users who simply participate in the same local running events or popular trails.

5. **50-Run Lookback:**
   - Comparing against all history is O(n) per finalization and won't scale. Bounding the search to the most recent `DUPLICATE_LOOKBACK_RUNS = 50` scales securely while catching typical repeat-abuse loops.

6. **Signature Persistence for Rejected Runs:**
   - `run_signatures` is populated during `finalizeRun` for BOTH successfully claimed and rejected runs. A rejected run (e.g., failed kinematic checks) still tells us the user attempted that route; we must know its signature so if they try to replay the exact same spoofed file later, it gets caught.

## Known Limitations
- A constant-true-pace track with standard 1.5 m Gaussian GPS noise measures a `speed_cv` of approximately 0.419, which heavily exceeds the 0.05 threshold. Because real GPS noise alone produces a coefficient of variation between 0.3 and 0.4 against the strict 0.05 threshold, two consequences result:
  1. Metronomic human runners are not falsely flagged.
  2. The constant-speed detector only catches naive synthetic generation with near-zero noise. A spoofer who adds jitter escapes this layer and is caught, if at all, by near-duplicate detection.

## Consequences
- We effectively halt mass GPX replays without penalizing humans who have routine running routes.
- An accepted residual false positive exists: two runs of the same route at the exact same pace on different days will be flagged as a near-duplicate. A 0.3 score is a suspicion, not an outright rejection, and RM-4.6 will decide what suspicion warrants.
- The `finalizeRun` queue length is shielded from geometric scaling since comparisons are hard-capped at 50 per execution.
- We maintain structural safety by keeping signature metadata strictly segregated from core Section 4.1 routing tables.
