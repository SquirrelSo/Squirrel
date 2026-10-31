import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    env: {},
    // integration tests share one Postgres instance and run SERIALIZABLE transactions, so parallel files contend on the same rows by design. Sequential execution is the intended configuration, not a workaround.
    fileParallelism: false,
    // Load .env so DATABASE_URL is available for DB integration tests.
    // In CI without a DB, DATABASE_URL remains unset and DB tests skip cleanly.
    envFile: ".env",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
  },
});
