import { db } from '../../db/pool.js';
import { centroid } from '../../lib/embedding.js';
import type { EditorialProfile, PostResonance } from './score.js';

/**
 * Builds the editorial profile used for ranking from:
 *  1. the editor's explicit decisions (authoritative), counted only after the latest reset;
 *  2. eccö's own published history (imported captions) as editorial context;
 *  3. audience metrics, kept in a separate structure and used only for the resonance component.
 */

const POSITIVE_STATUSES = ['approved_consideration', 'caption_draft', 'reviewed', 'approved_publication', 'manually_published'];
const STATUS_SIGNAL: Record<string, number> = {
  saved: 0.4,
  approved_consideration: 1,
  caption_draft: 1,
  reviewed: 1,
  approved_publication: 1.3,
  manually_published: 1.3,
  archived: 0,
  discovered: 0,
};
const SHRINK = 3;

let cache: { at: number; profile: EditorialProfile } | null = null;
const TTL_MS = 30_000;

export function invalidateProfile(): void {
  cache = null;
}

export async function getEditorialProfile(): Promise<EditorialProfile> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.profile;
  const profile = await buildProfile();
  cache = { at: Date.now(), profile };
  return profile;
}

export interface LearnedFeature {
  key: string;
  weight: number;
  evidence: number;
  overridden: boolean;
}

/** Signals from the latest (non-reverted) status decision of each reference since the last reset. */
export async function computeLearnedFeatures(): Promise<LearnedFeature[]> {
  const { rows } = await db().query<{
    reference_id: string; new_status: string; reason_scope: string | null; reason_code: string | null;
    source_id: string; creator_name: string | null; tags: string[] | null; entity_ids: string[] | null;
  }>(`
    WITH last_reset AS (
      SELECT coalesce(max(reset_at), '-infinity'::timestamptz) AS at FROM preference_resets WHERE undone_at IS NULL
    ), latest AS (
      SELECT DISTINCT ON (d.reference_id) d.reference_id, d.new_status, d.reason_scope, d.reason_code
        FROM editorial_decisions d, last_reset
       WHERE d.decision_type = 'status_change' AND d.reverted_at IS NULL AND d.created_at > last_reset.at
       ORDER BY d.reference_id, d.created_at DESC
    )
    SELECT l.*, r.source_id, r.creator_name,
      (SELECT array_agg(DISTINCT lower(t.tag)) FROM reference_tags t WHERE t.reference_id = r.id AND t.state <> 'rejected') AS tags,
      (SELECT array_agg(DISTINCT e.entity_id::text) FROM reference_entities e WHERE e.reference_id = r.id AND e.evidence IN ('documented','editor_confirmed')) AS entity_ids
    FROM latest l JOIN reference_items r ON r.id = l.reference_id WHERE r.deleted_at IS NULL`);

  const acc = new Map<string, { sum: number; n: number }>();
  const bump = (key: string, v: number) => {
    const a = acc.get(key) ?? { sum: 0, n: 0 };
    a.sum += v;
    a.n += 1;
    acc.set(key, a);
  };
  for (const r of rows) {
    const tagKeys = (r.tags ?? []).map((t) => `tag:${t}`);
    const entityKeys = (r.entity_ids ?? []).map((e) => `entity:${e}`);
    const creatorKey = r.creator_name ? [`creator:${r.creator_name.toLowerCase()}`] : [];
    const sourceKey = [`source:${r.source_id}`];
    if (r.new_status === 'rejected') {
      // A rejection is about this item unless the editor said otherwise.
      if (r.reason_code === 'weak_attribution') continue; // handled by source reliability, not taste
      switch (r.reason_scope) {
        case 'topic':
          [...tagKeys, ...entityKeys].forEach((k) => bump(k, -1));
          break;
        case 'creator':
          creatorKey.forEach((k) => bump(k, -1));
          break;
        case 'source':
          sourceKey.forEach((k) => bump(k, -1));
          break;
        default:
          [...tagKeys, ...creatorKey].forEach((k) => bump(k, -0.15));
      }
      continue;
    }
    const s = STATUS_SIGNAL[r.new_status] ?? 0;
    if (s === 0) continue;
    [...tagKeys, ...entityKeys, ...creatorKey].forEach((k) => bump(k, s));
    sourceKey.forEach((k) => bump(k, s * 0.3));
  }
  const overrides = await db().query<{ feature_kind: string; feature_value: string; weight: number }>('SELECT * FROM preference_overrides');
  const out = new Map<string, LearnedFeature>();
  for (const [key, a] of acc) {
    out.set(key, { key, weight: Math.max(-1, Math.min(1, a.sum / (a.n + SHRINK))), evidence: a.n, overridden: false });
  }
  for (const o of overrides.rows) {
    const key = `${o.feature_kind}:${o.feature_value.toLowerCase()}`;
    out.set(key, { key, weight: o.weight, evidence: out.get(key)?.evidence ?? 0, overridden: true });
  }
  return [...out.values()].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
}

