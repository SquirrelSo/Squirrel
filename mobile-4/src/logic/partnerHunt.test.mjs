import assert from 'node:assert/strict';
import test from 'node:test';
import { boardBlocker, labelOf, removeBuddyNote, removeBuddyOutcome, labelsOf, preferencesBody, preferencesDraft, preferencesProblems, requestOutcome, statusBlocker, toggleKey } from './partnerHunt.ts';

const options = {
  activities: [{ key: 'running', label: 'Running' }, { key: 'yoga', label: 'Yoga' }],
  times: [{ key: 'morning', label: 'Morning' }],
  modes: [{ key: 'in_person', label: 'In person' }, { key: 'remote', label: 'Remote' }, { key: 'either', label: 'Either' }],
  genders: [{ key: 'female', label: 'Female' }],
  partner_age: { min: 18, max: 99 },
  min_xp: 100,
};
const status = (over = {}) => ({ min_xp: 100, xp: { available: true, xp: 40, updated_at: null }, unlocked: false, age_eligible: true, fitness_level: 'beginner', preferences: null, ready: false, options, ...over });
const prefs = (over = {}) => ({ visible: true, activities: ['running'], mode: 'either', city: 'Kalyani', preferred_times: ['morning'], partner_genders: [], partner_age_min: 18, partner_age_max: 30, ...over });

test('labels come from options, and a key nobody labelled still reads', () => {
  assert.equal(labelOf(options.activities, 'yoga'), 'Yoga');
  assert.deepEqual(labelsOf(options.activities, ['running', 'parkour']), ['Running', 'parkour']);
});

test('each board refusal is its own state, with the XP numbers when locked', () => {
  assert.deepEqual(boardBlocker('xp_locked', { xp: 40, min_xp: 100 }, ''), { kind: 'xp_locked', xp: 40, minXp: 100 });
  assert.equal(boardBlocker('age_restricted', {}, '').kind, 'age');
  assert.equal(boardBlocker('xp_unavailable', {}, '').kind, 'xp_unavailable');
  assert.equal(boardBlocker('preferences_required', {}, '').kind, 'preferences');
  assert.equal(boardBlocker('blocks_unreachable', {}, '').kind, 'blocks_unreachable');
  assert.equal(boardBlocker('user_not_found', {}, '').kind, 'no_profile');
  assert.deepEqual(boardBlocker(null, {}, 'Network error'), { kind: 'error', message: 'Network error' });
});

test('the status call gives the same answer without trying the board', () => {
  assert.equal(statusBlocker(status({ age_eligible: false })).kind, 'age');
  assert.deepEqual(statusBlocker(status()), { kind: 'xp_locked', xp: 40, minXp: 100 });
  assert.equal(statusBlocker(status({ xp: { available: false, xp: null, updated_at: null } })).kind, 'xp_unavailable');
  assert.equal(statusBlocker(status({ unlocked: true })).kind, 'preferences');
  assert.equal(statusBlocker(status({ unlocked: true, preferences: prefs({ visible: false }) })).kind, 'preferences');
  assert.equal(statusBlocker(status({ unlocked: true, preferences: prefs(), ready: true })), null);
});

test('a refused Connect says why, and points at the request to answer when there is one', () => {
  assert.deepEqual(requestOutcome('they_asked_you', { request_id: 'r1' }, ''), { message: 'They’ve already asked you. Answer their request.', requestId: 'r1', showRequests: true });
  assert.equal(requestOutcome('already_requested', { request_id: 'r2' }, '').requestId, 'r2');
  assert.match(requestOutcome('too_soon', { retry_after: '2026-11-04T00:00:00Z' }, '').message, /ask again from 4 Nov/);
  assert.match(requestOutcome('daily_limit', {}, '').message, /10 requests/);
  assert.equal(requestOutcome('weird', {}, 'Server says no').message, 'Server says no');
});

test('preferences: a sensible draft, the server’s rules checked first, keys sent with the city cleaned', () => {
  const d = preferencesDraft(status());
  assert.deepEqual([d.mode, d.partner_age_min, d.partner_age_max, d.visible], ['either', 18, 30, true]);
  assert.deepEqual(preferencesProblems(d, options), ['Pick at least one activity.', 'Pick at least one time you train.', 'Add your city to meet in person.']);
  assert.deepEqual(preferencesProblems(prefs({ mode: 'remote', city: '' }), options), []);
  assert.deepEqual(preferencesProblems(prefs({ partner_age_min: 40, partner_age_max: 30 }), options), ['The youngest age can’t be above the oldest.']);
  assert.equal(preferencesBody(prefs({ mode: 'remote', city: 'Kalyani' })).city, null);
  assert.equal(preferencesBody(prefs({ city: '  Kalyani ' })).city, 'Kalyani');
  assert.deepEqual(toggleKey(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleKey(['a', 'b'], 'a'), ['b']);
});

test('removing a buddy: the confirm says silent and 30 days; already gone reads as gone, anything else as itself', () => {
  assert.match(removeBuddyNote('Riya'), /Riya won’t be told/);
  assert.match(removeBuddyNote('Riya'), /30 days/);
  assert.deepEqual(removeBuddyOutcome('connection_not_found', 'x'), { message: 'That connection isn’t there any more.', gone: true });
  assert.deepEqual(removeBuddyOutcome(null, 'You’re offline.'), { message: 'You’re offline.', gone: false });
});
