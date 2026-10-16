import assert from 'node:assert/strict';
import test from 'node:test';
import { applyBattleUpdate, battleHeadline, battleListFrom, battlesAtZone, battlesForCrew, orderedActions, startSlots } from './battles.ts';

const asha = { user_id: 'u1', display_name: 'Asha Rao', avatar_url: null };
const kabir = { user_id: 'u2', display_name: 'Kabir', avatar_url: null };
const owls = { id: 'c1', name: 'Night Owls', color: null, icon: 'run' };
let n = 0;
const battle = (over = {}) => ({
  id: `b${++n}`, type: 'territory', type_label: 'Territory duel', from: asha,
  target: { type: 'user', person: kabir }, zone: { id: 'library', name: 'Library' },
  starts_at: '2026-10-07T12:00:00Z', message: null, status: 'pending', direction: 'incoming',
  created_at: '2026-10-06T08:00:00Z', result: null, actions: ['accept', 'decline'], actions_status: 'ready',
  ...over,
});

test('zone battles: this zone only, battle types only, live first then three recent finished', () => {
  const list = [
    battle({ id: 'later', starts_at: '2026-10-09T12:00:00Z' }),
    battle({ id: 'soon', starts_at: '2026-10-07T06:00:00Z', status: 'accepted' }),
    battle({ id: 'elsewhere', zone: { id: 'mess', name: 'Mess' } }),
    battle({ id: 'group', type: 'group_activity' }),
    ...['d1', 'd2', 'd3', 'd4'].map((id, i) => battle({ id, status: 'completed', created_at: `2026-10-0${i + 1}T08:00:00Z` })),
  ];
  assert.deepEqual(battlesAtZone(list, 'library').map((b) => b.id), ['soon', 'later', 'd4', 'd3', 'd2']);
});

test('crew battles: those targeting the crew', () => {
  const war = battle({ id: 'war', type: 'weekend_war', zone: null, target: { type: 'crew', crew: owls } });
  const other = battle({ id: 'other', type: 'weekend_war', zone: null, target: { type: 'crew', crew: { ...owls, id: 'c2' } } });
  assert.deepEqual(battlesForCrew([war, other, battle()], 'c1').map((b) => b.id), ['war']);
});

test('buttons are exactly the server’s actions, in a fixed order', () => {
  assert.deepEqual(orderedActions(['decline', 'accept']), ['accept', 'decline']);
  assert.deepEqual(orderedActions(['cancel', 'schedule', 'start']), ['start', 'schedule', 'cancel']);
  assert.deepEqual(orderedActions([]), []);
  assert.deepEqual(orderedActions(undefined), []);
});

test('headlines', () => {
  assert.equal(battleHeadline(battle()), 'Asha Rao challenged you');
  assert.equal(battleHeadline(battle({ direction: 'outgoing' })), 'You challenged Kabir');
  assert.equal(battleHeadline(battle({ target: { type: 'crew', crew: owls } })), 'Asha Rao challenged Night Owls');
  assert.equal(battleHeadline(battle({ target: { type: 'crew', crew: { ...owls, name: '' } } })), 'Asha Rao challenged a crew');
});

test('start slots are at least 30 minutes ahead', () => {
  const now = new Date(2026, 9, 6, 17, 45); // a Tuesday, 5:45 PM local
  const slots = startSlots(now);
  assert.equal(slots[0].label, 'Tomorrow · 6:30 AM', '6 PM today is too close');
  assert.ok(slots.every((s) => s.at.getTime() > now.getTime() + 30 * 60_000));
  assert.equal(slots.at(-1).label, 'Sat · 7 AM');
});

test('battle list: crew battles missing only when the server says so', () => {
  const b = battle();
  assert.deepEqual(battleListFrom({ invites: [b] }), { invites: [b], crewBattlesUnavailable: false });
  assert.deepEqual(battleListFrom({ invites: [], crew_battles_unavailable: true }), { invites: [], crewBattlesUnavailable: true });
  assert.deepEqual(battleListFrom({ invites: [b], crew_battles_unavailable: false }).crewBattlesUnavailable, false);
});

test('a pushed battle replaces its old copy (with the actions it carries) or joins the list', () => {
  const a = battle({ id: 'a' });
  const b = battle({ id: 'b' });
  const list = { invites: [a, b], crewBattlesUnavailable: true };
  const accepted = { ...a, status: 'accepted', actions: ['start', 'cancel'] };
  const next = applyBattleUpdate(list, accepted);
  assert.deepEqual(next.invites.map((x) => [x.id, x.status, x.actions.join()]), [['a', 'accepted', 'start,cancel'], ['b', 'pending', 'accept,decline']]);
  assert.equal(next.crewBattlesUnavailable, true);
  assert.equal(list.invites[0], a); // the cached list isn't changed in place
  const fresh = battle({ id: 'c', direction: 'outgoing' });
  assert.deepEqual(applyBattleUpdate(next, fresh).invites.map((x) => x.id), ['c', 'a', 'b']);
});
