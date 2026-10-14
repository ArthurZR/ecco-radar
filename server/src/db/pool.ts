import pg from 'pg';
import { env } from '../config/env.js';

// Return numeric/bigint columns as JS numbers. Reference numbers stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));
// Keep DATE columns as 'YYYY-MM-DD' strings to avoid timezone shifts.
pg.types.setTypeParser(1082, (v) => v);

let pool: pg.Pool | undefined;

export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: env().DATABASE_URL, max: 10 });
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type Queryable = Pick<pg.Pool, 'query'> | pg.PoolClient;

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
