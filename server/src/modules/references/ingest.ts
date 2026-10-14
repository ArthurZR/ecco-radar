import type { PoolClient } from 'pg';
import { canonicalizeUrl, tryCanonicalizeUrl } from '../../lib/canonical-url.js';
import { parseLooseDate } from '../../lib/dates.js';
import { referenceEmbeddingText, textEmbedder } from '../../lib/embedding.js';
import { stripHtml } from '../../lib/text.js';
import { withTransaction } from '../../db/pool.js';
import { DiscoveredItemSchema, type DiscoveredItem, type ProvenanceStep } from './types.js';
import { detectDuplicates } from './duplicates.js';

export interface DiscoveryContext {
  sessionId?: string | null;
  queryId?: string | null;
  method: 'search' | 'manual_import' | 'rss' | 'related_reference';
  queryText?: string | null;
  path: ProvenanceStep[];
  rank?: number | null;
  scoreSnapshot?: unknown;
  actorId?: string | null;
}

export interface IngestResult {
  id: string;
  refNumber: number;
  created: boolean;
  /** true when the editor previously deleted this URL; it is not resurrected */
  tombstoned: boolean;
  duplicateCandidates: number;
}

function clean(s: string | undefined, max: number): string | null {
  if (!s) return null;
  const t = stripHtml(s).trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Stores a discovered item. Idempotent on the canonical URL and on (source, source item id):
 * a rediscovery only adds a provenance record. Permanent numbers come from the database sequence.
 */
export async function ingestReference(input: DiscoveredItem, ctx: DiscoveryContext, client?: PoolClient): Promise<IngestResult> {
  const item = DiscoveredItemSchema.parse(input);
  const canonical = canonicalizeUrl(item.originalUrl);
  const run = async (c: PoolClient): Promise<IngestResult> => {
    const existing = await c.query<{ id: string; ref_number: number; deleted_at: string | null }>(
      `SELECT id, ref_number, deleted_at FROM reference_items
        WHERE canonical_url = $1 OR (source_id = $2 AND source_item_id = $3) LIMIT 1`,
      [canonical, item.sourceId, item.sourceItemId ?? null],
    );
    let row = existing.rows[0];
    let created = false;
    if (!row) {
      const title = clean(item.title, 1000);
      const description = clean(item.description, 20000);
      const creator = clean(item.creatorName, 500);
      const date = parseLooseDate(item.publishedRaw);
      const tags = [...new Set(item.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 60);
      const embedding = textEmbedder.embed(referenceEmbeddingText({ title, description, creator_name: creator, tags }));
      const inserted = await c.query<{ id: string; ref_number: number }>(
        `INSERT INTO reference_items (original_url, canonical_url, source_id, source_item_id, creator_name, creator_url,
           title, description, published_raw, published_date, published_precision, preview_url, thumbnail_url,
           media_type, width, height, duration_seconds, license, rights_statement, attribution_status,
           text_embedding, text_embedding_model, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT DO NOTHING
         RETURNING id, ref_number`,
        [
          item.originalUrl, canonical, item.sourceId, item.sourceItemId ?? null, creator, item.creatorUrl ?? null,
          title, description, item.publishedRaw ?? null, date.date, date.precision, item.previewUrl ?? null,
          item.thumbnailUrl ?? null, item.mediaType, item.width ?? null, item.height ?? null,
          item.durationSeconds ?? null, item.license ?? null, item.rightsStatement ?? null,
          creator ? 'source_provided' : 'unknown', embedding, textEmbedder.model, ctx.actorId ?? null,
        ],
      );
      if (inserted.rows[0]) {
        row = { ...inserted.rows[0], deleted_at: null };
        created = true;
        for (const tag of tags) {
          await c.query(
            `INSERT INTO reference_tags(reference_id, tag, origin, state) VALUES ($1, $2, 'source', 'confirmed') ON CONFLICT DO NOTHING`,
            [row.id, tag],
          );
        }
        for (const e of item.entities) {
          const ent = await upsertEntity(c, e.label, e.kind, e.wikidataId);
          await c.query(
            `INSERT INTO reference_entities(reference_id, entity_id, predicate, evidence, provenance)
             VALUES ($1, $2, $3, 'documented', $4) ON CONFLICT DO NOTHING`,
            [row.id, ent, e.predicate, e.provenance],
          );
        }
        const sources = [
          { url: item.originalUrl, title: title ?? undefined, kind: 'original_source' as const },
          ...(item.creatorUrl ? [{ url: item.creatorUrl, title: creator ?? undefined, kind: 'creator_page' as const }] : []),
          ...item.researchSources,
        ];
        for (const s of sources) {
          await c.query(
            `INSERT INTO research_sources(reference_id, url, title, kind, added_by) VALUES ($1,$2,$3,$4,'system') ON CONFLICT DO NOTHING`,
            [row.id, s.url, s.title ?? null, s.kind],
          );
        }
      } else {
        // lost a race with a concurrent insert of the same URL
        const again = await c.query<{ id: string; ref_number: number; deleted_at: string | null }>(
          `SELECT id, ref_number, deleted_at FROM reference_items WHERE canonical_url = $1 OR (source_id = $2 AND source_item_id = $3) LIMIT 1`,
          [canonical, item.sourceId, item.sourceItemId ?? null],
        );
        row = again.rows[0];
        if (!row) throw new Error('Reference insert conflicted but no existing row was found');
      }
    }
    await c.query(
      `INSERT INTO reference_discoveries(reference_id, session_id, query_id, source_id, method, query_text, path, rank_in_results, score_snapshot, is_first)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [row.id, ctx.sessionId ?? null, ctx.queryId ?? null, item.sourceId, ctx.method, ctx.queryText ?? null,
        JSON.stringify(ctx.path), ctx.rank ?? null, ctx.scoreSnapshot ? JSON.stringify(ctx.scoreSnapshot) : null, created],
    );
    const duplicateCandidates = created ? await detectDuplicates(c, row.id, tryCanonicalizeUrl(item.previewUrl)) : 0;
    return { id: row.id, refNumber: row.ref_number, created, tombstoned: !!row.deleted_at, duplicateCandidates };
  };
  return client ? run(client) : withTransaction(run);
}

export async function upsertEntity(c: PoolClient, label: string, kind: string, wikidataId?: string): Promise<string> {
  if (wikidataId) {
    const r = await c.query<{ id: string }>(
      `INSERT INTO cultural_entities(kind, label, wikidata_id, external_url) VALUES ($1,$2,$3,$4)
       ON CONFLICT (wikidata_id) DO UPDATE SET label = cultural_entities.label RETURNING id`,
      [kind, label, wikidataId, `https://www.wikidata.org/wiki/${wikidataId}`],
    );
    return r.rows[0]!.id;
  }
  const found = await c.query<{ id: string }>(
    `SELECT id FROM cultural_entities WHERE lower(label) = lower($1) AND kind = $2 AND wikidata_id IS NULL LIMIT 1`,
    [label, kind],
  );
  if (found.rows[0]) return found.rows[0].id;
  const r = await c.query<{ id: string }>(`INSERT INTO cultural_entities(kind, label) VALUES ($1,$2) RETURNING id`, [kind, label]);
  return r.rows[0]!.id;
}
