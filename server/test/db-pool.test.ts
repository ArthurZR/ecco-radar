import { afterAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { db, closeDb } from '../src/db/pool.js';

afterAll(closeDb);

describe('database pool', () => {
  it('survives the server dropping an idle connection (as in a Postgres restart)', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const client = await db().connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    client.release();
    // Kill that idle backend from a separate connection, the way a restart does.
    const killer = new pg.Client({ connectionString: process.env.DATABASE_URL });
    await killer.connect();
    await killer.query('SELECT pg_terminate_backend($1)', [pid]);
    await killer.end();
    await new Promise((r) => setTimeout(r, 200));
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/database connection lost \(57P01\)/));
    // The process is still alive and the pool serves new queries.
    expect((await db().query<{ ok: number }>('SELECT 1 AS ok')).rows[0]!.ok).toBe(1);
    spy.mockRestore();
  });
});
