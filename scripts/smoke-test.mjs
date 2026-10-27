/**
 * scripts/smoke-test.mjs
 *
 * Post-Deploy Smoke Test for Pre-Event Garba Readiness (28 Oct 2026).
 * Verifies live functionality across all 4 services:
 *   1. Exercise API - Auth Login (/api/auth/login)
 *   2. Campus Service - Config & Claim Shield (/v1/config)
 *   3. Campus Service - Bubble Nearby 20-Item Limit Clamp (/v1/bubble/nearby?limit=50)
 *   4. Campus Service - Zone Territory Status (/v1/zones/cc1)
 *   5. Run Module API - XP Ledger & Breakdown (/v1/users/me/xp)
 *   6. Social Service - In-App Notifications (/v1/notifications)
 *   7. Exercise API - Partner Hunt Gate Status & Access (/api/users/:id/partner-hunt)
 *
 * Usage:
 *   CAMPUS_SERVICE_URL=https://... \
 *   EXERCISE_API_URL=https://... \
 *   SOCIAL_API_URL=https://... \
 *   RUN_API_URL=https://... \
 *   SMOKE_EMAIL=tester@iiserkol.ac.in \
 *   SMOKE_PASSWORD=... \
 *   node scripts/smoke-test.mjs
 */

const CAMPUS_URL   = (process.env.CAMPUS_SERVICE_URL || process.env.CAMPUS_URL || '').trim();
const EXERCISE_URL = (process.env.EXERCISE_API_URL   || process.env.EXERCISE_URL   || '').trim();
const SOCIAL_URL   = (process.env.SOCIAL_API_URL     || process.env.SOCIAL_URL     || '').trim();
const RUN_URL      = (process.env.RUN_API_URL        || process.env.RUN_URL        || '').trim();

const TEST_EMAIL    = (process.env.SMOKE_EMAIL || '').trim();
const TEST_PASSWORD = (process.env.SMOKE_PASSWORD || '').trim();

