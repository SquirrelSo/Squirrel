# ADR-008: Platform Trust Signals

## Status
Accepted

## Context
RM-4.3 mandates evaluating platform-level trust for uploaded run trajectories. Specifically, we must process the device-supplied mock-provider flag (e.g., Android's `isMock()`). The challenge in parsing client telemetry is navigating the fundamental asymmetry of untrusted inputs: a client supplying a mock-provider flag is delivering highly credible evidence against itself, whereas a client omitting or suppressing the flag provides zero evidence of legitimacy.

Additionally, future RM-4.5 temporal heuristics require understanding exact point batch arrival times (to measure upload latency and skew), requiring us to formalize how batch uploads are recorded at the persistence tier without breaking idempotency.

## Decision

1. **The Mock Provider Asymmetry:**
   - A PRESENT `is_mock = true` flag is strong, decisive evidence of cheating. No honest client will set it.
   - An ABSENT or `is_mock = false` flag is strictly NO evidence. A competent spoofer will simply suppress it.
   - Consequently, the Platform layer only acts punitively. The absence of flags grants no restorative score boost; it merely defaults to `1.0` allowing RM-4.6 to aggregate cleanly.

2. **Decisive Mock Scoring (No Ratio Mitigation):**
   - If *any* point in a run (`mock_point_count > 0`) is flagged as `is_mock`, the run scores a flat `0.0`. 
   - We do not scale this by ratio. Intermittent toggling of a joystick app to cross an arbitrary border requires instant penalization, regardless of whether 95% of the run was otherwise physically legitimate.

3. **`run_point_flags` as a Segregated, Nullable Table:**
   - The flag is stored in a separate table (`run_point_flags`) rather than appending columns to the core `run_points` table because `run_points` is a Section 4.1 specification table. Modifying Section 4.1 core schemas is prohibited by the project's strict scope constraints (the same reason rejection reasons are in `run_rejections`). The nullable third-state distinction provides a genuine secondary benefit.
   - The `is_mock` column is explicitly `NULLABLE`. This distinguishes between "client reported false" and "client reported nothing" (an old client or spoofed suppression). This enables the `unreported_ratio` signal for downstream confidence rating in RM-4.6.

4. **Dedicated `run_batches` Table:**
   - Upload events are recorded into a new `run_batches` table alongside point ingestion. 
   - This prevents RM-4.5 temporal tracking from piggybacking on API `idempotency_keys.created_at`. Idempotency keys are ephemeral infrastructure meant for eventual TTL pruning. Tying anti-cheat forensics to prunable infrastructure destroys our ability to re-evaluate historical runs safely.

5. **Deferred Root/Jailbreak Signal:**
   - Detecting OS modification (Rooting/Jailbreaking) lacks a universally agreed-upon or simple implementation without requiring third-party attestation components (e.g., Play Integrity API / DeviceCheck). 
   - We have defined the standard `root_signal` output constraint but defer it by emitting `null` until a broader platform attestation decision is made.

## Consequences
- The scoring model avoids penalizing legitimate users on old app versions who lack the telemetry integration.
- Storing `run_batches` adds minor storage overhead but cleanly insulates long-term anti-cheat forensics from transient API cache expiration.
- Minimal disruption to existing endpoint structural behavior, seamlessly bolsters the fraud-defense matrix for immediate use in RM-4.6.
