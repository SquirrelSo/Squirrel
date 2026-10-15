/**
 * src/config/env.ts
 *
 * Typed environment variable loader.
 * Validates all required variables at process startup.
 * Exits non-zero with a descriptive message on any missing variable.
 * Never provides defaults for security-sensitive or connection-string variables.
 */

const REQUIRED_VARS = [
  "DATABASE_URL",
  "REDIS_URL",
  "PORT",
  "NODE_ENV",
  "LOG_LEVEL",
  "JWT_SECRET",
] as const;

type RequiredVar = (typeof REQUIRED_VARS)[number];

const ALLOWED_JWT_ALGORITHMS = ["HS256", "RS256"] as const;
export type JwtAlgorithm = (typeof ALLOWED_JWT_ALGORITHMS)[number];

function requireEnv(name: RequiredVar): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(
      `[env] FATAL: Required environment variable "${name}" is not set. ` +
        `Copy .env.example to .env and fill in a real value.`
    );
    process.exit(1);
  }
  return value;
}

function loadEnv(): Record<RequiredVar, string> {
  const missing: string[] = [];

  for (const name of REQUIRED_VARS) {
    const value = process.env[name];
    if (value === undefined || value === "") {
      missing.push(name);
    }
  }

  if (missing.length > 0) {
    for (const name of missing) {
      console.error(
        `[env] FATAL: Required environment variable "${name}" is not set.`
      );
    }
    console.error(
      `[env] Set the missing variable(s) and restart. ` +
        `See .env.example for a reference.`
    );
    process.exit(1);
  }

  // Validate JWT_ALGORITHM if provided
  const rawAlg = process.env["JWT_ALGORITHM"];
  if (rawAlg !== undefined && rawAlg !== "") {
    if (!(ALLOWED_JWT_ALGORITHMS as ReadonlyArray<string>).includes(rawAlg)) {
      console.error(
        `[env] FATAL: JWT_ALGORITHM="${rawAlg}" is not allowed. ` +
          `Allowed values: ${ALLOWED_JWT_ALGORITHMS.join(", ")}.`
      );
      process.exit(1);
    }
  }

  return {
    DATABASE_URL: requireEnv("DATABASE_URL"),
    REDIS_URL: requireEnv("REDIS_URL"),
    PORT: requireEnv("PORT"),
    NODE_ENV: requireEnv("NODE_ENV"),
    LOG_LEVEL: requireEnv("LOG_LEVEL"),
    JWT_SECRET: requireEnv("JWT_SECRET"),
  };
}

export const env = loadEnv();

export const PORT        = parseInt(env.PORT, 10);
export const NODE_ENV    = env.NODE_ENV;
export const LOG_LEVEL   = env.LOG_LEVEL;
export const DATABASE_URL = env.DATABASE_URL;
export const REDIS_URL   = env.REDIS_URL;
export const JWT_SECRET  = env.JWT_SECRET;

/**
 * JWT signing algorithm.  Defaults to 'HS256' for local development.
 * MUST be set to 'RS256' in production — see ADR-003.
 */
export const JWT_ALGORITHM: JwtAlgorithm =
  (process.env["JWT_ALGORITHM"] as JwtAlgorithm | undefined) ?? "HS256";

/**
 * Optional JWT issuer claim.  When set, tokens whose `iss` does not match
 * are rejected.
 */
export const JWT_ISSUER = process.env["JWT_ISSUER"] ?? undefined;

/**
 * Optional JWT audience claim.  When set, tokens whose `aud` does not match
 * are rejected.
 */
export const JWT_AUDIENCE = process.env["JWT_AUDIENCE"] ?? undefined;
export const RATE_LIMIT_POINTS_PER_MIN = parseInt(process.env.RATE_LIMIT_POINTS_PER_MIN || '60', 10);
export const RATE_LIMIT_POINTS_PER_DAY = parseInt(process.env.RATE_LIMIT_POINTS_PER_DAY || '2000', 10);
export const RATE_LIMIT_RUNS_CREATE_PER_DAY = parseInt(process.env.RATE_LIMIT_RUNS_CREATE_PER_DAY || '50', 10);
export const RATE_LIMIT_WRITE_PER_MIN = parseInt(process.env.RATE_LIMIT_WRITE_PER_MIN || '120', 10);
/** Per-user limit on the app's XP reads (stats, history, XP board). Generous: they are cheap reads. */
export const RATE_LIMIT_XP_READ_PER_MIN = parseInt(process.env.RATE_LIMIT_XP_READ_PER_MIN || '120', 10);
