import assert from 'node:assert/strict';
import test from 'node:test';
import { labelBox, placeLabel, placeLabels, sameName, zoneTier } from './mapLabels.ts';

test('labels: a cut-off short name is never used; the campus name goes; long names shorten at words', () => {
  // As campus-service sends them (short_name cut at 18 characters).
  assert.equal(placeLabel('IISER Kolkata Library', 'IISER Kolkata Libr'), 'Library');
  assert.equal(placeLabel("Director's Bungalow", "Director's Bungalo"), "Director's Bungalow");
  assert.equal(placeLabel('Block B, Faculty Quarters', 'Block B, Faculty Q'), 'Block B, Faculty Qtrs');
  assert.equal(placeLabel('APC Ray Lecture Hall Complex', 'APC Ray Lecture'), 'APC Ray LHC');
  assert.equal(placeLabel('AJC Bose Research Complex', 'AJC Bose Research'), 'AJC Bose Research');
  assert.equal(placeLabel('Electrical Substation I', 'Electrical Substat'), 'Substation I');
  assert.equal(placeLabel('IISER Kolkata Swimming Pool', 'IISER Kolkata Swim'), 'Swimming Pool');
  assert.equal(placeLabel('Garden High Scool IISER Kolkata Campus', 'Garden High Scool '), 'Garden High Scool');
  assert.equal(placeLabel('Rabindranath Tagore Auditorium', 'Rabindranath Tagor'), 'Rabindranath Tagore');
  // A real short name is kept as given.
  assert.equal(placeLabel('Netaji Subhas Chandra Bose Hall', 'NSCB'), 'NSCB');
  assert.equal(placeLabel('Dining Hall', null), 'Dining Hall');
});

test('tiers: homes, food, library and grounds always; buildings mid; staff housing and utilities close up', () => {
  assert.equal(zoneTier({ kind: 'hostel', name: 'Nivedita Hall' }), 1);
  assert.equal(zoneTier({ kind: 'food', name: 'Dining Hall' }), 1);
  assert.equal(zoneTier({ kind: 'library', name: 'IISER Kolkata Library' }), 1);
  assert.equal(zoneTier({ kind: 'sports', name: 'Football Ground' }), 1);
  assert.equal(zoneTier({ kind: 'academic', name: 'APC Ray Lecture Hall Complex' }), 2);
  assert.equal(zoneTier({ kind: 'landmark', name: 'RC Lake' }), 2);
  assert.equal(zoneTier({ kind: 'landmark', name: 'Block A, Faculty Quarters' }), 3);
  assert.equal(zoneTier({ kind: 'landmark', name: 'Prefab II' }), 3);
  assert.equal(zoneTier({ kind: 'landmark', name: 'Electrical Substation I' }), 3);
  assert.equal(zoneTier({ kind: 'academic', name: 'Garden High Scool IISER Kolkata Campus' }), 3);
});

const L = (id, x, y, tier, extra = {}) => ({ id, x, y, text: id, tier, fontSize: 12, ...extra });

test('placement: tiers appear as you zoom in', () => {
  const c = [L('hostel', 0, 0, 1), L('lhc', 300, 0, 2), L('prefab', 600, 0, 3)];
  assert.deepEqual([...placeLabels(c, 3).keys()], ['hostel']);
  assert.deepEqual([...placeLabels(c, 2).keys()].sort(), ['hostel', 'lhc']);
  assert.deepEqual([...placeLabels(c, 1).keys()].sort(), ['hostel', 'lhc', 'prefab']);
});

test('placement: overlapping labels — the more important one takes the spot, the rest move aside or hide', () => {
  const c = ['a', 'b', 'c', 'd', 'e'].map((k, i) => L(`prefab-${k}`, i, i, 3)).concat(L('nivedita', 10, 4, 1));
  const shown = placeLabels(c, 1);
  assert.deepEqual(shown.get('nivedita'), { dx: 0, dy: 0 });
  // Six names on one spot: the hostel keeps it, three prefabs find room above and below, two hide.
  assert.equal(shown.size, 4);
  assert.equal(shown.has('prefab-e'), false);
  // Apart, all show.
  assert.equal(placeLabels([L('a', 0, 0, 3), L('b', 0, 60, 3)], 1).size, 2);
});

test('placement: a pinned label (selected, yours, contested) shows at any scale and goes first', () => {
  const c = [L('nivedita', 0, 0, 1), L('prefab', 2, 2, 3, { pinned: true })];
  const shown = placeLabels(c, 5);
  assert.deepEqual(shown.get('prefab'), { dx: 0, dy: 0 });
  assert.deepEqual(shown.get('nivedita'), { dx: 0, dy: 26 });
});

test('placement: a crowd on a hostel moves its name below it, never hides it while there is room', () => {
  const c = [L('library', 0, 0, 1), L('mess', 200, 0, 1)];
  const shown = placeLabels(c, 3, [{ x: 4, y: 2, r: 12 }]);
  assert.deepEqual(shown.get('library'), { dx: 0, dy: 26 });
  assert.deepEqual(shown.get('mess'), { dx: 0, dy: 0 });
  assert.ok(labelBox({ x: 0, y: 0, text: 'LIBRARY', fontSize: 12 }).x1 > 20);
});

test('a building captioned with its zone name is the same place', () => {
  assert.ok(sameName('IISER Kolkata Library', 'Library'));
  assert.ok(sameName('Dining Hall', 'Dining hall'));
  assert.equal(sameName('Indian Overseas Bank', 'Medical Unit'), false);
});
