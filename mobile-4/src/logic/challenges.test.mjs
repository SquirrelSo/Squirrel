import assert from 'node:assert/strict';
import test from 'node:test';
import { fmtMetric, goalFromRun, minutesUntil, sortGoals } from './challenges.ts';

const NOW = Date.parse('2026-10-06T10:00:00Z');
// A row as GET /v1/challenges/mine sends it: the challenge's columns snake_case, the per-user fields camelCase.
const row = (over = {}) => ({
  id: 'c1', type: 'daily', title: '5 km today', metric: 'distance_m', comparator: 'gte', threshold: 5000,
  starts_at: '2026-10-06T00:00:00Z', ends_at: '2026-10-07T00:00:00Z', xp_reward: 50, state: 'active',
  created_by: 'u0', created_at: '2026-10-05T00:00:00Z', resolved_at: null,
  participantStatus: 'accepted', isWinner: null, xpAwarded: null, myProgress: 3200, groupProgress: null, groupMemberCount: null,
  ...over,
});

test('a running daily challenge, in display units', () => {
  const c = goalFromRun(row(), NOW);
  assert.equal(c.kind, 'daily');
  assert.equal(c.metric, 'km');
  assert.equal(c.mine, 3.2);
  assert.equal(c.goal, 5);
  assert.equal(c.xp, 50);
  assert.equal(c.state, 'active');
  assert.equal(c.myStatus, 'accepted');
  assert.equal(c.result, null, 'no result while it runs');
  assert.equal(c.group, undefined);
});

test('metrics are converted: seconds to minutes, counts as they are', () => {
  assert.equal(goalFromRun(row({ metric: 'duration_s', threshold: 1800, myProgress: 900 }), NOW).goal, 30);
  assert.equal(goalFromRun(row({ metric: 'duration_s', threshold: 1800, myProgress: 900 }), NOW).mine, 15);
  const runs = goalFromRun(row({ metric: 'runs_completed', threshold: 3, myProgress: 2 }), NOW);
  assert.deepEqual([runs.metric, runs.mine, runs.goal], ['runs', 2, 3]);
  assert.equal(goalFromRun(row({ metric: 'something_new' }), NOW), null, 'unknown metric: not shown');
});

test('group challenges carry the shared total and member count', () => {
  const c = goalFromRun(row({ type: 'group', threshold: 50000, myProgress: 4000, groupProgress: 21000, groupMemberCount: 6 }), NOW);
  assert.deepEqual(c.group, { value: 21, members: 6 });
  assert.equal(c.goal, 50);
});

test('results: won, lost, and still running are told apart', () => {
  assert.deepEqual(goalFromRun(row({ state: 'resolved', isWinner: true, xpAwarded: 50 }), NOW).result, { won: true, xp: 50 });
  assert.deepEqual(goalFromRun(row({ state: 'resolved', isWinner: false, xpAwarded: 0 }), NOW).result, { won: false, xp: 0 });
  assert.equal(goalFromRun(row({ state: 'resolved', isWinner: false, xpAwarded: null }), NOW).result.xp, 0);
  assert.equal(goalFromRun(row({ isWinner: null }), NOW).result, null);
});

test('state comes from the server state and the window', () => {
  assert.equal(goalFromRun(row({ state: 'cancelled' }), NOW).state, 'cancelled');
  assert.equal(goalFromRun(row({ state: 'resolved' }), NOW).state, 'ended');
  assert.equal(goalFromRun(row({ state: 'pending', starts_at: '2026-10-08T00:00:00Z', ends_at: '2026-10-09T00:00:00Z' }), NOW).state, 'upcoming');
  assert.equal(goalFromRun(row({ ends_at: '2026-10-06T09:00:00Z' }), NOW).state, 'ended', 'past its end, awaiting the resolver');
});

test('invites are shown; declined challenges and head-to-heads are not', () => {
  assert.equal(goalFromRun(row({ participantStatus: 'invited' }), NOW).myStatus, 'invited');
  assert.equal(goalFromRun(row({ participantStatus: 'declined' }), NOW), null);
  assert.equal(goalFromRun(row({ type: 'head_to_head' }), NOW), null);
});

test('camelCase columns and numeric strings are read too', () => {
  const r = row({ starts_at: undefined, ends_at: undefined, xp_reward: undefined, startsAt: '2026-10-06T00:00:00Z', endsAt: '2026-10-07T00:00:00Z', xpReward: '75', threshold: '5000', myProgress: '1000' });
  const c = goalFromRun(r, NOW);
  assert.deepEqual([c.xp, c.goal, c.mine, c.state], [75, 5, 1, 'active']);
  assert.equal(goalFromRun(row({ ends_at: 'not a date' }), NOW), null);
});

test('sorting and formatting', () => {
  const cards = [
    goalFromRun(row({ id: 'done', state: 'resolved', isWinner: true, xpAwarded: 50 }), NOW),
    goalFromRun(row({ id: 'later', ends_at: '2026-10-08T00:00:00Z' }), NOW),
    goalFromRun(row({ id: 'soon' }), NOW),
  ];
  assert.deepEqual(sortGoals(cards).map((c) => c.id), ['soon', 'later', 'done']);
  assert.equal(fmtMetric(3.25, 'km'), '3.3 km');
  assert.equal(fmtMetric(1, 'runs'), '1 run');
  assert.equal(fmtMetric(12400, 'm2'), '12,400 m²');
  assert.equal(minutesUntil('2026-10-06T12:30:00Z', NOW), 150);
  assert.equal(minutesUntil('2026-10-06T09:00:00Z', NOW), 0);
});
