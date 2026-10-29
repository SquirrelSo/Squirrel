/**
 * PD-2: profile_details retired from campus-service.
 * These tests replace the old profile-details.test.ts suite (10 tests removed — all
 * tested behaviour that was deliberately removed: saving, reading back, CGPA round-trip,
 * upsert, partial patch, invalid input 422, hostel rollback, non-campus email, privacy
 * guarantee, and cascade delete). That behaviour now lives in Exercise.
 *
 * This file tests what the contract NOW says:
 *   - GET /v1/me does not include profile_details
 *   - PATCH /v1/me with profile_details is rejected 422 with a pointer to Exercise
 *   - PATCH /v1/me without profile_details still works
 */
import { describe, expect, it } from 'vitest';
import { api, HAS_DB, useTestApp } from './setup.js';

describe.skipIf(!HAS_DB)('profile_details retired (integration)', () => {
  useTestApp();

  it('GET /v1/me does not return profile_details', async () => {
    const r = await api('GET', '/v1/me', 'u_pd_reader');
    expect(r.status).toBe(200);
    expect(r.body).not.toHaveProperty('profile_details');
  });

  it('PATCH /v1/me with profile_details is rejected 422 pointing at Exercise', async () => {
    const details = {
      full_name: 'Asha Rao', personal_email: 'asha@gmail.com', college_email: 'u_asha@iiserkol.ac.in',
      phone: '+919876543210', gender: 'female', age: 20, course: 'BS-MS', cgpa: 8.4,
    };
    const r = await api('PATCH', '/v1/me', 'u_pd_sender', { profile_details: details, bio: 'should not stick' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('invalid');
    expect(r.body.detail).toMatch(/Exercise/i);

    // The whole request is rejected — bio must NOT have been written either
    const me = await api('GET', '/v1/me', 'u_pd_sender');
    expect(me.body.bio).toBeNull();
  });

  it('PATCH /v1/me without profile_details still works', async () => {
    const r = await api('PATCH', '/v1/me', 'u_pd_patch', { bio: 'still works', onboarding_completed: true });
    expect(r.status).toBe(200);
    expect(r.body.bio).toBe('still works');
    expect(r.body.onboarding_completed).toBe(true);
    expect(r.body).not.toHaveProperty('profile_details');
  });
});
