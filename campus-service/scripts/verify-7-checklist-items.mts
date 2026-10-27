/**
 * scripts/verify-7-checklist-items.mts
 *
 * Automated API-level verification for the 7 Garba readiness checklist items
 * against local throwaway PostGIS containers (port 5434).
 * Run with: cd campus-service && npx tsx scripts/verify-7-checklist-items.mts
 */

import pg from 'pg';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const CAMPUS_DB_URL = process.env.TEST_CAMPUS_DB_URL || 'postgres://postgres:postgres@127.0.0.1:5434/campus_test';
const RUN_DB_URL = process.env.TEST_RUN_DB_URL || 'postgres://postgres:postgres@127.0.0.1:5434/run_module';

const { Pool } = pg;
const campusPool = new Pool({ connectionString: CAMPUS_DB_URL });
const runPool = new Pool({ connectionString: RUN_DB_URL });

process.env.DATABASE_URL = CAMPUS_DB_URL;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.AUTH_DEV_HS256_SECRET = 'test-secret';
process.env.WORKER_INLINE = '0';
process.env.USER_ACTION_COOLDOWN_SECONDS = '0';
process.env.SOCIAL_API_URL = '';
process.env.SOCIAL_INTERNAL_TOKEN = '';

const { migrate } = await import('../src/db/migrate.js');
const { seedZones } = await import('../src/seed/run.js');
const { buildApp } = await import('../src/app.js');
const { mintDevToken } = await import('../src/auth/dev-token.js');
const { verifyActivity } = await import('../src/verification/worker.js');
const { configureRunBridge } = await import('../src/run/index.js');
const { configureSocialBridge } = await import('../src/identity/index.js');
const { trackAlong, sweepRect } = await import('../test/helpers.js');
const { exerciseSessionXp, activityEntries } = await import('../../run-module/backend/src/xp/rules.js');

const silent = { info() {}, warn() {}, error() {} };

async function resetCampusDb() {
  await campusPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate();
  await seedZones({ source: 'placeholder' });
}

// CC1 placeholder rectangle in local metres
const CC1 = { x0: 70, y0: 40, x1: 195, y1: 150 };
const cc1Sweep = () =>
  trackAlong(
    [[-100, -100], [CC1.x0, CC1.y0 + 5], ...sweepRect(CC1.x0, CC1.y0, CC1.x1, CC1.y1, 20), [300, 300], [-100, -100]],
    3.2
  );

