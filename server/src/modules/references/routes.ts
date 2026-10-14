import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { FeedQuerySchema, queryFeed } from './feed.js';
import { getReferenceDetail } from './detail.js';
import {
  StatusChangeSchema, TagEditSchema, ReportSchema, RelationshipDecisionSchema,
  changeStatus, addNote, updateNote, editTag, report, decideRelationship, deleteReference, restoreReference,
} from './actions.js';
import { STATUS_META, STATUSES, REJECTION_REASONS } from './status.js';
import { parseRefNumber } from './types.js';
import { analyzeReferenceImage } from './visual.js';
import { clusterReferences } from './clusters.js';
import { detectReferenceText, reviewDetectedText } from './detected-text.js';
import { referencePerformance } from '../insights/reference-performance.js';
import { ExplorationParamsSchema } from '../exploration/engine.js';
import { mediaDir } from '../post-media/service.js';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';

const RefParam = z.object({ ref: z.string() });

async function idForRef(ref: string): Promise<string> {
  const n = parseRefNumber(ref);
  if (n === null) throw badRequest('Invalid reference number');
  const r = await db().query<{ id: string }>('SELECT id FROM reference_items WHERE ref_number = $1', [n]);
  if (!r.rows[0]) throw notFound('Reference');
  return r.rows[0].id;
}

const SavedSearchSchema = z.object({
  name: z.string().trim().min(1).max(120),
  scope: z.enum(['feed', 'exploration']),
  params: z.record(z.string(), z.unknown()),
});

