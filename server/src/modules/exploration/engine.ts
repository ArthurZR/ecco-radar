import { z } from 'zod';
import { db } from '../../db/pool.js';
import { textEmbedder } from '../../lib/embedding.js';
import { parseLooseDate } from '../../lib/dates.js';
import { ingestReference } from '../references/ingest.js';
import { INSTITUTIONAL_CREATOR, assessResult, type SetAsideReason } from './quality.js';
import type { ProvenanceStep } from '../references/types.js';
import { runSourceSearch } from '../sources/service.js';
import { httpClient } from '../sources/registry.js';
import { WikidataClient } from '../sources/adapters/wikidata.js';
import { upsertEntity } from '../references/ingest.js';
import { withTransaction } from '../../db/pool.js';
import { getActiveRankingConfig } from '../ranking/config.js';
import { getEditorialProfile } from '../ranking/profile.js';
import { scoreReference } from '../ranking/score.js';
import { expandQuery, type Expansion } from './expansion.js';
import { getTextProvider, sessionAiTokens } from '../../ai/provider.js';

export const ExplorationParamsSchema = z.object({
  query: z.string().trim().min(1).max(300),
  concepts: z.array(z.string().trim().min(1).max(120)).max(10).default([]),
  categories: z.array(z.string().trim().min(1).max(80)).max(10).default([]),
  mode: z.enum(['familiar', 'adjacent', 'experimental']).default('adjacent'),
  sourceIds: z.array(z.string().max(60)).min(1).max(10),
  creator: z.string().trim().max(200).optional(),
  periodFrom: z.number().int().min(1000).max(2100).optional(),
  periodTo: z.number().int().min(1000).max(2100).optional(),
  novelty: z.number().min(0).max(1).default(0.5),
  depth: z.number().int().min(0).max(3).default(1),
  maxQueries: z.number().int().min(1).max(40).default(8),
  maxResults: z.number().int().min(1).max(500).default(60),
  useExternalAi: z.boolean().default(false),
  /** Most AI tokens (input + output) this run may spend; 0 means no AI even when enabled. */
  maxAiTokens: z.number().int().min(0).max(200_000).default(20_000),
  /** How strongly expansion leans on eccö's own captions and approvals. */
  historyRelation: z.enum(['close', 'balanced', 'away']).default('balanced'),
});
export type ExplorationParams = z.infer<typeof ExplorationParamsSchema>;

interface SessionRow {
  set_aside?: Partial<Record<SetAsideReason, number>>;
  id: string;
  query: string;
  concepts: string[];
  categories: string[];
  mode: 'familiar' | 'adjacent' | 'experimental';
  source_ids: string[];
  creator: string | null;
  period_from: number | null;
  period_to: number | null;
  novelty: number;
  depth: number;
  max_queries: number;
  max_results: number;
  use_external_ai: boolean;
  max_ai_tokens: number;
  history_relation: 'close' | 'balanced' | 'away';
  status: string;
  created_by: string | null;
  new_count: number;
  results_count: number;
}

export async function createSession(
  input: z.input<typeof ExplorationParamsSchema>,
  opts: { actorId: string | null; trigger?: 'manual' | 'scheduled' | 'related_reference' | 'repeat'; parentSessionId?: string; parentReferenceId?: string; scheduleId?: string },
): Promise<string> {
  const p = ExplorationParamsSchema.parse(input);
  const r = await db().query<{ id: string }>(
    `INSERT INTO exploration_sessions(query, concepts, categories, mode, source_ids, creator, period_from, period_to, novelty, depth,
       max_queries, max_results, use_external_ai, trigger, parent_session_id, parent_reference_id, schedule_id, created_by,
       max_ai_tokens, history_relation)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING id`,
    [p.query, p.concepts, p.categories, p.mode, p.sourceIds, p.creator ?? null, p.periodFrom ?? null, p.periodTo ?? null, p.novelty,
      p.depth, p.maxQueries, p.maxResults, p.useExternalAi, opts.trigger ?? 'manual', opts.parentSessionId ?? null,
      opts.parentReferenceId ?? null, opts.scheduleId ?? null, opts.actorId, p.maxAiTokens, p.historyRelation],
  );
  return r.rows[0]!.id;
}

