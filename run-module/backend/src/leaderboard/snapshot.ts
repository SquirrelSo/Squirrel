import { pool } from '../db/pool.js';
import { redis } from '../redis/client.js';
import { queryLeaderboard } from './query.js';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sql = readFileSync(join(__dirname, '../../../db/queries/leaderboard.sql'), 'utf8').split('----');
const SELECT_EARLIEST_ACHIEVEMENT = sql[3]!.trim().split('\n').slice(1).join('\n');

export interface SnapshotResult {
  capturedAt: Date;
  rowsWritten: number;
  windowsCaptured: string[];
  durationMs: number;
}

async function getTimestamps(userIds: string[]): Promise<Record<string, number>> {
  if (userIds.length === 0) return {};
  const res = await pool.query(SELECT_EARLIEST_ACHIEVEMENT, [userIds]);
  const map: Record<string, number> = {};
  for (const row of res.rows) {
    map[row.actor_id] = new Date(row.min_at).getTime();
  }
  return map;
}

export async function captureSnapshot(now?: Date): Promise<SnapshotResult> {
  const start = Date.now();
  const capturedAt = now || new Date();
  let rowsWritten = 0;
  const windowsCaptured: string[] = [];

  const snapshotRows: any[] = [];
  const BATCH_SIZE = 500;

  const windows: ('alltime' | 'daily' | 'weekly')[] = ['alltime', 'daily', 'weekly'];
  for (const window of windows) {
    let cursor: string | undefined = undefined;
    while (true) {
      const res = await queryLeaderboard(window, BATCH_SIZE, cursor, '');
      if (res.entries.length === 0) break;
      if (!windowsCaptured.includes(window)) windowsCaptured.push(window);

      for (const entry of res.entries) {
        snapshotRows.push({
          id: crypto.randomUUID(),
          scope: 'global',
          window: window,
          user_id: entry.user_id,
          score: entry.score,
          rank: entry.rank,
          captured_at: capturedAt
        });
      }

      if (res.entries.length < BATCH_SIZE || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
  }

  const dayKeys = await redis.keys('lb:day:*');
  for (const key of dayKeys) {
    const dayWindow = key.replace('lb:', '');
    if (!windowsCaptured.includes(dayWindow)) windowsCaptured.push(dayWindow);
    
    const rawElements = await redis.zrevrange(key, 0, -1, 'WITHSCORES');
    if (rawElements.length === 0) continue;

    const pipeline = redis.pipeline();
    for (let i = 0; i < rawElements.length; i += 2) {
      pipeline.zrevrank(key, rawElements[i] as string);
    }
    const ranks = await pipeline.exec();

    const groups: { score: number; members: { member: string; zrank: number }[] }[] = [];
    let currentScore = NaN;
    for (let i = 0; i < rawElements.length; i += 2) {
      const member = rawElements[i] as string;
      const score = Number(rawElements[i + 1] as string);
      if (!ranks || !ranks[i / 2]) throw new Error("Missing rank from pipeline");
      const [err, rankVal] = ranks[i / 2]!;
      if (err) throw err;
      const zrank = rankVal as number;
      if (score !== currentScore) {
        groups.push({ score, members: [] });
        currentScore = score;
      }
      groups[groups.length - 1]!.members.push({ member, zrank });
    }

    for (const group of groups) {
      if (group.members.length === 1) {
        snapshotRows.push({
          id: crypto.randomUUID(), scope: 'global', window: dayWindow,
          user_id: group.members[0]!.member, score: group.score, rank: group.members[0]!.zrank + 1,
          captured_at: capturedAt
        });
      } else {
        const uids = group.members.map(m => m.member);
        const timestamps = await getTimestamps(uids);
        
        const sortedMembers = [...group.members].sort((a, b) => {
          const tA = timestamps[a.member] ?? Infinity;
          const tB = timestamps[b.member] ?? Infinity;
          if (tA !== tB) return tA - tB;
          return a.member.localeCompare(b.member);
        });

        const availableRanks = group.members.map(m => m.zrank + 1).sort((a, b) => a - b);
        for (let i = 0; i < sortedMembers.length; i++) {
          snapshotRows.push({
            id: crypto.randomUUID(), scope: 'global', window: dayWindow,
            user_id: sortedMembers[i]!.member, score: group.score, rank: availableRanks[i] as number,
            captured_at: capturedAt
          });
        }
      }
    }
  }

  for (let i = 0; i < snapshotRows.length; i += BATCH_SIZE) {
    const batch = snapshotRows.slice(i, i + BATCH_SIZE);
    const values = batch.map((_, idx) => "($" + (idx * 7 + 1) + ", $" + (idx * 7 + 2) + ", $" + (idx * 7 + 3) + ", $" + (idx * 7 + 4) + ", $" + (idx * 7 + 5) + ", $" + (idx * 7 + 6) + ", $" + (idx * 7 + 7) + ")").join(', ');
    const flatParams = batch.flatMap(r => [r.id, r.scope, r.window, r.user_id, r.score, r.rank, r.captured_at]);
    await pool.query(
      "INSERT INTO leaderboard_snapshots (id, scope, \"window\", user_id, score, rank, captured_at) VALUES " + values,
      flatParams
    );
    rowsWritten += batch.length;
  }

  const thirtyDaysAgo = new Date(capturedAt.getTime() - 30 * 24 * 60 * 60 * 1000);
  await pool.query("DELETE FROM leaderboard_snapshots WHERE captured_at < $1", [thirtyDaysAgo]);

  return { capturedAt, rowsWritten, windowsCaptured, durationMs: Date.now() - start };
}
