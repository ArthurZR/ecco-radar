import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import sharp from 'sharp';
import { db } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { analyzeImage, VISUAL_HASH_MODEL, VISUAL_MODEL, type VisualAnalysis } from '../../lib/visual.js';
import { invalidateProfile } from '../ranking/profile.js';
import {
  ExportZip, MAX_IMAGE_BYTES, NO_POSTS_FILE, isImageUri, isVideoUri, matchExportPosts, type CandidatePost,
} from './instagram-export.js';

/**
 * Images of eccö's own published posts. These are the editor's own media, supplied by the editor,
 * so a downscaled copy (longest side 640 px, WebP) is kept for display and analysis. Originals are
 * not stored. Nothing here is sent anywhere.
 */

const STORED_SIDE = 640;

export function mediaDir(): string {
  return resolve(env().MEDIA_DIR);
}

const filePath = (fileName: string) => join(mediaDir(), fileName);

/** Pixel-measured descriptors. They describe brightness and colour intensity, nothing about subject. */
export function toneOf(meanLuminance: number): 'dark' | 'mid-tone' | 'light' {
  return meanLuminance < 0.33 ? 'dark' : meanLuminance > 0.66 ? 'light' : 'mid-tone';
}
export function colourfulnessOf(meanSaturation: number): 'muted' | 'moderate' | 'vivid' {
  return meanSaturation < 0.2 ? 'muted' : meanSaturation > 0.45 ? 'vivid' : 'moderate';
}

interface AttachInput {
  postId: string;
  buf: Buffer;
  origin: 'instagram_export' | 'upload';
  position: number;
  originalName: string | null;
  matchNote: string;
  importId: string | null;
  userId: string | null;
}

export type AttachOutcome = { status: 'added'; mediaId: string } | { status: 'already_attached' } | { status: 'unreadable'; error: string };

