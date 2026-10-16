/**
 * Multi-signal anti-cheat scoring. Pure: takes point data + derived stats, returns a score in
 * [0, 1], a verdict band, and a compact reason. No single signal decides on its own except the
 * structural hard-fails (no points, too short, absurd average speed).
 *
 * Bands:  score ≥ 0.75 → VERIFIED · 0.45 ≤ score < 0.75 → PARTIALLY_VERIFIED · < 0.45 → REJECTED
 */
import type { Point } from '../activities/gps.js';
import { trackStats, haversineM, HARD_MAX_SPEED_MS } from '../activities/gps.js';

export type AntiCheatInput = {
  activityType: 'run' | 'walk';
  points: Pick<Point, 'lat' | 'lng' | 'recorded_at' | 'accuracy_m' | 'speed_ms'>[];
  clientDistanceM: number | null;
  clientDurationS: number | null;
  startedAt: string;
  endedAt: string;
  device?: Record<string, unknown> | null;
};

export type AntiCheatResult = {
  score: number;
  band: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'REJECTED';
  reason: string;                     // machine code, e.g. 'too_fast', 'ok', 'segments_dropped'
  signals: Record<string, number | string | boolean>;
  stats: { distanceM: number; movingTimeS: number; elapsedS: number; droppedSegments: number };
  keptPoints: number[];               // indexes of points kept after cleaning
};

const MAX_HUMAN_SPEED: Record<'run' | 'walk', number> = { run: 8.5, walk: 3.5 };  // m/s for a single segment (sprint / brisk walk + GPS noise)
const MAX_AVG_SPEED: Record<'run' | 'walk', number> = { run: 6.5, walk: 2.5 };    // sustained average → vehicle / bike
const MIN_DISTANCE_M = 200;
const MIN_DURATION_S = 60;
const MAX_DURATION_S = 6 * 3600;

const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; };
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

