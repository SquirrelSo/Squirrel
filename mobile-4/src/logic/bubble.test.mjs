import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBubbleEvent, expiresIn, joinOutcome, rejoinDelay, REJOIN_MS, statesFor } from './bubble.ts';

const person = (id) => ({ user_id: id, display_name: id.toUpperCase(), avatar_url: null, hostel: 'H1', connection_mode: null, bio: null, level: 2, xp: 2500 });
const card = (id, over = {}) => ({ person: person(id), activity: null, proximity: 'nearby', zone: null, states: ['nearby', 'same_campus'], last_seen_at: '2026-10-07T10:00:00Z', ...over });
const ev = (id, state, over = {}) => ({ person: person(id), activity: null, proximity: 'very_close', zone: null, state, at: '2026-10-07T10:05:00Z', ...over });
const viewer = { zone_id: 'lib', activity: 'run' };

test('joined adds a card in the server order (same cell first)', () => {
  const out = applyBubbleEvent([card('a')], ev('b', 'joined'), viewer);
  assert.deepEqual(out.map((c) => c.person.user_id), ['b', 'a']);
  assert.deepEqual(out[0].states, ['nearby', 'same_campus']);
  assert.equal(out[0].last_seen_at, '2026-10-07T10:05:00Z');
});

test('left removes; an unknown leaver leaves the list untouched', () => {
  const list = [card('a'), card('b')];
  assert.deepEqual(applyBubbleEvent(list, ev('a', 'left'), viewer).map((c) => c.person.user_id), ['b']);
  assert.equal(applyBubbleEvent(list, ev('z', 'left'), viewer), list);
});

test('activity started / ended update the card and its states', () => {
  const started = applyBubbleEvent([card('a')], ev('a', 'activity_started', { activity: { type: 'run', started_at: null }, zone: { id: 'lib', name: 'Library' }, proximity: 'nearby' }), viewer);
  assert.equal(started.length, 1);
  assert.deepEqual(started[0].states, ['nearby', 'active_nearby', 'same_zone', 'same_campus', 'same_activity']);
  const ended = applyBubbleEvent(started, ev('a', 'activity_ended', { activity: { type: 'run', started_at: null }, proximity: 'nearby' }), viewer);
  assert.equal(ended[0].activity, null);
  assert.deepEqual(ended[0].states, ['nearby', 'same_campus']);
});

test('with a state filter, a card that stops matching leaves; one that never matched isn\'t added', () => {
  const list = [card('a', { activity: { type: 'run', started_at: null }, states: ['nearby', 'active_nearby', 'same_campus'] })];
  assert.deepEqual(applyBubbleEvent(list, ev('a', 'activity_ended'), viewer, 'active_nearby'), []);
  assert.deepEqual(applyBubbleEvent([], ev('b', 'joined'), viewer, 'same_zone'), []);
});

test('recently_active is kept from the shown card while not active', () => {
  const prev = card('a', { states: ['nearby', 'recently_active', 'same_campus'] });
  assert.deepEqual(statesFor({ activity: null, proximity: 'nearby', zone: null }, viewer, prev), ['nearby', 'recently_active', 'same_campus']);
  assert.deepEqual(statesFor({ activity: { type: 'walk', started_at: null }, proximity: 'nearby', zone: null }, viewer, prev), ['nearby', 'active_nearby', 'same_campus']);
});

test('re-join every 5 minutes, before expiry, never a tight loop', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  assert.equal(rejoinDelay({ lastJoinedAt: now, expiresAt: '2026-10-07T10:15:00Z', now }), REJOIN_MS);
  // Joined earlier (another visit): 5 minutes after the join implied by expires_at (TTL 15 min).
  assert.equal(rejoinDelay({ lastJoinedAt: null, expiresAt: '2026-10-07T10:12:00Z', now }), 2 * 60_000);
  // Overdue → soon, but not instantly.
  assert.equal(rejoinDelay({ lastJoinedAt: now - 20 * 60_000, expiresAt: null, now }), 5_000);
  // Close to expiry: a minute before it at the latest.
  assert.equal(rejoinDelay({ lastJoinedAt: now, expiresAt: '2026-10-07T10:03:00Z', now }), 2 * 60_000);
  assert.equal(rejoinDelay({ lastJoinedAt: now, expiresAt: null, now, retryAfterMs: 30_000 }), 30_000);
});

test('join outcomes: accepted, off campus, Open to Meet required, rate limited', () => {
  assert.deepEqual(joinOutcome({ ok: true, accepted: true, reason: null }), { kind: 'joined' });
  assert.deepEqual(joinOutcome({ ok: true, accepted: false, reason: 'off_campus' }), { kind: 'off_campus' });
  assert.deepEqual(joinOutcome({ ok: false, status: 409, code: 'open_to_meet_required' }), { kind: 'open_to_meet_required' });
  assert.deepEqual(joinOutcome({ ok: false, status: 429, code: 'rate_limited', retryAfterMs: 20_000 }), { kind: 'rate_limited', retryAfterMs: 20_000 });
  assert.deepEqual(joinOutcome({ ok: false, status: 429, code: 'rate_limited' }), { kind: 'rate_limited', retryAfterMs: 60_000 });
  assert.deepEqual(joinOutcome({ ok: false, status: 500, code: null }), { kind: 'error' });
});

test('expiry in words', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  assert.equal(expiresIn('2026-10-07T10:12:00Z', now), 'Expires in 12m');
  assert.equal(expiresIn('2026-10-07T10:00:20Z', now), 'Expires in under a minute');
  assert.equal(expiresIn(null, now), null);
});
