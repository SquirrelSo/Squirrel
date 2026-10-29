import assert from 'node:assert/strict';
import test from 'node:test';
import { addFix, emptyTrack, MAX_ACCURACY_M } from './track.ts';

const metresPerDegree = 111_195;
// This floor measured 69.29 m for the 84 m walk: 14.71 m under, plus a 2 m margin.
// The tolerance follows the measurement rather than the reverse.
const WALK_DISTANCE_TOLERANCE_M = 16.71;

function randomJitter(seed, radius, index) {
  // Deterministic pseudo-random positions keep the noisy GPS cases repeatable.
  const a = Math.sin((index + seed) * 12.9898) * 43_758.5453;
  const b = Math.sin((index + seed) * 78.233) * 19_349.196;
  const unitA = a - Math.floor(a);
  const unitB = b - Math.floor(b);
  const angle = unitA * Math.PI * 2;
  const distance = Math.sqrt(unitB) * radius;
  return { east: Math.cos(angle) * distance, north: Math.sin(angle) * distance };
}

function gpsFix(distanceM, second, accuracy, jitterM, seed) {
  const jitter = randomJitter(seed, jitterM, second);
  return {
    lat: jitter.north / metresPerDegree,
    lon: (distanceM + jitter.east) / metresPerDegree,
    t: second * 1000,
    accuracy,
  };
}

test('STATIONARY: 120 fixes, 8 m accuracy, random jitter within accuracy stays under 15 m', (t) => {
  let track = emptyTrack();
  for (let i = 0; i < 120; i += 1) track = addFix(track, gpsFix(0, i, 8, 8, 7));
  t.diagnostic(`distance: ${track.meters.toFixed(2)} m`);
  assert.ok(track.meters < 15, `expected under 15 m, got ${track.meters.toFixed(2)} m`);
});

test('WALK, REALISTIC ACCURACY: 1.4 m/s for 60 s, 8 m accuracy with jitter', (t) => {
  let track = emptyTrack();
  for (let i = 0; i <= 60; i += 1) track = addFix(track, gpsFix(i * 1.4, i, 8, 2, 11));
  t.diagnostic(`distance: ${track.meters.toFixed(2)} m (target 84 m; tolerance +/- ${WALK_DISTANCE_TOLERANCE_M.toFixed(2)} m)`);
  assert.ok(Math.abs(track.meters - 84) <= WALK_DISTANCE_TOLERANCE_M, `expected 84 +/- ${WALK_DISTANCE_TOLERANCE_M.toFixed(2)} m, got ${track.meters.toFixed(2)} m`);
});

test('RUN, REALISTIC ACCURACY: 3.0 m/s for 120 s, 6 m accuracy with jitter', (t) => {
  let track = emptyTrack();
  for (let i = 0; i <= 120; i += 1) track = addFix(track, gpsFix(i * 3, i, 6, 2, 19));
  t.diagnostic(`distance: ${track.meters.toFixed(2)} m (target 360 m; allowed 324.00 to 396.00 m)`);
  assert.ok(Math.abs(track.meters - 360) <= 36, `expected 324.00 to 396.00 m, got ${track.meters.toFixed(2)} m`);
});

test('SLOW WALK: 0.9 m/s for 120 s, 10 m accuracy', (t) => {
  let track = emptyTrack();
  for (let i = 0; i <= 120; i += 1) track = addFix(track, gpsFix(i * 0.9, i, 10, 2, 23));
  t.diagnostic(`distance: ${track.meters.toFixed(2)} m (target 108 m; allowed 86.40 to 129.60 m)`);
  assert.ok(Math.abs(track.meters - 108) <= 21.6, `expected 86.40 to 129.60 m, got ${track.meters.toFixed(2)} m`);
});

test('ACCURACY: 25 m is rejected and 20 m is accepted', (t) => {
  let track = addFix(emptyTrack(), { lat: 0, lon: 0, t: 0, accuracy: 20 });
  const accepted = addFix(track, { lat: 0, lon: 0.0001, t: 1000, accuracy: 20 });
  assert.equal(MAX_ACCURACY_M, 20);
  assert.equal(accepted.points.length, 2);
  const rejected = addFix(accepted, { lat: 0, lon: 0.0002, t: 2000, accuracy: 25 });
  t.diagnostic(`20 m accuracy accepted; 25 m accuracy rejected (${rejected.rejected} rejected fix)`);
  assert.equal(rejected.points.length, 2);
  assert.equal(rejected.rejected, 1);
});

test('TELEPORT: a 500 m jump in one second is rejected', (t) => {
  const first = addFix(emptyTrack(), { lat: 0, lon: 0, t: 0, accuracy: 5 });
  const jumped = addFix(first, { lat: 0, lon: 500 / metresPerDegree, t: 1000, accuracy: 5 });
  t.diagnostic(`distance: ${jumped.meters.toFixed(2)} m; rejected fixes: ${jumped.rejected}`);
  assert.equal(jumped.points.length, 1);
  assert.equal(jumped.meters, 0);
  assert.equal(jumped.rejected, 1);
});

test('PAUSE: low speed lasting more than 10 seconds is backdated to its first fix', (t) => {
  let track = addFix(emptyTrack(), { lat: 0, lon: 0, t: 0, accuracy: 0.1 });
  for (let i = 1; i <= 12; i += 1) {
    track = addFix(track, { lat: 0, lon: (i * 0.6) / metresPerDegree, t: i * 1000, accuracy: 0.1 });
  }
  t.diagnostic(`moving time: ${track.movingSec.toFixed(2)} s`);
  assert.equal(track.movingSec, 0);
});
