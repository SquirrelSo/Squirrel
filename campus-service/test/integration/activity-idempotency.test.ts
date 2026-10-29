import { describe, it, expect, beforeEach } from 'vitest';
import { HAS_DB, useTestApp, api, sql } from './setup.js';

describe.skipIf(!HAS_DB)('activity creation idempotency (integration)', () => {
  useTestApp();

  const user = 'u_idem_test';

  beforeEach(async () => {
    await sql('DELETE FROM idempotency_keys WHERE user_id = $1', [user]);
    await sql('DELETE FROM activities WHERE user_id = $1', [user]);
  });

  it('first call creates activity and saves idempotency row', async () => {
    const startedAt = new Date().toISOString();
    const idemKey = 'key-first-call-123';
    const r = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt,
      idempotency_key: idemKey,
    });

    expect(r.status).toBe(201);
    expect(r.body).toHaveProperty('activity_id');
    expect(r.body.run_id).toBe(r.body.activity_id);

    const rows = await sql<{ id: string }>('SELECT id FROM activities WHERE user_id = $1', [user]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(r.body.activity_id);

    const saved = await sql<{ key: string; scope: string; status_code: number }>(
      'SELECT key, scope, status_code FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [user, idemKey]
    );
    expect(saved).toHaveLength(1);
    expect(saved[0]!.scope).toBe('activity:create');
    expect(saved[0]!.status_code).toBe(201);
  });

  it('replay returns identical status code and payload without duplicate activity', async () => {
    const startedAt = new Date().toISOString();
    const idemKey = 'key-replay-456';
    const r1 = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt,
      idempotency_key: idemKey,
    });
    expect(r1.status).toBe(201);

    // Second call with same idempotency_key
    const r2 = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt,
      idempotency_key: idemKey,
    });

    expect(r2.status).toBe(201);
    expect(r2.body).toEqual(r1.body);

    const rows = await sql('SELECT id FROM activities WHERE user_id = $1', [user]);
    expect(rows).toHaveLength(1);
  });

  it('concurrent duplicates serialize and create exactly one activity row', async () => {
    const startedAt = new Date().toISOString();
    const idemKey = 'key-concurrent-789';

    const [r1, r2] = await Promise.all([
      api('POST', '/v1/activities', user, {
        type: 'run',
        started_at: startedAt,
        idempotency_key: idemKey,
      }),
      api('POST', '/v1/activities', user, {
        type: 'run',
        started_at: startedAt,
        idempotency_key: idemKey,
      }),
    ]);

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.activity_id).toBe(r2.body.activity_id);
    expect(r1.body).toEqual(r2.body);

    const rows = await sql('SELECT id FROM activities WHERE user_id = $1', [user]);
    expect(rows).toHaveLength(1);
  });

  it('missing key creates separate activities (backward-compatible with older APKs)', async () => {
    const startedAt1 = new Date(Date.now() - 60_000).toISOString();
    const startedAt2 = new Date().toISOString();

    const r1 = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt1,
    });
    const r2 = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt2,
    });

    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(r1.body.activity_id).not.toBe(r2.body.activity_id);

    const rows = await sql('SELECT id FROM activities WHERE user_id = $1', [user]);
    expect(rows).toHaveLength(2);
  });

  it('respects scope: does not replay row matching key but different scope', async () => {
    const startedAt = new Date().toISOString();
    const idemKey = 'shared-key-different-scope';

    // Insert an existing row under a different scope (e.g. territory:action)
    await sql(
      `INSERT INTO idempotency_keys (user_id, key, scope, status_code, response) VALUES ($1, $2, $3, 200, $4)`,
      [user, idemKey, 'territory:action', { fake_territory: true }]
    );

    const r = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt,
      idempotency_key: idemKey,
    });

    expect(r.status).toBe(201);
    expect(r.body).toHaveProperty('activity_id');
    expect(r.body).not.toHaveProperty('fake_territory');
  });

  it('points batch keys and activity keys live in separate tables without collision', async () => {
    const startedAt = new Date().toISOString();
    const sharedKey = 'common-batch-activity-key';

    // 1. Create activity with sharedKey
    const r1 = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt,
      idempotency_key: sharedKey,
    });
    expect(r1.status).toBe(201);
    const activityId = r1.body.activity_id;

    // 2. Add points batch with the exact same idempotency_key
    const r2 = await api('POST', `/v1/activities/${activityId}/points`, user, {
      idempotency_key: sharedKey,
      points: [{ lat: 22.963, lng: 88.524, recorded_at: startedAt, accuracy_m: 5 }],
    });
    expect(r2.status).toBe(200);

    // Verify activity_point_batches holds the key
    const batchRows = await sql(
      'SELECT idempotency_key FROM activity_point_batches WHERE activity_id = $1 AND idempotency_key = $2',
      [activityId, sharedKey]
    );
    expect(batchRows).toHaveLength(1);

    // 3. Replaying the activity create with sharedKey returns the activity response, unaffected by the batch
    const r3 = await api('POST', '/v1/activities', user, {
      type: 'run',
      started_at: startedAt,
      idempotency_key: sharedKey,
    });
    expect(r3.status).toBe(201);
    expect(r3.body.activity_id).toBe(activityId);
  });
});
