import { describe, expect, it } from 'vitest';
import { isBlockedEitherWay } from '../../src/blocks/service.js';
import { api, app, HAS_DB, sql, tokenFor, useTestApp } from './setup.js';

async function deleteBlock(blocker: string, blocked: string) {
  const res = await app.inject({ method: 'DELETE', url: `/v1/users/${blocked}/block`, headers: { authorization: `Bearer ${await tokenFor(blocker)}` } });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

describe.skipIf(!HAS_DB)('blocks (integration)', () => {
  useTestApp();

  it('blocking is idempotent', async () => {
    await api('GET', '/v1/me', 'u_blocker');
    await api('GET', '/v1/me', 'u_blocked');
    expect((await api('POST', '/v1/users/u_blocked/block', 'u_blocker')).status).toBe(200);
    expect((await api('POST', '/v1/users/u_blocked/block', 'u_blocker')).status).toBe(200);
    expect(await sql(`SELECT blocker_id FROM blocks WHERE blocker_id = 'u_blocker' AND blocked_id = 'u_blocked'`)).toHaveLength(1);
    expect((await api('GET', '/v1/me/blocks', 'u_blocker')).body.blocks).toHaveLength(1);
  });

  it('unblocking is idempotent', async () => {
    await api('GET', '/v1/me', 'u_blocker');
    await api('GET', '/v1/me', 'u_blocked');
    expect((await deleteBlock('u_blocker', 'u_blocked')).status).toBe(200);
    await api('POST', '/v1/users/u_blocked/block', 'u_blocker');
    expect((await deleteBlock('u_blocker', 'u_blocked')).status).toBe(200);
    expect((await deleteBlock('u_blocker', 'u_blocked')).status).toBe(200);
    expect(await sql(`SELECT blocker_id FROM blocks WHERE blocker_id = 'u_blocker' AND blocked_id = 'u_blocked'`)).toHaveLength(0);
  });

  it('rejects self-blocking', async () => {
    expect((await api('POST', '/v1/users/u_self/block', 'u_self')).status).toBe(422);
    expect(await sql(`SELECT blocker_id FROM blocks WHERE blocker_id = 'u_self' OR blocked_id = 'u_self'`)).toHaveLength(0);
  });

  it('isBlockedEitherWay is symmetric', async () => {
    await api('GET', '/v1/me', 'u_a');
    await api('GET', '/v1/me', 'u_b');
    await api('POST', '/v1/users/u_b/block', 'u_a');
    expect(await isBlockedEitherWay('u_a', 'u_b')).toBe(true);
    expect(await isBlockedEitherWay('u_b', 'u_a')).toBe(true);
    expect(await isBlockedEitherWay('u_a', 'u_missing')).toBe(false);
  });
});
