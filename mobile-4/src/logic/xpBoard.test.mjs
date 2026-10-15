import assert from 'node:assert/strict';
import test from 'node:test';
import { fromRunBoard, fromSocialBoard, namedWindow, xpBoardSpan } from './xpBoard.ts';

const person = (id, name) => ({ id, display_name: name, avatar_url: null });

test('Social names daily and weekly; monthly stays on the Run Module', () => {
  assert.equal(namedWindow('daily'), true);
  assert.equal(namedWindow('weekly'), true);
  assert.equal(namedWindow('monthly'), false);
});

test('a Social board keeps the server ranks and XP and carries profile ids and names', () => {
  const v = fromSocialBoard({
    window: 'daily', day: '2026-10-08', available: true,
    entries: [
      { rank: 1, xp: 300, hostel: 'H1', is_me: false, user: person('p-1', 'Aanya') },
      { rank: 2, xp: 120, hostel: null, is_me: true, user: person('p-2', 'Me') },
      { rank: 4, xp: 90, hostel: 'H2', is_me: false, user: person('p-4', 'Bilal') }, // a gap: Social drops unknown rows
    ],
    me: { rank: 2, xp: 120, hostel: null, is_me: true, user: person('p-2', 'Me') },
  });
  assert.deepEqual(v.rows.map((r) => [r.rank, r.xp, r.person?.user_id, r.person?.display_name, r.me]), [
    [1, 300, 'p-1', 'Aanya', false], [2, 120, 'p-2', 'Me', true], [4, 90, 'p-4', 'Bilal', false],
  ]);
  assert.equal(v.meRow, null, 'you are already in the list');
  assert.equal(v.totalRanked, null, 'Social has no total');
});

test('your Social row outside the top 10 is shown separately', () => {
  const v = fromSocialBoard({ window: 'weekly', day: 'd', available: true, entries: [{ rank: 1, xp: 5, hostel: null, is_me: false, user: person('a', 'A') }], me: { rank: 40, xp: 1, hostel: null, is_me: true, user: person('me', 'Me') } });
  assert.equal(v.meRow?.rank, 40);
  assert.equal(v.meRow?.person?.user_id, 'me');
});

test('a Run Module board has no names to invent', () => {
  const v = fromRunBoard({ window: 'monthly', day: 'd', total_ranked: 12, entries: [{ rank: 1, user_id: 'sub-1', xp: 900 }, { rank: 2, user_id: 'sub-me', xp: 10 }], me: { rank: 2, user_id: 'sub-me', xp: 10 } });
  assert.deepEqual(v.rows.map((r) => [r.rank, r.person, r.me]), [[1, null, false], [2, null, true]]);
  assert.equal(v.meRow, null);
  assert.equal(v.totalRanked, 12);
});

test('the footer span matches each window', () => {
  assert.deepEqual(['daily', 'weekly', 'monthly'].map(xpBoardSpan), ['today', 'in the last 7 days', 'this month']);
});
