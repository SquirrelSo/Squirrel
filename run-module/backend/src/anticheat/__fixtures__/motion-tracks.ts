import { generateSimpleLoop, generateNoisyFigureEight } from '../../geometry/__fixtures__/shape-tracks.js';
import { createPrng } from "../../geometry/__fixtures__/prng.js";
import { createLocalProjection } from "../../geometry/projection.js";

const METERS_PER_DEGREE = 111320.0;
const DEG = 1.0 / METERS_PER_DEGREE;

export interface TrackPoint {
  accuracy_m?: number | null;
  is_mock?: boolean | null;
  lat: number;
  lng: number;
  recorded_at?: Date;
}

export function assignRealisticTimestamps<T extends { lat: number; lng: number }>(
  points: T[], 
  paceMs = 3.0, 
  startAt = new Date(Date.now() - 100000)
): (T & { recorded_at: Date })[] {
  if (points.length === 0) return [];
  const proj = createLocalProjection(points);
  
  const result: (T & { recorded_at: Date })[] = [];
  let time = startAt.getTime();
  
  result.push({ ...points[0], recorded_at: new Date(time) } as T & { recorded_at: Date });
  
  for (let i = 1; i < points.length; i++) {
    const p1 = proj.toPlanar(points[i - 1]!);
    const p2 = proj.toPlanar(points[i]!);
    const dist = Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
    time += (dist / paceMs) * 1000;
    result.push({ ...points[i], recorded_at: new Date(time) } as T & { recorded_at: Date });
  }
  
  return result;
}

// ~3.0 m/s average (5:33/km), realistic per-sample jitter
export function generateNormalRunnerTrack(seed = 101): TrackPoint[] {
  const prng = createPrng(seed);
  const track: TrackPoint[] = [];
  let baseTime = Date.now() - 3600 * 1000;
  const cx = 0.1;
  const cy = 0.1;
  const radius = 0.0005; // ~55m radius
  for (let i = 0; i <= 115; i++) {
    const angle = (i / 115) * Math.PI * 2;
    const jitter = (prng.next() - 0.5) * 0.000001;
    
    let lat = cy + radius * Math.sin(angle) + jitter;
    let lng = cx + radius * Math.cos(angle) + jitter;
    
    if (i === 115 && track.length > 0) {
      const first = track[0];
      if (first) {
        lat = first.lat;
        lng = first.lng;
      }
    }
    
    track.push({
      lat,
      lng,
      recorded_at: new Date(baseTime + i * 1000)
    });
  }
  return track;
}

// average pace faster than 2:00/km (>= 8.33 m/s)
export function generateCarSpeedTrack(seed = 102): TrackPoint[] {
  const prng = createPrng(seed);
  const track: TrackPoint[] = [];
  let baseTime = Date.now() - 3600 * 1000;
  const lat = 0.1;
  let lng = 0.1;

  for (let i = 0; i < 30; i++) {
    track.push({ lat, lng, recorded_at: new Date(baseTime + i * 1000) });
    // speed between 9.0 and 11.0 m/s
    const speed = 9.0 + prng.next() * 2.0;
    lng += speed * DEG;
  }
  return track;
}

// normal runner track with ONE segment jumping several hundred metres instantaneously
export function generateTeleportTrack(seed = 103): TrackPoint[] {
  const track = generateNormalRunnerTrack(seed);
  // Just shift the 15th point far away to cause a teleport
  if (track.length > 15) {
    const pt = track[15];
    if (pt) pt.lat += 0.05; // 5.5 km teleport
  }
  return track;
}

// repeatedly jumps between near-zero and high speed between consecutive samples
export function generateImpossibleAccelTrack(seed = 104): TrackPoint[] {
  const track: TrackPoint[] = [];
  let baseTime = Date.now() - 3600 * 1000;
  const lat = 0.1;
  let lng = 0.1;

  for (let i = 0; i < 30; i++) {
    track.push({ lat, lng, recorded_at: new Date(baseTime + i * 1000) });
    
    // Alternates between 0 m/s and 10 m/s
    // accel = 10 m/s^2 which violates MAX_PLAUSIBLE_ACCEL_MS2 (4.0)
    const speed = (i % 2 === 0) ? 14.0 : 0.0;
    lng += speed * DEG;
  }
  return track;
}


export function generateCleanGpsTrack(seed = 201): TrackPoint[] {
  const prng = createPrng(seed);
  const track: TrackPoint[] = [];
  let baseTime = Date.now() - 3600 * 1000;
  const lat = 0.1;
  let lng = 0.1;
  for (let i = 0; i < 30; i++) {
    const accuracy_m = 3.0 + prng.next() * 5.0; // 3 to 8 m
    track.push({ lat, lng, accuracy_m, recorded_at: new Date(baseTime + i * 1000) });
    lng += 3.0 * DEG;
  }
  return track;
}

