import { pool } from "../db/pool.js";
import { LayerScore } from "./types.js";

export async function scorePlatform(runId: string): Promise<LayerScore> {
  const { rows: pointRows } = await pool.query<{ count: string }>(
    "SELECT count(*) FROM run_points WHERE run_id = $1",
    [runId]
  );
  
  const sampleCount = parseInt(pointRows[0]!.count, 10);

  if (sampleCount === 0) {
    return {
      layer: 'platform',
      score: 1.0,
      signals: {
        mock_point_count: 0,
        mock_ratio: 0,
        flagged_point_ratio: 0,
        unreported_ratio: 1.0,
        root_signal: null as unknown as number // null as requested
      },
      sampleCount
    };
  }

  const { rows: flagRows } = await pool.query<{ is_mock: boolean | null }>(
    "SELECT is_mock FROM run_point_flags WHERE run_id = $1",
    [runId]
  );

  let mock_point_count = 0;
  let reported_count = 0;
  let unreported_count = sampleCount; // all start unreported

  for (const row of flagRows) {
    unreported_count--; // for every row we have, we reduce unreported. But wait, if is_mock is null, it's still unreported!
    if (row.is_mock === null) {
      unreported_count++; // put it back
    } else {
      reported_count++;
      if (row.is_mock === true) {
        mock_point_count++;
      }
    }
  }

  const mock_ratio = mock_point_count / sampleCount;
  const flagged_point_ratio = reported_count / sampleCount;
  const unreported_ratio = unreported_count / sampleCount;

  let score = 1.0;
  if (mock_point_count > 0) {
    score = 0.0;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    layer: 'platform',
    score,
    signals: {
      mock_point_count,
      mock_ratio,
      flagged_point_ratio,
      unreported_ratio,
      root_signal: null as unknown as number // to satisfy Record<string, number> we cast null
    },
    sampleCount
  };
}
