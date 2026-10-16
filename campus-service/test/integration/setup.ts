import { beforeAll, afterAll } from 'vitest';
import { getPool, closePool, query } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { seedZones } from '../../src/seed/run.js';
import { buildApp } from '../../src/app.js';
import { mintDevToken } from '../../src/auth/dev-token.js';
import { verifyActivity } from '../../src/verification/worker.js';
import type { FastifyInstance } from 'fastify';
import type { Point } from '../../src/activities/gps.js';

export const HAS_DB = !!process.env.TEST_DATABASE_URL;

export let app: FastifyInstance;
const silent = { info() {}, warn() {}, error() {} };

export async function resetDb() {
  const pool = getPool();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  // The fixed placeholder map the tests are written against, never the committed OSM import
  // (which changes whenever someone re-imports). test/integration/seed-osm.test.ts covers that path.
  await seedZones({ source: 'placeholder' });
}

export type AwardBody = { subject: string; amount: number; reason: string; source: string; idempotency_key: string; source_id?: string; metadata?: Record<string, unknown> };
export let runFakeStats = { awards: 0, totals: 0, lastTotalSubjects: 0, awardBodies: [] as AwardBody[] };
export function resetRunFakeStats() { runFakeStats = { awards: 0, totals: 0, lastTotalSubjects: 0, awardBodies: [] }; }
export let runFakeState = { offline: false };

export function useTestApp() {
  let runFake: FastifyInstance;

  beforeAll(async () => {
    await resetDb();
    
    // Fake Run Module
    runFake = (await import('fastify')).default();
    runFake.post('/internal/v1/xp/award', async (req, res) => { 
      if (runFakeState.offline) return res.status(503).send({ error: 'offline' });
      runFakeStats.awards++;
      runFakeStats.awardBodies.push(req.body as AwardBody);
      return (req.body as any).amount + 1000; 
    }); 
    runFake.post('/internal/v1/xp/totals', async (req, res) => {
      if (runFakeState.offline) return res.status(503).send({ error: 'offline' });
      runFakeStats.totals++;
      const subs = (req.body as any).subjects as string[];
      runFakeStats.lastTotalSubjects = subs.length;
      const result: Record<string, number> = {};
      for (const s of subs) result[s] = 12000; // arbitrary cache refresh value
      return result;
    });
    const runUrl = await runFake.listen({ port: 0 });
    const { configureRunBridge } = await import('../../src/run/index.js');
    configureRunBridge({ url: runUrl, token: 'fake' });

    app = await buildApp({ logger: false });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await runFake.close();
    await closePool();
  });
}

export async function tokenFor(userId: string, name = userId) {
  return mintDevToken(userId, { name, email: `${userId}@iiserkol.ac.in` });
}

export async function api(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, userId: string | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (userId) headers.authorization = `Bearer ${await tokenFor(userId)}`;
  const res = await app.inject({ method, url, headers, payload: body as never });
  return { status: res.statusCode, body: res.json() as Record<string, unknown> & Record<string, never> };
}

/** Upload a full activity and run verification synchronously (the worker does the same thing asynchronously). */
export async function submitAndVerify(userId: string, points: Point[], type: 'run' | 'walk' = 'run') {
  const r = await api('POST', '/v1/activities', userId, { type, started_at: points[0]!.recorded_at, ended_at: points[points.length - 1]!.recorded_at, points });
  if (r.status !== 201) throw new Error(`submit failed: ${r.status} ${JSON.stringify(r.body)}`);
  const id = r.body.activity_id as string;
  await verifyActivity(id, silent);
  return id;
}

export async function sql<T extends Record<string, unknown> = Record<string, unknown>>(text: string, params: unknown[] = []) {
  return (await query<T>(text, params)).rows;
}
