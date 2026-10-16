/**
 * Lightweight GPS track processing for the run screen: rejects inaccurate fixes and
 * teleports, accumulates distance and moving time. Kalman smoothing is intentionally not
 * ported here: the Run Module's :core module has a tested implementation, and porting it
 * to this client is separate work. The server recomputes uploaded distance either way.
 */
export type Fix = { lat: number; lon: number; t: number; accuracy?: number | null };

const R = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;

export function haversine(a: Fix, b: Fix) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const MAX_ACCURACY_M = 20; // matches the Run Module signal-quality layer
export const MAX_SPEED_MS = 12; // ~2'20"/km — faster than any runner; treat as a GPS jump
export const MOVING_SPEED_MS = 0.8; // below this is a possible pause
const PAUSE_AFTER_MS = 10_000;

export type TrackState = { points: Fix[]; reference: Fix | null; meters: number; movingSec: number; rejected: number; lowSpeedSince: number | null; lowSpeedSec: number };

export const emptyTrack = (): TrackState => ({ points: [], reference: null, meters: 0, movingSec: 0, rejected: 0, lowSpeedSince: null, lowSpeedSec: 0 });

export function addFix(s: TrackState, f: Fix): TrackState {
  if (f.accuracy == null || f.accuracy > MAX_ACCURACY_M) return { ...s, rejected: s.rejected + 1 };
  const last = s.points[s.points.length - 1];
  if (!last) return { ...s, points: [f], reference: f };
  if (f.t <= last.t) return s;

  const reference = s.reference ?? last;
  const dt = (f.t - reference.t) / 1000;
  if (dt <= 0) return s;
  const d = haversine(reference, f);
  const noise = (reference.accuracy ?? 0) + (f.accuracy ?? 0);
  // Keep uncertain fixes in the route, but hold the last accepted reference steady.
  // Displacement can then accumulate against that reference until it clears the noise floor.
  if (d <= noise) return { ...s, points: [...s.points, f] };

  const v = d / dt;
  if (v > MAX_SPEED_MS) return { ...s, rejected: s.rejected + 1 };
  // The final partial segment can remain below the noise floor and be undercounted. This is
  // acceptable for the live client estimate because the server recomputes distance on upload.
  if (v >= MOVING_SPEED_MS) {
    return { ...s, points: [...s.points, f], reference: f, meters: s.meters + d, movingSec: s.movingSec + dt, lowSpeedSince: null, lowSpeedSec: 0 };
  }

  const lowSpeedSince = s.lowSpeedSince ?? last.t;
  const lowSpeedSec = s.lowSpeedSec + dt;
  // Tentatively count slow movement. Once it lasts >10 seconds, backdate the pause
  // by removing all tentative time since the first low-speed fix.
  if (lowSpeedSec > PAUSE_AFTER_MS / 1000) {
    const newlyPaused = s.lowSpeedSec <= PAUSE_AFTER_MS / 1000;
    return { ...s, points: [...s.points, f], reference: f, meters: s.meters + d, lowSpeedSince, lowSpeedSec, movingSec: newlyPaused ? Math.max(0, s.movingSec - s.lowSpeedSec) : s.movingSec };
  }
  return { ...s, points: [...s.points, f], reference: f, meters: s.meters + d, movingSec: s.movingSec + dt, lowSpeedSince, lowSpeedSec };
}

/** Feed a location batch in timestamp order; addFix rejects fixes older than the last point. */
export function addFixBatch(s: TrackState, fixes: readonly Fix[]): TrackState {
  return [...fixes]
    .sort((a, b) => a.t - b.t)
    .reduce(addFix, s);
}

/** Client-side plausibility check shown before the server's verdict arrives. */
export type Verdict = 'accepted' | 'flagged' | 'rejected';

export function localVerdict(km: number, movingSec: number, rejectedRatio: number): { verdict: Verdict; reason: string } {
  if (km < 0.2) return { verdict: 'rejected', reason: 'Too short to count — runs need at least 200 m.' };
  const paceSecPerKm = movingSec / Math.max(km, 0.001);
  if (paceSecPerKm < 150) return { verdict: 'rejected', reason: 'Faster than 2\'30"/km — looks like a vehicle.' };
  if (rejectedRatio > 0.3 || paceSecPerKm < 180) return { verdict: 'flagged', reason: 'Unusual GPS or pace — sent for review.' };
  return { verdict: 'accepted', reason: 'Looks good. Every metre counted.' };
}
