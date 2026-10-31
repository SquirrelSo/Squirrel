import assert from 'node:assert/strict';
import test from 'node:test';
import { inviteCandidates, meetupActions, meetupOpen } from './meetups.ts';

const p = (id, name = id) => ({ user_id: id, display_name: name, avatar_url: null, hostel: null });
const meetup = (over = {}) => ({ id: 'm1', title: 'Meetup', starts_at: '2026-10-07T12:00:00Z', location: { name: 'Library', zone_id: 'library' }, event_id: null, attendees: [], my_check_in_at: null, check_in_opens_at: '', check_in_closes_at: '', status: 'proposed', my_role: 'guest', my_rsvp: 'invited', ...over });

test('actions follow campus-service: host cancels; invited accept/decline; going leaves; declined can accept again', () => {
  assert.deepEqual(meetupActions(meetup({ my_role: 'host', my_rsvp: 'accepted' })), ['cancel']);
  assert.deepEqual(meetupActions(meetup()), ['accept', 'decline']);
  assert.deepEqual(meetupActions(meetup({ my_rsvp: 'accepted', status: 'confirmed' })), ['leave']);
  assert.deepEqual(meetupActions(meetup({ my_rsvp: 'declined' })), ['accept']);
});

test('nothing to do once it is cancelled or over, or when you are not in it', () => {
  assert.deepEqual(meetupActions(meetup({ status: 'cancelled' })), []);
  assert.deepEqual(meetupActions(meetup({ status: 'completed', my_role: 'host' })), []);
  assert.deepEqual(meetupActions(meetup({ my_role: null, my_rsvp: null })), []);
  assert.equal(meetupOpen(meetup({ status: 'confirmed' })), true);
});

test('invitees: once each, never you, with every reason they are there', () => {
  const list = inviteCandidates({
    shared: [{ person: p('a', 'Asha'), shared_zones_count: 3 }, { person: p('me'), shared_zones_count: 1 }, { person: p('k', 'Kabir'), shared_zones_count: 1 }],
    nearby: [p('k', 'Kabir'), p('r', 'Ravi')],
    crews: [{ name: 'Night Owls', members: [p('me'), p('a', 'Asha'), p('z', 'Zoya')] }],
  }, 'me');
  assert.deepEqual(list.map((c) => c.person.user_id), ['a', 'k', 'r', 'z']);
  assert.deepEqual(list[0].why, ['3 shared zones', 'Night Owls']);
  assert.deepEqual(list[1].why, ['1 shared zone', 'Nearby']);
  assert.deepEqual(list[1].sources, ['shared', 'nearby']);
  assert.deepEqual(inviteCandidates({}, 'me'), []);
});
