/**
 * src/db/pool.ts
 *
 * PostgreSQL connection pool.
 * Reads DATABASE_URL from the validated env config.
 * No schema assumptions. No ORM. Raw SQL only.
 */

import pg from "pg";
import { DATABASE_URL } from "../config/env.js";

const { Pool } = pg;

const poolMaxEnv = Number(process.env["DATABASE_POOL_MAX"]);
const poolMax = Number.isInteger(poolMaxEnv) && poolMaxEnv > 0 ? poolMaxEnv : 10;

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: poolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client:", err.message);
});
