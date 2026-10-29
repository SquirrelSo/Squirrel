import assert from 'node:assert/strict';
import test from 'node:test';
import { applyToggle, CATEGORIES, formatMinutes, isMutable, kindRoute, quietHoursError, quietHoursPatch, quietHoursText, toClock, toMinutes, togglePatch } from './notificationPrefs.ts';

const prefs = () => ({
  categories: Object.fromEntries(CATEGORIES.map((c) => [c, { push: true, in_app: true, mutable: c !== 'system' }])),
  quiet_hours_start: null,
  quiet_hours_end: null,
  timezone: 'Asia/Kolkata',
  updated_at: null,
});

test('a switch sends only that category and channel; system is never sent', () => {
  assert.deepEqual(togglePatch('bubble', 'push', false), { categories: { bubble: { push: false } } });
  assert.deepEqual(togglePatch('xp', 'in_app', true), { categories: { xp: { in_app: true } } });
  assert.equal(togglePatch('system', 'push', false), null);
  assert.equal(isMutable(prefs(), 'system'), false);
  assert.equal(isMutable(prefs(), 'crews'), true);
});

test('the optimistic copy changes one channel and leaves the original alone', () => {
  const p = prefs();
  const next = applyToggle(p, 'crews', 'push', false);
  assert.deepEqual(next.categories.crews, { push: false, in_app: true, mutable: true });
  assert.equal(p.categories.crews.push, true);
  assert.equal(next.categories.xp, p.categories.xp);
});

test('quiet hours: both or neither, 0–1439, never the same minute', () => {
  assert.equal(quietHoursError(null, null), null);
  assert.equal(quietHoursError(1320, 420), null);
  assert.match(quietHoursError(1320, null), /both/);
  assert.match(quietHoursError(null, 0), /both/);
  assert.match(quietHoursError(1440, 0), /between/);
  assert.match(quietHoursError(-1, 0), /between/);
  assert.match(quietHoursError(600, 600), /same minute/);
  assert.deepEqual(quietHoursPatch(1320, 420), { quiet_hours_start: 1320, quiet_hours_end: 420 });
  assert.deepEqual(quietHoursPatch(null, null), { quiet_hours_start: null, quiet_hours_end: null });
  assert.equal(quietHoursPatch(5, 5), null);
});

test('minutes ↔ clock, and how quiet hours read', () => {
  assert.deepEqual(toClock(1439), { hour: 23, minute: 59 });
  assert.equal(toMinutes({ hour: 7, minute: 30 }), 450);
  assert.equal(formatMinutes(0), '12:00 AM');
  assert.equal(formatMinutes(720), '12:00 PM');
  assert.equal(formatMinutes(1320), '10:00 PM');
  assert.equal(quietHoursText(1320, 420), '10:00 PM – 7:00 AM (overnight)');
  assert.equal(quietHoursText(780, 840), '1:00 PM – 2:00 PM');
  assert.equal(quietHoursText(null, null), null);
});

test('new kinds open their screens; unknown kinds leave it to the server route', () => {
  assert.equal(kindRoute('xp.level_up', { level: 5, route: '/progress' }), '/progress');
  assert.equal(kindRoute('shared_workout.invited', { code: 'AB12CD', session_id: 's-1' }), '/workout/join/AB12CD');
  assert.equal(kindRoute('shared_workout.invited', { code: '../../x', session_id: 's-1' }), '/workout/s-1');
  assert.equal(kindRoute('shared_workout.invited', { code: '../x', route: '/workout' }), null);
  assert.equal(kindRoute('shared_workout.finished', { session_id: 's-1' }), '/workout/s-1');
  assert.equal(kindRoute('bubble.activity', { zone_id: 'z-1', route: '/explore' }), '/bubble');
  assert.equal(kindRoute('ambassador.task', { route: '/ambassador/tasks', task_id: 't' }), '/ambassador');
  assert.equal(kindRoute('ambassador.reward', null), '/ambassador');
  assert.equal(kindRoute('ambassador.suspended', {}), '/ambassador');
  assert.equal(kindRoute('system.announcement', { route: '/notifications' }), null);
  assert.equal(kindRoute('system.announcement', { route: '/events' }), '/events');
  assert.equal(kindRoute('system.announcement', { route: '//evil.example' }), null);
  assert.equal(kindRoute('badge', { route: '/profile' }), undefined);
});
