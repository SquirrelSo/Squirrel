import { redis } from '../../redis/client.js';
import { pool } from '../../db/pool.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { dayKey, alltimeKey, processedKey } from './keys.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sql = readFileSync(join(__dirname, '../../../../db/queries/leaderboard.sql'), 'utf8').split('----');
const SELECT_PENDING_EVENTS = sql[1]!.trim().split('\n').slice(1).join('\n');
const SELECT_EVENT = sql[2]!.trim().split('\n').slice(1).join('\n');

export interface SyncResult {
  processed: number;
  skipped: number;
  durationMs: number;
}

export async function syncEvent(eventId: string): Promise<'applied' | 'skipped'> {
  const pKey = processedKey(eventId);
  
  await redis.watch(pKey);
  const exists = await redis.get(pKey);
  if (exists) {
    await redis.unwatch();
    return 'skipped';
  }

  const res = await pool.query(SELECT_EVENT, [eventId]);
  if (res.rowCount === 0) {
    await redis.unwatch();
    return 'skipped';
  }
  
  const row = res.rows[0];
  const occurredAt = new Date(row.occurred_at);
  const eventType = row.event_type;
  const areaDelta = Number(row.area_delta_m2);
  
  let targetUser: string;
  if (eventType === 'claimed') {
    targetUser = row.actor_id;
  } else {
    targetUser = row.previous_owner_id;
  }

  if (!targetUser) {
    await redis.unwatch();
    return 'skipped';
  }

  const dKey = dayKey(occurredAt);
  const aKey = alltimeKey();

  const multi = redis.multi();
  multi.set(pKey, '1', 'EX', 30 * 24 * 3600);
  multi.zincrby(dKey, areaDelta, targetUser);
  multi.expire(dKey, 9 * 24 * 3600);
  
  if (areaDelta > 0) {
    multi.zincrby(aKey, areaDelta, targetUser);
  }

  const execRes = await multi.exec();
  if (!execRes) {
    return 'skipped';
  }

  return 'applied';
}

export async function syncPending(limit: number = 500): Promise<SyncResult> {
  const start = Date.now();
  let processed = 0;
  let skipped = 0;
  
  let lastId = '00000000-0000-0000-0000-000000000000';
  
  while (true) {
    const res = await pool.query(SELECT_PENDING_EVENTS, [lastId, limit]);
    if (res.rowCount === 0) break;
    
    const pKeys = res.rows.map(r => processedKey(r.id));
    const statuses = await redis.mget(pKeys);
    
    for (let i = 0; i < res.rows.length; i++) {
      const row = res.rows[i];
      if (statuses[i]) {
        skipped++;
      } else {
        const result = await syncEvent(row.id);
        if (result === 'applied') processed++;
        else skipped++;
      }
    }
    
    lastId = res.rows[res.rows.length - 1].id;
  }

  return {
    processed,
    skipped,
    durationMs: Date.now() - start
  };
}
