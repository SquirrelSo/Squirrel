import assert from 'node:assert/strict';
import test from 'node:test';
import { endpointAvailability, EndpointUnavailableError, gateEndpoints, isEndpointUnavailable, parseLiveEndpoints } from './availability.ts';

// A stand-in service: two unbuilt endpoints, two working ones, one that returns an empty list
// and one that fails for real — the same shape as the campus service.
const service = {
  heatmap: async () => ({ cells: [{ id: 'c1' }] }),
  saveDetails: async () => ({ ok: true }),
  zones: async () => [{ id: 'lhc' }],
  crews: async () => [],
  me: async () => {
    throw Object.assign(new Error('Unauthorized'), { status: 401 });
  },
  updateMe: async (patch) => ({ ok: true, patch }),
};
const rules = {
  heatmap: { capability: 'heatmap' },
  saveDetails: { capability: 'profileDetails' },
  updateMe: { capability: 'profileDetails', when: (p) => p.profile_details !== undefined },
};
const none = new Set();

test('an unbuilt endpoint rejects as unavailable — never fake data', async () => {
  const api = gateEndpoints(service, rules, none);
  await assert.rejects(api.heatmap(), (e) => e instanceof EndpointUnavailableError && e.capability === 'heatmap' && isEndpointUnavailable(e));
  await assert.rejects(api.saveDetails(), (e) => isEndpointUnavailable(e) && e.code === 'profileDetails_unavailable');
});

test('one unavailable endpoint does not take down the rest of the service', async () => {
  const api = gateEndpoints(service, rules, none);
  await assert.rejects(api.heatmap());
  assert.deepEqual(await api.zones(), [{ id: 'lhc' }]);
});

test('available + empty is not unavailable', async () => {
  const api = gateEndpoints(service, rules, none);
  const crews = await api.crews();
  assert.deepEqual(crews, []);
});

test('real errors stay real errors', async () => {
  const api = gateEndpoints(service, rules, none);
  await assert.rejects(api.me(), (e) => !isEndpointUnavailable(e) && e.status === 401);
});

test('field-level gate: PATCH /v1/me works, only profile_details is unavailable', async () => {
  const api = gateEndpoints(service, rules, none);
  assert.deepEqual((await api.updateMe({ connection_mode: 'friends' })).ok, true);
  await assert.rejects(api.updateMe({ profile_details: {} }), (e) => isEndpointUnavailable(e) && e.capability === 'profileDetails');
});

test('opting an endpoint in (backend shipped) passes calls through, per endpoint', async () => {
  const api = gateEndpoints(service, rules, parseLiveEndpoints('heatmap, nonsense'));
  assert.deepEqual(await api.heatmap(), { cells: [{ id: 'c1' }] });
  await assert.rejects(api.saveDetails(), (e) => isEndpointUnavailable(e));
  assert.equal(endpointAvailability('heatmap', parseLiveEndpoints('heatmap')).status, 'available');
  assert.equal(endpointAvailability('profileDetails', none).status, 'unavailable');
});

test('a Proxy service (the "off" campus API) keeps every method, gated or not', async () => {
  const off = new Proxy({}, { get: (_t, key) => () => Promise.reject(new Error(`off:${String(key)}`)) });
  const api = gateEndpoints(off, { heatmap: { capability: 'heatmap' } }, new Set());
  assert.equal(typeof api.config, 'function');
  await assert.rejects(api.config(), /off:config/);
  await assert.rejects(api.heatmap('24h'), (e) => isEndpointUnavailable(e));
});

test('meetupCheckIn: unavailable until opted in, reads as one thing ("isn’t live yet")', () => {
  const a = endpointAvailability('meetupCheckIn', none);
  assert.equal(a.status, 'unavailable');
  assert.equal(a.reason, 'Meetup check-in isn’t live yet');
  assert.equal(new EndpointUnavailableError('meetupCheckIn').message, 'Meetup check-in isn’t live yet');
  assert.equal(new EndpointUnavailableError('meetupRating').message, 'Meetup ratings aren’t live yet');
  assert.equal(endpointAvailability('meetupCheckIn', parseLiveEndpoints('meetupCheckIn')).status, 'available');
});
