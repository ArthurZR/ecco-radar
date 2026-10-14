import { z } from 'zod';
import { db } from '../../db/pool.js';
import { textEmbedder, cosine } from '../../lib/embedding.js';
import { STATUSES } from './status.js';
import { MEDIA_TYPES, formatRefNumber, parseRefNumber, type ReferenceRow } from './types.js';
import { getActiveRankingConfig } from '../ranking/config.js';
import { getEditorialProfile } from '../ranking/profile.js';
import { scoreReference, type ScoreResult, type ScorableReference } from '../ranking/score.js';
import { diversify } from '../ranking/diversity.js';

const csv = <T extends z.ZodTypeAny>(item: T) =>
  z.preprocess((v) => (typeof v === 'string' ? v.split(',').filter(Boolean) : v), z.array(item)).optional();

export const FeedQuerySchema = z.object({
  q: z.string().max(300).optional(),
  semantic: z.string().max(500).optional(),
  status: csv(z.enum(STATUSES)),
  source: csv(z.string().max(60)),
  mediaType: csv(z.enum(MEDIA_TYPES)),
  creator: z.string().max(300).optional(),
  tag: z.string().max(120).optional(),
  periodFrom: z.coerce.number().int().min(1000).max(2100).optional(),
  periodTo: z.coerce.number().int().min(1000).max(2100).optional(),
  sessionId: z.string().uuid().optional(),
  duplicates: z.enum(['any', 'only', 'hide']).default('any'),
  includeDeleted: z.coerce.boolean().default(false),
  minScore: z.coerce.number().min(0).max(1).optional(),
  sort: z.enum(['ranked', 'recent', 'ref_number']).default('ranked'),
  mode: z.enum(['familiar', 'adjacent', 'experimental']).default('adjacent'),
  novelty: z.coerce.number().min(0).max(1).default(0.5),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});
export type FeedQuery = z.infer<typeof FeedQuerySchema>;

export const DEFAULT_FEED_STATUSES = ['discovered', 'saved', 'approved_consideration'] as const;

export interface FeedItem {
  id: string;
  refNumber: number;
  refLabel: string;
  title: string | null;
  creatorName: string | null;
  sourceId: string;
  sourceName: string;
  originalUrl: string;
  previewUrl: string | null;
  thumbnailUrl: string | null;
  mediaType: string;
  width: number | null;
  height: number | null;
  publishedRaw: string | null;
  publishedDate: string | null;
  publishedPrecision: string;
  discoveredAt: string;
  status: string;
  attributionStatus: string;
  tags: string[];
  duplicateCandidates: number;
  score: number | null;
  reasons: string[];
  caveats: string[];
  redundancy: { label: string; amount: number }[];
}

type Row = ReferenceRow & { source_name: string; tags: string[]; entity_ids: string[]; dup_count: number };

