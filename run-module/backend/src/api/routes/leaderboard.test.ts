import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import crypto from 'crypto';
import Fastify from 'fastify';
import { leaderboardRoutes } from './leaderboard.js';
import { requireAuth } from '../../auth/verify-jwt.js';
import { pool } from '../../db/pool.js';
import { redis } from '../../redis/client.js';
import { SignJWT } from 'jose';
import { JWT_SECRET } from '../../config/env.js';
import { dayKey, alltimeKey, weeklyTempKey } from '../../workers/leaderboard_sync/keys.js';

describe('GET /v1/leaderboard', () => {
  const fastify = Fastify();
  fastify.register(leaderboardRoutes, { prefix: '/v1/leaderboard' });
  const usersToClean: string[] = [];

  beforeAll(async () => {
    await fastify.ready();
    const keys = await redis.keys('lb:*'); if (keys.length > 0) await redis.del(...keys);
    await pool.query('DELETE FROM capture_events');
  });

  afterAll(async () => {
    await pool.end();
  });

  afterEach(async () => {
    if (usersToClean.length > 0) {
      const uids = [...usersToClean];
      await pool.query("DELETE FROM capture_events WHERE actor_id = ANY($1) OR previous_owner_id = ANY($1)", [uids]);
      usersToClean.length = 0;
    }
    const keys = await redis.keys('lb:*'); if (keys.length > 0) await redis.del(...keys);
  });

  async function getToken(userId: string) { return new SignJWT({ sub: userId }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode(JWT_SECRET)); }

  async function seedEvents(userId: string, areaDelta: number, occurredAt: Date) {
    usersToClean.push(userId);
    const eventId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO capture_events (id, territory_id, actor_id, event_type, area_delta_m2, occurred_at) VALUES ($1, $2, $3, 'claimed', $4, $5)",
      [eventId, crypto.randomUUID(), userId, areaDelta, occurredAt]
    );

    const dKey = dayKey(occurredAt);
    const aKey = alltimeKey();
    await redis.zincrby(dKey, areaDelta, userId);
    if (areaDelta > 0) await redis.zincrby(aKey, areaDelta, userId);
  }

  it('AC8, AC9, AC10: validations and empty', async () => {
    const token = await getToken(crypto.randomUUID());

    const noAuth = await fastify.inject({ method: 'GET', url: '/v1/leaderboard' });
    expect(noAuth.statusCode).toBe(401);
    console.log("AC9 No Auth: " + noAuth.statusCode);

    const invalidScope = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?scope=city', headers: { authorization: 'Bearer ' + token } });
    expect(invalidScope.statusCode).toBe(400);

    const invalidMetric = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?metric=distance', headers: { authorization: 'Bearer ' + token } });
    expect(invalidMetric.statusCode).toBe(400);

    const invalidWindow = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=monthly', headers: { authorization: 'Bearer ' + token } });
    expect(invalidWindow.statusCode).toBe(400);

    const empty = await fastify.inject({ method: 'GET', url: '/v1/leaderboard', headers: { authorization: 'Bearer ' + token } });
    expect(empty.statusCode).toBe(200);
    const body = empty.json();
    console.log("AC10 Empty Leaderboard: statusCode=" + empty.statusCode + ", entries=" + body.entries.length + ", me=" + body.me + ", total_ranked=" + body.total_ranked);
    expect(body.entries).toEqual([]);
    expect(body.me).toBeNull();
    expect(body.total_ranked).toBe(0);
  });

  it('AC1: SPEC CRITERION - THREE WINDOWS', async () => {
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);

    await seedEvents(u1, 100, now);
    await seedEvents(u2, 50, now);
    await seedEvents(u2, 200, yesterday);

    const token = await getToken(u1);

    const dailyReq = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily', headers: { authorization: 'Bearer ' + token } });
    const daily = dailyReq.json();
    console.log("AC1 Daily:", JSON.stringify(daily.entries));
    expect(daily.entries[0].user_id).toBe(u1);

    const weeklyReq = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=weekly', headers: { authorization: 'Bearer ' + token } });
    const weekly = weeklyReq.json();
    console.log("AC1 Weekly:", JSON.stringify(weekly.entries));
    expect(weekly.entries[0].user_id).toBe(u2);

    const alltimeReq = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=alltime', headers: { authorization: 'Bearer ' + token } });
    const alltime = alltimeReq.json();
    console.log("AC1 Alltime:", JSON.stringify(alltime.entries));
    expect(alltime.entries[0].user_id).toBe(u2);
  });

  it('AC2: SPEC CRITERION - TIE-BREAK', async () => {
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const now = new Date();
    
    await seedEvents(u1, 100, new Date(now.getTime() - 1000));
    await seedEvents(u2, 100, now);

    const token = await getToken(crypto.randomUUID());
    let req = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily', headers: { authorization: 'Bearer ' + token } });
    console.log("AC2 Order Before:", JSON.stringify(req.json().entries));
    expect(req.json().entries[0].user_id).toBe(u1);

    await pool.query("UPDATE capture_events SET occurred_at = $1 WHERE actor_id = $2", [new Date(now.getTime() - 2000), u2]);

    req = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily', headers: { authorization: 'Bearer ' + token } });
    console.log("AC2 Order After Swap:", JSON.stringify(req.json().entries));
    expect(req.json().entries[0].user_id).toBe(u2);
  });

  it('AC3: THREE-WAY TIE', async () => {
    const uA = crypto.randomUUID();
    const uB = crypto.randomUUID();
    const uC = crypto.randomUUID();
    const now = new Date();

    await seedEvents(uA, 50, new Date(now.getTime() - 1000));
    await seedEvents(uB, 50, now);
    await seedEvents(uC, 50, new Date(now.getTime() - 2000));

    const token = await getToken(crypto.randomUUID());
    const req = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily', headers: { authorization: 'Bearer ' + token } });
    console.log("AC3 Three-way Tie:", JSON.stringify(req.json().entries));
    
    expect(req.json().entries[0].user_id).toBe(uC);
    expect(req.json().entries[1].user_id).toBe(uA);
    expect(req.json().entries[2].user_id).toBe(uB);
  });

  it('AC4 & AC5 & AC6: PAGINATION AND ME', async () => {
    const now = new Date();
    const users: { id: string, score: number, time: number }[] = [];
    for (let i = 0; i < 50; i++) {
      users.push({ id: crypto.randomUUID(), score: 1000 - i, time: now.getTime() - i });
    }

    const dKey = dayKey(now);
    for (const u of users) {
      usersToClean.push(u.id);
      await pool.query(
        "INSERT INTO capture_events (id, territory_id, actor_id, event_type, area_delta_m2, occurred_at) VALUES ($1, $2, $3, 'claimed', $4, $5)",
        [crypto.randomUUID(), crypto.randomUUID(), u.id, u.score, new Date(u.time)]
      );
      await redis.zadd(dKey, u.score, u.id);
    }

    const u40 = users[39]!.id;
    const token = await getToken(u40);

    const emptyToken = await getToken(crypto.randomUUID());
    const emptyMeReq = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily', headers: { authorization: 'Bearer ' + emptyToken } });
    expect(emptyMeReq.json().me).toBeNull();

    const req40 = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily&limit=5', headers: { authorization: 'Bearer ' + token } });
    const b40 = req40.json();
    console.log('AC4 me.rank=' + b40.me.rank);
    expect(b40.me.rank).toBe(40);

    let cursor: string | undefined = undefined;
    let totalFetched = 0;
    const boundaries = [];
    
    for (let p = 0; p < 5; p++) {
      const q = (cursor as any) ? '&cursor=' + cursor : '';
      const reqP: any = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily&limit=10' + q, headers: { authorization: 'Bearer ' + token } });
      const bP: any = reqP.json();
      expect(bP.entries.length).toBe(10);
      expect(bP.entries[0].rank).toBe(p * 10 + 1);
      expect(bP.entries[9].rank).toBe(p * 10 + 10);
      boundaries.push('Page ' + (p+1) + ': rank ' + bP.entries[0].rank + ' to ' + bP.entries[9].rank);
      cursor = bP.next_cursor;
      totalFetched += bP.entries.length;
    }
    console.log("AC6 Boundaries:\n" + boundaries.join('\n'));
    expect(totalFetched).toBe(50);
  });

  it('AC7: NEGATIVE SCORE', async () => {
    const u1 = crypto.randomUUID();
    const u2 = crypto.randomUUID();
    const now = new Date();
    
    await seedEvents(u1, -500, now);
    await seedEvents(u2, 0, now);

    const token = await getToken(crypto.randomUUID());
    const req = await fastify.inject({ method: 'GET', url: '/v1/leaderboard?window=daily', headers: { authorization: 'Bearer ' + token } });
    const b = req.json();
    console.log("AC7 Negative Scores:", JSON.stringify(b.entries));
    
    expect(b.entries[0].user_id).toBe(u2);
    expect(b.entries[1].user_id).toBe(u1);
    expect(b.entries[1].score).toBe(-500);
  });
});



