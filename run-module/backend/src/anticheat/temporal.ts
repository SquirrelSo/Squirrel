import { pool } from "../db/pool.js";
import {
  OVERLAP_MIN_SECONDS,
  IMPOSSIBLE_UPLOAD_SKEW_S,
  TEMPORAL_LOOKBACK_RUNS
} from "./constants.js";
import { LayerScore } from "./types.js";

export async function scoreTemporal(runId: string): Promise<LayerScore> {
  const defaultSignals = {
    overlapping_run_ids: [] as string[],
    max_overlap_seconds: 0,
    upload_skew_s: null ,
    impossible_upload: false,
    batch_count: 0,
    compared_against: 0,
    insufficient_samples: 0
  };

  // Get run window and user_id
  const runRes = await pool.query<{ user_id: string, start_time: Date | null, end_time: Date | null }>(`
    SELECT
      r.user_id,
      (SELECT MIN(recorded_at) FROM run_points WHERE run_id = r.id) as start_time,
      (SELECT MAX(recorded_at) FROM run_points WHERE run_id = r.id) as end_time
    FROM runs r
    WHERE r.id = $1
  `, [runId]);

  if (runRes.rows.length === 0) {
    return { layer: 'temporal', score: 1.0, signals: { ...defaultSignals, insufficient_samples: 1  }, sampleCount: 0 };
  }

  const { user_id, start_time, end_time } = runRes.rows[0]!;

  if (!start_time || !end_time) {
    return { layer: 'temporal', score: 1.0, signals: { ...defaultSignals, insufficient_samples: 1  }, sampleCount: 0 };
  }

  // Get batches
  const batchesRes = await pool.query<{ uploaded_at: Date }>(`
    SELECT uploaded_at
    FROM run_batches
    WHERE run_id = $1
    ORDER BY uploaded_at ASC
  `, [runId]);

  const batch_count = batchesRes.rowCount ?? 0;
  let upload_skew_s: number | null = null;
  let impossible_upload = false;
  let score = 1.0;

  if (batch_count > 0) {
    const earliestUpload = batchesRes.rows[0]!.uploaded_at;
    upload_skew_s = (earliestUpload.getTime() - end_time.getTime()) / 1000.0;
    
    // Check if upload pre-dates last point by more than tolerance
    if (upload_skew_s < -IMPOSSIBLE_UPLOAD_SKEW_S) {
      impossible_upload = true;
      score = 0.0;
    }
  }

  // Overlap comparison
  const historyRes = await pool.query<{ run_id: string, start_time: Date, end_time: Date }>(`
    SELECT r.id as run_id, 
           (SELECT MIN(recorded_at) FROM run_points WHERE run_id = r.id) as start_time,
           (SELECT MAX(recorded_at) FROM run_points WHERE run_id = r.id) as end_time
    FROM runs r
    WHERE r.user_id = $1 AND r.id != $2
    ORDER BY r.started_at DESC
    LIMIT $3
  `, [user_id, runId, TEMPORAL_LOOKBACK_RUNS]);

  const compared_against = historyRes.rowCount ?? 0;
  const overlapping_run_ids: string[] = [];
  let max_overlap_seconds = 0;

  for (const h of historyRes.rows) {
    if (!h.start_time || !h.end_time) continue;
    
    // Compute overlap
    // Overlap window: [max(start1, start2), min(end1, end2)]
    const startMax = Math.max(start_time.getTime(), h.start_time.getTime());
    const endMin = Math.min(end_time.getTime(), h.end_time.getTime());
    
    const overlapMs = endMin - startMax;
    if (overlapMs > 0) {
      const overlapSec = overlapMs / 1000.0;
      if (overlapSec > max_overlap_seconds) {
        max_overlap_seconds = overlapSec;
      }
      if (overlapSec > OVERLAP_MIN_SECONDS) {
        overlapping_run_ids.push(h.run_id);
      }
    }
  }

  if (overlapping_run_ids.length > 0 && !impossible_upload) {
    score -= 0.4;
  }

  score = Math.max(0.0, Math.min(1.0, score));

  return {
    layer: 'temporal',
    score,
    signals: {
      ...defaultSignals,
      upload_skew_s: upload_skew_s ,
      impossible_upload: impossible_upload ,
      batch_count: batch_count ,
      overlapping_run_ids: overlapping_run_ids ,
      max_overlap_seconds: max_overlap_seconds ,
      compared_against: compared_against 
    },
    sampleCount: 0
  };
}