export async function computeResonance(): Promise<{ posts: PostResonance[]; basis: string }> {
  // Latest observation of each metric per post (later imports supersede earlier ones).
  const { rows } = await db().query<{ id: string; platform: string; text_embedding: number[] | null; metrics: Record<string, number> }>(`
    WITH latest AS (
      SELECT DISTINCT ON (m.post_id, m.metric) m.post_id, m.metric, m.value
        FROM historical_post_metrics m JOIN import_batches b ON b.id = m.batch_id
       WHERE b.status = 'committed'
       ORDER BY m.post_id, m.metric, b.created_at DESC
    )
    SELECT p.id, p.platform, p.text_embedding, jsonb_object_agg(l.metric, l.value) AS metrics
      FROM historical_posts p JOIN latest l ON l.post_id = p.id
     GROUP BY p.id`);
  // Instagram: engagement per reach. Only posts with reach > 0 and at least one engagement metric.
  const ENG = ['likes', 'comments', 'shares', 'saves'];
  const scored = rows
    .filter((r) => r.platform === 'instagram' && r.text_embedding && (r.metrics.reach ?? 0) > 0 && ENG.some((k) => r.metrics[k] !== undefined))
    .map((r) => ({
      embedding: r.text_embedding!,
      rate: ENG.reduce((a, k) => a + (r.metrics[k] ?? 0), 0) / r.metrics.reach!,
    }));
  const sorted = [...scored].map((s) => s.rate).sort((a, b) => a - b);
  const pct = (x: number) => {
    // mid-rank percentile handles ties
    let lo = 0;
    while (lo < sorted.length && sorted[lo]! < x) lo++;
    let hi = lo;
    while (hi < sorted.length && sorted[hi] === x) hi++;
    return sorted.length > 1 ? (lo + (hi - lo - 1) / 2) / (sorted.length - 1) : 0.5;
  };
  return {
    posts: scored.map((s) => ({ embedding: s.embedding, percentile: pct(s.rate) })),
    basis: 'Instagram engagement per reach: (likes + comments + shares + saves) ÷ reach, as percentile rank',
  };
}

async function buildProfile(): Promise<EditorialProfile> {
  const [approved, history, archive, entities, sources, reports, learned, resonance] = await Promise.all([
    db().query<{ text_embedding: number[] }>(
      `SELECT text_embedding FROM reference_items WHERE deleted_at IS NULL AND text_embedding IS NOT NULL AND status = ANY($1) LIMIT 5000`,
      [POSITIVE_STATUSES],
    ),
    db().query<{ text_embedding: number[] }>(`SELECT text_embedding FROM historical_posts WHERE text_embedding IS NOT NULL LIMIT 5000`),
    db().query<{ text_embedding: number[] }>(
      `SELECT text_embedding FROM reference_items WHERE deleted_at IS NULL AND text_embedding IS NOT NULL
         AND status = ANY($1) LIMIT 5000`,
      [[...POSITIVE_STATUSES, 'archived']],
    ),
    db().query<{ entity_id: string }>(
      `SELECT DISTINCT e.entity_id FROM reference_entities e JOIN reference_items r ON r.id = e.reference_id
        WHERE r.status = ANY($1) AND r.deleted_at IS NULL AND e.evidence IN ('documented','editor_confirmed')`,
      [POSITIVE_STATUSES],
    ),
    db().query<{ id: string; baseline_reliability: number }>('SELECT id, baseline_reliability FROM sources'),
    db().query<{ source_id: string; total: number; reported: number }>(
      `SELECT source_id, count(*)::int AS total, count(*) FILTER (WHERE attribution_status = 'reported_incorrect')::int AS reported
         FROM reference_items WHERE deleted_at IS NULL GROUP BY source_id`,
    ),
    computeLearnedFeatures(),
    computeResonance(),
  ]);
  const reliability = new Map<string, number>();
  for (const s of sources.rows) {
    const rep = reports.rows.find((r) => r.source_id === s.id);
    const ratio = rep && rep.total > 0 ? rep.reported / rep.total : 0;
    reliability.set(s.id, s.baseline_reliability * (1 - 0.5 * ratio));
  }
  const approvedVecs = approved.rows.map((r) => r.text_embedding);
  const historyVecs = history.rows.map((r) => r.text_embedding);
  return {
    approvedCentroid: centroid(approvedVecs),
    approvedCount: approvedVecs.length,
    historyCentroid: centroid(historyVecs),
    historyCount: historyVecs.length,
    featureWeights: new Map(learned.map((f) => [f.key, f.weight])),
    archiveEmbeddings: archive.rows.map((r) => r.text_embedding),
    historyEmbeddings: historyVecs,
    approvedEntityIds: new Set(entities.rows.map((r) => r.entity_id)),
    sourceReliability: reliability,
    resonance: resonance.posts,
    resonanceBasis: resonance.basis,
  };
}
