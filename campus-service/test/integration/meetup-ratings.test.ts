import { describe, it, expect, beforeEach } from 'vitest';
import { api, sql, active, app, randomUUID } from './setup.js';
import { configureSocialBridge, socialSettings } from '../../src/identity/index.js';
import { useTestApp } from './setup.js';

describe('meetup ratings (integration)', () => {
  useTestApp();
  const provision = async (...ids: string[]) => { for (const id of ids) await api('GET', '/v1/me', id); };

  beforeEach(async () => {
    configureSocialBridge(null); // tests below can test social when needed
  });

  async function createCompletedMeetup(host: string, guests: string[]): Promise<string> {
    const future = new Date(Date.now() + 3600000).toISOString(); // 1 hour future
    const m = await api('POST', '/v1/meetups', host, { place_text: 'Cafe', starts_at: future, invitee_ids: guests.length ? guests : undefined });
    expect(m.status).toBe(201);
    for (const g of guests) {
      await api('POST', `/v1/meetups/${m.body.id}/accept`, g);
    }
    // Now backdate it so it's completed
    const past = new Date(Date.now() - 3600000).toISOString();
    await sql(`UPDATE meetups SET starts_at = '${past}' WHERE id = '${m.body.id}'`);
    return m.body.id;
  }

  it('a participant can rate another participant after completion', async () => {
    await provision('mr_host_1');
    await provision('mr_guest_1');
    await provision('mr_guest_2');
    
    const meetupId = await createCompletedMeetup('mr_host_1', ['mr_guest_1', 'mr_guest_2']);
    
    const state = await api('GET', `/v1/meetups/${meetupId}/rating`, 'mr_host_1');
    expect(state.status).toBe(200);
    expect(state.body.can_rate).toBe(true);
    expect(state.body.already_rated).toBe(false);
    expect(state.body.rateable).toHaveLength(2); // both guests
    expect(state.body.dimensions.length).toBeGreaterThan(0);
    expect(state.body.trust_score).toBeNull(); // < 3 raters
    
    // Rater identity or individual rating is never returned in response.
    const res = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_1', {
      ratings: [
        { user_id: 'mr_guest_1', stars: 5, tags: ['friendly'] },
        { user_id: 'mr_guest_2', stars: 4, tags: ['punctual'] }
      ],
      idempotency_key: 'ik_1'
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ meetup_id: meetupId, submitted_at: expect.any(String), trust_score: null });
    expect(res.body.ratings).toBeUndefined(); // assert on the body (no rater identity or individual rating)
    expect(res.body.rater_id).toBeUndefined();
    
    // Check DB that ratings were inserted
    const dbRows = await sql(`SELECT stars, tags FROM meetup_ratings WHERE rater_id = 'mr_host_1'`);
    expect(dbRows.length).toBe(2);
  });

  it('a non-participant gets 404', async () => {
    await provision('mr_host_2');
    await provision('mr_guest_3');
    await provision('mr_rando');
    const meetupId = await createCompletedMeetup('mr_host_2', ['mr_guest_3']);
    
    const state = await api('GET', `/v1/meetups/${meetupId}/rating`, 'mr_rando');
    expect(state.status).toBe(404);
  });

  it('rating before completion is refused', async () => {
    await provision('mr_host_3');
    await provision('mr_guest_4');
    
    const future = new Date(Date.now() + 3600000).toISOString();
    const m = await api('POST', '/v1/meetups', 'mr_host_3', { place_text: 'Cafe', starts_at: future, invitee_ids: ['mr_guest_4'] });
    await api('POST', `/v1/meetups/${m.body.id}/accept`, 'mr_guest_4');
    
    const state = await api('GET', `/v1/meetups/${m.body.id}/rating`, 'mr_host_3');
    expect(state.status).toBe(200);
    expect(state.body.can_rate).toBe(false);
    expect(state.body.reason).toMatch(/has not ended/);
    
    const res = await api('POST', `/v1/meetups/${m.body.id}/ratings`, 'mr_host_3', {
      ratings: [{ user_id: 'mr_guest_4', stars: 4, tags: [] }],
      idempotency_key: 'ik_early'
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('meetup_not_completed');
  });

  it('rating yourself is refused', async () => {
    await provision('mr_host_4', 'mr_dummy');
    const meetupId = await createCompletedMeetup('mr_host_4', ['mr_dummy']);
    
    const res = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_4', {
      ratings: [{ user_id: 'mr_host_4', stars: 5, tags: [] }],
      idempotency_key: 'ik_self'
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('self_rating');
  });

  it('the same idempotency_key replays; a different key for an already-rated pair is rejected', async () => {
    await provision('mr_host_5');
    await provision('mr_guest_5');
    const meetupId = await createCompletedMeetup('mr_host_5', ['mr_guest_5']);
    
    const p1 = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_5', {
      ratings: [{ user_id: 'mr_guest_5', stars: 4, tags: [] }],
      idempotency_key: 'ik_replay'
    });
    expect(p1.status).toBe(200);
    
    const p2 = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_5', {
      ratings: [{ user_id: 'mr_guest_5', stars: 4, tags: [] }],
      idempotency_key: 'ik_replay'
    });
    expect(p2.status).toBe(200); // Replay succeeds
    
    const p3 = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_5', {
      ratings: [{ user_id: 'mr_guest_5', stars: 4, tags: [] }],
      idempotency_key: 'ik_different'
    });
    expect(p3.status).toBe(409);
    expect(p3.body.code).toBe('already_rated');
  });

  it('a blocked pair: absent from rateable[], and the rating refused', async () => {
    await provision('mr_host_6');
    await provision('mr_guest_6');
    const meetupId = await createCompletedMeetup('mr_host_6', ['mr_guest_6']);
    
    // Block locally
    await api('POST', `/v1/users/mr_guest_6/block`, 'mr_host_6');
    
    const state = await api('GET', `/v1/meetups/${meetupId}/rating`, 'mr_host_6');
    expect(state.body.rateable).toHaveLength(0); // Blocked guest hidden
    
    const res = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_6', {
      ratings: [{ user_id: 'mr_guest_6', stars: 4, tags: [] }],
      idempotency_key: 'ik_blocked'
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('meetup_blocked');
  });

  it('Social unreachable: fails closed, not open', async () => {
    await provision('mr_host_7');
    await provision('mr_guest_7');
    const meetupId = await createCompletedMeetup('mr_host_7', ['mr_guest_7']);
    
    // configure bad social bridge
    configureSocialBridge({ url: 'http://localhost:1', token: 'bad' });
    
    const state = await api('GET', `/v1/meetups/${meetupId}/rating`, 'mr_host_7');
    expect(state.status).toBe(503);
    expect(state.body.code).toBe('blocks_unreachable');
    
    const res = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_7', {
      ratings: [{ user_id: 'mr_guest_7', stars: 4, tags: [] }],
      idempotency_key: 'ik_social_down'
    });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('blocks_unreachable');
  });

  it('trust_score is null below the rater threshold', async () => {
    await provision('mr_target_1');
    await provision('mr_rater_1');
    await provision('mr_rater_2');
    
    const m1 = await createCompletedMeetup('mr_rater_1', ['mr_target_1']);
    const m2 = await createCompletedMeetup('mr_rater_2', ['mr_target_1']);
    
    // Rater 1 rates Target
    await api('POST', `/v1/meetups/${m1}/ratings`, 'mr_rater_1', { ratings: [{ user_id: 'mr_target_1', stars: 5, tags: [] }], idempotency_key: 'ts_1' });
    
    // Rater 2 rates Target
    const p2 = await api('POST', `/v1/meetups/${m2}/ratings`, 'mr_rater_2', { ratings: [{ user_id: 'mr_target_1', stars: 5, tags: [] }], idempotency_key: 'ts_2' });
    
    // We only have 2 raters rating target. Let's check target's state
    const targetState = await api('GET', `/v1/meetups/${m1}/rating`, 'mr_target_1');
    expect(targetState.body.trust_score).toBeNull();
  });

  it('trust_score is populated above the rater threshold', async () => {
    await provision('mr_target_2', 'mr_r_1', 'mr_r_2', 'mr_r_3');
    const m = await createCompletedMeetup('mr_target_2', ['mr_r_1', 'mr_r_2', 'mr_r_3']);
    
    await sql(`INSERT INTO meetup_ratings (meetup_id, rater_id, ratee_id, stars) VALUES 
      ('${m}', 'mr_r_1', 'mr_target_2', 5),
      ('${m}', 'mr_r_2', 'mr_target_2', 4),
      ('${m}', 'mr_r_3', 'mr_target_2', 5)`);
    
    const state = await api('GET', `/v1/meetups/${m}/rating`, 'mr_target_2');
    expect(state.body.trust_score).toMatchObject({ value: 4.7, label: 'Excellent' });
  });

  it('stars outside 1-5 are rejected by the API AND by the CHECK', async () => {
    await provision('mr_host_8');
    await provision('mr_guest_8');
    const meetupId = await createCompletedMeetup('mr_host_8', ['mr_guest_8']);
    
    const res = await api('POST', `/v1/meetups/${meetupId}/ratings`, 'mr_host_8', {
      ratings: [{ user_id: 'mr_guest_8', stars: 6, tags: [] }],
      idempotency_key: 'ik_bad_stars'
    });
    expect([400, 422]).toContain(res.status); // Zod validation fails first
    
    // Force direct DB insertion
    await expect(sql(`INSERT INTO meetup_ratings (meetup_id, rater_id, ratee_id, stars) VALUES ('${meetupId}', 'mr_host_8', 'mr_guest_8', 6)`)).rejects.toThrow(/meetup_ratings_stars_check/);
  });

  it('ratings are deleted with the user', async () => {
    await provision('mr_del_user');
    await provision('mr_del_target');
    const m = await createCompletedMeetup('mr_del_user', ['mr_del_target']);
    await api('POST', `/v1/meetups/${m}/ratings`, 'mr_del_user', { ratings: [{ user_id: 'mr_del_target', stars: 5, tags: [] }], idempotency_key: 'ik_del' });
    
    const before = await sql(`SELECT * FROM meetup_ratings WHERE rater_id = 'mr_del_user'`);
    expect(before.length).toBe(1);
    
    await sql(`DELETE FROM users WHERE id = 'mr_del_user'`);
    const after = await sql(`SELECT * FROM meetup_ratings WHERE rater_id = 'mr_del_user'`);
    expect(after.length).toBe(0);
  });
});
