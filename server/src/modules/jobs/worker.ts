import { db } from '../../db/pool.js';
import { claimJob, completeJob, enqueue, failJob, recoverStaleJobs, type ClaimedJob } from './queue.js';
import { runExploration, createSession, ExplorationParamsSchema } from '../exploration/engine.js';
import { analyzeReferenceImage, queuePendingVisualAnalysis } from '../references/visual.js';

const CONCURRENCY = 2;
const POLL_MS = 2000;

async function backgroundPaused(): Promise<boolean> {
  const r = await db().query<{ value: boolean }>(`SELECT value FROM app_settings WHERE key = 'background_paused'`);
  return r.rows[0]?.value === true;
}

/** Starts due schedules. Background discovery only runs for schedules the editor enabled. */
export async function scheduleTick(): Promise<number> {
  if (await backgroundPaused()) return 0;
  const due = await db().query<{ id: string; params: unknown; interval_minutes: number; max_runs_per_day: number; created_by: string | null }>(
    `SELECT * FROM discovery_schedules WHERE enabled AND (next_run_at IS NULL OR next_run_at <= now())`,
  );
  let started = 0;
  for (const s of due.rows) {
    const today = await db().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM exploration_sessions WHERE schedule_id = $1 AND created_at > now() - interval '1 day'`,
      [s.id],
    );
    const nextRun = `now() + ${Number(s.interval_minutes)} * interval '1 minute'`;
    if (today.rows[0]!.n >= s.max_runs_per_day) {
      await db().query(`UPDATE discovery_schedules SET next_run_at = ${nextRun} WHERE id = $1`, [s.id]);
      continue;
    }
    const params = ExplorationParamsSchema.safeParse(s.params);
    if (!params.success) continue;
    const sessionId = await createSession(params.data, { actorId: s.created_by, trigger: 'scheduled', scheduleId: s.id });
    await enqueue('run_exploration', { sessionId }, `explore:${sessionId}`);
    await db().query(`UPDATE discovery_schedules SET last_run_at = now(), next_run_at = ${nextRun} WHERE id = $1`, [s.id]);
    started++;
  }
  return started;
}

async function handle(job: ClaimedJob): Promise<void> {
  switch (job.kind) {
    case 'run_exploration':
      await runExploration(String(job.payload.sessionId));
      return;
    case 'schedule_tick':
      await scheduleTick();
      return;
    case 'embed_reference':
      if (job.payload.kind === 'visual') await analyzeReferenceImage(String(job.payload.referenceId));
      return;
    default:
      return;
  }
}

export function startWorker(log: (msg: string, extra?: unknown) => void): () => void {
  let stopped = false;
  let active = 0;
  let lastTick = 0;
  const loop = async () => {
    if (stopped) return;
    try {
      if (Date.now() - lastTick > 60_000) {
        lastTick = Date.now();
        await recoverStaleJobs();
        await scheduleTick();
        await queuePendingVisualAnalysis();
      }
      while (!stopped && active < CONCURRENCY) {
        const job = await claimJob();
        if (!job) break;
        active++;
        handle(job)
          .then(() => completeJob(job.id))
          .catch(async (err: Error) => {
            log('job failed', { kind: job.kind, error: err.message });
            if (job.kind === 'run_exploration') {
              await db().query(
                `UPDATE exploration_sessions SET status = CASE WHEN $3 THEN 'failed' ELSE status END, error_summary = $2 WHERE id = $1 AND status = 'running'`,
                [job.payload.sessionId, err.message.slice(0, 1000), job.attempts >= job.max_attempts],
              );
            }
            await failJob(job, err);
          })
          .finally(() => {
            active--;
          });
      }
    } catch (err) {
      log('worker loop error', { error: (err as Error).message });
    }
    if (!stopped) setTimeout(loop, POLL_MS);
  };
  setTimeout(loop, 500);
  return () => {
    stopped = true;
  };
}