export async function referenceRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/meta/statuses', async () => ({
    statuses: STATUSES.map((s) => ({ key: s, ...STATUS_META[s] })),
    rejectionReasons: REJECTION_REASONS,
  }));

  app.get('/api/references', async (req) => queryFeed(FeedQuerySchema.parse(req.query)));

  app.get('/api/references/:ref', async (req) => {
    const { ref } = RefParam.parse(req.params);
    const n = parseRefNumber(ref);
    if (n === null) throw badRequest('Invalid reference number');
    return getReferenceDetail(n);
  });

  app.post('/api/references/:ref/status', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return changeStatus(id, StatusChangeSchema.parse(req.body), req.user!.id);
  });

  app.post('/api/references/:ref/notes', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return addNote(id, z.object({ body: z.string() }).parse(req.body).body, req.user!.id);
  });

  app.patch('/api/references/:ref/notes/:noteId', async (req) => {
    const { ref, noteId } = z.object({ ref: z.string(), noteId: z.string().uuid() }).parse(req.params);
    const id = await idForRef(ref);
    return updateNote(id, noteId, z.object({ body: z.string() }).parse(req.body).body, req.user!.id);
  });

  app.post('/api/references/:ref/tags', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return editTag(id, TagEditSchema.parse(req.body), req.user!.id);
  });

  app.post('/api/references/:ref/report', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return report(id, ReportSchema.parse(req.body), req.user!.id);
  });

  app.post('/api/references/:ref/relationships', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return decideRelationship(id, RelationshipDecisionSchema.parse(req.body), req.user!.id);
  });

  app.post('/api/references/:ref/delete', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    const body = z.object({ confirm: z.literal(true), reason: z.string().max(2000).optional() }).parse(req.body);
    return deleteReference(id, body.reason, req.user!.id);
  });

  app.post('/api/references/:ref/restore', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return restoreReference(id, req.user!.id);
  });

  // Analyse this reference's preview image now (the background sweep would otherwise pick it up)
  app.post('/api/references/:ref/visual', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return analyzeReferenceImage(id);
  });

  // Facets for filter controls
  app.get('/api/references/:ref/performance', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    const r = await db().query<{ text_embedding: number[] | null; visual_embedding: number[] | null; visual_hash: string | null }>(
      'SELECT text_embedding, visual_embedding, visual_hash FROM reference_items WHERE id = $1', [id],
    );
    const row = r.rows[0];
    return referencePerformance(id, row?.text_embedding ?? null, { embedding: row?.visual_embedding ?? null, hash: row?.visual_hash ?? null });
  });

  // The local preview copy, only present where the source or licence permits it (see preview-cache.ts).
  app.get('/api/references/:ref/cached-preview', async (req, reply) => {
    const n = parseRefNumber(RefParam.parse(req.params).ref);
    if (n === null) throw badRequest('Invalid reference number');
    const r = await db().query<{ cached_preview_path: string | null }>('SELECT cached_preview_path FROM reference_items WHERE ref_number = $1', [n]);
    const rel = r.rows[0]?.cached_preview_path;
    if (!rel || !/^previews\/[0-9a-f-]{36}\.webp$/.test(rel)) throw notFound('Cached preview');
    reply.header('Content-Type', 'image/webp').header('Cache-Control', 'private, max-age=86400');
    return reply.send(createReadStream(join(mediaDir(), rel)));
  });

  app.post('/api/references/:ref/detected-text/run', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    return detectReferenceText(id);
  });

  app.post('/api/references/:ref/detected-text/review', async (req) => {
    const id = await idForRef(RefParam.parse(req.params).ref);
    const body = z.discriminatedUnion('action', [
      z.object({ action: z.literal('confirm') }),
      z.object({ action: z.literal('reject') }),
      z.object({ action: z.literal('reset') }),
      z.object({ action: z.literal('correct'), text: z.string().max(2000) }),
    ]).parse(req.body);
    return reviewDetectedText(id, body, req.user!.id);
  });

  app.get('/api/clusters', async (req) => {
    const { basis } = z.object({ basis: z.enum(['text', 'visual']).default('text') }).parse(req.query);
    return clusterReferences(basis);
  });

  app.get('/api/references-facets', async () => {
    const [sources, statuses, media, tags, creators] = await Promise.all([
      db().query(`SELECT s.id, s.name, count(r.id)::int AS n FROM sources s LEFT JOIN reference_items r ON r.source_id = s.id AND r.deleted_at IS NULL GROUP BY s.id ORDER BY s.name`),
      db().query(`SELECT status, count(*)::int AS n FROM reference_items WHERE deleted_at IS NULL GROUP BY status`),
      db().query(`SELECT media_type, count(*)::int AS n FROM reference_items WHERE deleted_at IS NULL GROUP BY media_type`),
      db().query(`SELECT lower(tag) AS tag, count(*)::int AS n FROM reference_tags WHERE state <> 'rejected' GROUP BY lower(tag) ORDER BY n DESC LIMIT 60`),
      db().query(`SELECT creator_name, count(*)::int AS n FROM reference_items WHERE deleted_at IS NULL AND creator_name IS NOT NULL GROUP BY creator_name ORDER BY n DESC LIMIT 40`),
    ]);
    return { sources: sources.rows, statuses: statuses.rows, mediaTypes: media.rows, tags: tags.rows, creators: creators.rows };
  });

  // Decision history across the archive (pattern inspection)
  app.get('/api/decisions', async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100), type: z.string().max(40).optional() }).parse(req.query);
    const r = await db().query(
      `SELECT d.id, d.decision_type, d.reason_code, d.reason_scope, d.notes, d.previous_status, d.new_status, d.created_at,
              r.ref_number, r.title, r.creator_name, r.source_id
         FROM editorial_decisions d JOIN reference_items r ON r.id = d.reference_id
        WHERE ($1::text IS NULL OR d.decision_type = $1)
        ORDER BY d.created_at DESC LIMIT $2`,
      [q.type ?? null, q.limit],
    );
    const summary = await db().query(
      `SELECT new_status, reason_code, reason_scope, count(*)::int AS n FROM editorial_decisions
        WHERE decision_type = 'status_change' GROUP BY 1,2,3 ORDER BY n DESC`,
    );
    return { decisions: r.rows, summary: summary.rows };
  });

  // Saved searches (feed filters or exploration presets)
  app.get('/api/saved-searches', async () => (await db().query('SELECT * FROM saved_searches ORDER BY created_at DESC')).rows);
  app.post('/api/saved-searches', async (req) => {
    const body = SavedSearchSchema.parse(req.body);
    // Reject params the feed or the exploration engine would not accept.
    if (body.scope === 'feed') FeedQuerySchema.parse(body.params);
    else ExplorationParamsSchema.parse(body.params);
    const r = await db().query('INSERT INTO saved_searches(name, scope, params, created_by) VALUES ($1,$2,$3,$4) RETURNING *', [
      body.name, body.scope, JSON.stringify(body.params), req.user!.id,
    ]);
    return r.rows[0];
  });
  app.delete('/api/saved-searches/:id', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await db().query('DELETE FROM saved_searches WHERE id = $1', [id]);
    return { ok: true };
  });
}
