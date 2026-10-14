import { db, withTransaction } from '../../db/pool.js';
import { analyzeImage, VISUAL_HASH_MODEL, VISUAL_MODEL } from '../../lib/visual.js';
import { httpClient } from '../sources/registry.js';
import { enqueue } from '../jobs/queue.js';
import { invalidateProfile } from '../ranking/profile.js';
import { detectDuplicates } from './duplicates.js';
import { cachePreviewIfPermitted } from './preview-cache.js';

const MAX_IMAGE_BYTES = 8_000_000;

export async function visualAnalysisEnabled(): Promise<boolean> {
  const r = await db().query<{ value: boolean }>(`SELECT value FROM app_settings WHERE key = 'visual_analysis_enabled'`);
  return r.rows[0]?.value ?? true;
}

/**
 * Downloads a reference's preview (GET only, SSRF-guarded, size-capped), computes the local
 * colour/tone vector and perceptual hash, and re-checks visual duplicates. Failures are recorded on
 * the item so the editor can see why, and are not retried automatically.
 */
export async function analyzeReferenceImage(id: string): Promise<{ ok: boolean; error?: string }> {
  const r = await db().query<{ thumbnail_url: string | null; preview_url: string | null; source_id: string; deleted_at: string | null }>(
    'SELECT thumbnail_url, preview_url, source_id, deleted_at FROM reference_items WHERE id = $1',
    [id],
  );
  const row = r.rows[0];
  if (!row || row.deleted_at) return { ok: false, error: 'Reference not found' };
  const url = row.thumbnail_url ?? row.preview_url;
  const record = async (error: string) => {
    await db().query(`UPDATE reference_items SET visual_analyzed_at = now(), visual_error = $2 WHERE id = $1`, [id, error.slice(0, 500)]);
    return { ok: false, error };
  };
  if (!url) return record('No preview image');
  let analysis;
  try {
    const res = await httpClient().getBytes(url, { maxBytes: MAX_IMAGE_BYTES, rateKey: `image:${row.source_id}`, ratePerMinute: 30, timeoutMs: 20_000, headers: { accept: 'image/*' } });
    if (!/^image\//i.test(res.contentType)) return record(`Preview is not an image (${res.contentType || 'unknown type'})`);
    analysis = await analyzeImage(res.body);
    // A local copy only where the source or the item's licence permits it; never fatal.
    await cachePreviewIfPermitted(id, res.body).catch(() => null);
  } catch (e) {
    return record(`Could not analyse preview: ${(e as Error).message}`);
  }
  await withTransaction(async (c) => {
    await c.query(
      `UPDATE reference_items SET visual_hash = $2, visual_hash_model = $3, visual_embedding = $4, visual_embedding_model = $5,
              visual_analyzed_at = now(), visual_error = NULL,
              width = coalesce(width, $6), height = coalesce(height, $7), updated_at = now()
        WHERE id = $1`,
      [id, analysis.dhash, VISUAL_HASH_MODEL, analysis.embedding, VISUAL_MODEL, analysis.width, analysis.height],
    );
    await detectDuplicates(c, id, null);
  });
  invalidateProfile();
  return { ok: true };
}

/** Queues analysis for references that have a preview and have not been analysed yet. */
export async function queuePendingVisualAnalysis(limit = 50): Promise<number> {
  if (!(await visualAnalysisEnabled())) return 0;
  const r = await db().query<{ id: string }>(
    `SELECT id FROM reference_items
      WHERE visual_analyzed_at IS NULL AND deleted_at IS NULL AND coalesce(thumbnail_url, preview_url) IS NOT NULL
      ORDER BY discovered_at DESC LIMIT $1`,
    [limit],
  );
  let n = 0;
  for (const { id } of r.rows) if (await enqueue('embed_reference', { referenceId: id, kind: 'visual' }, `visual:${id}`, 1)) n++;
  return n;
}

/** Clears earlier results or failures so the items are analysed again on the next sweep. */
export async function resetVisualAnalysis(onlyFailed: boolean): Promise<number> {
  const r = await db().query(
    `UPDATE reference_items SET visual_analyzed_at = NULL, visual_error = NULL WHERE deleted_at IS NULL ${onlyFailed ? 'AND visual_error IS NOT NULL' : ''}`,
  );
  await db().query(`DELETE FROM jobs WHERE kind = 'embed_reference' AND status IN ('done','failed') AND idempotency_key LIKE 'visual:%'`);
  return r.rowCount ?? 0;
}

export async function visualAnalysisStatus() {
  const r = await db().query<{ analysed: number; failed: number; pending: number; no_preview: number; cached: number }>(
    `SELECT count(*) FILTER (WHERE visual_embedding IS NOT NULL)::int AS analysed,
            count(*) FILTER (WHERE cached_preview_path IS NOT NULL)::int AS cached,
            count(*) FILTER (WHERE visual_error IS NOT NULL)::int AS failed,
            count(*) FILTER (WHERE visual_analyzed_at IS NULL AND coalesce(thumbnail_url, preview_url) IS NOT NULL)::int AS pending,
            count(*) FILTER (WHERE coalesce(thumbnail_url, preview_url) IS NULL)::int AS no_preview
       FROM reference_items WHERE deleted_at IS NULL`,
  );
  return { ...r.rows[0]!, model: VISUAL_MODEL, hashModel: VISUAL_HASH_MODEL };
}
