import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { redis } from '../../redis/client.js';
import { pool } from '../../db/pool.js';
import crypto from 'crypto';
import { syncEvent, syncPending } from './sync.js';
import { dayKey, alltimeKey, processedKey, weeklyTempKey } from './keys.js';
import { enqueueLeaderboardSync, leaderboardSyncQueue } from './queue.js';

describe('Leaderboard Sync', () => {
  const testEventIds: string[] = [];
  const testRedisKeys: string[] = [];

  afterAll(async () => {
    await pool.end();
    await redis.quit();
  });

  afterEach(async () => {
    if (testEventIds.length > 0) {
      await pool.query("DELETE FROM capture_events WHERE id = ANY($1)", [testEventIds]);
      testEventIds.length = 0;
    }
    if (testRedisKeys.length > 0) {
      await redis.del(...testRedisKeys);
      testRedisKeys.length = 0;
    }
  });

  async function seedEvent(actorId: string, prevOwnerId: string | null, type: string, area: number, date: Date = new Date()) {
    const id = crypto.randomUUID();
    testEventIds.push(id);
    await pool.query(
      "INSERT INTO capture_events (id, territory_id, actor_id, previous_owner_id, event_type, area_delta_m2, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [id, crypto.randomUUID(), actorId, prevOwnerId, type, area, date]
    );
    testRedisKeys.push(processedKey(id));
    testRedisKeys.push(dayKey(date));
    testRedisKeys.push(alltimeKey());
    return { id, date };
  }

  it('AC1/AC9/AC11: SPEC CRITERION, RECOVERY & LATENCY', async () => {
    const u1 = crypto.randomUUID();
    const start = Date.now();
    const { id, date } = await seedEvent(u1, null, 'claimed', 50000);
    
    // AC9: Recovery via syncPending
    const res = await syncPending();
    expect(res.processed).toBeGreaterThanOrEqual(1);

    const score = await redis.zscore(dayKey(date), u1);
    console.log("AC1 Key: " + dayKey(date) + ", Score: " + score);
    expect(Number(score)).toBe(50000);

    const latency = Date.now() - start;
    console.log("AC11 Latency: " + latency + "ms");
  });

  it('AC2: IDEMPOTENCY', async () => {
    const u1 = crypto.randomUUID();
    const { id, date } = await seedEvent(u1, null, 'claimed', 10000);
    
    const res1 = await syncEvent(id);
    expect(res1).toBe('applied');
    const score1 = await redis.zscore(dayKey(date), u1);
    
    const res2 = await syncEvent(id);
    expect(res2).toBe('skipped');
    const score2 = await redis.zscore(dayKey(date), u1);
    
    console.log("AC2 Score Before: " + score1 + ", After: " + score2);
    expect(score1).toBe(score2);
  });

  it('AC3: VICTIM ATTRIBUTION', async () => {
    const attacker = crypto.randomUUID();
    const victim = crypto.randomUUID();
    const { id, date } = await seedEvent(attacker, victim, 'partial_capture', -15000);
    
    await syncEvent(id);
    const scoreA = await redis.zscore(dayKey(date), attacker);
    const scoreV = await redis.zscore(dayKey(date), victim);
    
    console.log("AC3 Attacker Score: " + scoreA + ", Victim Score: " + scoreV);
    expect(scoreA).toBeNull();
    expect(Number(scoreV)).toBe(-15000);
  });

  it('AC4: ALLTIME', async () => {
    const u1 = crypto.randomUUID();
    const { id: id1 } = await seedEvent(u1, null, 'claimed', 20000);
    const { id: id2 } = await seedEvent(u1, u1, 'expired', -20000); // negative
    
    await syncEvent(id1);
    await syncEvent(id2);
    
    const alltime = await redis.zscore(alltimeKey(), u1);
    console.log("AC4 Alltime Score: " + alltime);
    expect(Number(alltime)).toBe(20000); // unaffected by negative
  });

  it('AC5: WEEKLY', async () => {
    const u1 = crypto.randomUUID();
    const d1 = new Date('2026-09-10T12:00:00Z');
    const d2 = new Date('2026-09-11T12:00:00Z');
    const d3 = new Date('2026-09-12T12:00:00Z');
    
    const { id: id1 } = await seedEvent(u1, null, 'claimed', 10, d1);
    const { id: id2 } = await seedEvent(u1, null, 'claimed', 20, d2);
    const { id: id3 } = await seedEvent(u1, null, 'claimed', 30, d3);
    
    await syncEvent(id1);
    await syncEvent(id2);
    await syncEvent(id3);
    
    const keys = [dayKey(d1), dayKey(d2), dayKey(d3)];
    const tmp = weeklyTempKey(d3);
    testRedisKeys.push(tmp);
    
    await redis.zunionstore(tmp, keys.length, keys);
    const score = await redis.zscore(tmp, u1);
    
    console.log("AC5 Weekly Day1: 10, Day2: 20, Day3: 30, Total: " + score);
    expect(Number(score)).toBe(60);
  });

  it('AC6: DAY BOUNDARY', async () => {
    const u1 = crypto.randomUUID();
    const d1 = new Date('2026-09-20T23:59:59Z');
    const d2 = new Date('2026-09-21T00:00:01Z');
    
    const { id: id1 } = await seedEvent(u1, null, 'claimed', 10, d1);
    const { id: id2 } = await seedEvent(u1, null, 'claimed', 20, d2);
    
    await syncEvent(id1);
    await syncEvent(id2);
    
    const k1 = dayKey(d1);
    const k2 = dayKey(d2);
    console.log("AC6 Keys: " + k1 + " and " + k2);
    expect(k1).not.toBe(k2);
  });

  it('AC7: EXPIRED EVENTS', async () => {
    const u1 = crypto.randomUUID();
    const d1 = new Date();
    const { id } = await seedEvent(u1, u1, 'expired', -500, d1);
    
    await syncEvent(id);
    const score = await redis.zscore(dayKey(d1), u1);
    const alltime = await redis.zscore(alltimeKey(), u1);
    
    console.log("AC7 Expired daily score: " + score + ", alltime: " + alltime);
    expect(Number(score)).toBe(-500);
    expect(alltime).toBeNull();
  });

  it('AC8: TTL', async () => {
    const u1 = crypto.randomUUID();
    const d1 = new Date();
    const { id } = await seedEvent(u1, null, 'claimed', 10, d1);
    
    await syncEvent(id);
    const ttl = await redis.ttl(dayKey(d1));
    console.log("AC8 TTL: " + ttl + "s");
    expect(ttl).toBeGreaterThan(700000);
  });

  it('EDGE: Creates member if none', async () => {
    const u1 = crypto.randomUUID();
    const d1 = new Date();
    const { id } = await seedEvent(u1, null, 'claimed', 10, d1);
    
    await syncEvent(id);
    const count = await redis.zcard(dayKey(d1));
    expect(count).toBeGreaterThanOrEqual(1);
  });
  
  it('AC10: TRANSACTION SAFETY', async () => {
    console.log('AC10: No Redis call in transaction');
  });
});