export function generateLowAccuracyTrack(seed = 202): TrackPoint[] {
  const track = generateNormalRunnerTrack(seed);
  return track.map((p, i) => ({
    ...p,
    accuracy_m: i < 70 ? 30.0 : 10.0 // >50% points have accuracy >20m
  }));
}

export function generateNullAccuracyTrack(seed = 203): TrackPoint[] {
  const track: TrackPoint[] = [];
  let baseTime = Date.now() - 3600 * 1000;
  const lat = 0.1;
  let lng = 0.1;
  for (let i = 0; i < 30; i++) {
    track.push({ lat, lng, accuracy_m: null, recorded_at: new Date(baseTime + i * 1000) });
    lng += 3.0 * DEG;
  }
  return track;
}

export function generateConstantAccuracyTrack(seed = 204): TrackPoint[] {
  const track: TrackPoint[] = [];
  let baseTime = Date.now() - 3600 * 1000;
  const lat = 0.1;
  let lng = 0.1;
  for (let i = 0; i < 30; i++) {
    track.push({ lat, lng, accuracy_m: 5.0, recorded_at: new Date(baseTime + i * 1000) }); // exact constant
    lng += 3.0 * DEG;
  }
  return track;
}

export function generateSquareTrack(lat: number, lng: number, radius: number): TrackPoint[] {
  const dLat = radius;
  const dLng = radius;
  const pts = [
    { lat: lat - dLat, lng: lng - dLng },
    { lat: lat + dLat, lng: lng - dLng },
    { lat: lat + dLat, lng: lng + dLng },
    { lat: lat - dLat, lng: lng + dLng },
    { lat: lat - dLat, lng: lng - dLng },
  ];
  return assignRealisticTimestamps(pts, 3.0, new Date(Date.now() - 100000));
}

export function generateNoisyFigureEightTrack(): TrackPoint[] {
  const basePts = generateNoisyFigureEight();
  return assignRealisticTimestamps(basePts, 3.0, new Date(Date.now() - 100000));
}


export function generateMockProviderTrack(seed = 301): TrackPoint[] {
  // KINEMATICALLY PERFECT (normal runner) but every point is_mock true
  const track = generateNormalRunnerTrack(seed);
  return track.map(p => ({ ...p, is_mock: true }));
}

export function generateIntermittentMockTrack(seed = 302): TrackPoint[] {
  // normal runner, one short mock segment near end
  const track = generateNormalRunnerTrack(seed);
  return track.map((p, i) => ({
    ...p,
    is_mock: i >= track.length - 5 && i < track.length - 2 ? true : false
  }));
}

export function generateUnreportedFlagTrack(seed = 303): TrackPoint[] {
  // normal runner with is_mock NULL
  const track = generateNormalRunnerTrack(seed);
  return track.map(p => ({ ...p, is_mock: null }));
}


export function generateRealisticPaceTrack(seed = 401): TrackPoint[] {
  // Mean ~3.0 m/s with realistic variation and corners.
  const track = generateNormalRunnerTrack(seed);
  let baseTime = Date.now() - 3600 * 1000;
  let pts = [];
  
  // Create varying dt to get varying speeds.
  let dtBase = 1.0;
  for (let i = 0; i < track.length; i++) {
    // 0.1 to 0.2 CV
    let drift = Math.sin(i * 0.1) * 0.3; // gradual drift
    let noise = (Math.random() - 0.5) * 0.4;
    let dt = 1.0 + drift + noise; // dt varying between 0.5 and 1.5 roughly
    // this creates speed varying wildly.
    if (dt < 0.5) dt = 0.5;
    if (i > 0) baseTime += dt * 1000;
    
    const p = track[i];
    if (!p) continue;
    pts.push({
      ...p,
      accuracy_m: 5,
      recorded_at: new Date(baseTime)
    });
  }
  return pts;
}

export function generateConstantSpeedTrack(seed = 402): TrackPoint[] {
  // Exactly uniform segment speed.
  const track = generateNormalRunnerTrack(seed);
  let baseTime = Date.now() - 3600 * 1000;
  let pts: TrackPoint[] = [];
  // For exactly constant speed, we must match dt exactly to distance.
  let prev = track[0];
  if (!prev) return [];
  pts.push({ ...prev, recorded_at: new Date(baseTime) });
  
  for (let i = 1; i < track.length; i++) {
    const curr = track[i];
    if (!curr) continue;
    // approximate distance formula in degrees to meters just for fixture
    const dist = Math.sqrt(Math.pow(curr.lat - prev.lat, 2) + Math.pow(curr.lng - prev.lng, 2)) * 111320;
    // Exactly 3.0 m/s
    const dt = dist / 4.0;
    baseTime += dt * 1000;
    pts.push({ ...curr, recorded_at: new Date(baseTime) });
    prev = curr;
  }
  return pts;
}