function buildWhere(q: FeedQuery): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (!q.includeDeleted) where.push('r.deleted_at IS NULL');
  const statuses = q.status?.length ? q.status : q.sessionId ? undefined : [...DEFAULT_FEED_STATUSES];
  if (statuses) where.push(`r.status = ANY(${p(statuses)})`);
  if (q.source?.length) where.push(`r.source_id = ANY(${p(q.source)})`);
  if (q.mediaType?.length) where.push(`r.media_type = ANY(${p(q.mediaType)})`);
  if (q.creator) where.push(`r.creator_name ILIKE ${p(`%${q.creator.replace(/[%_]/g, '\\$&')}%`)}`);
  if (q.tag) where.push(`EXISTS (SELECT 1 FROM reference_tags t WHERE t.reference_id = r.id AND lower(t.tag) = lower(${p(q.tag)}) AND t.state <> 'rejected')`);
  if (q.periodFrom) where.push(`r.published_date >= make_date(${p(q.periodFrom)}, 1, 1)`);
  if (q.periodTo) where.push(`r.published_date <= make_date(${p(q.periodTo)}, 12, 31)`);
  if (q.sessionId) where.push(`EXISTS (SELECT 1 FROM reference_discoveries d WHERE d.reference_id = r.id AND d.session_id = ${p(q.sessionId)})`);
  if (q.duplicates === 'only') where.push(`EXISTS (SELECT 1 FROM reference_relations x WHERE (x.from_id = r.id OR x.to_id = r.id) AND x.kind = 'duplicate_candidate')`);
  if (q.duplicates === 'hide') where.push(`r.duplicate_group_id IS NULL`);
  if (q.q) {
    const refNo = parseRefNumber(q.q);
    if (refNo !== null && /^#|^\d+$/.test(q.q.trim())) where.push(`r.ref_number = ${p(refNo)}`);
    else where.push(`(r.search_tsv @@ websearch_to_tsquery('english', ${p(q.q)}) OR r.search_tsv @@ websearch_to_tsquery('simple', $${params.length})
      OR EXISTS (SELECT 1 FROM reference_tags t WHERE t.reference_id = r.id AND lower(t.tag) = lower($${params.length})))`);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const SELECT = `
  SELECT r.*, s.name AS source_name,
    coalesce((SELECT array_agg(t.tag ORDER BY t.tag) FROM reference_tags t WHERE t.reference_id = r.id AND t.state <> 'rejected'), '{}') AS tags,
    coalesce((SELECT array_agg(e.entity_id::text) FROM reference_entities e WHERE e.reference_id = r.id AND e.evidence IN ('documented','editor_confirmed')), '{}') AS entity_ids,
    (SELECT count(*)::int FROM reference_relations x WHERE (x.from_id = r.id OR x.to_id = r.id) AND x.kind = 'duplicate_candidate') AS dup_count
  FROM reference_items r JOIN sources s ON s.id = r.source_id`;

export function toScorable(r: Row): ScorableReference {
  return {
    id: r.id, source_id: r.source_id, creator_name: r.creator_name, creator_url: r.creator_url, title: r.title,
    description: r.description, published_date: r.published_date, license: r.license, rights_statement: r.rights_statement,
    preview_url: r.preview_url, attribution_status: r.attribution_status, text_embedding: r.text_embedding, visual_embedding: r.visual_embedding,
    tags: r.tags, entity_ids: r.entity_ids,
  };
}

function toItem(r: Row, s: ScoreResult | null, redundancy: FeedItem['redundancy'] = [], score?: number): FeedItem {
  return {
    id: r.id, refNumber: r.ref_number, refLabel: formatRefNumber(r.ref_number), title: r.title, creatorName: r.creator_name,
    sourceId: r.source_id, sourceName: r.source_name, originalUrl: r.original_url, previewUrl: r.preview_url,
    thumbnailUrl: r.thumbnail_url, mediaType: r.media_type, width: r.width, height: r.height, publishedRaw: r.published_raw,
    publishedDate: r.published_date, publishedPrecision: r.published_precision, discoveredAt: r.discovered_at,
    status: r.status, attributionStatus: r.attribution_status, tags: r.tags, duplicateCandidates: r.dup_count,
    score: score ?? s?.total ?? null, reasons: s?.reasons ?? [], caveats: s?.caveats ?? [], redundancy,
  };
}

export async function queryFeed(q: FeedQuery): Promise<{ items: FeedItem[]; total: number; nextOffset: number | null; rankingVersion: number | null; semanticModel: string | null }> {
  const { sql, params } = buildWhere(q);
  const countRes = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM reference_items r ${sql}`, params);
  const total = countRes.rows[0]!.n;

  if (q.sort !== 'ranked' && !q.semantic) {
    const order = q.sort === 'recent' ? 'r.discovered_at DESC, r.ref_number DESC' : 'r.ref_number DESC';
    const rows = await db().query<Row>(`${SELECT} ${sql} ORDER BY ${order} OFFSET ${q.offset} LIMIT ${q.limit}`, params);
    const next = q.offset + rows.rows.length < total ? q.offset + rows.rows.length : null;
    return { items: rows.rows.map((r) => toItem(r, null)), total, nextOffset: next, rankingVersion: null, semanticModel: null };
  }

  // Ranked or semantic: score a bounded candidate set in the application.
  // At single-editor scale (thousands of items) this is fast; see docs/ARCHITECTURE.md for scaling notes.
  const CANDIDATES = 2000;
  const rows = await db().query<Row>(`${SELECT} ${sql} ORDER BY r.discovered_at DESC LIMIT ${CANDIDATES}`, params);
  const [config, profile] = await Promise.all([getActiveRankingConfig(), getEditorialProfile()]);
  const queryText = [q.semantic, q.q && parseRefNumber(q.q) === null ? q.q : null].filter(Boolean).join(' ');
  const queryEmbedding = queryText ? textEmbedder.embed(queryText) : null;

  let scored = rows.rows.map((r) => {
    const s = scoreReference(toScorable(r), profile, config.weights, {
      mode: q.mode, novelty: q.novelty, queryEmbedding, queryLabel: queryText || null,
      historicalExposurePenalty: config.diversity.historical_exposure_penalty,
    });
    return { row: r, s };
  });
  if (q.semantic && queryEmbedding) {
    // Semantic search keeps only items with some lexical-semantic overlap with the concept text.
    scored = scored.filter(({ row }) => cosine(row.text_embedding, queryEmbedding) > 0.05);
  }
  if (q.minScore !== undefined) scored = scored.filter(({ s }) => s.total >= q.minScore!);
  const diversified = diversify(
    scored.map(({ row, s }) => ({ id: row.id, score: s.total, creator: row.creator_name, source: row.source_id, tags: row.tags, embedding: row.text_embedding, row, s })),
    config.diversity,
  );
  const page = diversified.slice(q.offset, q.offset + q.limit);
  const filteredTotal = q.semantic || q.minScore !== undefined ? diversified.length : total;
  return {
    items: page.map((d) => toItem(d.item.row, d.item.s, d.redundancy, Math.max(0, d.adjusted))),
    total: filteredTotal,
    nextOffset: q.offset + page.length < diversified.length ? q.offset + page.length : null,
    rankingVersion: config.version,
    semanticModel: queryEmbedding ? textEmbedder.model : null,
  };
}

export async function loadRow(where: 'id' | 'ref_number', value: string | number): Promise<Row | null> {
  const r = await db().query<Row>(`${SELECT} WHERE r.${where} = $1`, [value]);
  return r.rows[0] ?? null;
}
