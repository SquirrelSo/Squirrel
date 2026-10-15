import { buildApp } from './app.js';
import { config } from './config.js';
import { closePool } from './db/pool.js';
import { startRealtimeFanout, stopRealtimeFanout } from './realtime/bus.js';
import { startWorker } from './verification/worker.js';
import { authConfigured, warmKeys } from './auth/jwt.js';
import { migrate } from './db/migrate.js';
import { seedZones } from './seed/run.js';
import { bridgeEnabled } from './identity/index.js';
import { startSweeper } from './sweeper.js';

async function main() {
  const app = await buildApp();
  if (config.isProd && !authConfigured()) { app.log.fatal('AUTH_JWKS_URL or AUTH_PUBLIC_KEY_PEM is required in production'); process.exit(1); }
  if (config.isProd && !bridgeEnabled()) { app.log.fatal('SOCIAL_API_URL and SOCIAL_INTERNAL_TOKEN are required in production'); process.exit(1); }
  // Single-service deploys (Render): schema and placeholder zones are prepared before the API listens.
  if (config.startup.migrateOnStart) {
    await migrate(undefined, (m) => app.log.info(m));
    app.log.info('migrations up to date');
  }
  if (config.startup.seedZonesOnStart) {
    await seedZones(); // hostels + zones only; geometry overwritten only while geometry_source = 'dev_placeholder'
    app.log.info('hostels and zones seeded');
  }
  app.log.info({ social_bridge: bridgeEnabled() }, bridgeEnabled() ? 'identity bridge to Social is ON' : 'identity bridge to Social is OFF (SOCIAL_API_URL / SOCIAL_INTERNAL_TOKEN unset)');
  warmKeys(app.log);
  await startRealtimeFanout(app.log);
  const abort = new AbortController();
  if (config.worker.inline) {
    void startWorker(app.log, abort.signal);
    startSweeper(app.log, abort.signal); // presence + bubble expiry, every minute
  }
  await app.listen({ port: config.port, host: config.host });
  const shutdown = async () => {
    app.log.info('shutting down');
    abort.abort();
    await app.close();
    await stopRealtimeFanout();
    await closePool();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((e) => { console.error(e); process.exit(1); });
