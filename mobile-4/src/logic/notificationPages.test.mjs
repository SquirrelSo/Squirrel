import assert from 'node:assert/strict';
import test from 'node:test';
import { earlierRows, keepOlder } from './notificationPages.ts';

const n = (id, minute, read = false) => ({ id, type: 'poke', actor: null, text: id, created_at: `2026-10-05T10:${String(minute).padStart(2, '0')}:00Z`, read, data: null });

test('older pages join in time order, without repeats; a fresher copy of a row wins', () => {
  const first = [n('f3', 50), n('f2', 40), n('f1', 30)];
  const page2 = [n('o2', 20), n('o1', 10)];
  let kept = keepOlder([], first, page2);
  assert.deepEqual(earlierRows(kept, first).map((x) => x.id), ['o2', 'o1']);
  kept = keepOlder(kept, [n('o1', 10, true), n('o0', 5)]);
  assert.deepEqual(kept.map((x) => x.id), ['f3', 'f2', 'f1', 'o2', 'o1', 'o0']);
  assert.equal(kept.find((x) => x.id === 'o1').read, true);
});

test('rows pushed out of the first page by new arrivals stay visible under Earlier', () => {
  const first = [n('f3', 50), n('f2', 40), n('f1', 30)];
  const kept = keepOlder([], first, [n('o1', 10)]);
  // Two new notifications; the refreshed first page (still 3 long) no longer holds f2 and f1.
  const refreshed = [n('new2', 58), n('new1', 55), n('f3', 50)];
  assert.deepEqual(earlierRows(kept, refreshed).map((x) => x.id), ['f2', 'f1', 'o1']);
});

test('same timestamp: ordered by id, newest id first, as the server pages', () => {
  assert.deepEqual(keepOlder([], [n('a', 10), n('c', 10), n('b', 10)]).map((x) => x.id), ['c', 'b', 'a']);
});
