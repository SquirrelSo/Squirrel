import { redis } from '../redis/client.js';
import { pool } from '../db/pool.js';
import { dayKey, alltimeKey, weeklyTempKey } from '../workers/leaderboard_sync/keys.js';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const sql = readFileSync(join(__dirname, '../../../db/queries/leaderboard.sql'), 'utf8').split('----');
const SELECT_EARLIEST_ACHIEVEMENT = sql[3]!.trim().split('\n').slice(1).join('\n');

export type LeaderboardWindow = 'daily' | 'weekly' | 'alltime';

export interface LeaderboardEntry {
  rank: number;
  user_id: string;
  score: number;
}

export interface LeaderboardResult {
  entries: LeaderboardEntry[];
  me: { rank: number; score: number } | null;
  next_cursor: string | null;
  total_ranked: number;
}

interface Cursor {
  s: number;
  m: string;
}

async function getRedisKey(window: LeaderboardWindow): Promise<string> {
  const now = new Date();
  if (window === 'daily') return dayKey(now);
  if (window === 'alltime') return alltimeKey();
  
  const tmpKey = weeklyTempKey(now);
  const exists = await redis.exists(tmpKey);
  if (!exists) {
    const keys = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - i);
      keys.push(dayKey(d));
    }
    await redis.zunionstore(tmpKey, keys.length, ...keys);
    await redis.expire(tmpKey, 60);
  }
  return tmpKey;
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

export async function queryLeaderboard(
  window: LeaderboardWindow,
  limit: number,
  cursorStr: string | undefined,
  meUserId: string
): Promise<LeaderboardResult> {
  const key = await getRedisKey(window);
  const totalRanked = await redis.zcard(key);

  let s = '+inf';
  let m: string | null = null;

  if (cursorStr) {
    try {
      const decoded: Cursor = JSON.parse(Buffer.from(cursorStr, 'base64').toString('utf8'));
      s = String(decoded.s);
      m = decoded.m;
    } catch (e) {
      // ignore invalid cursor
    }
  }

  let rawElements: string[] = [];

  if (m === null) {
    rawElements = await redis.zrevrangebyscore(key, s, '-inf', 'WITHSCORES', 'LIMIT', 0, limit);
  } else {
    // We fetch all members tied at score s
    const tied = await redis.zrevrangebyscore(key, s, s, 'WITHSCORES');
    let mIndex = -1;
    for (let i = 0; i < tied.length; i += 2) {
      if (tied[i] === m) {
        mIndex = i;
        break;
      }
    }
    
    let nextElements: string[] = [];
    if (mIndex !== -1) {
      nextElements = tied.slice(mIndex + 2);
    }

    if (nextElements.length / 2 >= limit) {
      rawElements = nextElements.slice(0, limit * 2);
    } else {
      rawElements = nextElements;
      const needed = limit - (rawElements.length / 2);
      const lower = await redis.zrevrangebyscore(key, '(' + s, '-inf', 'WITHSCORES', 'LIMIT', 0, needed);
      rawElements = rawElements.concat(lower);
    }
  }

  const entries: LeaderboardEntry[] = [];
  let nextCursor: string | null = null;

  if (rawElements.length > 0) {
    // cursor is the last element from Redis before re-ordering
    const lastMember = rawElements[rawElements.length - 2] as string;
    const lastScore = Number(rawElements[rawElements.length - 1] as string);
    if (rawElements.length / 2 === limit) {
      nextCursor = Buffer.from(JSON.stringify({ s: lastScore, m: lastMember })).toString('base64');
    }

    // Pipeline ZREVRANK to get absolute baseline ranks
    const pipeline = redis.pipeline();
    for (let i = 0; i < rawElements.length; i += 2) {
      pipeline.zrevrank(key, rawElements[i] as string);
    }
    const ranks = await pipeline.exec();

    // Group by score
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
        entries.push({
          user_id: group.members[0]!.member,
          score: group.score,
          rank: group.members[0]!.zrank + 1
        });
      } else {
        const uids = group.members.map(m => m.member);
        const timestamps = await getTimestamps(uids);
        
        const sortedMembers = [...group.members].sort((a, b) => {
          const tA = timestamps[a.member] ?? Infinity;
          const tB = timestamps[b.member] ?? Infinity;
          if (tA !== tB) return tA - tB;
          return a.member.localeCompare(b.member); // fallback to UUID
        });

        // The absolute ranks available to this group in the page
        const availableRanks = group.members.map(m => m.zrank + 1).sort((a, b) => a - b);
        
        for (let i = 0; i < sortedMembers.length; i++) {
          entries.push({
            user_id: sortedMembers[i]!.member,
            score: group.score,
            rank: availableRanks[i] as number
          });
        }
      }
    }
  }

  // Determine ME
  let me: { rank: number; score: number } | null = null;
  const myScoreStr = await redis.zscore(key, meUserId);
  if (myScoreStr !== null) {
    const myScore = Number(myScoreStr);
    const higherCount = await redis.zcount(key, '(' + myScore, '+inf');
    
    // Resolve tie-break for me
    const tied = await redis.zrevrangebyscore(key, myScore, myScore);
    if (tied.length === 1) {
      me = { rank: higherCount + 1, score: myScore };
    } else {
      const timestamps = await getTimestamps(tied);
      tied.sort((a, b) => {
        const tA = timestamps[a] ?? Infinity;
        const tB = timestamps[b] ?? Infinity;
        if (tA !== tB) return tA - tB;
        return a.localeCompare(b);
      });
      const index = tied.indexOf(meUserId);
      me = { rank: higherCount + index + 1, score: myScore };
    }
  }

  return {
    entries,
    me,
    next_cursor: nextCursor,
    total_ranked: totalRanked
  };
}
