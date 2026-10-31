# ADR-022: Kalman Smoothing

## Context
As specified in RM-1.3, accepted GPS fixes require smoothing to estimate true velocity and reduce track length inflation caused by raw positional jitter. This output directly feeds the auto-pause trigger and derived metrics logic.

## Decisions

1. **Filtering in Metres**: A degree of longitude represents a physical distance that shrinks with latitude, causing raw degree-based filtering to treat axes asymmetrically. The track is projected into a local equirectangular frame centred on its first accepted point, filtered in metres, and unprojected for output. Local projection maintains sub-millimetre round-trip precision across run-sized bounds (e.g., a 2 km square).

2. **Per-Axis 1-D Constant-Velocity Filters**: Rather than using a generic linear-algebra library for a 4x4 state matrix, we run two independent 1-D filters (one for Easting, one for Northing) each with state `[position, velocity]`. Because the measurement covariance is diagonal, this is mathematically equivalent to the 4-state formulation but much faster and less error-prone to hand-write.

3. **Accuracy as Measurement Noise**: The measurement noise variance `R` is defined directly from the fix's `accuracyM` squared. A floor of `1.0` metre prevents extremely low reported accuracies from locking the filter state to a single fix.

4. **Acceleration Variance (Q)**: 
   The process noise covariance `Q` is scaled dynamically with `dt` under the standard white-noise-acceleration model:
   ```
   Q = q * [[dt^4/4, dt^3/2],
            [dt^3/2, dt^2  ]]
   ```
   We have chosen `q = 0.005` (m/s^2)^2 uniformly for all fixtures. This single parameter effectively suppresses high-frequency jitter (allowing stationary drift to remain below 0.5 m/s) while preserving enough responsiveness to avoid massive corner-cutting on the rectangular loop.

5. **Gap Reset**: If the interval between consecutive fixes exceeds 30,000 ms, we assume a break in continuity (e.g., the runner stopped and later resumed) and re-initialise velocity to zero at the new position.

6. **Residual Jitter (Implication for ADR-001)**:
   Initially, point-to-point RMS error was measured at 4.68 m, leading to the incorrect conclusion that jitter remained far above ADR-001's 1.5 m assumption. However, point-to-point RMS conflates random jitter with the smoother's temporal lag along the path. 
   When measured correctly as CROSS-TRACK error (perpendicular distance to the path), the findings are:
   - Cross-track RMS (straight segments only): **2.65 m**.
   - Cross-track RMS (whole loop): 3.04 m.
   - Max cross-track deviation at corner: 10.75 m.
   - Mean signed along-track error (lag): -1.24 m.
   
   **ADR-001's revisit condition is TRIGGERED** (measured straight-segment cross-track jitter 2.65 m against an assumed 1.5 m). However, the project owner has **DEFERRED** any change to SIMPLIFY_EPSILON_M until real device traces exist. Rationale: the 4.0 m input noise is itself synthetic, and real GPS error (multipath near buildings and trees, hardware variation, non-uniform sampling) is not Gaussian, so calibrating one synthetic figure against another would be over-fitting. 
   
   The same deferral covers retuning the smoother's q for the auto-pause lag (which causes roughly +16 s of moving time per stop).

   Additionally, the smoothed speed CV for a metronomic straight-line runner is **0.230**, while a realistic pacing line is **0.296**. Since both are comfortably above the backend's SPEED_CV_SUSPICIOUS = 0.05 threshold, the margin provided by noise keeps honest even-paced runners safe from the pending band, even after smoothing.