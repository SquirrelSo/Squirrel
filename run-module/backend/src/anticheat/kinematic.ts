import { pool } from "../db/pool.js";
import { createLocalProjection } from "../geometry/projection.js";
import { LayerScore } from "./types.js";
import {
  MAX_PLAUSIBLE_SPEED_MS,
  IMPLAUSIBLE_AVG_SPEED_MS,
  MAX_PLAUSIBLE_ACCEL_MS2,
  TELEPORT_MIN_SPEED_MS,
  MIN_SAMPLES_FOR_SCORING
} from "./constants.js";

interface Point {
  lat: number;
  lng: number;
  recorded_at: Date;
}

export async function scoreKinematic(runId: string): Promise<LayerScore> {
  const { rows } = await pool.query<Point>(
    "SELECT lat, lng, recorded_at FROM run_points WHERE run_id = $1 ORDER BY seq ASC",
    [runId]
  );

  const sampleCount = rows.length;

  if (sampleCount < MIN_SAMPLES_FOR_SCORING) {
    return {
      layer: 'kinematic',
      score: 1.0,
      signals: { insufficient_samples: 1 },
      sampleCount
    };
  }

  const proj = createLocalProjection(rows);
  const projected = rows.map(p => {
    const coords = proj.toPlanar(p);
    return {
      x: coords.x,
      y: coords.y,
      time: p.recorded_at.getTime() / 1000
    };
  });

    let speedViolations = 0;
  let accelViolations = 0;
  let teleports = 0;
  let negativeDtCount = 0;
  let zeroDtCount = 0;

  let totalDistance = 0;
  let totalTime = 0;
  let validSegments = 0;

  const segments: { speed: number; dt: number; excluded: boolean }[] = [];

  for (let i = 1; i < projected.length; i++) {
    const prev = projected[i - 1];
    const curr = projected[i];
    if (!prev || !curr) continue;

    const rawDt = curr.time - prev.time;
    if (rawDt < 0) {
      negativeDtCount++;
      segments.push({ speed: 0, dt: 0, excluded: true });
      continue;
    }
    if (rawDt === 0) {
      zeroDtCount++;
      segments.push({ speed: 0, dt: 0, excluded: true });
      continue;
    }

    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    
    const speed = dist / rawDt;

    if (speed > MAX_PLAUSIBLE_SPEED_MS) speedViolations++;
    if (speed > TELEPORT_MIN_SPEED_MS) teleports++;

    segments.push({ speed, dt: rawDt, excluded: false });
    validSegments++;

    totalDistance += dist;
    totalTime += rawDt;
  }

  let accelPairs = 0;
  for (let i = 1; i < segments.length; i++) {
    const prev = segments[i - 1];
    const curr = segments[i];
    if (!prev || !curr) continue;
    
    if (prev.excluded || curr.excluded) continue;
    
    const dt = (prev.dt + curr.dt) / 2;
    const accel = Math.abs(curr.speed - prev.speed) / dt;

    if (accel > MAX_PLAUSIBLE_ACCEL_MS2) accelViolations++;
    accelPairs++;
  }

  const segmentCount = projected.length - 1;
  const negative_dt_ratio = segmentCount > 0 ? negativeDtCount / segmentCount : 0;
  const zero_dt_ratio = segmentCount > 0 ? zeroDtCount / segmentCount : 0;
  const exclusionRatio = segmentCount > 0 ? (negativeDtCount + zeroDtCount) / segmentCount : 0;

  if (exclusionRatio > 0.5) {
    return {
      layer: 'kinematic',
      score: 1.0,
      signals: {
        insufficient_valid_segments: 1,
        negative_dt_ratio,
        zero_dt_ratio
      },
      sampleCount
    };
  }

  const speed_violation_ratio = validSegments > 0 ? speedViolations / validSegments : 0;
  const teleport_ratio = validSegments > 0 ? teleports / validSegments : 0;
  const accel_violation_ratio = accelPairs > 0 ? accelViolations / accelPairs : 0;

  const avg_speed_ms = totalTime > 0 ? totalDistance / totalTime : 0;

  let score = 1.0;
  score -= speed_violation_ratio;
  score -= accel_violation_ratio * 0.5;
  score -= teleport_ratio * 2.0;

  if (avg_speed_ms >= IMPLAUSIBLE_AVG_SPEED_MS) {
    score *= 0.2;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    layer: 'kinematic',
    score,
    signals: {
      speed_violation_ratio,
      accel_violation_ratio,
      teleport_ratio,
      avg_speed_ms,
      negative_dt_ratio,
      zero_dt_ratio
    },
    sampleCount
  };

}
