import pg from 'pg';
import { config } from '../config.js';

const { Pool, types } = pg;
// Return timestamptz as ISO strings and bigint as numbers (versions fit comfortably).
types.setTypeParser(1184, (v: string) => new Date(v).toISOString());
types.setTypeParser(20, (v: string) => Number(v));

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl, max: config.databasePoolMax });
    pool.on('error', (err) => console.error('pg pool error', err));
  }
  return pool;
}

export type Queryable = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], q: Queryable = getPool()) {
  return q.query<T>(text, params);
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], q: Queryable = getPool()): Promise<T | null> {
  const r = await q.query<T>(text, params);
  return r.rows[0] ?? null;
}

export async function many<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = [], q: Queryable = getPool()): Promise<T[]> {
  const r = await q.query<T>(text, params);
  return r.rows;
}

/** Run `fn` inside a transaction. Rolls back on throw. */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>, isolation: 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE' = 'READ COMMITTED'): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; }
}
