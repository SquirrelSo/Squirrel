import assert from 'node:assert/strict';
import test from 'node:test';
import { createEngine } from './movementEngine.ts';
import { CHALLENGES, challengeById, challengeSummary } from './movementChallenges.ts';

/** Samples every 50 ms; `amp(t)` gives the acceleration magnitude on one axis. */
function feed(engine, fromMs, toMs, amp) {
  let s;
  for (let t = fromMs; t <= toMs; t += 50) s = engine.push({ t, x: amp(t), y: 0, z: 0 });
  return s;
}
const wiggle = (a) => (t) => (Math.floor(t / 50) % 2 ? a : -a);

test('dance: seconds only count while moving, and it completes', () => {
  const e = createEngine(challengeById('dance').rule(5));
  let s = feed(e, 0, 2000, () => 0.05);
  assert.equal(s.status, 'waiting');
  assert.equal(s.progress, 0);
  s = feed(e, 2050, 5000, wiggle(3));
  assert.ok(s.progress >= 2 && s.progress <= 3, `progress ${s.progress}`);
  assert.equal(s.status, 'moving');
  s = feed(e, 8100, 12000, wiggle(3));
  assert.equal(s.status, 'done');
  assert.equal(s.progress, 5);
});

test('dance pauses (keeps progress) when you stop', () => {
  const e = createEngine(challengeById('dance').rule(20));
  feed(e, 0, 4000, wiggle(3));
  const s = feed(e, 4050, 8000, () => 0.02);
  assert.equal(s.status, 'stopped');
  assert.ok(s.progress >= 3, 'progress kept');
  assert.equal(s.wasReset, false);
});

test('shake resets after 3 s still', () => {
  const e = createEngine(challengeById('shake').rule(15));
  const moving = feed(e, 0, 4000, wiggle(5));
  assert.ok(moving.progress >= 3);
  const still = feed(e, 4050, 5500, () => 0.02);
  assert.equal(still.status, 'stopped');
  assert.ok(still.progress > 0, 'not reset yet at 1.5 s');
  const reset = e.tick(8000);
  assert.equal(reset.progress, 0);
  assert.equal(reset.wasReset, true);
});

test('jumps: each spike-then-settle is one rep, with a minimum gap', () => {
  const e = createEngine(challengeById('jumping').rule(3));
  let s;
  for (let i = 0; i < 3; i++) {
    const t0 = i * 700;
    s = e.push({ t: t0, x: 0, y: 12, z: 0 }); // take-off spike
    s = e.push({ t: t0 + 20, x: 0, y: 11, z: 0 }); // same jump — must not double count
    s = e.push({ t: t0 + 200, x: 0, y: 0.5, z: 0 }); // settle
  }
  assert.equal(s.status, 'done');
  assert.equal(s.progress, 3);
});

test('squats: gentle sway is not a rep', () => {
  const e = createEngine(challengeById('squats').rule(5));
  const s = feed(e, 0, 5000, wiggle(1.2));
  assert.equal(s.progress, 0);
});

test('reps are never taken away when you pause, and you get nudged', () => {
  const e = createEngine(challengeById('squats').rule(5));
  e.push({ t: 0, x: 0, y: 3, z: 0 });
  e.push({ t: 300, x: 0, y: 0.2, z: 0 });
  const s = e.tick(9000);
  assert.equal(s.progress, 1);
  assert.equal(s.status, 'stopped');
});

test('credit (backup tap challenge) advances and completes', () => {
  const e = createEngine(challengeById('jumping').rule(2));
  e.credit(0);
  const s = e.credit(10);
  assert.equal(s.status, 'done');
});

test('catalogue: every challenge has amounts that include its default, and a summary', () => {
  for (const c of CHALLENGES) {
    assert.ok(c.amounts.includes(c.defaultAmount), c.id);
    assert.equal(c.rule(c.defaultAmount).target, c.defaultAmount);
  }
  assert.equal(challengeSummary('dance', 20), 'Dance · 20 sec');
  assert.equal(challengeSummary('squats', 10), 'Squats · 10 reps');
});

test('burst-and-rest movement (2 Hz) counts as continuous and as reps', () => {
  const burst = (t) => (Math.floor(t / 250) % 2 === 0 ? (Math.floor(t / 50) % 2 ? 9 : -9) : 0.1);
  const dance = createEngine(challengeById('dance').rule(3));
  assert.equal(feed(dance, 0, 4000, burst).status, 'done');
  const jumps = createEngine(challengeById('jumping').rule(4));
  assert.equal(feed(jumps, 0, 3000, burst).status, 'done');
  const squats = createEngine(challengeById('squats').rule(3));
  assert.equal(feed(squats, 0, 4000, burst).status, 'done');
});
