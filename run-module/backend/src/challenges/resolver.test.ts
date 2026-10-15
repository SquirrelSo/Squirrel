import { test, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { pool } from '../db/pool.js';
import { createChallenge, getChallenge, inviteUser, acceptInvite, declineInvite, listMyChallenges } from './service.js';
import { resolveChallengesBatch } from './resolver.js';
import { getUserXp } from '../xp/query.js';

const U1 = crypto.randomUUID();
const U2 = crypto.randomUUID();
const U3 = crypto.randomUUID();
const LIST_USERS = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()] as const;
const EXTRA_ACTIVITY_USERS: string[] = [];

beforeAll(async () => {
});

afterAll(async () => {
  await pool.query('DELETE FROM activity_sessions WHERE user_id IN ($1, $2, $3)', [U1, U2, U3]);
  await pool.query('DELETE FROM challenges WHERE created_by IN ($1, $2, $3)', [U1, U2, U3]);
  await pool.query('DELETE FROM activity_sessions WHERE user_id = ANY($1::uuid[])', [LIST_USERS]);
  await pool.query('DELETE FROM challenges WHERE created_by = ANY($1::uuid[])', [LIST_USERS]);
  if (EXTRA_ACTIVITY_USERS.length) {
    await pool.query('DELETE FROM activity_sessions WHERE user_id = ANY($1::uuid[])', [EXTRA_ACTIVITY_USERS]);
  }
});

test('GOALS-2: mine list progress matches the challenge detail route', async () => {
  const userId = LIST_USERS[0];
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() + 3600000);
  const challenge = await createChallenge(userId, 'daily', 'list progress', 'distance_m', 'gte', 5000, starts, ends, 100);
  const distance = 3210.5;

  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), userId, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: distance })]
  );

  const listed = (await listMyChallenges(userId)).find((item) => item.id === challenge.id)!;
  const detail = await getChallenge(challenge.id, userId);
  expect(listed.myProgress).toBe(detail.myProgress);
  expect(listed.myProgress).toBe(distance);
});

test('GOALS-2: mine list reports zero progress when the user has no activity', async () => {
  const userId = LIST_USERS[1];
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() + 3600000);
  const challenge = await createChallenge(userId, 'daily', 'zero progress', 'runs_completed', 'gte', 1, starts, ends, 100);

  const listed = (await listMyChallenges(userId)).find((item) => item.id === challenge.id);
  expect(listed?.myProgress).toBe(0);
  expect(listed?.myProgress).not.toBeNull();
});

test('GOALS-2/4: mine list preserves challenge values with camelCase fields and GOALS-3 additions', async () => {
  const userId = LIST_USERS[2];
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() + 3600000);
  const challenge = await createChallenge(userId, 'daily', 'shape check', 'runs_completed', 'gte', 1, starts, ends, 100);
  const raw = await pool.query('SELECT * FROM challenges WHERE id = $1', [challenge.id]);
  const listed = (await listMyChallenges(userId)).find((item) => item.id === challenge.id)!;
  const fieldMap = {
    id: 'id',
    type: 'type',
    title: 'title',
    metric: 'metric',
    comparator: 'comparator',
    threshold: 'threshold',
    startsAt: 'starts_at',
    endsAt: 'ends_at',
    xpReward: 'xp_reward',
    state: 'state',
    createdBy: 'created_by',
    createdAt: 'created_at',
    resolvedAt: 'resolved_at',
  } as const;
  const expectedKeys = [
    ...Object.keys(fieldMap),
    'participantStatus', 'isWinner', 'xpAwarded', 'myProgress', 'groupProgress', 'groupMemberCount'
  ].sort();

  expect(Object.keys(listed).sort()).toEqual(expectedKeys);
  expect(Object.keys(listed).every((key) => !key.includes('_'))).toBe(true);
  for (const [responseField, databaseField] of Object.entries(fieldMap)) {
    expect(listed[responseField as keyof typeof listed]).toEqual(raw.rows[0][databaseField]);
  }
  expect(listed.groupProgress).toBeNull();
  expect(listed.groupMemberCount).toBeNull();
});

test('GOALS-3: mine list returns participant status and unresolved result fields distinctly', async () => {
  const userId = LIST_USERS[0];
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() + 3600000);
  const challenge = await createChallenge(userId, 'daily', 'status and pending result', 'runs_completed', 'gte', 1, starts, ends, 100);
  await pool.query("UPDATE challenge_participants SET status = 'declined' WHERE challenge_id = $1 AND user_id = $2", [challenge.id, userId]);
  const dbParticipant = await pool.query(
    'SELECT status, is_winner, xp_awarded FROM challenge_participants WHERE challenge_id = $1 AND user_id = $2',
    [challenge.id, userId]
  );

  const listed = (await listMyChallenges(userId)).find((item) => item.id === challenge.id)!;
  expect(listed.participantStatus).toBe(dbParticipant.rows[0].status);
  expect(listed.participantStatus).toBe('declined');
  expect(listed.participantStatus).not.toBe('accepted');
  expect(listed.isWinner).toBeNull();
  expect(listed.xpAwarded).toBeNull();
});