async function sessionStatus(id: string): Promise<string> {
  const r = await db().query<{ status: string }>('SELECT status FROM exploration_sessions WHERE id = $1', [id]);
  return r.rows[0]?.status ?? 'cancelled';
}

interface QueryNode {
  id: string;
  query: string;
  depth: number;
  path: ProvenanceStep[];
}

async function insertQuery(sessionId: string, parent: QueryNode | null, q: string, depth: number, origin: string, rationale: string): Promise<string | null> {
  const r = await db().query<{ id: string }>(
    `INSERT INTO exploration_queries(session_id, parent_query_id, query, depth, origin, rationale)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING RETURNING id`,
    [sessionId, parent?.id ?? null, q, depth, origin, rationale],
  );
  return r.rows[0]?.id ?? null;
}

/** Stores the documented Wikidata relation behind a knowledge-graph branch. */
async function recordGraphEdge(e: NonNullable<Expansion['entity']>): Promise<void> {
  if (!e.via) return;
  await withTransaction(async (c) => {
    const from = await upsertEntity(c, e.via!.label, 'concept', e.via!.id);
    const to = await upsertEntity(c, e.label, 'concept', e.id);
    if (from === to) return;
    const predMap: Record<string, string> = {
      P170: 'created_by', P50: 'created_by', P178: 'created_by', P287: 'created_by', P86: 'created_by', P135: 'related_movement',
      P136: 'genre', P737: 'influenced_by', P361: 'part_of', P31: 'instance_of', P279: 'instance_of', P2079: 'uses_technique', P2348: 'belongs_to_period',
    };
    await c.query(
      `INSERT INTO entity_relations(from_entity_id, to_entity_id, predicate, evidence, provenance, provenance_url)
       VALUES ($1,$2,$3,'documented',$4,$5) ON CONFLICT DO NOTHING`,
      [from, to, predMap[e.via!.property] ?? 'associated_with', `Wikidata ${e.via!.property} (${e.via!.propertyLabel})`, `https://www.wikidata.org/wiki/${e.via!.id}#${e.via!.property}`],
    );
  });
}

function withinPeriod(publishedRaw: string | undefined, from: number | null, to: number | null): boolean {
  if (!from && !to) return true;
  const d = parseLooseDate(publishedRaw);
  if (!d.date) return true; // unknown dates are kept and shown as unknown, not guessed
  const y = Number(d.date.slice(0, 4));
  return (!from || y >= from) && (!to || y <= to);
}

/**
 * Runs (or resumes) a bounded exploration session. Work is checkpointed per query, so a paused
 * or crashed session resumes without repeating finished queries. Hard limits: depth, number of
 * queries, number of new references, and per-source rate limits.
 */