export function scoreActivity(input: AntiCheatInput): AntiCheatResult {
  const signals: AntiCheatResult['signals'] = {};
  const pts = input.points;
  const fail = (reason: string, extra: AntiCheatResult['signals'] = {}): AntiCheatResult => ({
    score: 0, band: 'REJECTED', reason, signals: { ...signals, ...extra }, stats: { distanceM: 0, movingTimeS: 0, elapsedS: 0, droppedSegments: 0 }, keptPoints: [],
  });
  if (pts.length < 2) return fail('no_points');

  const segMax = MAX_HUMAN_SPEED[input.activityType];
  // raw: everything except physically impossible teleports (> HARD_MAX_SPEED_MS) — used to judge vehicle use.
  // cleaned: only human-plausible segments — used for credited distance and zone matching.
  const raw = trackStats(pts, HARD_MAX_SPEED_MS);
  const cleaned = trackStats(pts, segMax);
  signals.point_count = pts.length;
  signals.raw_distance_m = Math.round(raw.distanceM);
  signals.distance_m = Math.round(cleaned.distanceM);
  signals.elapsed_s = Math.round(cleaned.elapsedS);
  signals.moving_time_s = Math.round(cleaned.movingTimeS);
  signals.dropped_segments = cleaned.droppedSegments;
  signals.dropped_distance_m = Math.round(cleaned.droppedDistanceM);

  // --- structural hard fails (evaluated on the RAW track first so a vehicle is called a vehicle, not "too short") ---
  if (raw.elapsedS > MAX_DURATION_S) return fail('too_long');
  const rawAvg = raw.movingTimeS > 0 ? raw.distanceM / raw.movingTimeS : 0;
  signals.raw_avg_moving_speed_ms = Number(rawAvg.toFixed(2));
  if (rawAvg > MAX_AVG_SPEED[input.activityType]) return fail('too_fast');
  const segCount = Math.max(1, pts.length - 1);
  const jumpRatio = cleaned.droppedSegments / segCount;
  signals.jump_ratio = Number(jumpRatio.toFixed(3));
  if (jumpRatio > 0.25) return fail('gps_jumps');
  if (cleaned.distanceM < MIN_DISTANCE_M || cleaned.elapsedS < MIN_DURATION_S) return fail('too_short');
  const avgSpeed = cleaned.movingTimeS > 0 ? cleaned.distanceM / cleaned.movingTimeS : 0;
  signals.avg_moving_speed_ms = Number(avgSpeed.toFixed(2));
  if (avgSpeed > MAX_AVG_SPEED[input.activityType]) return fail('too_fast');

  // --- soft signals, each in [0,1] where 1 = fully plausible ---
  const sJumps = clamp01(1 - jumpRatio * 4);                       // 25 % jumps → 0

  const accs = pts.map((p) => p.accuracy_m);
  const medAcc = median(accs);
  const poorShare = accs.filter((a) => a > 30).length / accs.length;
  const sAccuracy = clamp01(1 - Math.max(0, medAcc - 15) / 40) * clamp01(1 - poorShare * 1.5);
  signals.median_accuracy_m = Number(medAcc.toFixed(1));
  signals.poor_accuracy_share = Number(poorShare.toFixed(3));

  // Sampling regularity: big timestamp gaps are suspicious (backgrounded app, or teleport hidden in a gap)
  let maxGap = 0, gapTotal = 0;
  for (let i = 1; i < pts.length; i++) {
    const g = (Date.parse(pts[i]!.recorded_at) - Date.parse(pts[i - 1]!.recorded_at)) / 1000;
    if (g > 60) gapTotal += g;
    maxGap = Math.max(maxGap, g);
  }
  const gapShare = cleaned.elapsedS > 0 ? gapTotal / cleaned.elapsedS : 0;
  const sGaps = clamp01(1 - gapShare * 2) * (maxGap > 600 ? 0.6 : 1);
  signals.max_gap_s = Math.round(maxGap);
  signals.gap_share = Number(gapShare.toFixed(3));

  // Speed profile: humans vary; a perfectly constant speed or many near-max segments is synthetic
  const speeds = cleaned.speeds;
  const medSpeed = median(speeds);
  const fastShare = speeds.filter((v) => v > segMax * 0.8).length / Math.max(1, speeds.length);
  const variance = speeds.length > 3 ? speeds.reduce((s, v) => s + (v - medSpeed) ** 2, 0) / speeds.length : 1;
  const sProfile = clamp01(1 - fastShare * 2) * (speeds.length > 20 && variance < 0.005 ? 0.5 : 1);
  signals.median_speed_ms = Number(medSpeed.toFixed(2));
  signals.fast_segment_share = Number(fastShare.toFixed(3));
  signals.speed_variance = Number(variance.toFixed(4));

  // Straightness: a route that is nearly a straight line at high speed is typical of a car/bike
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const chord = haversineM(first.lat, first.lng, last.lat, last.lng);
  const straightness = cleaned.distanceM > 0 ? chord / cleaned.distanceM : 0;
  const sShape = straightness > 0.95 && avgSpeed > 4 ? 0.6 : 1;
  signals.straightness = Number(straightness.toFixed(3));

  // Client-vs-server consistency: a client that over-reports distance by a lot is suspicious
  let sClient = 1;
  if (input.clientDistanceM && cleaned.distanceM > 0) {
    const ratio = input.clientDistanceM / cleaned.distanceM;
    signals.client_distance_ratio = Number(ratio.toFixed(3));
    if (ratio > 1.3) sClient = clamp01(1 - (ratio - 1.3));
  }
  // Duration consistency between declared window and recorded points
  const declared = (Date.parse(input.endedAt) - Date.parse(input.startedAt)) / 1000;
  const sWindow = declared > 0 && cleaned.elapsedS > declared * 1.2 ? 0.7 : 1;
  signals.declared_duration_s = Math.round(declared);

  // Device-reported speed agreement (when the device sends it)
  let sDevice = 1;
  const deviceSpeeds = pts.map((p) => p.speed_ms).filter((v): v is number => typeof v === 'number');
  if (deviceSpeeds.length > 10) {
    const devMed = median(deviceSpeeds);
    if (devMed > 0 && medSpeed > 0) { const r = medSpeed / devMed; sDevice = r > 1.6 || r < 0.6 ? 0.7 : 1; signals.device_speed_ratio = Number(r.toFixed(2)); }
  }
  // Point density: too sparse for the distance → the route is guessed between points
  const density = cleaned.distanceM / pts.length; // metres per point
  const sDensity = density > 60 ? 0.7 : 1;
  signals.metres_per_point = Number(density.toFixed(1));

  const weights: [number, number][] = [[sJumps, 0.25], [sAccuracy, 0.15], [sGaps, 0.15], [sProfile, 0.2], [sShape, 0.05], [sClient, 0.05], [sWindow, 0.05], [sDevice, 0.05], [sDensity, 0.05]];
  const score = clamp01(weights.reduce((s, [v, w]) => s + v * w, 0));
  const band: AntiCheatResult['band'] = score >= 0.75 ? 'VERIFIED' : score >= 0.45 ? 'PARTIALLY_VERIFIED' : 'REJECTED';
  const reason = band === 'REJECTED'
    ? (jumpRatio > 0.15 ? 'gps_jumps' : poorShare > 0.5 ? 'poor_accuracy' : gapShare > 0.3 ? 'timestamp_gaps' : 'low_confidence')
    : cleaned.droppedSegments > 0 ? 'segments_dropped' : 'ok';

  // Kept points: drop the far end of every excluded (jump) segment
  const kept: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[kept[kept.length - 1]!]!, b = pts[i]!;
    const dt = (Date.parse(b.recorded_at) - Date.parse(a.recorded_at)) / 1000;
    const v = dt > 0 ? haversineM(a.lat, a.lng, b.lat, b.lng) / dt : 0;
    if (v <= segMax) kept.push(i);
  }
  return { score: Number(score.toFixed(3)), band, reason, signals, stats: { distanceM: cleaned.distanceM, movingTimeS: cleaned.movingTimeS, elapsedS: cleaned.elapsedS, droppedSegments: cleaned.droppedSegments }, keptPoints: kept };
}
