/**
 * All configuration comes from the environment. Game-rule numbers live here so that they are
 * tunable without a deploy of new code, and so tests can override them.
 */
const num = (k: string, d: number) => {
  const v = process.env[k];
  const n = v === undefined || v === '' ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const str = (k: string, d = '') => process.env[k] ?? d;
const bool = (k: string, d: boolean) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v === '1' || v === 'true';
};

export const config = {
  env: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV', 'development') === 'production',
  port: num('PORT', 8080),
  host: str('HOST', '0.0.0.0'),
  logLevel: str('LOG_LEVEL', 'info'),
  corsOrigins: str('CORS_ORIGINS').split(',').map((s) => s.trim()).filter(Boolean),

  databaseUrl: str('DATABASE_URL', 'postgres://campus:campus@localhost:5432/campus'),
  databasePoolMax: num('DATABASE_POOL_MAX', 10),

  // Start-up tasks run by `node dist/index.js` before the API listens (single-service deploys, e.g. Render).
  startup: {
    migrateOnStart: bool('MIGRATE_ON_START', false),   // apply migrations/*.sql (each once) before listening
    seedZonesOnStart: bool('SEED_ZONES_ON_START', false), // upsert hostels + placeholder zones only (never dev users)
  },

  // Identity bridge to the Social service. OFF unless BOTH are set: then every user id sent to clients is the
  // Social profile id and names/avatars come from Social (src/identity/). OFF = ids are JWT subs, as before.
  social: {
    apiUrl: str('SOCIAL_API_URL').trim().replace(/\/+$/, ''),
    internalToken: str('SOCIAL_INTERNAL_TOKEN').trim(),
    timeoutMs: num('SOCIAL_TIMEOUT_MS', 3000),
    cacheTtlSeconds: num('SOCIAL_CACHE_TTL_SECONDS', 300),
  },

  // ADR-032 / WI-07: blocks are Social's. Until the one-time import (social-backend/scripts/import_blocks.py)
  // has copied campus's legacy `blocks` rows into Social, those rows are unioned with Social's answer. Set
  // LEGACY_LOCAL_BLOCKS=0 right after the import: then only Social decides, so an unblock in the app
  // (which writes Social) is never overridden by a stale local row, and the local block routes answer 410.
  blocks: {
    // Only an explicit "off" value drops the union: a typo must never weaken block checks.
    legacyLocal: !['0', 'false', 'off', 'no'].includes(str('LEGACY_LOCAL_BLOCKS').trim().toLowerCase()),
  },

  run: {
    apiUrl: str('RUN_API_URL').trim().replace(/\/+$/, ''),
    internalToken: str('RUN_INTERNAL_TOKEN').trim(),
    timeoutMs: num('RUN_TIMEOUT_MS', 3000),
    cacheTtlSeconds: num('RUN_CACHE_TTL_SECONDS', 300),
  },

  auth: {
    jwksUrl: str('AUTH_JWKS_URL'),
    publicKeyPem: str('AUTH_PUBLIC_KEY_PEM'),
    issuer: str('AUTH_ISSUER') || undefined,
    audience: str('AUTH_AUDIENCE') || undefined,
    devHs256Secret: str('AUTH_DEV_HS256_SECRET'),
    // How long to wait for AUTH_JWKS_URL. The free Render plan takes ~1 min to wake the Exercise backend.
    jwksTimeoutMs: num('AUTH_JWKS_TIMEOUT_MS', 15_000),
  },

  campus: {
    id: str('CAMPUS_ID', 'iiser-kolkata'),
    name: str('CAMPUS_NAME', 'IISER Kolkata'),
    shortName: str('CAMPUS_SHORT_NAME', 'IISER K'),
    emailDomains: str('CAMPUS_EMAIL_DOMAINS', 'iiserkol.ac.in').split(',').map((s) => s.trim()).filter(Boolean),
    centerLat: num('CAMPUS_CENTER_LAT', 22.9637),
    centerLng: num('CAMPUS_CENTER_LNG', 88.5245),
    maxRadiusM: num('CAMPUS_MAX_RADIUS_M', 4000),
  },

  realtime: {
    publicUrl: str('REALTIME_PUBLIC_URL') || null,
    pgChannel: str('REALTIME_PG_CHANNEL', 'campus_events'),
  },

  worker: {
    pollMs: num('WORKER_POLL_MS', 1000),
    concurrency: num('WORKER_CONCURRENCY', 2),
    maxAttempts: num('WORKER_MAX_ATTEMPTS', 5),
    inline: bool('WORKER_INLINE', true),
  },

  rules: {
    qualificationTtlHours: num('QUALIFICATION_TTL_HOURS', 24),
    claimShieldHours: num('CLAIM_SHIELD_HOURS', 2),
    userActionCooldownSeconds: num('USER_ACTION_COOLDOWN_SECONDS', 60),
    defendCooldownMinutes: num('DEFEND_COOLDOWN_MINUTES', 60),
    areaZoneDefaultThreshold: num('AREA_ZONE_DEFAULT_THRESHOLD', 0.6),
    routeZoneDefaultThreshold: num('ROUTE_ZONE_DEFAULT_THRESHOLD', 0.8),
    areaCoverageBufferM: num('AREA_COVERAGE_BUFFER_M', 15),
    routeMatchToleranceM: num('ROUTE_MATCH_TOLERANCE_M', 20),
    // Fallback interaction minimums (a zone can override): either satisfied counts as "visited"
    minTimeInZoneS: num('MIN_TIME_IN_ZONE_S', 30),
    minDistanceInZoneM: num('MIN_DISTANCE_IN_ZONE_M', 80),
    xpClaim: num('XP_CLAIM', 25),
    xpSteal: num('XP_STEAL', 40),
    xpDefend: num('XP_DEFEND', 15),
  },

  gps: {
    maxPointsPerBatch: 1000,
    maxPointsPerActivity: 20_000,
    maxAccuracyM: 100, // points worse than this are rejected at ingest (client already filters at 30 m)
    maxActivityHours: 6,
    minPoints: 2,
  },

  presence: {
    ttlMinutes: num('PRESENCE_TTL_MINUTES', 15),
    gridM: num('PRESENCE_GRID_M', 100),
    nearbyRadiusM: num('NEARBY_RADIUS_M', 800),
    veryCloseM: 150,
    nearbyM: 500,
  },

  // Bubble: ephemeral proximity layer (src/bubble). No coordinates are stored, only a coarse grid cell.
  bubble: {
    cellM: num('BUBBLE_CELL_M', 250),
    ttlMinutes: num('BUBBLE_TTL_MINUTES', 15),
    eventThrottleS: num('BUBBLE_EVENT_THROTTLE_S', 60),
    notifyMinOthers: num('BUBBLE_NOTIFY_MIN_OTHERS', 3),
    notifyWindowHours: num('BUBBLE_NOTIFY_WINDOW_HOURS', 6),
    recentlyActiveMinutes: num('BUBBLE_RECENTLY_ACTIVE_MINUTES', 120),
  },

  // Periodic clean-up (expired presence fixes, bubble members): worker, and the API when WORKER_INLINE.
  sweep: {
    intervalMs: num('SWEEP_INTERVAL_MS', 60_000),
  },
} as const;
