import {
  defineRailway,
  github,
  group,
  preserve,
  project,
  redis,
  service,
  volume,
} from "railway/iac";

const repository = "SquirrelSo/Squirrel";
const branch = "saheb";
const singapore = "asia-southeast1-eqsg3a";

const source = (rootDirectory: string) =>
  github(repository, { branch, rootDirectory });

export default defineRailway((ctx) => {
  // Create these four Shared Variables in the Railway environment before planning.
  const sharedEnv = {
    JWT_SECRET: ctx.shared.JWT_SECRET,
    JWT_ALGORITHM: ctx.shared.JWT_ALGORITHM,
    XP_TIMEZONE: ctx.shared.XP_TIMEZONE,
    SOCIAL_INTERNAL_TOKEN: ctx.shared.SOCIAL_INTERNAL_TOKEN,
  };

  // Each service gets its own volume because Railway volumes attach to one service only.
  const exerciseCa = volume("exercise-supabase-ca", { region: singapore, sizeMB: 16 });
  const runCa = volume("run-api-supabase-ca", { region: singapore, sizeMB: 16 });
  const runWorkerCa = volume("run-worker-supabase-ca", { region: singapore, sizeMB: 16 });
  const socialCa = volume("social-supabase-ca", { region: singapore, sizeMB: 16 });
  const campusCa = volume("campus-supabase-ca", { region: singapore, sizeMB: 16 });
  const campusWorkerCa = volume("campus-worker-supabase-ca", { region: singapore, sizeMB: 16 });

  const cache = redis("squirrel-redis");

  const exercise = service("squirrel-exercise", {
    source: source("Exercise_Mechanics--main"),
    replicas: { [singapore]: 1 },
    healthcheck: "/",
    volumeMounts: { "/etc/secrets": exerciseCa },
    env: {
      ...sharedEnv,
      DATABASE_URL: preserve(),
      CORS_ALLOWED_ORIGINS: preserve(),
      RUN_MODULE_URL: preserve(),
      SOCIAL_API_URL: preserve(),
      EXERCISE_REQUIRE_AUTH: "1",
      MODERATION_TOKEN: preserve(),
      SQUIRREL_PUBLIC_BASE_URL: preserve(),
      SQUIRREL_ALLOWED_EMAIL_DOMAINS: "ac.in",
      SQUIRREL_EMAIL_VERIFICATION: "on",
      SMTP_USER: preserve(),
      SMTP_PASSWORD: preserve(),
      RESEND_API_KEY: preserve(),
      EMAIL_FROM: preserve(),
      JWT_PRIVATE_KEY: preserve(),
    },
  });

  const runApi = service("squirrel-run-api", {
    source: source("run-module"),
    replicas: { [singapore]: 1 },
    healthcheck: "/health",
    volumeMounts: { "/etc/secrets": runCa },
    env: {
      ...sharedEnv,
      DATABASE_URL: preserve(),
      CORS_ALLOWED_ORIGINS: preserve(),
      REDIS_URL: cache.env.REDIS_URL,
      MIGRATE_ON_START: "1",
      RUN_WORKERS_IN_API: "0",
      SOCIAL_API_URL: preserve(),
      NODE_ENV: "production",
      LOG_LEVEL: "info",
    },
  });

  const runWorker = service("squirrel-run-worker", {
    source: source("run-module"),
    start: "node --import tsx/esm src/workers/start.ts",
    replicas: { [singapore]: 1 },
    volumeMounts: { "/etc/secrets": runWorkerCa },
    env: {
      ...sharedEnv,
      DATABASE_URL: preserve(),
      REDIS_URL: cache.env.REDIS_URL,
      RUN_WORKERS_IN_API: "0",
      SOCIAL_API_URL: preserve(),
      NODE_ENV: "production",
      LOG_LEVEL: "info",
    },
  });

  const social = service("squirrel-social", {
    source: source("squirrel-social-profile-social-fixed/social-backend"),
    replicas: { [singapore]: 1 },
    healthcheck: "/healthz",
    volumeMounts: { "/etc/secrets": socialCa },
    env: {
      ...sharedEnv,
      DATABASE_URL: preserve(),
      CORS_ALLOWED_ORIGINS: preserve(),
      SOCIAL_RUN_MODULE_URL: preserve(),
      SOCIAL_HOSTELS: preserve(),
      SOCIAL_ZONES_FILE: preserve(),
      SOCIAL_ZONES: preserve(),
      SOCIAL_APP_URL: preserve(),
      EXPO_ACCESS_TOKEN: preserve(),
    },
  });

  const campus = service("squirrel-campus", {
    source: source("campus-service"),
    replicas: { [singapore]: 1 },
    healthcheck: "/healthz",
    volumeMounts: { "/etc/secrets": campusCa },
    env: {
      ...sharedEnv,
      DATABASE_URL: preserve(),
      AUTH_JWKS_URL: preserve(),
      SOCIAL_API_URL: preserve(),
      CORS_ORIGINS: preserve(),
      REALTIME_PUBLIC_URL: preserve(),
      NODE_ENV: "production",
      MIGRATE_ON_START: "1",
      SEED_ZONES_ON_START: "1",
      WORKER_INLINE: "0",
    },
  });

  const campusWorker = service("squirrel-campus-worker", {
    source: source("campus-service"),
    start: "npm run start:worker",
    replicas: { [singapore]: 1 },
    volumeMounts: { "/etc/secrets": campusWorkerCa },
    env: {
      ...sharedEnv,
      DATABASE_URL: preserve(),
      AUTH_JWKS_URL: preserve(),
      SOCIAL_API_URL: preserve(),
      NODE_ENV: "production",
      WORKER_INLINE: "0",
    },
  });

  return project("squirrel-railway", {
    resources: [
      group("APIs and workers", [exercise, runApi, runWorker, social, campus, campusWorker]),
      cache,
      exerciseCa,
      runCa,
      runWorkerCa,
      socialCa,
      campusCa,
      campusWorkerCa,
    ],
  });
});
