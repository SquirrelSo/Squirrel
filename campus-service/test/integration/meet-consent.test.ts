import { describe, it, expect } from 'vitest';
import { HAS_DB, useTestApp, api, sql } from './setup.js';

const insertActivity = async (userId: string, status: 'VERIFIED' | 'PARTIALLY_VERIFIED' | 'PENDING') => {
  await sql(
    `INSERT INTO activities (user_id, activity_type, verification_status, started_at)
     VALUES ($1, 'walk', $2, now())`,
    [userId, status],
  );
};

describe.skipIf(!HAS_DB)('Open to Meet verified-activity consent gate (integration)', () => {
  useTestApp();

  it('a new account with no activity cannot turn Open to Meet on', async () => {
    const result = await api('PUT', '/v1/me/open-to-meet', 'meet_gate_new', { enabled: true });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('verified_activity_required');
    expect(result.body.detail).toBe('Record and verify a run or walk first to turn on Open to Meet.');
    expect((await sql(`SELECT open_to_meet FROM users WHERE id = $1`, ['meet_gate_new']))[0]?.open_to_meet).toBe(false);
  });

  it('one VERIFIED activity allows Open to Meet', async () => {
    await api('GET', '/v1/me', 'meet_gate_verified');
    await insertActivity('meet_gate_verified', 'VERIFIED');
    const result = await api('PUT', '/v1/me/open-to-meet', 'meet_gate_verified', { enabled: true });
    expect(result.status).toBe(200);
    expect(result.body.enabled).toBe(true);
  });

  it('PENDING and PARTIALLY_VERIFIED activities do not satisfy the fully verified requirement', async () => {
    await api('GET', '/v1/me', 'meet_gate_pending');
    await insertActivity('meet_gate_pending', 'PENDING');
    await insertActivity('meet_gate_pending', 'PARTIALLY_VERIFIED');
    const result = await api('PUT', '/v1/me/open-to-meet', 'meet_gate_pending', { enabled: true });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('verified_activity_required');
  });

  it('all Open to Meet aliases are gated; PATCH /v1/me cannot set consent, and onboarding does not change it', async () => {
    for (const [method, path] of [
      ['PATCH', '/v1/me/open-to-meet'],
      ['PATCH', '/v1/users/me/open-to-meet'],
    ] as const) {
      const result = await api(method, path, 'meet_gate_alias', { enabled: true });
      expect(result.status).toBe(409);
      expect(result.body.code).toBe('verified_activity_required');
    }

    const bypass = await api('PATCH', '/v1/me', 'meet_gate_alias', { open_to_meet: true });
    expect(bypass.status).toBe(422);
    const onboarding = await api('PATCH', '/v1/me', 'meet_gate_alias', { onboarding_completed: true });
    expect(onboarding.status).toBe(200);
    expect((await sql(`SELECT open_to_meet FROM users WHERE id = $1`, ['meet_gate_alias']))[0]?.open_to_meet).toBe(false);
  });

  it('turning Open to Meet off is always allowed without a verified activity', async () => {
    await api('GET', '/v1/me', 'meet_gate_off');
    await sql(`UPDATE users SET open_to_meet = true, open_to_meet_until = now() + interval '1 hour' WHERE id = $1`, ['meet_gate_off']);
    const result = await api('PUT', '/v1/me/open-to-meet', 'meet_gate_off', { enabled: false });
    expect(result.status).toBe(200);
    expect(result.body.enabled).toBe(false);
  });

  it('a previously enabled user is not switched off when a later enable request is refused', async () => {
    await api('GET', '/v1/me', 'meet_gate_existing');
    await sql(`UPDATE users SET open_to_meet = true, open_to_meet_until = now() + interval '1 hour' WHERE id = $1`, ['meet_gate_existing']);
    const result = await api('PUT', '/v1/me/open-to-meet', 'meet_gate_existing', { enabled: true });
    expect(result.status).toBe(409);
    expect((await sql(`SELECT open_to_meet FROM users WHERE id = $1`, ['meet_gate_existing']))[0]?.open_to_meet).toBe(true);
  });
});