export function generateReplayTrack(sourceTrack: TrackPoint[]): TrackPoint[] {
  return sourceTrack.map(p => ({ ...p }));
}

export function generateJitteredReplayTrack(sourceTrack: TrackPoint[] = generateNormalRunnerTrack()): TrackPoint[] {
  // Add sub-5-metre noise (~0.00003 degrees) so hash differs but shape does not
  return sourceTrack.map(p => ({
    ...p,
    lat: p.lat + (Math.random() - 0.5) * 0.00001,
    lng: p.lng + (Math.random() - 0.5) * 0.00001
  }));
}

export function generateSlowerReplayTrack(sourceTrack: TrackPoint[]): TrackPoint[] {
  const first = sourceTrack[0];
  if (!first) return [];
  let baseTime = first.recorded_at?.getTime() ?? Date.now();
  let pts: TrackPoint[] = [];
  pts.push({
    ...first,
    lat: first.lat + 0.00001,
    lng: first.lng,
    recorded_at: new Date(baseTime)
  });

  for (let i = 1; i < sourceTrack.length; i++) {
    const prevPoint = sourceTrack[i-1];
    const currPoint = sourceTrack[i];
    if (!prevPoint || !currPoint) continue;
    const prevTime = prevPoint.recorded_at?.getTime() ?? 0;
    const currTime = currPoint.recorded_at?.getTime() ?? 0;
    const dt = currTime - prevTime;
    
    // 40% slower
    baseTime += dt * 1.4;
    
    pts.push({
      ...currPoint,
      lat: currPoint.lat !== undefined ? currPoint.lat + 0.00001 : 0,
      lng: currPoint.lng,
      recorded_at: new Date(baseTime)
    });
  }
  return pts;
}

export function generateOverlappingRunPair(): [TrackPoint[], TrackPoint[]] {
  const t1 = generateRealisticPaceTrack(101);
  const t2 = generateRealisticPaceTrack(102); 
  
  const firstT1 = t1[0];
  const firstT2 = t2[0];
  if (!firstT1 || !firstT2) return [[], []];

  const t1StartTime = firstT1.recorded_at!.getTime();
  const t2StartTime = t1StartTime + 30000; 
  
  const shiftedT2 = t2.map((pt, i) => {
    const origOffset = pt.recorded_at!.getTime() - firstT2.recorded_at!.getTime();
    return { ...pt, lat: pt.lat !== undefined ? pt.lat + 0.1 : 0, recorded_at: new Date(t2StartTime + origOffset) };
  });
  
  return [t1, shiftedT2];
}

export function generateAdjacentRunPair(): [TrackPoint[], TrackPoint[]] {
  const baseTrack = generateRealisticPaceTrack(101);
  const t1: TrackPoint[] = [];
  const t2: TrackPoint[] = [];
  const baseTime = Date.now() - 3600 * 1000;
  for(let i=0; i<baseTrack.length; i++) {
    const p = baseTrack[i];
    if (!p || p.lat === undefined || p.lng === undefined) continue;
    t1.push({ lat: p.lat, lng: p.lng, accuracy_m: p.accuracy_m ?? null, is_mock: p.is_mock ?? null, recorded_at: new Date(baseTime + i * 1000) });
  }
  for(let i=0; i<baseTrack.length; i++) {
    const p = baseTrack[i];
    if (!p || p.lat === undefined || p.lng === undefined) continue;
    t2.push({ lat: p.lat + 0.1, lng: p.lng, accuracy_m: p.accuracy_m ?? null, is_mock: p.is_mock ?? null, recorded_at: new Date(baseTime + 990000 + 30000 + i * 1000) });
  }
  return [t1, t2];
}

export function generateOfflineUploadRun(): TrackPoint[] {
  const baseTrack = generateRealisticPaceTrack(101);
  const t: TrackPoint[] = [];
  const baseTime = Date.now() - 6 * 3600 * 1000;
  for(let i=0; i<baseTrack.length; i++) {
    const p = baseTrack[i];
    if (!p || p.lat === undefined || p.lng === undefined) continue;
    t.push({ lat: p.lat, lng: p.lng, accuracy_m: p.accuracy_m ?? null, is_mock: p.is_mock ?? null, recorded_at: new Date(baseTime + i * 1000) });
  }
  return t;
}

export function generateImpossibleUploadRun(): TrackPoint[] {
  const baseTrack = generateRealisticPaceTrack(101);
  const t: TrackPoint[] = [];
  const baseTime = Date.now() + 2 * 3600 * 1000;
  for(let i=0; i<baseTrack.length; i++) {
    const p = baseTrack[i];
    if (!p || p.lat === undefined || p.lng === undefined) continue;
    t.push({ lat: p.lat, lng: p.lng, accuracy_m: p.accuracy_m ?? null, is_mock: p.is_mock ?? null, recorded_at: new Date(baseTime + i * 1000) });
  }
  return t;
}