export async function runExploration(sessionId: string): Promise<void> {
  const s = (await db().query<SessionRow>('SELECT * FROM exploration_sessions WHERE id = $1', [sessionId])).rows[0];
  if (!s || ['completed', 'cancelled', 'failed'].includes(s.status)) return;
  await db().query(`UPDATE exploration_sessions SET status = 'running', started_at = coalesce(started_at, now()) WHERE id = $1`, [sessionId]);

  const errors: string[] = [];
  const baseQuery = [s.query, s.creator].filter(Boolean).join(' ');
  const queryEmbedding = textEmbedder.embed([s.query, ...s.concepts, ...s.categories].join(' '));
  const [config, profile] = await Promise.all([getActiveRankingConfig(), getEditorialProfile()]);
  const wikidata = new WikidataClient(httpClient());
  const ai = s.use_external_ai && s.max_ai_tokens > 0 ? await getTextProvider() : null;
  const aiSuggest = ai?.provider
    ? async (q: string, n: number) => {
        // The run's own AI budget, checked before every call (one call can end slightly above it).
        const spent = await sessionAiTokens(sessionId);
        if (spent >= s.max_ai_tokens) throw new Error(`this run's AI limit is reached (${spent} of ${s.max_ai_tokens} tokens)`);
        const text = await ai.provider!.generate({
          explorationSessionId: sessionId,
          purpose: 'query_expansion',
          system: 'You suggest search terms for finding existing cultural and visual references in public archives. Reply with search terms only, one per line, no numbering or commentary.',
          prompt: `Suggest ${n} distinct search terms adjacent to: "${q}". Prefer named movements, techniques, publications, or design vocabularies over generic words.`,
          maxTokens: 2000,
        });
        return text.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter((l) => l && l.length < 100).slice(0, n);
      }
    : undefined;
  if (s.use_external_ai && s.max_ai_tokens === 0) errors.push('AI expansion skipped: this run allows 0 AI tokens');
  else if (s.use_external_ai && !ai?.provider) errors.push(`AI expansion skipped: ${ai && 'reason' in ai ? ai.reason : 'unavailable'}`);

  // Level 0: the user's query and each explicit concept/category.
  const existing = (await db().query<{ id: string; query: string; depth: number; status: string; origin: string; rationale: string; parent_query_id: string | null }>(
    'SELECT id, query, depth, status, origin, rationale, parent_query_id FROM exploration_queries WHERE session_id = $1 ORDER BY depth, executed_at NULLS LAST',
    [sessionId],
  )).rows;
  if (existing.length === 0) {
    await insertQuery(sessionId, null, baseQuery, 0, 'user', 'Your query');
    for (const c of [...s.concepts, ...s.categories]) await insertQuery(sessionId, null, `${c}`, 0, 'concept', 'Concept you added');
  }

  let newCount = s.new_count;
  let resultsCount = s.results_count;
  const setAside: Record<SetAsideReason, number> = { no_preview: 0, not_visual: 0, administrative: 0, off_topic: 0, ...(s.set_aside ?? {}) };
  const seenQueries = new Set<string>();
  const perQuerySource = Math.max(5, Math.min(20, Math.ceil(s.max_results / Math.max(1, s.source_ids.length * 2))));

  for (let depth = 0; depth <= s.depth; depth++) {
    const level = (await db().query<{ id: string; query: string; status: string; origin: string; rationale: string; parent_query_id: string | null }>(
      `SELECT id, query, status, origin, rationale, parent_query_id FROM exploration_queries WHERE session_id = $1 AND depth = $2 AND source_id IS NULL`,
      [sessionId, depth],
    )).rows;
    const creatorsSeen: string[] = [];
    for (const q of level) {
      seenQueries.add(q.query.toLowerCase());
      if (q.status === 'done' || q.status === 'skipped') continue;
      const executed = (await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM exploration_queries WHERE session_id = $1 AND status IN ('done','failed')`, [sessionId])).rows[0]!.n;
      if (executed >= s.max_queries || newCount >= s.max_results) {
        await db().query(`UPDATE exploration_queries SET status = 'skipped', error = 'Session budget reached' WHERE id = $1`, [q.id]);
        continue;
      }
      const st = await sessionStatus(sessionId);
      if (st === 'paused' || st === 'cancelled') return;

      // Provenance chain: walk up the parents
      const chain: ProvenanceStep[] = [];
      let cur: { query: string; origin: string; rationale: string; parent_query_id: string | null } | undefined = q;
      while (cur) {
        chain.unshift({ kind: cur.origin === 'user' ? 'query' : 'expansion', label: cur.query, detail: cur.rationale });
        cur = cur.parent_query_id
          ? (await db().query<{ query: string; origin: string; rationale: string; parent_query_id: string | null }>('SELECT query, origin, rationale, parent_query_id FROM exploration_queries WHERE id = $1', [cur.parent_query_id])).rows[0]
          : undefined;
      }

      let qResults = 0;
      const qErrors: string[] = [];
      for (const sourceId of s.source_ids) {
        if (newCount >= s.max_results) break;
        const out = await runSourceSearch(sourceId, { query: q.query, page: 1, perPage: perQuerySource });
        if (!out.ok) {
          qErrors.push(`${sourceId}: ${out.error}`);
          continue;
        }
        let rank = 0;
        for (const item of out.result!.items) {
          rank++;
          if (!withinPeriod(item.publishedRaw, s.period_from, s.period_to)) continue;
          const verdict = assessResult(item, q.query);
          if (!verdict.keep) {
            setAside[verdict.reason]++;
            continue;
          }
          if (newCount >= s.max_results) break;
          try {
            const scoreable = {
              id: '', source_id: item.sourceId, creator_name: item.creatorName ?? null, creator_url: item.creatorUrl ?? null,
              title: item.title ?? null, description: item.description ?? null, published_date: parseLooseDate(item.publishedRaw).date,
              license: item.license ?? null, rights_statement: item.rightsStatement ?? null, preview_url: item.previewUrl ?? null,
              attribution_status: item.creatorName ? 'source_provided' : 'unknown',
              text_embedding: textEmbedder.embed([item.title, item.creatorName, (item.tags ?? []).join(' '), item.description].filter(Boolean).join('\n')),
              tags: item.tags ?? [], entity_ids: [],
            };
            const snap = scoreReference(scoreable, profile, config.weights, { mode: s.mode, novelty: s.novelty, queryEmbedding, queryLabel: s.query });
            const res = await ingestReference(item, {
              sessionId, queryId: q.id, method: sourceId === 'rss' ? 'rss' : 'search', queryText: q.query,
              path: [...chain, { kind: 'source', label: sourceId, detail: `result ${rank}` }],
              rank, scoreSnapshot: { total: snap.total, reasons: snap.reasons, rankingVersion: config.version, mode: s.mode },
              actorId: s.created_by,
            });
            resultsCount++;
            qResults++;
            if (res.created) newCount++;
            if (item.creatorName && !INSTITUTIONAL_CREATOR.test(item.creatorName) && !creatorsSeen.includes(item.creatorName)) creatorsSeen.push(item.creatorName);
          } catch (e) {
            qErrors.push(`${sourceId}: could not store an item (${(e as Error).message.slice(0, 200)})`);
          }
        }
      }
      await db().query(
        `UPDATE exploration_queries SET status = $2, results_count = $3, error = $4, executed_at = now() WHERE id = $1`,
        [q.id, qErrors.length && qResults === 0 ? 'failed' : 'done', qResults, qErrors.length ? qErrors.join('; ').slice(0, 2000) : null],
      );
      errors.push(...qErrors);
      await db().query('UPDATE exploration_sessions SET results_count = $2, new_count = $3, set_aside = $4 WHERE id = $1', [sessionId, resultsCount, newCount, setAside]);
    }

    // Expand into the next level, bounded by the remaining query budget.
    if (depth < s.depth && newCount < s.max_results) {
      const used = (await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM exploration_queries WHERE session_id = $1`, [sessionId])).rows[0]!.n;
      const budget = s.max_queries - used;
      if (budget <= 0) break;
      const parents = level.filter((q) => q.status !== 'skipped').slice(0, 3);
      for (const parent of parents) {
        const { expansions, errors: expErrors } = await expandQuery({
          query: parent.query, mode: s.mode, limit: Math.max(1, Math.ceil(budget / parents.length)), depth: depth + 1,
          creatorsSeen, wikidata, aiSuggest, exclude: seenQueries, historyRelation: s.history_relation,
        });
        errors.push(...expErrors);
        for (const e of expansions) {
          seenQueries.add(e.query.toLowerCase());
          if (e.entity) await recordGraphEdge(e.entity).catch(() => undefined);
          await insertQuery(sessionId, { id: parent.id, query: parent.query, depth, path: [] }, e.query, depth + 1, e.origin, e.rationale);
        }
      }
    }
  }

  const finalStatus = await sessionStatus(sessionId);
  if (finalStatus === 'paused' || finalStatus === 'cancelled') return;
  const allFailed = resultsCount === 0 && errors.length > 0;
  await db().query(
    `UPDATE exploration_sessions SET status = $2, completed_at = now(), error_summary = $3, results_count = $4, new_count = $5 WHERE id = $1`,
    [sessionId, allFailed ? 'failed' : 'completed', errors.length ? [...new Set(errors)].slice(0, 20).join('\n').slice(0, 4000) : null, resultsCount, newCount],
  );
}
