import { pool } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { syncEvent } from '../workers/leaderboard_sync/sync.js';

export interface RebuildResult {
  restoredFrom: Date | null;
  membersRestored: number;
  eventsReplayed: number;
  durationMs: number;
}

export async function rebuildFromPostgres(): Promise<RebuildResult> {
  const start = Date.now();
  
  const existingKeys = await redis.keys('lb:*');
  if (existingKeys.length > 0) {
    await redis.del(...existingKeys);
  }

  const { rows: snapRows } = await pool.query(
    "SELECT MAX(captured_at) as max_captured FROM leaderboard_snapshots"
  );
  const maxCaptured = snapRows[0]?.max_captured ? new Date(snapRows[0].max_captured) : null;

  let membersRestored = 0;
  let eventsReplayed = 0;

  if (maxCaptured) {
    const { rows: members } = await pool.query(
      "SELECT \"window\", user_id, score FROM leaderboard_snapshots WHERE captured_at = $1 AND (\"window\" = 'alltime' OR \"window\" LIKE 'day:%')",
      [maxCaptured]
    );
    
    if (members.length > 0) {
      const pipeline = redis.pipeline();
      for (const row of members) {
        const key = row.window === 'alltime' ? 'lb:alltime' : `lb:${row.window}`;
        pipeline.zadd(key, row.score, row.user_id);
        membersRestored++;
      }
      await pipeline.exec();
    }

    const { rows: events } = await pool.query(
      "SELECT * FROM capture_events WHERE occurred_at > $1 ORDER BY occurred_at ASC",
      [maxCaptured]
    );
    for (const event of events) {
      await syncEvent(event.id);
      eventsReplayed++;
    }
  } else {
    const { rows: events } = await pool.query(
      "SELECT * FROM capture_events ORDER BY occurred_at ASC"
    );
    for (const event of events) {
      await syncEvent(event.id);
      eventsReplayed++;
    }
  }

  return {
    restoredFrom: maxCaptured,
    membersRestored,
    eventsReplayed,
    durationMs: Date.now() - start
  };
}
