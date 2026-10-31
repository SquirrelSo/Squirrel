/**
 * src/geometry/__fixtures__/shape-tracks.ts
 *
 * Deterministic synthetic track fixtures for polygonization tests (RM-2.4 / RM-2.5).
 *
 * ALL COORDINATES ARE SYNTHETIC — no real GPS data, no real user locations.
 *
 * ════════════════════════════════════════════════════════════════════════
 * FIXTURE DESIGN — Part A (RM-2.4a)
 *
 * Every generator now accepts ShapeOptions and defaults to:
 *   noiseStdDevM = 1.5   (SMOOTHED_TRACK_PROFILE, see ADR-001)
 *   rotationDeg  = 23    (non-axis-aligned — exercises the full pipeline)
 *   seed         = per-shape constant
 *
 * Clean baseline: pass { noiseStdDevM: 0, rotationDeg: 0 } to recover
 * the idealised geometry from RM-2.4.
 *
 * All shapes are constructed in LOCAL AEQD PLANAR METRES then
 * unprojected to WGS84.  Area constants are ideal planar values;
 * tests check that the pipeline output is WITHIN TOLERANCE of them,
 * not exactly equal.
 * ════════════════════════════════════════════════════════════════════════
 *
 * Centre: mid-latitude Mumbai area (19.0025°N, 72.803°E)
 * matching the RM-2.1 projection fixture.
 */

import { createLocalProjection } from "../projection.js";
import { createPrng } from "./prng.js";
import type { LatLng } from "../types.js";

// ── Shared centre ─────────────────────────────────────────────────────────────

const CENTRE: LatLng = { lat: 19.0025, lng: 72.803 };

// ── Options ───────────────────────────────────────────────────────────────────

export interface ShapeOptions {
  /**
   * Gaussian noise standard deviation in metres, applied per-vertex.
   * Default: 1.5 m (SMOOTHED_TRACK_PROFILE, see ADR-001).
   * Pass 0 for a clean noiseless baseline.
   */
  noiseStdDevM?: number;
  /**
   * Rigid rotation of the entire shape in degrees CCW before projecting.
   * Default: 23° — ensures the shape is not axis-aligned, exercising the
   * full pipeline.  Pass 0 for an axis-aligned baseline.
   */
  rotationDeg?: number;
  /**
   * Seed for the Gaussian noise PRNG.  Each generator has its own default
   * so different shapes don't interfere.  Override to reproduce a specific run.
   */
  seed?: number;
}

// ── Planar geometry helpers ───────────────────────────────────────────────────

/** Rotate a point (x, y) by angleDeg degrees counter-clockwise. */
function rotate(x: number, y: number, angleDeg: number): [number, number] {
  const rad = (angleDeg * Math.PI) / 180;
  return [
    x * Math.cos(rad) - y * Math.sin(rad),
    x * Math.sin(rad) + y * Math.cos(rad),
  ];
}

/**
 * Box–Muller: one pair of standard-normal samples from the PRNG.
 * Returns [z0, z1].
 */
