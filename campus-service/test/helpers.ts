/** Test helpers: synthetic GPS tracks around the campus centre. */
import { config } from '../src/config.js';
import type { Point } from '../src/activities/gps.js';

const M_PER_DEG_LAT = 111_320;
const mPerDegLng = () => 111_320 * Math.cos((config.campus.centerLat * Math.PI) / 180);
export const xyToLatLng = (x: number, y: number) => ({ lat: config.campus.centerLat + y / M_PER_DEG_LAT, lng: config.campus.centerLng + x / mPerDegLng() });

/** Walk a polyline of local-metre waypoints at `speedMs`, sampling every `stepS` seconds. */
export function trackAlong(waypoints: [number, number][], speedMs: number, opts: { stepS?: number; accuracy?: number; startAt?: Date } = {}): Point[] {
  const stepS = opts.stepS ?? 2, acc = opts.accuracy ?? 8;
  const start = (opts.startAt ?? new Date(Date.now() - 3600_000)).getTime();
  const pts: Point[] = [];
  let t = 0, seq = 0;
  const push = (x: number, y: number) => { const { lat, lng } = xyToLatLng(x, y); pts.push({ seq: seq++, lat, lng, recorded_at: new Date(start + t * 1000).toISOString(), accuracy_m: acc, speed_ms: speedMs }); };
  push(waypoints[0]![0], waypoints[0]![1]);
  for (let i = 1; i < waypoints.length; i++) {
    const [x0, y0] = waypoints[i - 1]!, [x1, y1] = waypoints[i]!;
    const len = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.max(1, Math.round(len / (speedMs * stepS)));
    for (let s = 1; s <= steps; s++) { t += stepS; push(x0 + ((x1 - x0) * s) / steps, y0 + ((y1 - y0) * s) / steps); }
  }
  return pts;
}

/** A lawn-mower sweep across a rectangle — covers most of its area. */
export function sweepRect(x0: number, y0: number, x1: number, y1: number, laneM = 20): [number, number][] {
  const wps: [number, number][] = [];
  let dir = 1;
  for (let y = y0 + 5; y <= y1 - 5; y += laneM) {
    wps.push(dir > 0 ? [x0 + 5, y] : [x1 - 5, y]);
    wps.push(dir > 0 ? [x1 - 5, y] : [x0 + 5, y]);
    dir = -dir;
  }
  return wps;
}
