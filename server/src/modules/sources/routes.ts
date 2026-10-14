import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { assertSafeUrlShape, BlockedUrlError } from '../../lib/ssrf.js';
import { badRequest, AppError } from '../../lib/errors.js';
import { ADAPTERS, httpClient } from './registry.js';
import { runSourceSearch } from './service.js';
import { importFromUrl } from './adapters/manual-url.js';
import { ingestReference } from '../references/ingest.js';
import { formatRefNumber } from '../references/types.js';
import { parseFeed } from './adapters/rss.js';

export async function sourceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sources', async () => {
    const rows = (await db().query('SELECT * FROM sources ORDER BY name')).rows as Record<string, unknown>[];
    const counts = (await db().query<{ source_id: string; n: number }>(`SELECT source_id, count(*)::int AS n FROM reference_items WHERE deleted_at IS NULL GROUP BY source_id`)).rows;
    const feeds = (await db().query('SELECT * FROM rss_feeds ORDER BY created_at')).rows;
    return {
      sources: ADAPTERS.map((a) => {
        const row = rows.find((r) => r.id === a.id) ?? {};
        return {
          ...row,
          capabilities: a.capabilities,
          accessNotes: a.accessNotes,
          missingConfiguration: a.missingConfiguration(env()),
          searchable: typeof a.search === 'function',
          referenceCount: counts.find((c) => c.source_id === a.id)?.n ?? 0,
        };
      }),
      feeds,
    };
  });

  app.patch('/api/sources/:id', async (req) => {
    const { id } = z.object({ id: z.string().max(60) }).parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    const r = await db().query(
      `UPDATE sources SET enabled = $2, status = CASE WHEN $2 THEN (CASE WHEN status = 'disabled' THEN 'unverified' ELSE status END) ELSE 'disabled' END, updated_at = now() WHERE id = $1`,
      [id, body.enabled],
    );
    if (!r.rowCount) throw badRequest('Unknown source');
    return { ok: true };
  });

  // Live connectivity check: performs one small real search and records the outcome.
  app.post('/api/sources/:id/test', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { id } = z.object({ id: z.string().max(60) }).parse(req.params);
    const query = z.object({ query: z.string().min(1).max(200).default('poster') }).parse(req.body ?? {}).query;
    const out = await runSourceSearch(id, { query, page: 1, perPage: 3 });
    return {
      ok: out.ok,
      status: out.status,
      error: out.error,
      sample: out.result?.items.slice(0, 3).map((i) => ({ title: i.title, url: i.originalUrl, creator: i.creatorName ?? null })),
    };
  });

  app.post('/api/sources/rss/feeds', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ url: z.string().url().max(2000) }).parse(req.body);
    try {
      assertSafeUrlShape(body.url);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    // Validate that it is a feed before saving it
    let title: string | undefined;
    try {
      const res = await httpClient().getText(body.url, { maxBytes: 3_000_000, rateKey: 'rss-validate', ratePerMinute: 10 });
      const parsed = parseFeed(res.body, body.url);
      if (parsed.entries.length === 0 && !parsed.title) throw new Error('No RSS or Atom entries found at this URL');
      title = parsed.title;
    } catch (e) {
      if (e instanceof BlockedUrlError) throw badRequest(e.message);
      throw new AppError(422, 'feed_unreachable', `Could not read the feed: ${(e as Error).message}`);
    }
    const r = await db().query('INSERT INTO rss_feeds(url, title) VALUES ($1,$2) ON CONFLICT (url) DO UPDATE SET enabled = true RETURNING *', [body.url, title ?? null]);
    return r.rows[0];
  });

  app.delete('/api/sources/rss/feeds/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db().query('DELETE FROM rss_feeds WHERE id = $1', [id]);
    return { ok: true };
  });

  app.post('/api/import-url', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ url: z.string().url().max(2000), note: z.string().max(5000).optional() }).parse(req.body);
    let imported;
    try {
      imported = await importFromUrl(body.url, httpClient());
    } catch (e) {
      if (e instanceof BlockedUrlError) throw badRequest(e.message);
      throw new AppError(422, 'fetch_failed', `Could not read that URL: ${(e as Error).message}`);
    }
    const res = await ingestReference(imported.item, {
      method: 'manual_import',
      path: [{ kind: 'manual', label: 'Manual URL import', detail: imported.note }],
      actorId: req.user!.id,
    });
    if (body.note && res.created) {
      await db().query('INSERT INTO research_notes(reference_id, author_id, body) VALUES ($1,$2,$3)', [res.id, req.user!.id, body.note]);
    }
    return { ...res, refLabel: formatRefNumber(res.refNumber), note: imported.note };
  });
}
