import assert from 'node:assert/strict';
import test from 'node:test';
import { addFix, addFixBatch, emptyTrack } from './track.ts';

const metresPerDegree = 111_195;

function routeFix(i) {
  const jitter = Math.sin(i * 1.7) * 0.15;
  return {
    lat: Math.cos(i * 0.9) * 0.15 / metresPerDegree,
    lon: (i * 1.4 + jitter) / metresPerDegree,
    t: i * 1000,
    accuracy: 0.2,
  };
}

test('BATCH EQUIVALENCE: timestamp-sorted batches produce the same TrackState as point-by-point fixes', () => {
  const fixes = Array.from({ length: 61 }, (_, i) => routeFix(i));
  const pointByPoint = fixes.reduce(addFix, emptyTrack());

  let batched = emptyTrack();
  for (let start = 0; start < fixes.length; start += 10) {
    const batch = fixes.slice(start, start + 10).reverse();
    batched = addFixBatch(batched, batch);
  }

  assert.deepEqual(batched, pointByPoint);
});

test('BACKGROUND GAP ORDER: shuffled fixes and a transition duplicate remain strictly time-ordered', () => {
  const fixes = Array.from({ length: 8 }, (_, i) => ({
    lat: 0,
    lon: ((i + 1) * 1.2) / metresPerDegree,
    t: (i + 1) * 1000,
    accuracy: 0.1,
  }));
  let track = fixes.slice(0, 4).reduce(addFix, emptyTrack());

  // The app switches from the foreground watcher to background updates at 5 s.
  // Expo's first background callback may repeat the transition fix and return later fixes unsorted.
  track = addFixBatch(track, [fixes[6], fixes[3], fixes[5], fixes[4]]);
  // A delayed duplicate/older callback after switching back cannot move the accepted clock back.
  track = addFixBatch(track, [fixes[4], fixes[7], fixes[2]]);

  const times = track.points.map((point) => point.t);
  assert.deepEqual(times, [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000]);
  assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
});