test('GOALS-3: resolved participant results match the XP awarded to winner and loser', async () => {
  const winnerId = LIST_USERS[1];
  const loserId = crypto.randomUUID();
  EXTRA_ACTIVITY_USERS.push(loserId);
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() - 1000);
  const reward = 125;
  const challenge = await createChallenge(winnerId, 'head_to_head', 'resolved result fields', 'distance_m', 'gte', 100, starts, ends, reward);
  await inviteUser(challenge.id, winnerId, loserId);
  await acceptInvite(challenge.id, loserId);
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), winnerId, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 500 })]
  );
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), loserId, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 250 })]
  );

  await resolveChallengesBatch();
  const winner = (await listMyChallenges(winnerId)).find((item) => item.id === challenge.id)!;
  const loser = (await listMyChallenges(loserId)).find((item) => item.id === challenge.id)!;
  expect(winner.isWinner).toBe(true);
  expect(winner.xpAwarded).toBe(reward);
  expect(loser.isWinner).toBe(false);
  expect(loser.xpAwarded).toBe(0);
});

test('GOALS-3: group list returns accepted members’ shared progress and member count', async () => {
  const userId = LIST_USERS[2];
  const secondMember = crypto.randomUUID();
  const invited = crypto.randomUUID();
  EXTRA_ACTIVITY_USERS.push(secondMember);
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() + 3600000);
  const challenge = await createChallenge(userId, 'group', 'shared progress', 'distance_m', 'gte', 1000, starts, ends, 100);
  await pool.query('INSERT INTO challenge_participants (challenge_id, user_id, status) VALUES ($1, $2, $3)', [challenge.id, secondMember, 'accepted']);
  await pool.query('INSERT INTO challenge_participants (challenge_id, user_id, status) VALUES ($1, $2, $3)', [challenge.id, invited, 'invited']);
  await pool.query('UPDATE challenges SET state = $1 WHERE id = $2', ['active', challenge.id]);
  for (const [member, distance] of [[userId, 350], [secondMember, 650]] as const) {
    await pool.query(
      'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
      [crypto.randomUUID(), member, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: distance })]
    );
  }

  const listed = (await listMyChallenges(userId)).find((item) => item.id === challenge.id)!;
  expect(listed.myProgress).toBe(350);
  expect(listed.groupProgress).toBe(1000);
  expect(listed.groupMemberCount).toBe(2);
  expect(listed.participantStatus).toBe('accepted');
});

test('H1: Daily challenge target met', async () => {
  const U1 = crypto.randomUUID();
  const starts = new Date(Date.now() - 3600000); // 1 hour ago
  const ends = new Date(Date.now() - 1000); // just ended

  const ch = await createChallenge(U1, 'daily', '5k today', 'distance_m', 'gte', 5000, starts, ends, 100);
  
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U1, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 5000 })]
  );

  const resolved = await resolveChallengesBatch();
  expect(resolved).toBeGreaterThanOrEqual(1);

  const d = await getChallenge(ch.id, U1);
  const me = d.participants.find(p => p.userId === U1);
  expect(me?.finalProgress).toBe(5000);
  expect(me?.isWinner).toBe(true);
});

test('H2: Progress is derived, not accumulated', async () => {
  const U1 = crypto.randomUUID();
  const U2 = crypto.randomUUID();
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() + 3600000);

  const ch = await createChallenge(U1, 'daily', 'live derived', 'distance_m', 'gte', 5000, starts, ends, 100);
  
  const actId = crypto.randomUUID();
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [actId, U1, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 5000 })]
  );

  let d = await getChallenge(ch.id, U1);
  expect(d.myProgress).toBe(5000);

  // Mark row for different user
  await pool.query('UPDATE activity_sessions SET user_id = $1 WHERE id = $2', [U2, actId]);

  d = await getChallenge(ch.id, U1);
  expect(d.myProgress).toBe(0);
});

