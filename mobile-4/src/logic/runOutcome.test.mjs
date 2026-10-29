import assert from 'node:assert/strict';
import test from 'node:test';
import { recordedRunReason, territoryReasonText } from './runOutcome.ts';

test('a finalized run with a territory reason says it was recorded and why no ground was claimed', () => {
  assert.equal(recordedRunReason('accepted', 'not_closed'), "Recorded. Your loop didn't close, so no ground was claimed. Finish near where you started to claim it.");
  assert.match(recordedRunReason('accepted', 'no_faces'), /^Recorded\. Your route didn't enclose any ground/);
  assert.match(recordedRunReason('accepted', 'below_minimum_area'), /^Recorded\. Your loop was too small/);
});

test('no territory reason keeps the plain verified line', () => {
  assert.equal(recordedRunReason('accepted', null), 'Verified by the server.');
  assert.equal(recordedRunReason('accepted', undefined), 'Verified by the server.');
});

test('a flagged run explains the missing ground too', () => {
  assert.equal(recordedRunReason('flagged', null), 'Flagged for review.');
  assert.match(recordedRunReason('flagged', 'not_closed'), /^Flagged for review\. Your loop didn't close/);
});

test('processing ignores the territory reason', () => {
  assert.equal(recordedRunReason('processing', 'not_closed'), 'Uploaded. The server is still finishing it.');
});

test('an unknown reason still says no ground was claimed, without inventing a cause', () => {
  assert.equal(territoryReasonText('something_new'), 'No ground was claimed this time.');
  assert.equal(recordedRunReason('accepted', 'something_new'), 'Recorded. No ground was claimed this time.');
});
