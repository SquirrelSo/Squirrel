import assert from 'node:assert/strict';
import test from 'node:test';
import { amountText, mergeHistory, reasonText, sourceLabel, sourceRows } from './xpHistory.ts';

const item = (id, minute, extra = {}) => ({ id, amount: 20, source: 'exercise', reason: 'shared_workout_finished', source_id: null, created_at: `2026-10-05T10:${String(minute).padStart(2, '0')}:00.000Z`, reversed: false, ...extra });

test('every source has a label', () => {
  assert.deepEqual(['run', 'exercise', 'campus', 'challenge', 'social', 'daily_goal'].map(sourceLabel), ['Runs', 'Workouts', 'Campus', 'Challenges', 'Social', 'Daily goals']);
});

test('award reasons read as words', () => {
  assert.equal(reasonText('meetup_checkin'), 'Checked in at a meetup');
  assert.equal(reasonText('shared_workout_finished'), 'Finished a workout with a partner');
  assert.equal(reasonText('buddy_connected'), 'Connected with a workout buddy');
  assert.equal(reasonText('ambassador_referral'), 'Someone you referred joined');
  assert.equal(reasonText('ambassador_task'), 'Finished an ambassador task');
  assert.equal(reasonText('special_event'), 'Special event');
  assert.equal(reasonText('territory_claim'), 'Claimed a zone');
  assert.equal(reasonText('territory_steal'), 'Took over a zone');
  assert.equal(reasonText('territory_defend'), 'Defended your zone');
  assert.equal(reasonText('daily_goal'), 'Hit your daily goal');
  // The Run Module's challenge reason has a space, not an underscore.
  assert.equal(reasonText('challenge completed'), 'Won a challenge');
});

test('an unknown reason or source still reads as words, never as a code', () => {
  assert.equal(reasonText('streak_bonus'), 'Streak bonus');
  assert.equal(sourceLabel('crew_war'), 'Crew war');
  assert.equal(reasonText(''), 'XP');
});

test('amounts are signed; cap cuts are negative', () => {
  assert.equal(amountText(25), '+25 XP');
  assert.equal(amountText(-20), '−20 XP');
  assert.equal(amountText(1500), '+1,500 XP');
});

test('XP by source: biggest first, empty sources left out', () => {
  const rows = sourceRows({ run: 120, exercise: 0, campus: 25, challenge: 0, social: 300, daily_goal: 0 });
  assert.deepEqual(rows.map((r) => [r.label, r.xp]), [['Social', 300], ['Runs', 120], ['Campus', 25]]);
  assert.deepEqual(sourceRows({ run: 0 }), []);
});

test('Load more joins pages newest first, without repeats; the later copy wins', () => {
  const first = [item('c', 30), item('b', 20)];
  const next = [item('b', 20, { reversed: true }), item('a', 10)];
  const all = mergeHistory(first, next);
  assert.deepEqual(all.map((x) => x.id), ['c', 'b', 'a']);
  assert.equal(all[1].reversed, true);
});

test('same-instant items keep the server order (id descending)', () => {
  assert.deepEqual(mergeHistory([item('x1', 5), item('x2', 5)]).map((x) => x.id), ['x2', 'x1']);
});