test('H3 & H6: Head to head higher wins & Idempotency', async () => {
  const U1 = crypto.randomUUID();
  const U2 = crypto.randomUUID();
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() - 1000);

  const ch = await createChallenge(U1, 'head_to_head', 'h2h', 'distance_m', 'gte', 5000, starts, ends, 100);
  await inviteUser(ch.id, U1, U2);
  await acceptInvite(ch.id, U2);

  // U1 gets 6000, U2 gets 5000
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U1, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 6000 })]
  );
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U2, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 5000 })]
  );

  const res1 = await resolveChallengesBatch();
  const d = await getChallenge(ch.id, U1);
  const p1 = d.participants.find(p => p.userId === U1);
  const p2 = d.participants.find(p => p.userId === U2);
  
  console.log('H3 P1 final progress:', p1?.finalProgress);
  console.log('H3 P2 final progress:', p2?.finalProgress);

  expect(p1?.isWinner).toBe(true);
  expect(p2?.isWinner).toBe(false); // U1 won

  // Double run
  const res2 = await resolveChallengesBatch();
  console.log('H6 First run resolved:', res1, 'Second run resolved:', res2);
  expect(res2).toBe(0);
});

test('H4: Head to head invite declined -> cancelled', async () => {
  const U1 = crypto.randomUUID();
  const U2 = crypto.randomUUID();
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() - 1000);

  const ch = await createChallenge(U1, 'head_to_head', 'h2h decline', 'distance_m', 'gte', 5000, starts, ends, 100);
  await inviteUser(ch.id, U1, U2);
  await declineInvite(ch.id, U2);

  const res = await pool.query('SELECT state FROM challenges WHERE id = $1', [ch.id]);
  expect(res.rows[0].state).toBe('cancelled');
});

test('H5: Group challenge combined progress', async () => {
  const U1 = crypto.randomUUID();
  const U2 = crypto.randomUUID();
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() - 1000);

  const ch = await createChallenge(U1, 'group', 'group 10k', 'distance_m', 'gte', 10000, starts, ends, 100);
  // join is tested in routes, let's insert direct for test
  await pool.query('INSERT INTO challenge_participants (challenge_id, user_id, status) VALUES ($1, $2, $3)', [ch.id, U2, 'accepted']);
  await pool.query('UPDATE challenges SET state = $1 WHERE id = $2', ['active', ch.id]);

  // U1 gets 4000, U2 gets 7000 (11000 total > 10000)
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U1, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 4000 })]
  );
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U2, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 7000 })]
  );

  await resolveChallengesBatch();
  const d = await getChallenge(ch.id, U1);
  const p1 = d.participants.find(p => p.userId === U1);
  const p2 = d.participants.find(p => p.userId === U2);
  
  expect(p1?.isWinner).toBe(true);
  expect(p2?.isWinner).toBe(true);
});

test('H7: a challenge whose window has not ended is not resolved', async () => {
  const U1 = crypto.randomUUID();
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() + 3600000); // 1 hour in future

  const ch = await createChallenge(U1, 'daily', 'not ended', 'distance_m', 'gte', 5000, starts, ends, 100);
  
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U1, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 6000 })]
  );

  await resolveChallengesBatch();
  const res = await pool.query('SELECT state FROM challenges WHERE id = $1', [ch.id]);
  expect(res.rows[0].state).toBe('active'); // Still active, not resolved
});

test('H8: Activity OUTSIDE window does not count', async () => {
  const U1 = crypto.randomUUID();
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() - 1000);

  const ch = await createChallenge(U1, 'daily', 'out of window', 'distance_m', 'gte', 5000, starts, ends, 100);
  
  // Before
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U1, 'run', 'territory_run', new Date(starts.getTime() - 10000), JSON.stringify({ distance_m: 10000 })]
  );
  // After
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U1, 'run', 'territory_run', new Date(ends.getTime() + 10000), JSON.stringify({ distance_m: 10000 })]
  );

  await resolveChallengesBatch();
  const d = await getChallenge(ch.id, U1);
  const me = d.participants.find(p => p.userId === U1);
  expect(me?.finalProgress).toBe(0);
});

test('H9: XP breakdown includes challenge completed', async () => {
  const starts = new Date(Date.now() - 3600000);
  const ends = new Date(Date.now() - 1000);
  const REWARD = 180; // within the 200 xp_reward cap and the 200/day challenge cap (ADR-033)

  const ch = await createChallenge(U3, 'daily', 'xp test', 'distance_m', 'gte', 10, starts, ends, REWARD);
  
  await pool.query(
    'INSERT INTO activity_sessions (id, user_id, type, subtype, started_at, duration_s, metrics) VALUES ($1, $2, $3, $4, $5, 1000, $6)',
    [crypto.randomUUID(), U3, 'run', 'territory_run', new Date(starts.getTime() + 1000), JSON.stringify({ distance_m: 20 })]
  );

  const before = await getUserXp(U3);

  await resolveChallengesBatch();

  const after = await getUserXp(U3);
  expect(after.xp - before.xp).toBe(REWARD);
  const line = after.breakdown.find(l => l.reason === 'challenge completed' && l.xp === REWARD);
  expect(line).toBeDefined();
});
