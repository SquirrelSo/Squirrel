import { pool } from "../db/pool.js";
import { LayerScore } from "./types.js";
import {
  LOW_ACCURACY_THRESHOLD_M,
  LOW_ACCURACY_FAIL_RATIO,
  SUSPICIOUS_ACCURACY_VARIANCE,
  MIN_SAMPLES_FOR_SCORING
} from "./constants.js";

export async function scoreSignalQuality(runId: string): Promise<LayerScore> {
  const { rows } = await pool.query<{ accuracy_m: number | null }>(
    "SELECT accuracy_m FROM run_points WHERE run_id = $1 ORDER BY seq ASC",
    [runId]
  );

  const sampleCount = rows.length;
  if (sampleCount < MIN_SAMPLES_FOR_SCORING) {
    return {
      layer: 'signal_quality',
      score: 1.0,
      signals: { insufficient_samples: 1 },
      sampleCount
    };
  }

  let nullCount = 0;
  let lowAccCount = 0;
  let sumAcc = 0;
  
  const validAccuracies: number[] = [];

  for (const row of rows) {
    if (row.accuracy_m === null) {
      nullCount++;
    } else {
      validAccuracies.push(row.accuracy_m);
      sumAcc += row.accuracy_m;
      if (row.accuracy_m > LOW_ACCURACY_THRESHOLD_M) {
        lowAccCount++;
      }
    }
  }

  const low_accuracy_ratio = lowAccCount / sampleCount; // Spec: >50% of points
  const null_accuracy_ratio = nullCount / sampleCount;

  const validCount = validAccuracies.length;
  const mean_accuracy_m = validCount > 0 ? sumAcc / validCount : 0;

  let accuracy_variance = 0;
  let variancePenalty = 0;
  
  if (validCount >= 20) {
    let sumSqDiff = 0;
    for (const acc of validAccuracies) {
      const diff = acc - mean_accuracy_m;
      sumSqDiff += diff * diff;
    }
    accuracy_variance = sumSqDiff / validCount;
    if (accuracy_variance < SUSPICIOUS_ACCURACY_VARIANCE) {
      variancePenalty = 0.1;
    }
  }

  let score = 1.0 - low_accuracy_ratio;
  if (low_accuracy_ratio > LOW_ACCURACY_FAIL_RATIO) {
    score *= 0.4;
  }
  
  score -= null_accuracy_ratio * 0.3;
  score -= variancePenalty;

  score = Math.max(0, Math.min(1, score));

  const signals: Record<string, number> = {
    low_accuracy_ratio,
    null_accuracy_ratio,
    mean_accuracy_m
  };

  // Only include accuracy_variance if validCount >= 2 (or 20 based on logic, but we can just include it if validCount >= 2 to be safe, wait, spec says: 
  // "variance is undefined for 1 point - report how you handled it."
  // If validCount < 2, we just don't include it in signals or set it to 0. 
  // I will include it if validCount >= 2.
  if (validCount >= 2) {
    let sumSqDiff = 0;
    for (const acc of validAccuracies) {
      const diff = acc - mean_accuracy_m;
      sumSqDiff += diff * diff;
    }
    // Spec doesn't strictly say sample or population variance, using population variance (divide by N)
    accuracy_variance = sumSqDiff / validCount;
    signals.accuracy_variance = accuracy_variance;
  } else if (validCount === 1) {
      // variance undefined for a single point, omit from signals
  }

  return {
    layer: 'signal_quality',
    score,
    signals,
    sampleCount
  };
}
