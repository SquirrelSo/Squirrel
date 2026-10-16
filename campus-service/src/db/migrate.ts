/**
 * Minimal forward-only SQL migrator: applies migrations/*.sql in name order, once each.
 * Usage: npm run migrate (dev, tsx) · node dist/db/migrate.js (production image) ·
 *        MIGRATE_ON_START=1 node dist/index.js (runs this before the API listens).
 * A session advisory lock serialises concurrent runners (e.g. two instances booting at once).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPool, closePool } from './pool.js';

const MIGRATION_LOCK_KEY = 727_110_001; // arbitrary, constant: pg_advisory_lock key for this service's migrator

export const DEFAULT_MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');

export async function migrate(dir = DEFAULT_MIGRATIONS_DIR, log: (m: string) => void = console.log) {
  const pool = getPool();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await lock.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set((await lock.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = await readFile(path.join(dir, f), 'utf8');
      try {
        await lock.query('BEGIN');
        await lock.query(sql);
        await lock.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
        await lock.query('COMMIT');
        log(`applied ${f}`);
      } catch (e) {
        await lock.query('ROLLBACK').catch(() => undefined);
        throw new Error(`migration ${f} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lock.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  migrate().then(() => closePool()).catch((e) => { console.error(e); process.exit(1); });
}
