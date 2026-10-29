# ADR-010: Temporal Scoring Layer (Temporal Plausibility)

## Status
Accepted

## Context
RM-4.5 requires a temporal scoring layer to detect implausible timestamp patterns that indicate fabricated data. Specifically, we need to detect:
1. Two runs from the same user with overlapping timestamps.
2. Uploads whose timing is impossible relative to the run they describe (e.g., an upload timestamped *before* the points it contains were recorded).

Unlike kinematic or geometric violations, overlapping runs have innocent explanations—a run left active and forgotten while the user starts a new one on another device, or two devices signed into the same account. Thus, overlap is a data-quality signal carrying suspicion, not proof, and must be flagged for review rather than outright rejected.

Crucially, RM-1.6 explicitly supports offline tracking, meaning a large gap between the time points were recorded and the time they were uploaded is *designed behavior*. Delay must never be penalized. However, an upload timestamped *before* the points were recorded is a contradiction that proves timestamp fabrication.

## Decision

1. **Definition of a Run's Time Window:**
   - A run's time window is strictly defined by its first and last `run_points.recorded_at` timestamps.
   - We do *not* use `runs.started_at` because it is when the client claims it began the run (client-influenced metadata), whereas the points are the actual evidence.

2. **Decisive vs. Suspicious Temporal Signals:**
   - **Impossible Upload Skew (Decisive):** If the earliest `run_batches.uploaded_at` predates the last point's `recorded_at` by more than `IMPOSSIBLE_UPLOAD_SKEW_S` (60 seconds, to absorb normal clock drift), the score drops to `0.0` immediately. It is impossible to upload data before it was recorded.
   - **Overlapping Runs (Suspicious):** If the time window of a run overlaps with the window of a previous run by the *same user* by more than `OVERLAP_MIN_SECONDS` (60 seconds, to ignore trivial overlaps from imperfect clock precision when ending/starting runs), we subtract `0.4` from the score. This lands the score at `0.6` (above the rejection threshold of 0.5) to flag it for review by RM-4.6, rather than rejecting it.

3. **Offline Uploads are Safe:**
   - Positive upload skew (uploading long after the points were recorded) is normal and unpenalized. This ensures RM-1.6 offline tracking works seamlessly.

4. **Handling Absent Data (Pre-migration Runs):**
   - If a run lacks `run_batches` rows (e.g., seeded directly in tests or predating migration 005), we report `batch_count` 0 and `upload_skew_s` null, and apply no penalty. Absent data is not evidence.

5. **Same-User Only and Lookback Limit:**
   - Overlap checks are constrained to runs by the *same user*. Two different users can safely run at the same time.
   - Comparisons are bounded to the most recent `TEMPORAL_LOOKBACK_RUNS = 50` to maintain O(1) scalability during finalization.

## Consequences
- We reliably catch teleported timestamps or poorly fabricated future-timestamped GPX tracks via impossible skew.
- Honest runners who use multiple devices or accidentally leave a tracker running will only be flagged (0.6), not punished by default. RM-4.6 can aggregate this suspicion.
- The temporal layer remains completely deterministic, read-only, and bounded in execution time.
