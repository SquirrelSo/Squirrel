# ADR-007: Anti-Cheat Scoring Model and Kinematic Bounds

## Status
Accepted

## Context
RM-4.1 mandates detecting vehicle-speed runs, impossible acceleration, and teleports by analyzing GPS coordinates server-side. Fraud detection involves multiple heuristics across different layers (kinematic, signal quality, platform, etc.). Rather than inventing the final routing architecture (which is scoped for RM-4.6), a robust, composable, and interim-compatible model is required.

Furthermore, we must assume **no client-side filtering occurred**. A fraudulent client can disable client-side limits (e.g., the RM-1.2 rejection filter), so the server must independently re-evaluate every rule. Poor GPS signals or buffered offline uploads create out-of-order timestamps and accuracy issues which must be handled gracefully.

## Decision

1. **Normalized Layer Scoring Convention:**
   - Every anti-cheat layer returns a continuous `score` strictly bounded in `[0, 1]`.
   - `1.0` signifies a definitively clean, human-plausible trace.
   - `0.0` signifies certainly fraudulent or physically impossible data.

2. **Test-Only Threshold for Layers:**
   - A threshold of `0.5` is used temporarily in layer tests (RM-4.1, RM-4.2) to satisfy pass/fail requirements.
   - **The real `accept`/`pending`/`reject` band definitions and cross-layer score aggregation are explicitly deferred to RM-4.6.**

3. **Kinematic Constants & Rationale:**
   - `MAX_PLAUSIBLE_SPEED_MS = 12.0`: Corresponds to roughly 2:19/km, surpassing elite sprint pace if sustained.
   - `IMPLAUSIBLE_AVG_SPEED_MS = 8.33`: Corresponds to 2:00/km (the spec's car-speed example).
   - `MAX_PLAUSIBLE_ACCEL_MS2 = 4.0`: Human sprint starts can briefly exceed this.
   - `TELEPORT_MIN_SPEED_MS = 25.0`: Roughly 90 km/h. Exceeding this represents a discontinuity or spoof.
   - `MIN_SAMPLES_FOR_SCORING = 10`: Prevents falsely penalizing very short runs.

4. **Kinematic Handling of Timestamps:**
   - Out-of-order timestamps (`dt < 0`) and zero timestamps (`dt = 0`) are treated as **data quality observations, not fraud**.
   - These segments are omitted from speed and acceleration penalties.
   - If `negative_dt_ratio` and `zero_dt_ratio` exceed `0.5`, the layer returns a `1.0` score with `insufficient_valid_segments = 1`, deferring to other layers.

5. **Kinematic Composition Formula:**
   - `score = 1.0`
   - `- speed_violation_ratio` (fraction of valid segments > `12 m/s`)
   - `- accel_violation_ratio * 0.5` (fraction of valid pairs with > `4 m/s²`)
   - `- teleport_ratio * 2.0` (fraction of valid segments > `25 m/s`)
   - If `avg_speed_ms >= 8.33 m/s`, multiply by `0.2`.
   - Clamp final score to `[0, 1]`.

6. **Signal Quality Scoring Layer:**
   - GPS quality evaluates confidence, not guilt. A poor score doesn't outright condemn a runner (e.g., they could be in an urban canyon), but tracks it for aggregation.
   - `score = 1.0 - low_accuracy_ratio` (fraction of points with `accuracy_m > 20.0`).
   - If `low_accuracy_ratio > 0.5`, multiply score by `0.4` to ensure it lands strictly below `0.5` as per the spec.
   - `- null_accuracy_ratio * 0.3` (Null is unverifiable, tracked separately).
   - `- 0.1` if `accuracy_variance < 0.1` and `non-null points >= 20`. Identical or near-identical GPS accuracies across an entire run are suspicious and highly indicative of synthesis rather than real-world measurement.

## Consequences
- The architecture cleanly decouples the evaluation of fraud and data confidence from the policy (the routing action).
- Sub-signals are fully transparent, preventing opaque "black box" bans.
- Handling out-of-order timestamps prevents devastating false positives for legitimate users utilizing RM-1.6 offline batched uploads.
