import type { PoolClient } from 'pg';
import { cosine } from '../../lib/embedding.js';

export const TEXT_DUPLICATE_THRESHOLD = 0.93;
export const DHASH_MAX_DISTANCE = 6;

export function normalizeTitle(t: string | null | undefined): string {
  return (t ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\.(jpe?g|png|gif|webp|tiff?)$/i, '')
    .replace(/^file:/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function hammingHex(a: string, b: string): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY;
  let d = 0;
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

interface Candidate {
  id: string;
  method: string;
  score: number;
}

/**
 * Finds likely duplicates of a newly stored reference and records them as *candidates* for the
 * editor to confirm or dismiss. Exact canonical-URL duplicates never reach this point because the
 * URL is unique. Nothing is merged automatically.
 */
export async function detectDuplicates(c: PoolClient, id: string, previewCanonical: string | null): Promise<number> {
  const self = await c.query<{ title: string | null; creator_name: string | null; text_embedding: number[] | null; visual_hash: string | null; preview_url: string | null }>(
    'SELECT title, creator_name, text_embedding, visual_hash, preview_url FROM reference_items WHERE id = $1',
    [id],
  );
  const me = self.rows[0];
  if (!me) return 0;
  const found = new Map<string, Candidate>();
  // Deterministic evidence outranks fuzzy similarity when several methods agree.
  const PRIORITY: Record<string, number> = { same_preview_url: 4, title_creator: 3, dhash: 2, text_embedding: 1 };
  const add = (cand: Candidate) => {
    const prev = found.get(cand.id);
    if (!prev || (PRIORITY[prev.method] ?? 0) < (PRIORITY[cand.method] ?? 0)) found.set(cand.id, cand);
  };

  if (me.preview_url || previewCanonical) {
    const r = await c.query<{ id: string }>(
      `SELECT id FROM reference_items WHERE id <> $1 AND deleted_at IS NULL AND preview_url = ANY($2::text[])`,
      [id, [me.preview_url, previewCanonical].filter(Boolean)],
    );
    r.rows.forEach((x) => add({ id: x.id, method: 'same_preview_url', score: 1 }));
  }

  const nt = normalizeTitle(me.title);
  if (nt.length >= 6) {
    const r = await c.query<{ id: string; title: string | null; creator_name: string | null }>(
      `SELECT id, title, creator_name FROM reference_items
        WHERE id <> $1 AND deleted_at IS NULL AND lower(coalesce(creator_name,'')) = lower(coalesce($2,''))
          AND title IS NOT NULL LIMIT 500`,
      [id, me.creator_name],
    );
    r.rows.filter((x) => normalizeTitle(x.title) === nt).forEach((x) => add({ id: x.id, method: 'title_creator', score: 0.95 }));
  }

  if (me.text_embedding) {
    const r = await c.query<{ id: string; text_embedding: number[] }>(
      `SELECT id, text_embedding FROM reference_items
        WHERE id <> $1 AND deleted_at IS NULL AND text_embedding IS NOT NULL
        ORDER BY discovered_at DESC LIMIT 3000`,
      [id],
    );
    for (const x of r.rows) {
      const s = cosine(me.text_embedding, x.text_embedding);
      if (s >= TEXT_DUPLICATE_THRESHOLD) add({ id: x.id, method: 'text_embedding', score: s });
    }
  }

  if (me.visual_hash) {
    const r = await c.query<{ id: string; visual_hash: string }>(
      `SELECT id, visual_hash FROM reference_items WHERE id <> $1 AND deleted_at IS NULL AND visual_hash IS NOT NULL`,
      [id],
    );
    for (const x of r.rows) {
      const d = hammingHex(me.visual_hash, x.visual_hash);
      if (d <= DHASH_MAX_DISTANCE) add({ id: x.id, method: 'dhash', score: 1 - d / 64 });
    }
  }

  let n = 0;
  for (const cand of found.values()) {
    const dismissed = await c.query(
      `SELECT 1 FROM reference_relations WHERE kind = 'not_duplicate' AND ((from_id = $1 AND to_id = $2) OR (from_id = $2 AND to_id = $1))`,
      [id, cand.id],
    );
    if (dismissed.rowCount) continue;
    const ins = await c.query(
      `INSERT INTO reference_relations(from_id, to_id, kind, score, method, evidence)
       VALUES ($1, $2, 'duplicate_candidate', $3, $4, 'computed') ON CONFLICT DO NOTHING`,
      [id, cand.id, cand.score, cand.method],
    );
    n += ins.rowCount ?? 0;
  }
  return n;
}
