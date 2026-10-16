import assert from 'node:assert/strict';
import test from 'node:test';
import { photoOutcome } from './photo.ts';

test('a stored photo with no moderation field is usable at once (Social sends none)', () => {
  assert.equal(photoOutcome({ status: 'ready' }), 'usable');
  assert.equal(photoOutcome({ status: 'ready', moderation: null }), 'usable');
});

test('a verdict, if one is ever sent, decides', () => {
  assert.equal(photoOutcome({ status: 'ready', moderation: 'approved' }), 'usable');
  assert.equal(photoOutcome({ status: 'ready', moderation: 'rejected' }), 'rejected');
  assert.equal(photoOutcome({ status: 'ready', moderation: 'pending' }), 'checking');
});

test('not stored yet is never treated as usable', () => {
  assert.equal(photoOutcome({ status: 'pending' }), 'checking');
  assert.equal(photoOutcome({ status: 'pending', moderation: 'rejected' }), 'rejected');
});
