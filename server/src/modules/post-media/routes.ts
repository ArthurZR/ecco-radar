import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { AppError, badRequest, notFound } from '../../lib/errors.js';
import { attachImage, importInstagramExport, mediaDir, removeAllMedia, removeMedia } from './service.js';

/** Instagram exports with media are large; the archive is streamed to a temporary file, never held in memory. */
const MAX_EXPORT_BYTES = 4 * 1024 ** 3;
const MAX_IMAGE_UPLOAD = 25 * 1024 * 1024;

const Id = z.object({ id: z.string().uuid() });

export async function postMediaRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/post-media/instagram-export', async (req) => {
    const q = z.object({ account: z.string().trim().min(1).max(100).optional() }).parse(req.query);
    const file = await req.file({ limits: { fileSize: MAX_EXPORT_BYTES, files: 1 } });
    if (!file) throw badRequest('No file uploaded');
    const name = file.filename.replace(/[^\w.\- ()]/g, '_').slice(0, 200);
    if (!/\.zip$/i.test(name)) {
      file.file.resume();
      throw badRequest('Upload the .zip file Instagram sent you');
    }
    const dir = await mkdtemp(join(tmpdir(), 'radar-ig-export-'));
    const path = join(dir, 'export.zip');
    try {
      await pipeline(file.file, createWriteStream(path));
      if (file.file.truncated) throw new AppError(413, 'too_large', 'The archive is larger than 4 GB. Request the download with lower media quality, or only the Content section.');
      return await importInstagramExport(path, name, q.account?.replace(/^@/, '') ?? null, req.user!.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  app.get('/api/post-media/imports', async () => (await db().query(
    `SELECT i.id, i.filename, i.account, i.summary, i.created_at, count(m.id)::int AS images
       FROM post_media_imports i LEFT JOIN historical_post_media m ON m.import_id = i.id
      GROUP BY i.id ORDER BY i.created_at DESC`,
  )).rows);

  app.delete('/api/post-media/imports/:id', async (req) => removeAllMedia(req.user!.id, Id.parse(req.params).id));
  app.delete('/api/post-media', async (req) => removeAllMedia(req.user!.id));

  app.get('/api/post-media/summary', async () => {
    const r = await db().query<{ posts: number; with_media: number; images: number; uploads: number; from_export: number }>(
      `SELECT (SELECT count(*) FROM historical_posts WHERE platform = 'instagram')::int AS posts,
              (SELECT count(*) FROM historical_posts WHERE platform = 'instagram' AND media_available)::int AS with_media,
              count(m.id)::int AS images,
              count(m.id) FILTER (WHERE m.origin = 'upload')::int AS uploads,
              count(m.id) FILTER (WHERE m.origin = 'instagram_export')::int AS from_export
         FROM historical_post_media m`,
    );
    return { ...r.rows[0]!, model: 'colour-tone-v1 + dhash-64' };
  });

  app.get('/api/historical-posts', async (req) => {
    const q = z.object({
      media: z.enum(['with', 'without', 'any']).default('any'),
      limit: z.coerce.number().int().min(1).max(100).default(30),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
    }).parse(req.query);
    const where = q.media === 'with' ? 'AND p.media_available' : q.media === 'without' ? 'AND NOT p.media_available' : '';
    const [rows, total] = await Promise.all([
      db().query(
        `SELECT p.id, p.account_handle AS account, left(p.caption, 200) AS caption, p.permalink, p.format, p.published_at AS "publishedAt",
                coalesce((SELECT json_agg(json_build_object('id', m.id, 'width', m.width, 'height', m.height, 'origin', m.origin, 'matchNote', m.match_note)
                                          ORDER BY m.position, m.created_at)
                            FROM historical_post_media m WHERE m.post_id = p.id), '[]') AS media
           FROM historical_posts p
          WHERE p.platform = 'instagram' ${where}
          ORDER BY p.published_at DESC NULLS LAST, p.id
          LIMIT $1 OFFSET $2`,
        [q.limit, q.offset],
      ),
      db().query<{ n: number }>(`SELECT count(*)::int AS n FROM historical_posts p WHERE p.platform = 'instagram' ${where}`),
    ]);
    return { total: total.rows[0]!.n, posts: rows.rows };
  });

  app.post('/api/historical-posts/:id/media', async (req) => {
    const { id } = Id.parse(req.params);
    const post = await db().query(`SELECT 1 FROM historical_posts WHERE id = $1`, [id]);
    if (!post.rowCount) throw notFound('Post');
    const file = await req.file({ limits: { fileSize: MAX_IMAGE_UPLOAD, files: 1 } });
    if (!file) throw badRequest('No file uploaded');
    const buf = await file.toBuffer().catch(() => {
      throw new AppError(413, 'too_large', 'Images must be 25 MB or smaller');
    });
    const position = (await db().query<{ n: number }>('SELECT count(*)::int AS n FROM historical_post_media WHERE post_id = $1', [id])).rows[0]!.n;
    const out = await attachImage({
      postId: id, buf, origin: 'upload', position, originalName: file.filename, importId: null, userId: req.user!.id,
      matchNote: 'Attached by the editor.',
    });
    if (out.status === 'unreadable') throw badRequest('That file is not an image RADAR can read (JPEG, PNG, WebP, GIF or AVIF).');
    if (out.status === 'already_attached') throw new AppError(409, 'conflict', 'This image is already attached to the post.');
    return out;
  });

  app.get('/api/post-media/:id/image', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const r = await db().query<{ file_name: string }>('SELECT file_name FROM historical_post_media WHERE id = $1', [id]);
    if (!r.rowCount) throw notFound('Image');
    reply.header('Content-Type', 'image/webp').header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(join(mediaDir(), r.rows[0]!.file_name)));
  });

  app.delete('/api/post-media/:id', async (req) => removeMedia(Id.parse(req.params).id, req.user!.id));
}
