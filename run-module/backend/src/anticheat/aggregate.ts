import { BAND_ACCEPT_ABOVE, BAND_REJECT_BELOW } from './constants.js';
import { LayerScore } from './types.js';
import { scoreKinematic } from './kinematic.js';
import { scoreSignalQuality } from './signal-quality.js';
import { scorePlatform } from './platform.js';
import { scoreStatistical } from './statistical.js';
import { scoreTemporal } from './temporal.js';

export type Band = 'accept' | 'pending' | 'reject';

export interface AggregateResult {
  aggregate: number;
  band: Band;
  layers: LayerScore[];
  decisiveLayer: string | null;
}

export async function scoreRun(
  runId: string, 
  currentWkt?: string,
  currentSig?: { user_id: string, point_hash: string, area_m2: number | null, duration_s: number | null, mean_speed_ms: number | null }
): Promise<AggregateResult> {
  // Concurrently run all five layers
  // Fixed order for determinism: platform, temporal, statistical, kinematic, signal-quality
  const layers = await Promise.all([
    scorePlatform(runId),
    scoreTemporal(runId),
    scoreStatistical(runId, currentWkt, currentSig),
    scoreKinematic(runId),
    scoreSignalQuality(runId)
  ]);

  let aggregate = 1.0;
  let decisiveLayer: string | null = null;

  for (const layer of layers) {
    if (layer.score < aggregate) {
      aggregate = layer.score;
    }
    // Zero-override: if any layer is exactly 0.0, the aggregate is 0.0.
    // We capture the FIRST decisive layer based on the Promise.all fixed array order.
    if (layer.score === 0.0 && decisiveLayer === null) {
      decisiveLayer = layer.layer;
      aggregate = 0.0;
    }
  }

  // Ensure strict Math.min logic holds even if the override hit
  aggregate = Math.min(...layers.map(l => l.score));

  let band: Band;
  // Boundaries explicitly stated: 
  // reject   <  0.3
  // pending  0.3 <= agg <= 0.7
  // accept   >  0.7
  if (aggregate < BAND_REJECT_BELOW) {
    band = 'reject';
  } else if (aggregate > BAND_ACCEPT_ABOVE) {
    band = 'accept';
  } else {
    band = 'pending';
  }

  return {
    aggregate,
    band,
    layers,
    decisiveLayer
  };
}
