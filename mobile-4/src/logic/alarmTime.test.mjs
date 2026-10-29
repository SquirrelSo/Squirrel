import assert from 'node:assert/strict';
import test from 'node:test';
import { formatClock, from24, nextFireAt, to24, untilText } from './alarmTime.ts';

test('next fire is later today, or tomorrow once the time has passed', () => {
  const now = new Date(2026, 9, 1, 6, 0, 0);
  assert.equal(nextFireAt({ hour: 7, minute: 30 }, now).getDate(), 1);
  assert.equal(nextFireAt({ hour: 5, minute: 0 }, now).getDate(), 2);
  assert.equal(nextFireAt({ hour: 6, minute: 0 }, now).getDate(), 2, 'exactly now → tomorrow');
});

test('12/24-hour conversion round-trips', () => {
  for (let h = 0; h < 24; h++) {
    const p = from24({ hour: h, minute: 5 });
    assert.deepEqual(to24(p.h12, p.minute, p.ampm), { hour: h, minute: 5 });
  }
  assert.equal(formatClock({ hour: 7, minute: 30 }).full, '07:30 AM');
  assert.equal(formatClock({ hour: 0, minute: 0 }).full, '12:00 AM');
  assert.equal(formatClock({ hour: 12, minute: 5 }).full, '12:05 PM');
});

test('until text', () => {
  const now = new Date(2026, 9, 1, 6, 0, 0);
  assert.equal(untilText(new Date(2026, 9, 1, 7, 25), now), 'in 1 h 25 min');
  assert.equal(untilText(new Date(2026, 9, 1, 6, 4), now), 'in 4 min');
});
