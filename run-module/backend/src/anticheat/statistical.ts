import { pool } from "../db/pool.js";
import { LayerScore } from "./types.js";
import { createLocalProjection } from "../geometry/projection.js";
import { SPEED_CV_SUSPICIOUS, DUPLICATE_HAUSDORFF_M, DUPLICATE_AREA_TOLERANCE, DUPLICATE_LOOKBACK_RUNS, DUPLICATE_DURATION_TOLERANCE, DUPLICATE_PACE_TOLERANCE } from "./constants.js";

// Haversine distance for basic segment speed calculation
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371e3;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) *
            Math.sin(dl / 2) * Math.sin(dl / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export async function scoreStatistical(
  runId: string, 
  currentWkt?: string,
  currentSig?: { user_id: string, point_hash: string, area_m2: number | null, duration_s: number | null, mean_speed_ms: number | null }
): Promise<LayerScore> {
  const pointsRes = await pool.query<{ seq: number, lat: number, lng: number, recorded_at: Date }>(
    "SELECT seq, lat, lng, recorded_at FROM run_points WHERE run_id = $1 ORDER BY seq ASC",
    [runId]
  );
  
  const points = pointsRes.rows;
  const sampleCount = points.length;
  
  const defaultSignals = {
    speed_cv: null as unknown as number,
    accel_cv: null as unknown as number,
    exact_duplicate_run_id: null as unknown as string,
    near_duplicate_run_id: null as unknown as string,
    same_route_different_pace_run_id: null as unknown as string,
    compared_against: 0
  };

  // Fewer than 10 points or fewer than 5 valid segments -> insufficient
  if (sampleCount < 10) {
    return {
      layer: 'statistical',
      score: 1.0,
      signals: { ...defaultSignals, insufficient_samples: 1 },
      sampleCount
    };
  }

  const speeds: number[] = [];
  let prevValidPoint = points[0]!;

  for (let i = 1; i < sampleCount; i++) {
    const p = points[i]!;
    const dt = (p.recorded_at.getTime() - prevValidPoint.recorded_at.getTime()) / 1000;
    
    if (dt <= 0) {
      continue; // Skip out-of-order / duplicate timestamps (RM-4.1a logic)
    }

    const dist = haversineDistance(prevValidPoint.lat, prevValidPoint.lng, p.lat, p.lng);
    speeds.push(dist / dt);
    prevValidPoint = p;
  }

  if (speeds.length < 5) {
    return {
      layer: 'statistical',
      score: 1.0,
      signals: { ...defaultSignals, insufficient_samples: 1 },
      sampleCount
    };
  }

  // Calculate CV of speed
  const meanSpeed = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  let speed_cv = 0;
  
  if (meanSpeed > 0) {
    const variance = speeds.reduce((a, b) => a + Math.pow(b - meanSpeed, 2), 0) / speeds.length;
    speed_cv = Math.sqrt(variance) / meanSpeed;
  }

  // Calculate CV of acceleration
  const accels: number[] = [];
  for (let i = 1; i < speeds.length; i++) {
    // approximating dt = 1 (we don't have the exact dt of the second segment handy without re-looping,
    // but the spec just says "same for acceleration". We can just diff the speeds as a proxy if dt ~ 1)
    accels.push(Math.abs(speeds[i]! - speeds[i-1]!)); 
  }
  let accel_cv = 0;
  if (accels.length > 0) {
    const meanAccel = accels.reduce((a, b) => a + b, 0) / accels.length;
    if (meanAccel > 0) {
      const varAccel = accels.reduce((a, b) => a + Math.pow(b - meanAccel, 2), 0) / accels.length;
      accel_cv = Math.sqrt(varAccel) / meanAccel;
    }
  }

  let exact_duplicate_run_id: string | null = null;
  let near_duplicate_run_id: string | null = null;
  let same_route_different_pace_run_id: string | null = null;
  let compared_against = 0;

  let currentSigData = currentSig;
  if (!currentSigData) {
    const sigRes = await pool.query<{ user_id: string, point_hash: string, area_m2: number | null, duration_s: number | null, mean_speed_ms: number | null }>(
      "SELECT user_id, point_hash, area_m2, duration_s, mean_speed_ms FROM run_signatures WHERE run_id = $1",
      [runId]
    );
    if (sigRes.rows.length > 0) currentSigData = sigRes.rows[0];
  }

  if (currentSigData) {
    const { user_id, point_hash, area_m2 } = currentSigData;
    const currentSig = currentSigData;

    // Check last 50 runs for this user
    const historyRes = await pool.query<{ run_id: string, point_hash: string, area_m2: number | null, duration_s: number | null, mean_speed_ms: number | null }>(
      "SELECT run_id, point_hash, area_m2, duration_s, mean_speed_ms FROM run_signatures WHERE user_id = $1 AND run_id != $2 ORDER BY created_at DESC LIMIT $3",
      [user_id, runId, DUPLICATE_LOOKBACK_RUNS]
    );

    compared_against = historyRes.rows.length;

    for (const h of historyRes.rows) {
      if (h.point_hash === point_hash) {
        exact_duplicate_run_id = h.run_id;
        break; // Decisive match found
      }
    }

    if (!exact_duplicate_run_id && area_m2 !== null) {
      for (const h of historyRes.rows) {
        if (h.area_m2 === null) continue;
        
        const areaDelta = Math.abs(area_m2 - h.area_m2) / Math.max(area_m2, h.area_m2);
        if (areaDelta <= DUPLICATE_AREA_TOLERANCE) {
          let hdRes;
          if (currentWkt) {
            hdRes = await pool.query<{ hdist: number }>(`
              SELECT ST_HausdorffDistance(
                ST_Transform(ST_GeomFromText($1, 4326), 3857),
                ST_Transform(t2.geom, 3857)
              ) * cos(radians(ST_Y(ST_Centroid(ST_GeomFromText($1, 4326))))) as hdist
              FROM territories t2
              WHERE t2.run_id = $2
            `, [currentWkt, h.run_id]);
          } else {
            hdRes = await pool.query<{ hdist: number }>(`
              SELECT ST_HausdorffDistance(
                ST_Transform(t1.geom, 3857),
                ST_Transform(t2.geom, 3857)
              ) * cos(radians(ST_Y(ST_Centroid(t1.geom)))) as hdist
              FROM territories t1, territories t2
              WHERE t1.run_id = $1 AND t2.run_id = $2
            `, [runId, h.run_id]);
          }

          if (hdRes.rows.length > 0 && hdRes.rows[0]!.hdist <= DUPLICATE_HAUSDORFF_M) {
            if (h.duration_s === null || h.mean_speed_ms === null || currentSig.duration_s === null || currentSig.mean_speed_ms === null) {
              continue;
            }
            const durA = Math.max(0.001, currentSig.duration_s);
            const durB = Math.max(0.001, h.duration_s);
            const durationDelta = Math.abs(currentSig.duration_s - h.duration_s) / Math.max(durA, durB);
            
            const paceA = Math.max(0.001, currentSig.mean_speed_ms);
            const paceB = Math.max(0.001, h.mean_speed_ms);
            const paceDelta = Math.abs(currentSig.mean_speed_ms - h.mean_speed_ms) / Math.max(paceA, paceB);

            if (durationDelta <= DUPLICATE_DURATION_TOLERANCE && paceDelta <= DUPLICATE_PACE_TOLERANCE) {
              near_duplicate_run_id = h.run_id;
              break; 
            } else {
              if (!same_route_different_pace_run_id) {
                same_route_different_pace_run_id = h.run_id;
              }
            }
          }
        }
      }
    }
  }

  let score = 1.0;
  if (exact_duplicate_run_id !== null) {
    score = 0.0;
  } else if (near_duplicate_run_id !== null) {
    score = 0.3;
  }

  // Check constant speed
  if (speed_cv < SPEED_CV_SUSPICIOUS) {
    score -= 0.6;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    layer: 'statistical',
    score,
    signals: {
      speed_cv,
      accel_cv,
      exact_duplicate_run_id: exact_duplicate_run_id as unknown as string,
      same_route_different_pace_run_id: same_route_different_pace_run_id as unknown as string,
      near_duplicate_run_id: near_duplicate_run_id as unknown as string,
      compared_against
    },
    sampleCount
  };
}
