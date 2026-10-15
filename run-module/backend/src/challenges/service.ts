import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../db/pool.js';
import crypto from 'node:crypto';
import { Challenge, ChallengeType, Comparator, ChallengeState, ChallengeParticipant, ParticipantStatus } from './types.js';
import { Metric } from './metrics.js';
import { computeProgress } from './progress.js';
import { MAX_CHALLENGE_XP_REWARD } from '../xp/awards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sqlFile = await fs.readFile(
  path.join(__dirname, '../../../db/queries/challenges.sql'),
  'utf8'
);
const queries = sqlFile
  .split('----')
  .map((q) => q.trim())
  .filter(Boolean);

const [
  INSERT_CHALLENGE,
  INSERT_PARTICIPANT,
  UPDATE_PARTICIPANT_STATUS,
  UPDATE_CHALLENGE_STATE,
  GET_CHALLENGE,
  GET_PARTICIPANTS,
  CHECK_PARTICIPANT,
  LIST_MY_CHALLENGES,
  RESOLVER_GET_RESOLVABLE,
  RESOLVER_GET_ACTIVITY
] = queries;

export async function createChallenge(
  createdBy: string,
  type: ChallengeType,
  title: string,
  metric: Metric,
  comparator: Comparator,
  threshold: number,
  startsAt: Date,
  endsAt: Date,
  xpReward: number
): Promise<Challenge> {
  if (endsAt <= startsAt) {
    throw new Error('ends_at must be after starts_at');
  }
  if (!Number.isInteger(xpReward) || xpReward < 0 || xpReward > MAX_CHALLENGE_XP_REWARD) {
    throw new Error(`xp_reward must be an integer from 0 to ${MAX_CHALLENGE_XP_REWARD}`);
  }

  const challengeId = crypto.randomUUID();
  let initialState: ChallengeState = 'pending';
  
  // Daily challenge only has one participant (the creator) and is active immediately
  if (type === 'daily') {
    initialState = 'active';
  } else if (type === 'head_to_head' || type === 'group') {
    initialState = 'pending';
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(INSERT_CHALLENGE!, [
      challengeId, type, title, metric, comparator, threshold, startsAt, endsAt, xpReward, initialState, createdBy
    ]);
    
    // Creator is always accepted immediately
    await client.query(INSERT_PARTICIPANT!, [challengeId, createdBy, 'accepted']);
    
    await client.query('COMMIT');
    return res.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function inviteUser(challengeId: string, inviterId: string, inviteeId: string): Promise<void> {
  const challengeRes = await pool.query(GET_CHALLENGE!, [challengeId]);
  if (!challengeRes.rows[0]) throw new Error('Challenge not found');
  const challenge = challengeRes.rows[0];

  const participantCheck = await pool.query(CHECK_PARTICIPANT!, [challengeId, inviterId]);
  if (participantCheck.rowCount === 0) throw new Error('Forbidden'); // 403

  if (challenge.type === 'daily') throw new Error('Cannot invite to daily challenge');

  await pool.query(INSERT_PARTICIPANT!, [challengeId, inviteeId, 'invited']);
}

export async function acceptInvite(challengeId: string, userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const challengeRes = await client.query(GET_CHALLENGE!, [challengeId]);
    if (!challengeRes.rows[0]) {
      await client.query('ROLLBACK');
      throw new Error('Forbidden'); // 403 or 404 handled in route
    }
    const challenge = challengeRes.rows[0];

    const partRes = await client.query(UPDATE_PARTICIPANT_STATUS!, [challengeId, 'accepted', userId]);
    if (partRes.rowCount === 0) {
      await client.query('ROLLBACK');
      throw new Error('Forbidden'); // Not invited
    }

    if (challenge.type === 'head_to_head' && challenge.state === 'pending') {
      await client.query(UPDATE_CHALLENGE_STATE!, [challengeId, 'active']);
    } else if (challenge.type === 'group' && challenge.state === 'pending') {
      await client.query(UPDATE_CHALLENGE_STATE!, [challengeId, 'active']);
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function declineInvite(challengeId: string, userId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const challengeRes = await client.query(GET_CHALLENGE!, [challengeId]);
    if (!challengeRes.rows[0]) throw new Error('Forbidden');
    const challenge = challengeRes.rows[0];

    const partRes = await client.query(UPDATE_PARTICIPANT_STATUS!, [challengeId, 'declined', userId]);
    if (partRes.rowCount === 0) throw new Error('Forbidden');

    if (challenge.type === 'head_to_head') {
      await client.query(UPDATE_CHALLENGE_STATE!, [challengeId, 'cancelled']);
    }
    
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function joinGroupChallenge(challengeId: string, userId: string): Promise<void> {
  // Group has two or more; anyone may join while it is pending or active.
  // Late joining is allowed because progress is derived from activity_sessions in the [starts_at, ends_at] window,
  // meaning past activities within the window will automatically be included in progress calculation.
  const challengeRes = await pool.query(GET_CHALLENGE!, [challengeId]);
  if (!challengeRes.rows[0]) throw new Error('Not Found');
  const challenge = challengeRes.rows[0];
  
  if (challenge.type !== 'group') throw new Error('Can only join group challenges');
  if (challenge.state !== 'pending' && challenge.state !== 'active') throw new Error('Challenge not open');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(INSERT_PARTICIPANT!, [challengeId, userId, 'accepted']);
    
    if (challenge.state === 'pending') {
      // It becomes active once someone else joins
      await client.query(UPDATE_CHALLENGE_STATE!, [challengeId, 'active']);
    }
    await client.query('COMMIT');
  } catch(err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getChallenge(challengeId: string, userId: string): Promise<{ challenge: Challenge, participants: ChallengeParticipant[], myProgress: number }> {
  const challengeRes = await pool.query(GET_CHALLENGE!, [challengeId]);
  if (!challengeRes.rows[0]) throw new Error('Forbidden');
  
  const checkRes = await pool.query(CHECK_PARTICIPANT!, [challengeId, userId]);
  if (checkRes.rowCount === 0) throw new Error('Forbidden'); // 403

  const parts = await pool.query(GET_PARTICIPANTS!, [challengeId]);
  
  const actRes = await pool.query(RESOLVER_GET_ACTIVITY!, [userId, challengeRes.rows[0].starts_at, challengeRes.rows[0].ends_at]);
  const prog = computeProgress(actRes.rows, challengeRes.rows[0].metric as Metric);

  return {
    challenge: challengeRes.rows[0],
    participants: parts.rows.map(r => ({
      challengeId: r.challenge_id,
      userId: r.user_id,
      status: r.status,
      joinedAt: r.joined_at,
      finalProgress: r.final_progress,
      isWinner: r.is_winner,
      xpAwarded: r.xp_awarded
    })),
    myProgress: prog
  };
}

export async function listMyChallenges(userId: string): Promise<Array<Challenge & {
  participantStatus: ParticipantStatus;
  isWinner: boolean | null;
  xpAwarded: number | null;
  myProgress: number;
  groupProgress: number | null;
  groupMemberCount: number | null;
}>> {
  const res = await pool.query(LIST_MY_CHALLENGES!, [userId]);
  return res.rows;
}