function boxMullerPair(next: () => number): [number, number] {
  const u1 = next() || Number.EPSILON;
  const u2 = next();
  const r = Math.sqrt(-2 * Math.log(u1));
  const theta = 2 * Math.PI * u2;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/**
 * Transform a list of ideal (x, y) planar metre coords to WGS84 LatLng:
 *   1. Rotate by rotationDeg.
 *   2. Add Gaussian noise (noiseStdDevM per axis).
 *   3. Unproject to WGS84 via AEQD.
 *
 * If close=true, appends a COPY of the (noisy, rotated) first point as
 * the last vertex.  The first point is NOT re-noised — it is copied exactly.
 */
function transformCoords(
  coords: [number, number][],
  opts: Required<ShapeOptions>,
  close = false
): LatLng[] {
  const proj = createLocalProjection([CENTRE]);
  const prng = createPrng(opts.seed);
  const noiseSigma = opts.noiseStdDevM;

  // Pre-generate noise pairs
  const noiseX = new Float64Array(coords.length);
  const noiseY = new Float64Array(coords.length);
  for (let i = 0; i < coords.length; i += 2) {
    const [z0, z1] = boxMullerPair(prng.next.bind(prng));
    noiseX[i] = z0 * noiseSigma;
    noiseY[i] = z1 * noiseSigma;
    if (i + 1 < coords.length) {
      const [z2, z3] = boxMullerPair(prng.next.bind(prng));
      noiseX[i + 1] = z2 * noiseSigma;
      noiseY[i + 1] = z3 * noiseSigma;
    }
  }

  const result: LatLng[] = coords.map(([ix, iy], i) => {
    const [rx, ry] = rotate(ix, iy, opts.rotationDeg);
    const x = rx + (noiseX[i] ?? 0);
    const y = ry + (noiseY[i] ?? 0);
    return proj.toLatLng({ x, y });
  });

  if (close && result.length > 0) {
    result.push({ ...result[0]! });
  }
  return result;
}

/** Merge caller opts with per-shape defaults. */
function mergeOpts(
  callerOpts: ShapeOptions | undefined,
  defaultSeed: number
): Required<ShapeOptions> {
  return {
    noiseStdDevM: callerOpts?.noiseStdDevM ?? 1.5,
    rotationDeg:  callerOpts?.rotationDeg  ?? 23,
    seed:         callerOpts?.seed         ?? defaultSeed,
  };
}

// ── Simple loop ───────────────────────────────────────────────────────────────

/**
 * A convex quadrilateral loop (200 × 150 m rectangle).
 * With default noise/rotation the pipeline area will differ from the ideal
 * value by a small percentage — the test measures that delta.
 *
 * Expected faces: 1
 * Ideal planar area: 200 × 150 = 30 000 m²
 */
export const SIMPLE_LOOP_EXPECTED_FACES = 1;
/** Ideal planar area of the simple loop in m². Tests use this as the reference. */
export const SIMPLE_LOOP_AREA_M2 = 200 * 150; // 30 000

export function generateSimpleLoop(opts?: ShapeOptions): LatLng[] {
  const o = mergeOpts(opts, /* defaultSeed= */ 101);
  return transformCoords(
    [
      [-100, -75],
      [ 100, -75],
      [ 100,  75],
      [-100,  75],
    ],
    o,
    true // close
  );
}

// ── Figure-eight (clean) ──────────────────────────────────────────────────────

/**
 * A CLEAN figure-eight: the linework crosses itself exactly once at a
 * well-defined point (the origin), producing exactly 2 polygon faces.
 *
 * With default noise and rotation, the measured face areas will differ
 * from the ideal values by a few percent — the test verifies the delta
 * is within 5%.
 *
 * Expected faces: 2
 * Ideal right lobe: 160 × 100 = 16 000 m²
 * Ideal left  lobe:  80 × 100 =  8 000 m²
 */
export const FIGURE_EIGHT_EXPECTED_FACES = 2;
export const FIGURE_EIGHT_RIGHT_AREA_M2 = 160 * 100; // 16 000
export const FIGURE_EIGHT_LEFT_AREA_M2  =  80 * 100; //  8 000
export const FIGURE_EIGHT_TOTAL_AREA_M2 = FIGURE_EIGHT_RIGHT_AREA_M2 + FIGURE_EIGHT_LEFT_AREA_M2;

export function generateFigureEight(opts?: ShapeOptions): LatLng[] {
  // NOISE IS ZERO BY DEFAULT for the clean figure-eight.
  //
  // The crossing at (0,0) must be an EXACT vertex shared by both passes.
  // Gaussian noise applied to that vertex shifts it slightly off-centre on
  // each pass, destroying the clean intersection and instead creating an
  // ambiguous near-degenerate region that ST_Node resolves unpredictably —
  // producing one merged lobe + a sliver, not two clean lobes.
  //
  // The noisy crossing behaviour is the domain of generateNoisyFigureEight().
  // That fixture uses noise intentionally to reproduce microfaces.
  //
  // Rotation (23°) is retained — it exercises the projection round-trip
  // without disturbing the crossing topology.
  const o: Required<ShapeOptions> = {
    noiseStdDevM: opts?.noiseStdDevM ?? 0,   // ← 0 by default
    rotationDeg:  opts?.rotationDeg  ?? 23,
    seed:         opts?.seed         ?? 202,
  };
  const coords: [number, number][] = [
    [0,    0],
    [0,   -50],
    [160, -50],
    [160,  50],
    [0,    50],
    [0,    0],   // crossing back through origin
    [0,    50],
    [-80,  50],
    [-80, -50],
    [0,   -50],
    [0,    0],   // close
  ];
  return transformCoords(coords, o);
}

// ── Noisy figure-eight (microface) ────────────────────────────────────────────

/**
 * A NOISY figure-eight that INTENTIONALLY produces MICROFACES at the crossing.
 *
 * This fixture reproduces the ORIGINAL RM-2.4 crossing design: the path
 * revisits the crossing region as several nearby but distinct points.  With
 * Gaussian noise applied, the crossing area has multiple nearly-coincident
 * segments that ST_Node finds as separate intersections, yielding several
 * microfaces in addition to the two main lobes.
 *
 * This is REAL BEHAVIOUR on real GPS input — a runner who loops back through
 * their own path produces noisy crossings that the polygonizer splits into
 * microfaces.  RM-2.5's minimum-area gate filters them out.
 *
 * Expected: MORE than 2 faces total.
 * The two LARGEST faces should account for the bulk of total area.
 * Exported face count is a LOWER BOUND — the exact count is noise-dependent.
 */
export const NOISY_FIGURE_EIGHT_DOMINANT_FACES = 2;

export function generateNoisyFigureEight(opts?: ShapeOptions): LatLng[] {
  // Higher noise to ensure the crossing is genuinely ambiguous.
  const defaultNoise = opts?.noiseStdDevM ?? 3.0; // RAW_GPS_TRACK_PROFILE
  const o = mergeOpts({ ...opts, noiseStdDevM: defaultNoise }, /* defaultSeed= */ 303);

  // Visiting the crossing region multiple times with several points close
  // together — these are indistinguishable from a real noisy crossing.
  const coords: [number, number][] = [
    // Start/end — crossing region with several nearby vertices
    [0,    0],
    [2,    1],
    [-1,   2],
    [1,   -1],
    // Right lobe
    [0,   -50],
    [160, -50],
    [160,  50],
    [0,    50],
    // Back through crossing with slightly different points
    [1,    0],
    [-2,   1],
    [0,    2],
    [-1,  -1],
    // Left lobe
    [0,    50],
    [-80,  50],
    [-80, -50],
    [0,   -50],
    // Return to start region
    [-1,   0],
    [2,   -1],
    [0,    0],
  ];
  return transformCoords(coords, o);
}

// ── Out-and-back ──────────────────────────────────────────────────────────────

/**
 * A rectangular loop (200 × 150 m) with a 100 m spur that goes out and
 * returns along the same path.  The spur is a dangling edge and is
 * discarded naturally by ST_Polygonize.
 *
 * Expected faces: 1
 * Ideal loop area: 200 × 150 = 30 000 m²
 */
export const OUT_AND_BACK_EXPECTED_FACES = 1;
export const OUT_AND_BACK_LOOP_AREA_M2 = 200 * 150; // 30 000

export function generateOutAndBack(opts?: ShapeOptions): LatLng[] {
  const o = mergeOpts(opts, /* defaultSeed= */ 404);
  const coords: [number, number][] = [
    [-100, -75],
    [ 100, -75],
    [ 100,  75],
    [-100,  75],
    [-100, -75],
    [-200, -75],   // spur: out
    [-100, -75],   // spur: back
  ];
  return transformCoords(coords, o);
}

// ── Open track ────────────────────────────────────────────────────────────────

/**
 * A track whose start and end are ~500 m apart — well above the 30 m
 * snap-close threshold.  Returns ok=false reason='not_closed'.
 */
export function generateOpenTrack(opts?: ShapeOptions): LatLng[] {
  const o = mergeOpts(opts, /* defaultSeed= */ 505);
  return transformCoords([
    [-250, -75],
    [ 250, -75],
    [ 250,  75],
  ], o);
}
