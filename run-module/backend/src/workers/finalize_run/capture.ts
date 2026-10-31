import crypto from 'crypto';
import { PoolClient } from 'pg';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { MIN_TERRITORY_AREA_M2 } from '../../geometry/constants.js';
import { TERRITORY_TTL_DAYS } from '../../anticheat/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CAPTURE_SQL = readFileSync(join(__dirname, '../../../../db/queries/capture.sql'), 'utf8');

const sqlFragments = CAPTURE_SQL.split(/----+/).map(s => s.trim()).filter(s => s.length > 0);
if (sqlFragments[0]!.startsWith('-- db/queries')) {
  sqlFragments.shift();
}
const SELECT_OVERLAPPING_FOR_UPDATE = sqlFragments[0] as string;
const EXPIRE_TERRITORY = sqlFragments[1] as string;
const UPDATE_TERRITORY_GEOM = sqlFragments[2] as string;
const INSERT_NEW_TERRITORY = sqlFragments[3] as string;
const INSERT_EVENT = sqlFragments[4] as string;

export interface CaptureResult {
  territoryId: string;
  areaM2: number;
  emittedEventIds: string[];
  carved: Array<{
    territoryId: string;
    previousOwnerId: string;
    areaBeforeM2: number;
    areaAfterM2: number;
    fullyConsumed: boolean;
    sliversDiscarded: number;
    sliverAreaM2: number;
  }>;
  attempts: number; // Will be set by finalizeRun, initialized to 1 here
}

export async function captureTerritory(params: {
  client: PoolClient;
  runId: string;
  ownerId: string;
  geomWkt4326: string;
  areaM2: number;
  attempts?: number;
}): Promise<CaptureResult> {
  const { client, runId, ownerId, geomWkt4326, areaM2, attempts = 1 } = params;

  const res = await client.query<{
    id: string;
    owner_id: string;
    old_area: number;
    diff_wkt: string | null;
    diff_empty: boolean;
    diff_area: number;
    int_area: number;
    diff_valid: boolean;
    slivers_discarded: number;
    sliver_area_m2: number;
  }>(SELECT_OVERLAPPING_FOR_UPDATE, [geomWkt4326, MIN_TERRITORY_AREA_M2]);

  const carved = [];
  const emittedEventIds: string[] = [];

  for (const row of res.rows) {
    // If they only touch at an edge, intersection area is ~0
    if (row.int_area < 0.1) {
      continue;
    }

    const eventId = crypto.randomUUID();
    let fullyConsumed = false;
    let areaAfter = 0;
    
    if (row.diff_empty || row.diff_area < 0.1) {
      // Fully consumed
      fullyConsumed = true;
      areaAfter = 0;
      await client.query(EXPIRE_TERRITORY, [row.id]);
    } else {
      // Partially carved
      if (!row.diff_valid) {
        throw new Error('carved_invalid');
      }
      fullyConsumed = false;
      areaAfter = row.diff_area;
      await client.query(UPDATE_TERRITORY_GEOM, [row.id, row.diff_wkt, row.diff_area]);
    }

    // Emit event for victim
    const eventType = fullyConsumed ? 'full_capture' : 'partial_capture';
    const areaDeltaM2 = -(row.old_area - areaAfter);
    await client.query(INSERT_EVENT, [eventId, row.id, ownerId, row.owner_id, eventType, areaDeltaM2]);
    emittedEventIds.push(eventId);

    carved.push({
      territoryId: row.id,
      previousOwnerId: row.owner_id,
      areaBeforeM2: row.old_area,
      areaAfterM2: areaAfter,
      fullyConsumed,
      sliversDiscarded: Number(row.slivers_discarded) || 0,
      sliverAreaM2: Number(row.sliver_area_m2) || 0,
    });
  }

  const territoryId = crypto.randomUUID();
  await client.query(INSERT_NEW_TERRITORY, [territoryId, ownerId, runId, geomWkt4326, areaM2, TERRITORY_TTL_DAYS]);

  const claimEventId = crypto.randomUUID();
  await client.query(INSERT_EVENT, [claimEventId, territoryId, ownerId, null, 'claimed', areaM2]);
  emittedEventIds.push(claimEventId);

  return {
    territoryId,
    areaM2,
    emittedEventIds,
    carved,
    attempts,
  };
}
