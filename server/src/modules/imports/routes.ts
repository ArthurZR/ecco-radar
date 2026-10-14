import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { ImportOptionsSchema } from './schemas.js';
import { pruneOrphanFiles } from '../post-media/service.js';
import { commitImport, deleteImport, inspectCsv, rollbackImport, validateImport } from './service.js';

async function readUpload(req: FastifyRequest): Promise<{ buf: Buffer; filename: string; fields: Record<string, string> }> {
  const parts = req.parts();
  let buf: Buffer | null = null;
  let filename = 'upload.csv';
  const fields: Record<string, string> = {};
  for await (const part of parts) {
    if (part.type === 'file') {
      filename = part.filename.replace(/[^\w.\- ()]/g, '_').slice(0, 200);
      if (!/\.(csv|tsv|txt)$/i.test(filename)) throw badRequest('Upload a .csv file');
      buf = await part.toBuffer();
    } else {
      fields[part.fieldname] = String(part.value);
    }
  }
  if (!buf || buf.length === 0) throw badRequest('No file uploaded');
  return { buf, filename, fields };
}

const optionsFrom = (fields: Record<string, string>) => {
  try {
    return ImportOptionsSchema.parse(JSON.parse(fields.options ?? '{}'));
  } catch (e) {
    if (e instanceof SyntaxError) throw badRequest('options must be JSON');
    throw e;
  }
};

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/imports/inspect', async (req) => {
    const { buf, filename } = await readUpload(req);
    return inspectCsv(buf, filename);
  });

  app.post('/api/imports/preview', async (req) => {
    const { buf, fields } = await readUpload(req);
    const v = await validateImport(buf, optionsFrom(fields));
    // Return the rows that need attention plus a small sample; the file itself is not stored.
    return {
      summary: v.summary,
      warnings: v.warnings,
      problems: v.rows.filter((r) => r.outcome === 'invalid').slice(0, 200).map((r) => ({ row: r.rowIndex + 2, errors: r.errors })),
      sample: v.rows.filter((r) => r.outcome === 'imported' || r.outcome === 'duplicate').slice(0, 8).map((r) => ({ row: r.rowIndex + 2, outcome: r.outcome, post: r.post, daily: r.daily })),
    };
  });

  app.post('/api/imports/commit', async (req) => {
    const { buf, filename, fields } = await readUpload(req);
    return commitImport(buf, filename, optionsFrom(fields), req.user!.id);
  });

  app.get('/api/imports', async () => (await db().query(
    `SELECT id, kind, filename, account_filter, row_count, imported_count, skipped_count, duplicate_count, invalid_count, status, created_at, rolled_back_at
       FROM import_batches ORDER BY created_at DESC`,
  )).rows);

  app.get('/api/imports/:id/rows', async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const q = z.object({ outcome: z.enum(['imported', 'skipped_account', 'duplicate', 'invalid']).optional() }).parse(req.query);
    return (await db().query(
      `SELECT row_index, outcome, errors, raw FROM import_raw_rows WHERE batch_id = $1 AND ($2::text IS NULL OR outcome = $2) ORDER BY row_index LIMIT 500`,
      [id, q.outcome ?? null],
    )).rows;
  });

  app.post('/api/imports/:id/rollback', async (req) => {
    const out = await rollbackImport(z.object({ id: z.string().uuid() }).parse(req.params).id, req.user!.id);
    // Posts removed by the rollback take their images with them; delete the stored files too.
    await pruneOrphanFiles();
    return out;
  });
  app.delete('/api/imports/:id', async (req) => deleteImport(z.object({ id: z.string().uuid() }).parse(req.params).id));
}
