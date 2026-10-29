import crypto from 'crypto';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../../db/pool.js';
import { enqueueLeaderboardSync } from '../leaderboard_sync/queue.js';
import { enqueueNotificationSync } from '../../notifications/emitter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sqlFile = readFileSync(join(__dirname, '../../../../db/queries/decay.sql'), 'utf-8');
const sqlFragments = sqlFile.split('----').map(s => s.trim()).filter(s => s.length > 0);

const SELECT_EXPIRING_TERRITORIES = sqlFragments[1] as string;
const EXPIRE_TERRITORIES = sqlFragments[2] as string;

export interface DecayResult {
  expiredCount: number;
  totalAreaExpiredM2: number;
  eventIds: string[];
  durationMs: number;
}

export async function runDecay(now: Date = new Date()): Promise<DecayResult> {
  const start = Date.now();
  let expiredCount = 0;
  let totalAreaExpiredM2 = 0;
  const eventIds: string[] = [];

  const BATCH_SIZE = 500;

  while (true) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const res = await client.query(SELECT_EXPIRING_TERRITORIES, [now, BATCH_SIZE]);

      if (res.rows.length === 0) {
        await client.query('COMMIT');
        client.release();
        break;
      }

      const terrIds = res.rows.map(r => r.id);
      
      await client.query(EXPIRE_TERRITORIES, [terrIds]);

      let batchEventIds: string[] = [];
      if (terrIds.length > 0) {
        let query = 'INSERT INTO capture_events (id, territory_id, actor_id, previous_owner_id, event_type, area_delta_m2, occurred_at) VALUES ';
        const params: any[] = [];
        let pIdx = 1;
        const values = [];

        for (const row of res.rows) {
          const eId = crypto.randomUUID();
          eventIds.push(eId);
          batchEventIds.push(eId);
          values.push(`($${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, 'expired', $${pIdx++}, $${pIdx++})`);
          params.push(eId, row.id, row.owner_id, row.owner_id, -Number(row.area_m2), now);
          
          expiredCount++;
          totalAreaExpiredM2 += Number(row.area_m2);
        }

        query += values.join(', ');
        await client.query(query, params);
      }

      await client.query('COMMIT');
      client.release();
      
      if (batchEventIds.length > 0) {
        try {
          await enqueueLeaderboardSync(batchEventIds);
          await enqueueNotificationSync(null, batchEventIds);
        } catch (err) {
          console.error('Failed to enqueue leaderboard sync:', err);
        }
      }
    } catch (error) {
      await client.query('ROLLBACK');
      client.release();
      throw error;
    }
  }

  return {
    expiredCount,
    totalAreaExpiredM2,
    eventIds,
    durationMs: Date.now() - start
  };
}
