import { db } from '../../db/pool.js';

/**
 * Postgres-backed job queue. Job kinds are fixed by a CHECK constraint in the schema; there is
 * no kind that publishes, schedules posts, or contacts a social platform.
 */
export type JobKind = 'run_exploration' | 'embed_reference' | 'schedule_tick' | 'refresh_source_status';

export async function enqueue(kind: JobKind, payload: Record<string, unknown>, idempotencyKey?: string, maxAttempts = 3): Promise<string | null> {
  const r = await db().query<{ id: string }>(
    `INSERT INTO jobs(kind, payload, idempotency_key, max_attempts) VALUES ($1,$2,$3,$4)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [kind, JSON.stringify(payload), idempotencyKey ?? null, maxAttempts],
  );
  return r.rows[0]?.id ?? null;
}

export interface ClaimedJob {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export async function claimJob(): Promise<ClaimedJob | null> {
  const r = await db().query<ClaimedJob>(
    `UPDATE jobs SET status = 'running', locked_at = now(), attempts = attempts + 1
      WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND run_after <= now() ORDER BY run_after FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, kind, payload, attempts, max_attempts`,
  );
  return r.rows[0] ?? null;
}

export async function completeJob(id: string): Promise<void> {
  await db().query(`UPDATE jobs SET status = 'done', finished_at = now(), locked_at = NULL WHERE id = $1`, [id]);
}

export async function failJob(job: ClaimedJob, err: Error): Promise<void> {
  const retry = job.attempts < job.max_attempts;
  await db().query(
    `UPDATE jobs SET status = $2, last_error = $3, locked_at = NULL,
       run_after = now() + ($4::int * interval '1 second'), finished_at = CASE WHEN $2 = 'failed' THEN now() END
     WHERE id = $1`,
    [job.id, retry ? 'queued' : 'failed', err.message.slice(0, 1000), Math.min(3600, 30 * 2 ** job.attempts)],
  );
}

/** Jobs left 'running' by a crashed process are returned to the queue. */
export async function recoverStaleJobs(): Promise<void> {
  await db().query(`UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '30 minutes'`);
}
