import { defineConfig } from 'vitest/config';

// Integration tests need a PostGIS database: TEST_DATABASE_URL=postgres://... npm test
const testDb = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      AUTH_DEV_HS256_SECRET: 'test-secret',
      WORKER_INLINE: '0',
      USER_ACTION_COOLDOWN_SECONDS: '0',
      // Identity bridge OFF by default in tests (a developer's shell must not switch it on);
      // test/integration/identity-bridge.test.ts turns it on against a fake Social server.
      SOCIAL_API_URL: '',
      SOCIAL_INTERNAL_TOKEN: '',
      ...(testDb ? { DATABASE_URL: testDb } : {}),
    },
  },
});