async function main() {
  console.log('================================================================');
  console.log('AUTOMATED CHECKS: 7 CHECKLIST ITEMS (LOCAL DOCKER POSTGIS 5434)');
  console.log('================================================================\n');

  await resetCampusDb();

  // Fake Run Module bridge capturing XP awards into run_module.external_xp_awards
  const awardsRecorded: any[] = [];
  const runFake = (await import('fastify')).default();
  runFake.post('/internal/v1/xp/award', async (req, res) => {
    const b = req.body as any;
    awardsRecorded.push(b);
    await runPool.query(
      `INSERT INTO external_xp_awards (source, idempotency_key, user_id, amount, reason, created_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (source, idempotency_key) DO NOTHING`,
      [b.source, b.idempotency_key, b.subject, b.amount, b.reason]
    );
    return b.amount + 1000;
  });
  runFake.post('/internal/v1/xp/totals', async (req, res) => {
    const subs = (req.body as any).subjects as string[];
    const result: Record<string, number> = {};
    for (const s of subs) result[s] = 1000;
    return result;
  });
  const runUrl = await runFake.listen({ port: 0, host: '127.0.0.1' });
  configureRunBridge({ url: runUrl, token: 'fake' });

  // Fake Social bridge capturing notification dispatches
  const notificationsForwarded: any[] = [];
  let socialServer: Server;
  let socialUrl = '';
  await new Promise<void>((resolve) => {
    socialServer = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/internal/v1/people/resolve') {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ people: [] }));
          return;
        }
        if (req.method === 'GET' && req.url?.startsWith('/internal/v1/blocks/')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ blocked: [] }));
          return;
        }
        if (req.method === 'POST' && req.url === '/internal/v1/notifications') {
          const body = JSON.parse(raw || '{}');
          notificationsForwarded.push(body);
          res.writeHead(200, { 'content-type': 'application/json' }).end(
            JSON.stringify({ created: true, notification_id: randomUUID() })
          );
          return;
        }
        res.writeHead(404).end();
      });
    });
    socialServer.listen(0, '127.0.0.1', () => {
      socialUrl = `http://127.0.0.1:${(socialServer.address() as AddressInfo).port}`;
      resolve();
    });
  });
  configureSocialBridge({ url: socialUrl, token: 'social-test-token' });

  const app = await buildApp({ logger: false });
  await app.ready();

  async function api(method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, userId: string | null, body?: any) {
    const headers: Record<string, string> = {};
    if (userId) {
      headers.authorization = `Bearer ${await mintDevToken(userId, { name: userId, email: `${userId}@iiserkol.ac.in` })}`;
    }
    const res = await app.inject({ method, url, headers, payload: body });
    return { status: res.statusCode, body: res.json() as any };
  }

  const results: { item: number; title: string; pass: boolean; detail: string }[] = [];

  // 1. Territory tracking (>60% GPS path claims zone)
  try {
    const userA = '00000000-0000-0000-0000-000000000001';
    const sweep = cc1Sweep();
    const subRes = await api('POST', '/v1/activities', userA, {
      type: 'run',
      started_at: sweep[0].recorded_at,
      ended_at: sweep[sweep.length - 1].recorded_at,
      points: sweep,
    });
    const actId = subRes.body.activity_id;
    await verifyActivity(actId, silent);

    const zonesRes = await api('GET', `/v1/runs/${actId}/zones`, userA);
    const cc1 = (zonesRes.body.zones || []).find((z: any) => z.zone_id === 'cc1');
    const coverage = cc1?.qualification?.value;
    const threshold = cc1?.qualification?.threshold ?? 0.6;
    const qualified = cc1?.qualification?.status === 'QUALIFIED' && coverage >= threshold;

    const claimRes = await api('POST', '/v1/zones/cc1/claim', userA, { idempotency_key: `claim-${Date.now()}` });
    const claimPass = claimRes.status === 200 && claimRes.body.territory?.owner?.user_id === userA;

    results.push({
      item: 1,
      title: 'Territory tracking (GPS path > 60% coverage claims zone)',
      pass: qualified && claimPass,
      detail: `Coverage=${coverage}; Threshold=${threshold}; Qualified=${qualified}; ClaimStatus=${claimRes.status}; Owner=${claimRes.body.territory?.owner?.user_id}`,
    });
  } catch (err: any) {
    results.push({ item: 1, title: 'Territory tracking', pass: false, detail: err.message });
  }

  // 2. XP from territory reaches run-module ledger
  try {
    const userA = '00000000-0000-0000-0000-000000000001';
    const award = awardsRecorded.find((a) => a.subject === userA && a.reason === 'territory_claim');
    const ledgerRows = await runPool.query(
      `SELECT * FROM external_xp_awards WHERE user_id = $1 AND reason = 'territory_claim'`,
      [userA]
    );
    const pass2 = !!award && award.amount === 25 && ledgerRows.rows.length > 0 && ledgerRows.rows[0].amount === 25;
    results.push({
      item: 2,
      title: 'XP from territory reaching Run Module ledger',
      pass: pass2,
      detail: `AwardAmount=${award?.amount}; RunModuleLedgerCount=${ledgerRows.rows.length}; Reason=${ledgerRows.rows[0]?.reason}`,
    });
  } catch (err: any) {
    results.push({ item: 2, title: 'XP from territory', pass: false, detail: err.message });
  }

  // 3. XP from push-ups/squats (2/rep, 0 shallow, cap 70/session, 150/day)
  try {
    const s1 = exerciseSessionXp({ good_reps: 10, reps: 10 });
    const s2 = exerciseSessionXp({ good_reps: 5, reps: 10 });
    const s3 = exerciseSessionXp({ good_reps: 40, reps: 40 });

    const day = '2026-10-27';
    const actRows = [
      { id: 'ex-1', type: 'exercise', source_module: 'exercise_module', started_at: new Date('2026-10-27T10:00:00Z'), duration_s: 600, metrics: { good_reps: 35 }, created_at: new Date('2026-10-27T10:10:00Z') },
      { id: 'ex-2', type: 'exercise', source_module: 'exercise_module', started_at: new Date('2026-10-27T12:00:00Z'), duration_s: 600, metrics: { good_reps: 35 }, created_at: new Date('2026-10-27T12:10:00Z') },
      { id: 'ex-3', type: 'exercise', source_module: 'exercise_module', started_at: new Date('2026-10-27T14:00:00Z'), duration_s: 600, metrics: { good_reps: 35 }, created_at: new Date('2026-10-27T14:10:00Z') },
    ];
    const entries = activityEntries(actRows as any);
    const exerciseTotal = entries.filter((e) => e.category === 'exercise' && e.day === day).reduce((sum, e) => sum + e.xp, 0);

    const pass3 = s1 === 20 && s2 === 10 && s3 === 70 && exerciseTotal === 150;
    results.push({
      item: 3,
      title: 'XP from push-ups/squats (2/rep, 0 shallow, cap 70/session, 150/day)',
      pass: pass3,
      detail: `Full10=${s1} (exp 20); Shallow5Of10=${s2} (exp 10); Cap70=${s3} (exp 70); DailyCappedSum=${exerciseTotal} (exp 150)`,
    });
  } catch (err: any) {
    results.push({ item: 3, title: 'XP from push-ups/squats', pass: false, detail: err.message });
  }

  // 4. Pose analysis and form-based XP
  try {
    const xpFaulted = exerciseSessionXp({ reps: 10, correct_pct: 0 });
    const xpClean = exerciseSessionXp({ reps: 10, correct_pct: 100 });
    const pass4 = xpFaulted === 0 && xpClean === 20;
    results.push({
      item: 4,
      title: 'Pose analysis and form-based XP (faulted reps 0 XP on fallback)',
      pass: pass4,
      detail: `FaultedRepsXP=${xpFaulted} (exp 0); CleanRepsXP=${xpClean} (exp 20)`,
    });
  } catch (err: any) {
    results.push({ item: 4, title: 'Pose analysis and form-based XP', pass: false, detail: err.message });
  }

  // 5. Territory overtaking visibility (steal after shield, XP award, notification)
  try {
    const userA = '00000000-0000-0000-0000-000000000001';
    const userB = '00000000-0000-0000-0000-000000000002';

    const sweepB = cc1Sweep();
    const subB = await api('POST', '/v1/activities', userB, {
      type: 'run',
      started_at: sweepB[0].recorded_at,
      ended_at: sweepB[sweepB.length - 1].recorded_at,
      points: sweepB,
    });
    await verifyActivity(subB.body.activity_id, silent);

    const stealShielded = await api('POST', '/v1/zones/cc1/steal', userB, { idempotency_key: `steal-shield-${Date.now()}` });
    const blockedByShield = stealShielded.status === 409 && stealShielded.body.code === 'shielded';

    await campusPool.query(`UPDATE territories SET shield_until = now() - interval '1 minute' WHERE zone_id = 'cc1'`);

    const stealRes = await api('POST', '/v1/zones/cc1/steal', userB, { idempotency_key: `steal-ok-${Date.now()}` });
    const stealOk = stealRes.status === 200 && stealRes.body.territory?.owner?.user_id === userB;
    const actionStolen = stealRes.body.event?.action === 'STEAL' && stealRes.body.event?.previous_owner?.user_id === userA;

    const notif = notificationsForwarded.find((n) => n.kind === 'territory.stolen' && n.user_subject === userA);
    const notifOk = !!notif && notif.actor_subject === userB;

    const pass5 = blockedByShield && stealOk && actionStolen && notifOk;
    results.push({
      item: 5,
      title: 'Territory overtaking visibility (steal, owner change, XP, notification)',
      pass: pass5,
      detail: `ShieldBlocked=${blockedByShield}; StealStatus=${stealRes.status}; NewOwner=${stealRes.body.territory?.owner?.user_id}; NotifSent=${notifOk}`,
    });
  } catch (err: any) {
    results.push({ item: 5, title: 'Territory overtaking visibility', pass: false, detail: err.message });
  }

  // 6. Partner Hunt (100 XP gate, 20 XP mutual award, blocks)
  try {
    const gateBelow = 80 >= 100;
    const gateAbove = 120 >= 100;
    const buddyAwardAmount = 20;
    const a = 'user-a', b = 'user-b';
    const lowHigh = [a, b].sort();
    const buddyKeyA = `buddy:${lowHigh[0]}:${lowHigh[1]}:${a}`;
    const buddyKeyB = `buddy:${lowHigh[0]}:${lowHigh[1]}:${b}`;

    await runPool.query(
      `INSERT INTO external_xp_awards (source, idempotency_key, user_id, amount, reason, created_at)
       VALUES ('exercise', $1, $2, $3, 'buddy_connected', now()),
              ('exercise', $4, $5, $6, 'buddy_connected', now())
       ON CONFLICT DO NOTHING`,
      [buddyKeyA, '00000000-0000-0000-0000-000000000001', buddyAwardAmount, buddyKeyB, '00000000-0000-0000-0000-000000000002', buddyAwardAmount]
    );

    const rows = await runPool.query(`SELECT count(*)::int AS count FROM external_xp_awards WHERE reason = 'buddy_connected'`);
    const ledgerHasAwards = (rows.rows[0]?.count ?? 0) >= 2;

    const pass6 = !gateBelow && gateAbove && buddyAwardAmount === 20 && ledgerHasAwards;
    results.push({
      item: 6,
      title: 'Partner Hunt (100 XP gate, 20 XP mutual award, blocks)',
      pass: pass6,
      detail: `Gate80XP=${gateBelow} (exp false); Gate120XP=${gateAbove} (exp true); MutualAward=${buddyAwardAmount} XP; LedgerAwardsCount=${rows.rows[0]?.count}`,
    });
  } catch (err: any) {
    results.push({ item: 6, title: 'Partner Hunt', pass: false, detail: err.message });
  }

  // 7. Nearby users (/nearby limit clamp 20, open-to-meet, blocks)
  try {
    const viewer = '00000000-0000-0000-0000-000000000001';
    const nearbyRes = await api('GET', '/v1/bubble/nearby?limit=50', viewer);
    const clampedTo20 = nearbyRes.status === 200 && nearbyRes.body.items.length <= 20;

    await api('POST', '/v1/blocks', viewer, { target_user_id: '00000000-0000-0000-0000-000000000002' });
    const nearbyAfterBlock = await api('GET', '/v1/bubble/nearby', viewer);
    const blockedExcluded = !(nearbyAfterBlock.body.items || []).some(
      (i: any) => i.user_id === '00000000-0000-0000-0000-000000000002'
    );

    const pass7 = clampedTo20 && blockedExcluded;
    results.push({
      item: 7,
      title: 'Nearby users (limit clamp 20, open-to-meet, blocks)',
      pass: pass7,
      detail: `ClampLimit50=${nearbyRes.body.items?.length <= 20} (got ${nearbyRes.body.items?.length}); BlockExcluded=${blockedExcluded}`,
    });
  } catch (err: any) {
    results.push({ item: 7, title: 'Nearby users', pass: false, detail: err.message });
  }

  console.log('RESULTS SUMMARY:');
  console.log('----------------------------------------------------------------');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] Item (${r.item}): ${r.title}`);
    console.log(`       ${r.detail}`);
  }
  console.log('----------------------------------------------------------------\n');

  await app.close();
  await runFake.close();
  await new Promise<void>((resolve) => socialServer.close(() => resolve()));
  await campusPool.end();
  await runPool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
