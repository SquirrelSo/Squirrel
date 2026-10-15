import assert from 'node:assert/strict';
import test from 'node:test';
import { appendPage, hiddenInfo, proximityWords, sectionAccepts, sectionQuery, zoneChoices, zoneLine } from './discover.ts';

test('proximity is words only, never a number', () => {
  assert.equal(proximityWords('very_close'), 'Very close');
  assert.equal(proximityWords('nearby'), 'Nearby');
  assert.equal(proximityWords('on_campus'), 'On campus');
  assert.equal(proximityWords(null), null);
  assert.equal(proximityWords('120m'), null);
});

test('section query keeps only the filters that route accepts (unknown params are a 422)', () => {
  const f = { activity_type: 'run', sort: 'level', zone_id: 'library', type: 'zone_race' };
  assert.deepEqual(sectionQuery('nearby', f), { limit: 20, activity_type: 'run', zone_id: 'library' }); // level isn't a nearby sort
  assert.deepEqual(sectionQuery('active', f, 'c1'), { limit: 20, activity_type: 'run', sort: 'level', cursor: 'c1' });
  assert.deepEqual(sectionQuery('challenges', f), { limit: 20, zone_id: 'library', type: 'zone_race' });
  assert.deepEqual(sectionQuery('zones', { sort: 'contested' }), { limit: 20, sort: 'contested' });
  assert.deepEqual(sectionQuery('crews', f, null, 10), { limit: 10 });
  assert.equal(sectionAccepts('zones', 'activity_type'), false);
  assert.equal(sectionAccepts('nearby', 'zone_id'), true);
});

test('a further page is appended without repeating anyone', () => {
  const a = [{ id: '1' }, { id: '2' }];
  assert.deepEqual(appendPage(a, [{ id: '2' }, { id: '3' }], (x) => x.id).map((x) => x.id), ['1', '2', '3']);
});

test('zone choices: once each, by name', () => {
  assert.deepEqual(zoneChoices([{ id: 'b', name: 'Library' }, null, { id: 'a', name: 'Canteen' }, { id: 'b', name: 'Library' }]), [{ id: 'a', name: 'Canteen' }, { id: 'b', name: 'Library' }]);
});

test('every hidden reason is explained, with what fixes it', () => {
  assert.equal(hiddenInfo(null), null);
  assert.equal(hiddenInfo('open_to_meet_off').action, 'open_to_meet');
  assert.equal(hiddenInfo('location_unknown').action, 'bubble');
  assert.equal(hiddenInfo('not_in_bubble').action, 'bubble');
  assert.equal(hiddenInfo('blocks_unreachable').action, 'retry');
  assert.equal(hiddenInfo('crew_names_unavailable').action, 'retry');
  assert.equal(hiddenInfo('unavailable').action, 'retry');
  assert.equal(hiddenInfo('something_new').action, 'retry');
});

test('zone line: status, owner kind, popularity bucket, battle — no counts or owner names', () => {
  assert.equal(zoneLine({ zone: { id: 'z', name: 'Z' }, territory: { status: 'claimed', owner_type: 'crew' }, popularity: 'high', contested: true }), 'Held by a crew · Busy this week · Battle on');
  assert.equal(zoneLine({ zone: { id: 'z', name: 'Z' }, territory: { status: 'contested', owner_type: 'user' }, popularity: null, contested: true }), 'Contested');
  assert.equal(zoneLine({ zone: { id: 'z', name: 'Z' }, territory: { status: 'unclaimed', owner_type: 'none' }, popularity: 'low', contested: false }), 'Unclaimed · A few visitors this week');
});