function assert(condition, message) {
  if (!condition) {
    console.error(`\n❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
}

// Ensure all environment variables are provided with strictly NO default password
const missing = [];
if (!CAMPUS_URL) missing.push('CAMPUS_SERVICE_URL (or CAMPUS_URL)');
if (!EXERCISE_URL) missing.push('EXERCISE_API_URL (or EXERCISE_URL)');
if (!SOCIAL_URL) missing.push('SOCIAL_API_URL (or SOCIAL_URL)');
if (!RUN_URL) missing.push('RUN_API_URL (or RUN_URL)');
if (!TEST_EMAIL) missing.push('SMOKE_EMAIL');
if (!TEST_PASSWORD) missing.push('SMOKE_PASSWORD');

if (missing.length > 0) {
  console.error('❌ Missing required environment variable(s):\n  - ' + missing.join('\n  - '));
  console.error('\nAll service URLs, SMOKE_EMAIL, and SMOKE_PASSWORD must be explicitly provided via environment variables.');
  console.error('No default password is permitted.\n');
  process.exit(1);
}

const authHeader = (token) => ({
  'Authorization': `Bearer ${token}`,
  'Content-Type': 'application/json',
});

async function run() {
  console.log('================================================================');
  console.log('POST-DEPLOY SMOKE TEST: GARBA READINESS VERIFICATION');
  console.log('================================================================');
  console.log(`Campus Service : ${CAMPUS_URL}`);
  console.log(`Exercise API   : ${EXERCISE_URL}`);
  console.log(`Social API     : ${SOCIAL_URL}`);
  console.log(`Run Module API : ${RUN_URL}`);
  console.log(`Smoke User     : ${TEST_EMAIL}\n`);

  // 1. AUTH LOGIN (Exercise Backend)
  console.log('1. Checking Auth Login (POST /api/auth/login)...');
  const loginRes = await fetch(`${EXERCISE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD }),
  });
  if (!loginRes.ok) {
    const errText = await loginRes.text();
    console.error(`❌ Login failed: HTTP ${loginRes.status} - ${errText}`);
    process.exit(1);
  }
  const loginData = await loginRes.json();
  const token = loginData.access_token;
  const userId = loginData.user_id;
  assert(typeof token === 'string' && token.length > 0, 'No access_token returned from login');
  assert(typeof userId === 'string' && userId.length > 0, 'No user_id returned from login');
  console.log(`   ✓ Authenticated successfully as user "${userId}". Bearer token acquired.\n`);

  // 2. CAMPUS CONFIG & CLAIM SHIELD (Campus Service)
  console.log('2. Checking Campus Config & Claim Shield (GET /v1/config)...');
  const cfgRes = await fetch(`${CAMPUS_URL}/v1/config`);
  if (!cfgRes.ok) {
    const errText = await cfgRes.text();
    console.error(`❌ Config fetch failed: HTTP ${cfgRes.status} - ${errText}`);
    process.exit(1);
  }
  const cfg = await cfgRes.json();
  assert(cfg && cfg.rules, 'Config response missing "rules" object');
  assert(
    cfg.rules.claim_shield_hours === 2,
    `Claim shield misconfigured: expected 2 hours, got ${cfg.rules.claim_shield_hours}`
  );
  console.log(`   ✓ Config OK: claim_shield_hours = ${cfg.rules.claim_shield_hours} (2h protection verified)\n`);

  // 3. NEARBY USERS 20-ITEM LIMIT CLAMP (Campus Service)
  console.log('3. Checking Bubble Nearby 20-Item Limit Clamp (GET /v1/bubble/nearby?limit=50)...');
  const nearbyRes = await fetch(`${CAMPUS_URL}/v1/bubble/nearby?limit=50`, {
    headers: authHeader(token),
  });
  if (!nearbyRes.ok) {
    const errText = await nearbyRes.text();
    console.error(`❌ Bubble nearby failed: HTTP ${nearbyRes.status} - ${errText}`);
    process.exit(1);
  }
  const nearby = await nearbyRes.json();
  assert(nearby && Array.isArray(nearby.items), 'Bubble nearby response missing "items" array');
  assert(
    nearby.items.length <= 20,
    `Clamp failed: requested limit=50, but received ${nearby.items.length} items (expected <= 20)`
  );
  console.log(`   ✓ Limit Clamp OK: requested limit=50, received ${nearby.items.length} items (strictly <= 20)\n`);

  // 4. ZONE STATUS & TERRITORY DETAILS (Campus Service)
  console.log('4. Checking Zone Details (GET /v1/zones/cc1)...');
  const zoneRes = await fetch(`${CAMPUS_URL}/v1/zones/cc1`, {
    headers: authHeader(token),
  });
  if (!zoneRes.ok) {
    const errText = await zoneRes.text();
    console.error(`❌ Zone check failed: HTTP ${zoneRes.status} - ${errText}`);
    process.exit(1);
  }
  const zone = await zoneRes.json();
  assert(zone && (zone.id === 'cc1' || zone.zone?.id === 'cc1'), 'Invalid zone response for cc1');
  const territory = zone.territory || zone.zone?.territory;
  const ownerId = territory?.owner?.user_id || 'UNCLAIMED';
  const status = territory?.status || 'UNCLAIMED';
  console.log(`   ✓ Zone cc1 Verified: status=${status}, owner=${ownerId}\n`);

  // 5. XP LEDGER (Run Module Backend)
  console.log('5. Checking XP Ledger (GET /v1/users/me/xp)...');
  const xpRes = await fetch(`${RUN_URL}/v1/users/me/xp`, {
    headers: authHeader(token),
  });
  if (!xpRes.ok) {
    const errText = await xpRes.text();
    console.error(`❌ XP ledger fetch failed: HTTP ${xpRes.status} - ${errText}`);
    process.exit(1);
  }
  const xpData = await xpRes.json();
  assert(typeof xpData.xp === 'number', `Invalid XP response, expected numeric xp, got: ${JSON.stringify(xpData)}`);
  assert(Array.isArray(xpData.breakdown), 'XP response missing "breakdown" array');
  console.log(`   ✓ XP Ledger OK: Current User XP = ${xpData.xp} XP (${xpData.breakdown.length} line items)\n`);

  // 6. NOTIFICATIONS LIST (Social Backend)
  console.log('6. Checking Notifications (GET /v1/notifications)...');
  const notifRes = await fetch(`${SOCIAL_URL}/v1/notifications`, {
    headers: authHeader(token),
  });
  if (!notifRes.ok) {
    const errText = await notifRes.text();
    console.error(`❌ Notifications fetch failed: HTTP ${notifRes.status} - ${errText}`);
    process.exit(1);
  }
  const notifs = await notifRes.json();
  assert(Array.isArray(notifs.items), 'Notifications response missing "items" array');
  assert(typeof notifs.unread_count === 'number', 'Notifications response missing numeric "unread_count"');
  console.log(`   ✓ Notifications OK: ${notifs.items.length} items loaded (unread count: ${notifs.unread_count})\n`);

  // 7. PARTNER HUNT STATUS & ACCESS GATE (Exercise Backend)
  console.log('7. Checking Partner Hunt Gate (GET /api/users/:id/partner-hunt)...');
  const phRes = await fetch(`${EXERCISE_URL}/api/users/${userId}/partner-hunt`, {
    headers: authHeader(token),
  });
  if (!phRes.ok) {
    const errText = await phRes.text();
    console.error(`❌ Partner Hunt status fetch failed: HTTP ${phRes.status} - ${errText}`);
    process.exit(1);
  }
  const ph = await phRes.json();
  assert(typeof ph.unlocked === 'boolean', `Expected boolean 'unlocked' in Partner Hunt response, got: ${JSON.stringify(ph)}`);
  assert(ph.min_xp === 100, `Expected min_xp = 100, got: ${ph.min_xp}`);
  assert(ph.xp && typeof ph.xp.xp === 'number', `Expected numeric xp in Partner Hunt response, got: ${JSON.stringify(ph.xp)}`);
  assert(typeof ph.age_eligible === 'boolean', 'Expected boolean "age_eligible" in Partner Hunt response');
  assert(typeof ph.ready === 'boolean', 'Expected boolean "ready" in Partner Hunt response');
  assert(ph.options && Array.isArray(ph.options.activities), 'Expected vocabulary options in Partner Hunt response');

  const currentXp = ph.xp.xp;
  if (currentXp >= ph.min_xp) {
    assert(ph.unlocked === true, `Inconsistent gate: XP is ${currentXp} (>= ${ph.min_xp}) but unlocked is false`);
    console.log(`   ✓ Partner Hunt Gate Status: UNLOCKED (${currentXp} XP >= ${ph.min_xp} min XP)`);
  } else {
    assert(ph.unlocked === false, `Inconsistent gate: XP is ${currentXp} (< ${ph.min_xp}) but unlocked is true`);
    console.log(`   ✓ Partner Hunt Gate Status: LOCKED (${currentXp} XP < ${ph.min_xp} min XP)`);
  }

  // Also check the gated matches board endpoint
  const matchesRes = await fetch(`${EXERCISE_URL}/api/users/${userId}/partner-hunt/matches`, {
    headers: authHeader(token),
  });
  if (!ph.unlocked) {
    assert(
      matchesRes.status === 403,
      `Expected HTTP 403 (xp_locked) for locked user on /matches, got HTTP ${matchesRes.status}`
    );
    const errBody = await matchesRes.json();
    assert(
      errBody.detail?.code === 'xp_locked',
      `Expected error code 'xp_locked' on /matches, got: ${JSON.stringify(errBody)}`
    );
    console.log(`   ✓ Partner Hunt Matches Gate: Verified HTTP 403 (xp_locked correctly enforced)\n`);
  } else {
    assert(
      matchesRes.status === 200 || matchesRes.status === 409,
      `Expected HTTP 200 or 409 for unlocked user on /matches, got HTTP ${matchesRes.status}`
    );
    console.log(`   ✓ Partner Hunt Matches Gate: Verified access granted (HTTP ${matchesRes.status})\n`);
  }

  console.log('================================================================');
  console.log('✓ ALL 7 SMOKE TEST ENDPOINTS VERIFIED AND HEALTHY');
  console.log('================================================================');
}

run().catch((err) => {
  console.error('\n❌ Unexpected Smoke Test Error:', err);
  process.exit(1);
});
