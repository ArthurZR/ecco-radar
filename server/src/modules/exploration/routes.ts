import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { badRequest, notFound, AppError } from '../../lib/errors.js';
import { enqueue } from '../jobs/queue.js';
import { createSession, ExplorationParamsSchema } from './engine.js';
import { searchableAdapters } from '../sources/registry.js';
import { MODE_STRATEGIES } from './expansion.js';
import { SEED_MAP } from './seed-map.js';
import { parseRefNumber } from '../references/types.js';

const Id = z.object({ id: z.string().uuid() });

const ScheduleSchema = z.object({
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean().default(false),
  params: ExplorationParamsSchema,
  intervalMinutes: z.number().int().min(60).max(60 * 24 * 14),
  maxRunsPerDay: z.number().int().min(1).max(24).default(4),
});

export async function explorationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/exploration/options', async () => {
    const enabled = new Map((await db().query<{ id: string; enabled: boolean }>('SELECT id, enabled FROM sources')).rows.map((r) => [r.id, r.enabled]));
    return {
      sources: searchableAdapters().map((a) => {
        const missing = a.missingConfiguration(env());
        const notReady = missing.length ? `needs ${missing.join(', ')}` : enabled.get(a.id) === false ? 'disabled' : null;
        return { id: a.id, name: a.name, ready: !notReady, notReady };
      }),
      modes: MODE_STRATEGIES,
      // Starting territories for the "cultural categories" picker; each becomes a level-0 query.
      territories: Object.keys(SEED_MAP),
    };
  });

  app.post('/api/explorations', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const params = ExplorationParamsSchema.parse(req.body);
    const valid = new Set(searchableAdapters().map((a) => a.id));
    const bad = params.sourceIds.filter((s) => !valid.has(s));
    if (bad.length) throw badRequest(`Unknown or non-searchable sources: ${bad.join(', ')}`);
    const id = await createSession(params, { actorId: req.user!.id });
    await enqueue('run_exploration', { sessionId: id }, `explore:${id}`);
    return { id };
  });

  // Follow a reference: explore from its creator / title / tags
  app.post('/api/explorations/from-reference', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ ref: z.string(), mode: z.enum(['familiar', 'adjacent', 'experimental']).default('adjacent'), sourceIds: z.array(z.string()).min(1).max(10) }).parse(req.body);
    const n = parseRefNumber(body.ref);
    if (n === null) throw badRequest('Invalid reference number');
    const r = await db().query<{ id: string; title: string | null; creator_name: string | null; tags: string[] | null }>(
      `SELECT r.id, r.title, r.creator_name, (SELECT array_agg(tag) FROM (SELECT tag FROM reference_tags t WHERE t.reference_id = r.id AND t.state <> 'rejected' LIMIT 3) x) AS tags
         FROM reference_items r WHERE r.ref_number = $1`,
      [n],
    );
    const ref = r.rows[0];
    if (!ref) throw notFound('Reference');
    const query = ref.creator_name ?? ref.title ?? ref.tags?.[0];
    if (!query) throw badRequest('This reference has no creator, title or tags to explore from');
    const params = ExplorationParamsSchema.parse({ query, concepts: (ref.tags ?? []).slice(0, 3), mode: body.mode, sourceIds: body.sourceIds, depth: 1, maxQueries: 6, maxResults: 40 });
    const id = await createSession(params, { actorId: req.user!.id, trigger: 'related_reference', parentReferenceId: ref.id });
    await enqueue('run_exploration', { sessionId: id }, `explore:${id}`);
    return { id };
  });

  app.get('/api/explorations', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) }).parse(req.query);
    return (await db().query(
      `SELECT id, query, mode, source_ids, status, trigger, results_count, new_count, error_summary, created_at, started_at, completed_at, depth, max_queries, max_results
         FROM exploration_sessions ORDER BY created_at DESC LIMIT $1`,
      [q.limit],
    )).rows;
  });

  app.get('/api/explorations/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const s = (await db().query(
      `SELECT s.*, (SELECT coalesce(sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)),0)::int FROM ai_usage u WHERE u.exploration_session_id = s.id) AS ai_tokens_used
         FROM exploration_sessions s WHERE s.id = $1`,
      [id],
    )).rows[0];
    if (!s) throw notFound('Exploration session');
    const queries = (await db().query(
      `SELECT id, parent_query_id, query, depth, origin, rationale, status, results_count, error, executed_at
         FROM exploration_queries WHERE session_id = $1 ORDER BY depth, executed_at NULLS LAST`,
      [id],
    )).rows;
    return { session: s, queries };
  });

  const transition = (from: string[], to: string) => async (id: string) => {
    const r = await db().query(`UPDATE exploration_sessions SET status = $2 WHERE id = $1 AND status = ANY($3) RETURNING id`, [id, to, from]);
    if (!r.rowCount) throw new AppError(409, 'invalid_state', `Session cannot be set to ${to} from its current state`);
  };

  app.post('/api/explorations/:id/pause', async (req) => {
    await transition(['queued', 'running'], 'paused')(Id.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/explorations/:id/resume', async (req) => {
    const { id } = Id.parse(req.params);
    await transition(['paused'], 'queued')(id);
    await enqueue('run_exploration', { sessionId: id }, `explore:${id}:resume:${Date.now()}`);
    return { ok: true };
  });
  app.post('/api/explorations/:id/cancel', async (req) => {
    await transition(['queued', 'running', 'paused'], 'cancelled')(Id.parse(req.params).id);
    return { ok: true };
  });
  app.post('/api/explorations/:id/repeat', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = Id.parse(req.params);
    const s = (await db().query('SELECT * FROM exploration_sessions WHERE id = $1', [id])).rows[0] as Record<string, unknown> | undefined;
    if (!s) throw notFound('Exploration session');
    const params = ExplorationParamsSchema.parse({
      query: s.query, concepts: s.concepts, categories: s.categories, mode: s.mode, sourceIds: s.source_ids,
      creator: s.creator ?? undefined, periodFrom: s.period_from ?? undefined, periodTo: s.period_to ?? undefined,
      novelty: s.novelty, depth: s.depth, maxQueries: s.max_queries, maxResults: s.max_results, useExternalAi: s.use_external_ai,
      maxAiTokens: s.max_ai_tokens, historyRelation: s.history_relation,
    });
    const newId = await createSession(params, { actorId: req.user!.id, trigger: 'repeat', parentSessionId: id });
    await enqueue('run_exploration', { sessionId: newId }, `explore:${newId}`);
    return { id: newId };
  });

  // Background schedules (opt-in)
  app.get('/api/schedules', async () => (await db().query('SELECT * FROM discovery_schedules ORDER BY created_at DESC')).rows);
  app.post('/api/schedules', async (req) => {
    const b = ScheduleSchema.parse(req.body);
    const r = await db().query(
      `INSERT INTO discovery_schedules(name, enabled, params, interval_minutes, max_runs_per_day, next_run_at, created_by)
       VALUES ($1,$2,$3,$4::int,$5, now() + $4::int * interval '1 minute', $6) RETURNING *`,
      [b.name, b.enabled, JSON.stringify(b.params), b.intervalMinutes, b.maxRunsPerDay, req.user!.id],
    );
    return r.rows[0];
  });
  // Edit any part of a schedule. Switching one off also stops the runs it started that have not finished.
  app.patch('/api/schedules/:id', async (req) => {
    const { id } = Id.parse(req.params);
    const b = ScheduleSchema.partial().parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [id];
    const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.name !== undefined) set('name', b.name);
    if (b.enabled !== undefined) set('enabled', b.enabled);
    if (b.params !== undefined) set('params', JSON.stringify(b.params));
    if (b.maxRunsPerDay !== undefined) set('max_runs_per_day', b.maxRunsPerDay);
    if (b.intervalMinutes !== undefined) {
      set('interval_minutes', b.intervalMinutes);
      sets[sets.length - 1] += '::int';
      sets.push(`next_run_at = coalesce(last_run_at, now()) + $${vals.length}::int * interval '1 minute'`);
    }
    if (!sets.length) throw badRequest('Nothing to change');
    const r = await db().query(`UPDATE discovery_schedules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);
    if (!r.rowCount) throw notFound('Schedule');
    let stopped = 0;
    if (b.enabled === false) {
      stopped = (await db().query(
        `UPDATE exploration_sessions SET status = 'cancelled', error_summary = coalesce(error_summary || E'\n', '') || 'Stopped: the schedule was switched off'
          WHERE schedule_id = $1 AND status IN ('queued','running','paused')`,
        [id],
      )).rowCount ?? 0;
    }
    return { ...r.rows[0], stoppedRuns: stopped };
  });
  // Runs a schedule once now, whether or not it is switched on. Still a run the editor started.
  app.post('/api/schedules/:id/run', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = Id.parse(req.params);
    const row = (await db().query<{ params: unknown }>('SELECT params FROM discovery_schedules WHERE id = $1', [id])).rows[0];
    if (!row) throw notFound('Schedule');
    const params = ExplorationParamsSchema.parse(row.params);
    const sessionId = await createSession(params, { actorId: req.user!.id, trigger: 'manual', scheduleId: id });
    await enqueue('run_exploration', { sessionId }, `explore:${sessionId}`);
    await db().query('UPDATE discovery_schedules SET last_run_at = now() WHERE id = $1', [id]);
    return { id: sessionId };
  });
  app.delete('/api/schedules/:id', async (req) => {
    await db().query('DELETE FROM discovery_schedules WHERE id = $1', [Id.parse(req.params).id]);
    return { ok: true };
  });
}
