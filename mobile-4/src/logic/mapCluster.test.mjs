import assert from 'node:assert/strict';
import test from 'node:test';
import { groupMarkers, MARKER_CLEARANCE_PX, PAIR_GAP_PX } from './mapCluster.ts';

const P = (id, x, y) => ({ id, x, y });
const singles = (out) => out.filter((o) => o.kind === 'single');

test('two people in one spot sit side by side, far enough apart that avatars and badges never touch', () => {
  const out = groupMarkers([P('isha', 100, 100), P('hari', 100, 100)]);
  assert.equal(out.length, 2);
  const [a, b] = singles(out);
  assert.ok(Math.abs(a.x - b.x) >= PAIR_GAP_PX && PAIR_GAP_PX >= MARKER_CLEARANCE_PX, 'apart by at least the clearance (avatar 30 px + badge overhang + a gap)');
  assert.equal((a.x + b.x) / 2, 100); // still centred on where they are
});

test('either side of what used to be a grid line: still grouped', () => {
  // 45 and 47 were different 46-px cells before, drawn 2 px apart on top of each other.
  const out = groupMarkers([P('a', 45, 10), P('b', 47, 10)]);
  const [a, b] = singles(out);
  assert.ok(Math.abs(a.x - b.x) >= PAIR_GAP_PX);
});

test('three or more close together become one count; people further apart stay themselves', () => {
  const out = groupMarkers([P('a', 0, 0), P('b', 10, 5), P('c', 5, 12), P('far', 200, 0)]);
  const cl = out.find((o) => o.kind === 'cluster');
  assert.deepEqual(cl.ids.sort(), ['a', 'b', 'c']);
  assert.deepEqual(singles(out).map((s) => s.id), ['far']);
  assert.equal(cl.key, 'a|b|c');
});

test('far enough apart that they would not touch: no grouping, no moving', () => {
  const out = groupMarkers([P('a', 0, 0), P('b', MARKER_CLEARANCE_PX + 1, 0)]);
  assert.deepEqual(out.map((o) => [o.id, o.x]), [['a', 0], ['b', MARKER_CLEARANCE_PX + 1]]);
});

test('no two markers ever touch: a pair spread beside a count merges into it, zoomed far out', () => {
  // A count of three at x=0 and a pair 50 px away: spread, the pair's left avatar would sit 30 px from the count.
  const out = groupMarkers([P('a', 0, 0), P('b', 4, 4), P('c', 2, -3), P('isha', 50, 0), P('hari', 50, 0)]);
  const all = out.map((o) => [o.x, o.y]);
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) assert.ok(Math.hypot(all[i][0] - all[j][0], all[i][1] - all[j][1]) >= 42);
  assert.deepEqual(out.map((o) => o.kind), ['cluster']);
  assert.equal(out[0].ids.length, 5);
});

test('everyone on campus, packed into a phone width: whatever is shown never overlaps', () => {
  const pts = Array.from({ length: 30 }, (_, i) => P(`p${i}`, (i * 37) % 300, (i * 53) % 120));
  const out = groupMarkers(pts);
  for (let i = 0; i < out.length; i++) for (let j = i + 1; j < out.length; j++) assert.ok(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y) >= 42);
  // Nobody lost: every person is shown on their own or counted in a group.
  const count = out.reduce((s, o) => s + (o.kind === 'cluster' ? o.ids.length : 1), 0);
  assert.equal(count, 30);
});

test('nobody covers your dot: a person on top of you slides just clear, others stay put', () => {
  const me = { x: 100, y: 100 };
  const out = groupMarkers([P('kavya', 108, 106), P('far', 300, 300)], me);
  const k = out.find((o) => o.id === 'kavya');
  assert.ok(Math.hypot(k.x - me.x, k.y - me.y) >= 30);
  assert.ok(Math.hypot(k.x - me.x, k.y - me.y) < 34, 'moved only just enough');
  assert.ok(k.x > me.x && k.y > me.y, 'in the direction they already were');
  assert.deepEqual(out.find((o) => o.id === 'far'), { kind: 'single', id: 'far', x: 300, y: 300 });
  // Exactly on top: straight down.
  const on = groupMarkers([P('z', 100, 100)], me)[0];
  assert.equal(on.x, 100);
  assert.ok(on.y >= 130);
});
