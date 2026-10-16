# ADR-001: Geometry Fixture Noise Profiles

**Status:** Accepted

---

## Context

During RM-2.2 (Douglas–Peucker simplification), the geometry pipeline's
unit-test fixtures were found to produce inconsistent results depending on
which noise level was chosen for the synthetic GPS track generator.

### The sigma-vs-epsilon finding

The RM-2.2 spec requires that Douglas–Peucker with `epsilon = 4 m`
reduces a 2 000-point track by **at least 80 %**.

Empirical measurement showed that the choice of `noiseStdDevM` determines
whether this criterion is met. Specifically, at noise 3 m with epsilon 4 m, the sigma/epsilon ratio is 0.75, Douglas-Peucker cannot discriminate noise from signal, and reduction falls to ~55%, below the spec's 80% floor.

### The pipeline-order justification

The specification's ≥ 80 % floor is not arbitrary — it is premised on the
actual input the geometry pipeline receives. Two upstream stages pre-process
every raw GPS point before it reaches this code:

1. **RM-1.2 accuracy gating** rejects any point whose reported GPS accuracy
   exceeds 20 m. This removes the worst-accuracy outliers.

2. **RM-1.3 Kalman smoothing** runs **on device**, before any point is
   transmitted to the backend. It suppresses high-frequency jitter by
   maintaining a state estimate and blending new measurements with the
   predicted trajectory.

The combination of these two stages means that the geometry pipeline never
receives raw, unsmoothed GPS data. Raw 3 m independent jitter models unsmoothed GPS, which this code never sees. After RM-1.2
gating and RM-1.3 smoothing, the residual jitter is approximately **1.5 m**,
which is the canonical fixture noise level.

## Decision

Two named noise profiles are exported from
`src/geometry/__fixtures__/noisy-track.ts`:

1. `SMOOTHED_TRACK_PROFILE` (1.5 m) is CANONICAL for all Phase 2 tickets.
2. `RAW_GPS_TRACK_PROFILE` (3.0 m) is for stress tests only.

The noise generator will use a deterministic seeded PRNG using the `mulberry32` algorithm with Box-Muller Gaussian noise to offset `lat` and `lng` by the specified standard deviation in meters.

### Fixture-shape catalogue

We define base shapes for deterministic testing:

1.  **Simple Loop:** A rectangular run covering ~30,000m² (a large park block). Used to test baseline area, perimeter, and the `snap-to-close` behavior.
2.  **Figure-Eight:** A loop that crosses over itself exactly once. Used to test `ST_Polygonize`, ensuring it correctly nodes the intersection and emits two distinct faces rather than an invalid self-intersecting polygon.
3.  **Noisy Figure-Eight:** A figure-eight with a high-noise intersection, where the runner paces back and forth at the crossing. Used to test how the pipeline handles MICROFACES produced by a noisy self-crossing: 10 faces, of which the two dominant lobes carry 98.8% of total area and the remaining 8 are all under 171 m2, safely below the 500 m2 minimum-area floor. Note that these faces are adjacent, not overlapping. ST_MakeValid is no longer applied at insert (ADR-006).
4.  **Out-and-Back:** A rectangular loop with a dangling spur. It produces ONE face of roughly 30,000 m2 and is ACCEPTED.

---

## Consequences

- If RM-1.3's smoothing leaves more residual jitter than 1.5 m, this ADR and `SIMPLIFY_EPSILON_M` are revisited together.
- Test files will rely heavily on these fixtures and the chosen PRNG. WKT output (golden files) will remain stable unless the pipeline algorithm fundamentally changes.

*Corrected 2026-09-19: Documented the NOISE PROFILE decision, canonical vs stress profiles, sigma/epsilon finding, pipeline-order justification, PRNG as mulberry32 with Box-Muller, and corrected the out-and-back shape description.*
