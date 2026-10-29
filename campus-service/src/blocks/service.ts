import { getPool, one, many, type Queryable } from '../db/pool.js';
import { lookupBlocks, BlocksUnavailableError } from '../identity/index.js';
import { ApiError } from '../lib/errors.js';
import { config } from '../config.js';

/** Fetch the caller's full block set: Social's list, plus the legacy local rows while LEGACY_LOCAL_BLOCKS is on. */
export async function getFullBlockSet(userId: string, q: Queryable = getPool()): Promise<Set<string>> {
  let socialBlocks: Set<string>;
  try {
    socialBlocks = await lookupBlocks(userId);
  } catch (err) {
    if (err instanceof BlocksUnavailableError) {
      throw new ApiError(503, 'blocks_unreachable', 'Cannot verify block status at this time. Please try again.');
    }
    throw err;
  }
  if (!config.blocks.legacyLocal) return socialBlocks;
  const localBlocks = await many<{ other: string }>(
    `SELECT blocked_id AS other FROM blocks WHERE blocker_id = $1
     UNION
     SELECT blocker_id AS other FROM blocks WHERE blocked_id = $1`, [userId], q
  );
  const fullSet = new Set(socialBlocks);
  for (const row of localBlocks) fullSet.add(row.other);
  return fullSet;
}

/** True when either user has blocked the other. Keep all block checks on this helper. */
export async function isBlockedEitherWay(a: string, b: string, q: Queryable = getPool()): Promise<boolean> {
  try {
    const blocksA = await lookupBlocks(a);
    if (blocksA.has(b)) return true;
  } catch (err) {
    if (err instanceof BlocksUnavailableError) {
      throw new ApiError(503, 'blocks_unreachable', 'Cannot verify block status at this time. Please try again.');
    }
    throw err;
  }
  if (!config.blocks.legacyLocal) return false;

  const r = await one<{ blocked: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM blocks
       WHERE (blocker_id = $1 AND blocked_id = $2)
          OR (blocker_id = $2 AND blocked_id = $1)
     ) AS blocked`, [a, b], q,
  );
  return r?.blocked ?? false;
}
