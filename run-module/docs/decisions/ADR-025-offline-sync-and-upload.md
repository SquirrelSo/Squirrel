# ADR-025: Offline Sync & Upload

## Context
RM-1.6 requires recorded runs to be uploaded to the backend such that an offline recording synced later produces the identical stored point set as a live-uploaded recording.

## Decisions

1. **Upload Smoothed Points, Recomputed from Stored Raw Fixes**
   We upload smoothed points (recomputed from raw fixes), not the raw fixes themselves. ADR-001 assumed smoothed input, and the server's auto-pause would fail on raw jitter. The re-smoothing must occur from seq 0 over the stored fixes, never taken from the recording service's live smoother, because the live smoother resets on RESUME and would break determinism. ccuracy_m sent is the original fix's accuracy. is_mock is explicitly alse since the client drops mock fixes (ADR-008).

2. **Deterministic Idempotency Keys**
   The upload uses idempotency keys formatted as "<runLocalId>:<firstSeq>-<lastSeq>". Since fixes are immutable and smoothing is deterministic, the key guarantees that retries after lost responses result in the server cleanly replaying its stored answer without creating duplicates.

3. **One Uploader for Both Paths**
   Live recording and offline sync use the exact same upload pipeline, guaranteeing identical stored sets. Live mode merely triggers the upload pipeline more frequently (e.g., every 30 points).

4. **Schema Change by Migration Only**
   Added fields: uploadedThroughSeq, inishSent, and serverStatus to the uns table. We enforce this through a real Room Migration to avoid destructive migration wiping out users' recorded territory.

## Deferred (Known Gaps)
- Reporting mock-location rejection counts to the server requires a backend schema change. This is deemed low priority since spoofers cannot gain territory (mock fixes are rejected locally).
- POST /v1/runs lacks an idempotency key. A dropped response on run creation might leave an empty orphan run on the server. Since it has no points and is never finished, it's harmless, but requires a backend change to fix properly.