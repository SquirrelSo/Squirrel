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

export const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on("error", (err) => {
  console.error("[db] Unexpected error on idle client:", err.message);
});