export async function attachImage(input: AttachInput): Promise<AttachOutcome> {
  const sha256 = createHash('sha256').update(input.buf).digest('hex');
  const existing = await db().query('SELECT 1 FROM historical_post_media WHERE post_id = $1 AND sha256 = $2', [input.postId, sha256]);
  if (existing.rowCount) return { status: 'already_attached' };

  let analysis: VisualAnalysis;
  let stored: Buffer;
  try {
    analysis = await analyzeImage(input.buf);
    stored = await sharp(input.buf, { limitInputPixels: 50_000_000 })
      .rotate()
      .resize(STORED_SIDE, STORED_SIDE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();
  } catch (e) {
    return { status: 'unreadable', error: e instanceof Error ? e.message : 'Not a readable image' };
  }

  const id = randomUUID();
  const fileName = `${id}.webp`;
  await mkdir(mediaDir(), { recursive: true });
  await writeFile(filePath(fileName), stored);
  try {
    await db().query(
      `INSERT INTO historical_post_media(id, post_id, origin, import_id, position, sha256, file_name, original_name, width, height,
                                         visual_hash, visual_hash_model, visual_embedding, visual_model, mean_luminance, mean_saturation, match_note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [id, input.postId, input.origin, input.importId, input.position, sha256, fileName, input.originalName?.slice(0, 300) ?? null,
        analysis.width, analysis.height, analysis.dhash, VISUAL_HASH_MODEL, analysis.embedding, VISUAL_MODEL,
        analysis.stats.meanLuminance, analysis.stats.meanSaturation, input.matchNote, input.userId],
    );
  } catch (e) {
    await rm(filePath(fileName), { force: true });
    if ((e as { code?: string }).code === '23505') return { status: 'already_attached' };
    throw e;
  }
  await refreshPostVisualFeatures(input.postId);
  return { status: 'added', mediaId: id };
}

/** Keeps media_available and the pixel-measured features of a post in step with its images. */
async function refreshPostVisualFeatures(postId: string): Promise<void> {
  // The post is described by its first image: the cover a viewer sees first.
  const cover = await db().query<{ mean_luminance: number; mean_saturation: number }>(
    'SELECT mean_luminance, mean_saturation FROM historical_post_media WHERE post_id = $1 ORDER BY position, created_at LIMIT 1',
    [postId],
  );
  await db().query(`DELETE FROM historical_post_features WHERE post_id = $1 AND evidence = 'media'`, [postId]);
  await db().query('UPDATE historical_posts SET media_available = $2 WHERE id = $1', [postId, cover.rowCount! > 0]);
  invalidateProfile();
  const c = cover.rows[0];
  if (!c) return;
  await db().query(
    `INSERT INTO historical_post_features(post_id, feature_kind, value, evidence) VALUES ($1,'tone',$2,'media'), ($1,'colourfulness',$3,'media')
     ON CONFLICT DO NOTHING`,
    [postId, toneOf(c.mean_luminance), colourfulnessOf(c.mean_saturation)],
  );
}

export async function removeMedia(mediaId: string, userId: string): Promise<{ removed: true }> {
  const r = await db().query<{ post_id: string; file_name: string }>('DELETE FROM historical_post_media WHERE id = $1 RETURNING post_id, file_name', [mediaId]);
  if (!r.rowCount) throw notFound('Image');
  await rm(filePath(r.rows[0]!.file_name), { force: true });
  await refreshPostVisualFeatures(r.rows[0]!.post_id);
  await audit(userId, 'post_media_removed', mediaId, {});
  return { removed: true };
}

/** Removes every stored post image, or those of one export import. */
export async function removeAllMedia(userId: string, importId?: string): Promise<{ removed: number }> {
  const r = importId
    ? await db().query<{ post_id: string; file_name: string }>('DELETE FROM historical_post_media WHERE import_id = $1 RETURNING post_id, file_name', [importId])
    : await db().query<{ post_id: string; file_name: string }>('DELETE FROM historical_post_media RETURNING post_id, file_name');
  if (importId) await db().query('DELETE FROM post_media_imports WHERE id = $1', [importId]);
  else await db().query('DELETE FROM post_media_imports');
  for (const row of r.rows) await rm(filePath(row.file_name), { force: true });
  for (const postId of new Set(r.rows.map((x) => x.post_id))) await refreshPostVisualFeatures(postId);
  await audit(userId, importId ? 'post_media_import_undone' : 'post_media_all_removed', importId ?? null, { removed: r.rowCount });
  return { removed: r.rowCount ?? 0 };
}

/** Deletes stored files that no longer belong to a post (for example after a CSV import is rolled back). */
export async function pruneOrphanFiles(): Promise<number> {
  let names: string[];
  try {
    names = await readdir(mediaDir());
  } catch {
    return 0;
  }
  const known = new Set((await db().query<{ file_name: string }>('SELECT file_name FROM historical_post_media')).rows.map((r) => r.file_name));
  let removed = 0;
  for (const n of names) {
    if (/^[0-9a-f-]{36}\.webp$/.test(n) && !known.has(n)) {
      await rm(filePath(n), { force: true });
      removed++;
    }
  }
  return removed;
}

async function audit(userId: string | null, action: string, entityId: string | null, data: object): Promise<void> {
  await db().query(`INSERT INTO audit_events(actor_id, action, entity_type, entity_id, data) VALUES ($1,$2,'post_media',$3,$4)`, [userId, action, entityId, JSON.stringify(data)]);
}

// --- Instagram export import --------------------------------------------------------------------

export interface ExportImportSummary {
  importId: string | null;
  postsInExport: number;
  matchedPosts: number;
  imagesAdded: number;
  imagesAlreadyAttached: number;
  videosSkipped: number;
  missingFiles: number;
  unreadableImages: number;
  unmatched: { entry: string; date: string | null; caption: string; reason: string }[];
  note: string;
}

export async function importInstagramExport(zipPath: string, filename: string, account: string | null, userId: string): Promise<ExportImportSummary> {
  const zip = await ExportZip.open(zipPath).catch((e: Error) => {
    throw badRequest(e.message);
  });
  try {
    const { posts, files } = await zip.posts().catch((e: Error) => {
      throw badRequest(e.message);
    });
    if (!files.length) throw badRequest(NO_POSTS_FILE);

    const candidates = (await db().query<{ id: string; caption: string | null; published_at: Date | null }>(
      `SELECT p.id, p.caption, p.published_at FROM historical_posts p
        WHERE p.platform = 'instagram' AND ($1::text IS NULL OR lower(p.account_handle) = lower($1))
          AND EXISTS (SELECT 1 FROM historical_post_imports hi JOIN import_batches b ON b.id = hi.batch_id AND b.status = 'committed' WHERE hi.post_id = p.id)`,
      [account],
    )).rows.map((r): CandidatePost => ({ id: r.id, caption: r.caption, publishedAt: r.published_at ? r.published_at.getTime() : null }));
    if (!candidates.length) {
      throw badRequest('There are no imported Instagram posts to attach images to. Import the analytics CSV in Insights first.');
    }

    const matches = matchExportPosts(posts, candidates);
    const byKey = new Map(posts.map((p) => [p.key, p]));
    const imp = await db().query<{ id: string }>(
      `INSERT INTO post_media_imports(filename, account, created_by) VALUES ($1,$2,$3) RETURNING id`,
      [filename.slice(0, 200), account, userId],
    );
    const importId = imp.rows[0]!.id;
    const s: ExportImportSummary = {
      importId, postsInExport: posts.length, matchedPosts: 0, imagesAdded: 0, imagesAlreadyAttached: 0, videosSkipped: 0,
      missingFiles: 0, unreadableImages: 0, unmatched: [], note: '',
    };

    for (const m of matches) {
      const p = byKey.get(m.key)!;
      if (m.postId === null) {
        s.unmatched.push({
          entry: m.key, date: p.timestamp ? new Date(p.timestamp * 1000).toISOString() : null,
          caption: p.caption.replace(/\s+/g, ' ').slice(0, 120), reason: m.reason,
        });
        continue;
      }
      s.matchedPosts++;
      for (const item of p.media) {
        if (isVideoUri(item.uri)) {
          s.videosSkipped++;
          continue;
        }
        if (!isImageUri(item.uri)) continue;
        const entry = zip.find(item.uri);
        if (!entry) {
          s.missingFiles++;
          continue;
        }
        let buf: Buffer;
        try {
          buf = await zip.read(entry, MAX_IMAGE_BYTES);
        } catch {
          s.unreadableImages++;
          continue;
        }
        const out = await attachImage({
          postId: m.postId, buf, origin: 'instagram_export', position: item.position, originalName: item.uri,
          matchNote: `Instagram export ${m.key}: ${m.note}`, importId, userId,
        });
        if (out.status === 'added') s.imagesAdded++;
        else if (out.status === 'already_attached') s.imagesAlreadyAttached++;
        else s.unreadableImages++;
      }
    }
    s.note = [
      `${s.matchedPosts} of ${s.postsInExport} exported posts were tied to imported posts; ${s.unmatched.length} were left unmatched rather than guessed.`,
      s.videosSkipped ? `${s.videosSkipped} video file(s) were skipped: only still images are analysed.` : '',
      'Images are analysed for colour and tone only (colour-tone-v1); subjects and style are not recognised.',
    ].filter(Boolean).join(' ');
    const { importId: _omit, ...stored } = s;
    void _omit;
    if (s.imagesAdded === 0) {
      await db().query('DELETE FROM post_media_imports WHERE id = $1', [importId]);
      s.importId = null;
    } else {
      await db().query('UPDATE post_media_imports SET summary = $2 WHERE id = $1', [importId, JSON.stringify({ ...stored, unmatched: s.unmatched.slice(0, 500) })]);
    }
    await audit(userId, 'post_media_imported', s.importId, { filename, imagesAdded: s.imagesAdded, matchedPosts: s.matchedPosts });
    return s;
  } finally {
    zip.close();
  }
}
