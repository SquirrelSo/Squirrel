/**
 * GPS payload validation and track maths. Pure functions (no I/O) so they are unit-testable.
 * Everything here is about REJECTING malformed data at the door; anti-cheat scoring
 * (verification/anticheat.ts) is a separate, softer stage that runs asynchronously.
 */
import { z } from 'zod';
import { config } from '../config.js';
import { errors } from '../lib/errors.js';

export const PointSchema = z.object({
  seq: z.number().int().min(0).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  recorded_at: z.string().datetime({ offset: true }),
  accuracy_m: z.number().min(0).max(10_000),
  speed_ms: z.number().min(0).max(100).nullable().optional(),
  altitude_m: z.number().min(-500).max(10_000).nullable().optional(),
});
export type Point = z.infer<typeof PointSchema>;

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
export function haversineM(aLat: number, aLng: number, bLat: number, bLng: number) {
  const dLat = rad(bLat - aLat);
  const dLng = rad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const HARD_MAX_SPEED_MS = 30; // ~108 km/h: beyond this a fix cannot be a human — rejected at ingest as a jump

/**
 * Validate a batch of points against structural rules. Throws ApiError(422, invalid_gps).
 * `prev` is the last accepted point before this batch (for timestamp ordering across batches).
 */
export function validatePoints(points: Point[], prev: Point | null, opts: { startedAt?: string; maxPoints?: number } = {}): void {
  const maxBatch = opts.maxPoints ?? config.gps.maxPointsPerBatch;
  if (points.length === 0) throw errors.invalidGps('points must not be empty');
  if (points.length > maxBatch) throw errors.payloadTooLarge(`At most ${maxBatch} points per batch`);
  const startedAt = opts.startedAt ? Date.parse(opts.startedAt) : null;
  let last = prev;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) throw errors.invalidGps(`point ${i}: invalid coordinates`);
    if (p.accuracy_m > config.gps.maxAccuracyM) throw errors.invalidGps(`point ${i}: accuracy ${p.accuracy_m} m is worse than the ${config.gps.maxAccuracyM} m limit`);
    const t = Date.parse(p.recorded_at);
    if (!Number.isFinite(t)) throw errors.invalidGps(`point ${i}: invalid recorded_at`);
    if (t > Date.now() + 120_000) throw errors.invalidGps(`point ${i}: recorded_at is in the future`);
    if (startedAt !== null && t < startedAt - 60_000) throw errors.invalidGps(`point ${i}: recorded before the activity started`);
    if (last) {
      const lt = Date.parse(last.recorded_at);
      if (t < lt) throw errors.invalidGps(`point ${i}: timestamps must be non-decreasing`);
      if (last.seq !== undefined && p.seq !== undefined && p.seq <= last.seq) throw errors.invalidGps(`point ${i}: seq must increase`);
      const dt = (t - lt) / 1000;
      const d = haversineM(last.lat, last.lng, p.lat, p.lng);
      if (dt > 0 && d / dt > HARD_MAX_SPEED_MS) throw errors.invalidGps(`point ${i}: impossible jump (${Math.round(d)} m in ${dt.toFixed(1)} s)`);
      if (dt === 0 && d > 50) throw errors.invalidGps(`point ${i}: two positions ${Math.round(d)} m apart with the same timestamp`);
    }
    last = p;
  }
  // Campus fence: everything must be within a sane distance of the campus centre.
  const c = config.campus;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    if (haversineM(c.centerLat, c.centerLng, p.lat, p.lng) > c.maxRadiusM) throw errors.invalidGps(`point ${i}: outside the campus area`);
  }
}

/** Distance and moving time along a track. Segments faster than `maxSpeed` are excluded (they are GPS jumps). */
export function trackStats(points: { lat: number; lng: number; recorded_at: string }[], maxSpeedMs: number, movingSpeedMs = 0.5) {
  let distance = 0, moving = 0, dropped = 0, droppedDistance = 0, maxSpeed = 0;
  const speeds: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const dt = (Date.parse(b.recorded_at) - Date.parse(a.recorded_at)) / 1000;
    const d = haversineM(a.lat, a.lng, b.lat, b.lng);
    if (dt <= 0) continue;
    const v = d / dt;
    if (v > maxSpeedMs) { dropped++; droppedDistance += d; continue; }
    speeds.push(v);
    maxSpeed = Math.max(maxSpeed, v);
    if (v >= movingSpeedMs) { distance += d; moving += dt; }
  }
  const first = points[0], last = points[points.length - 1];
  const elapsed = first && last ? Math.max(0, (Date.parse(last.recorded_at) - Date.parse(first.recorded_at)) / 1000) : 0;
  return { distanceM: distance, movingTimeS: moving, elapsedS: elapsed, droppedSegments: dropped, droppedDistanceM: droppedDistance, maxSpeedMs: maxSpeed, speeds };
}

export function toLineStringWkt(points: { lat: number; lng: number }[]): string {
  return `LINESTRING(${points.map((p) => `${p.lng} ${p.lat}`).join(',')})`;
}
