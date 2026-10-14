import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { resetDb, appWithSession } from './helpers.js';

beforeEach(resetDb);
afterAll(closeDb);

async function setup() {
  const r = await ingestReference(
    { sourceId: 'manual', originalUrl: 'https://example.com/a', title: 'Synthetic item', creatorName: 'Test Creator', mediaType: 'image' },
    { method: 'manual_import', path: [] },
  );
  const s = await appWithSession();
  const post = (url: string, payload: unknown) => s.app.inject({ method: 'POST', url, headers: { cookie: s.cookie }, payload: payload as object });
  return { ...s, r, post };
}

describe('editorial states', () => {
  it('records each decision with previous and new state', async () => {
    const { r, post } = await setup();
    expect((await post(`/api/references/${r.refNumber}/status`, { status: 'saved' })).statusCode).toBe(200);
    expect((await post(`/api/references/${r.refNumber}/status`, { status: 'rejected', reasonCode: 'too_generic', reasonScope: 'topic' })).statusCode).toBe(200);
    const d = await db().query('SELECT previous_status, new_status, reason_code, reason_scope FROM editorial_decisions ORDER BY created_at');
    expect(d.rows).toEqual([
      { previous_status: 'discovered', new_status: 'saved', reason_code: null, reason_scope: null },
      { previous_status: 'saved', new_status: 'rejected', reason_code: 'too_generic', reason_scope: 'topic' },
    ]);
    // rejected items stay in the database as learning signals
    const row = await db().query('SELECT status, deleted_at FROM reference_items WHERE id = $1', [r.id]);
    expect(row.rows[0]).toEqual({ status: 'rejected', deleted_at: null });
  });

  it('enforces the publication pipeline order', async () => {
    const { r, post, app, cookie } = await setup();
    const skip = await post(`/api/references/${r.refNumber}/status`, { status: 'approved_publication' });
    expect(skip.statusCode).toBe(409);
    await post(`/api/references/${r.refNumber}/status`, { status: 'approved_consideration' });
    await post(`/api/references/${r.refNumber}/status`, { status: 'caption_draft' });
    const noCaption = await post(`/api/references/${r.refNumber}/status`, { status: 'reviewed' });
    expect(noCaption.statusCode).toBe(409);
    await app.inject({ method: 'PUT', url: `/api/captions/${r.refNumber}/final`, headers: { cookie }, payload: { body: 'Editor-written caption.' } });
    expect((await post(`/api/references/${r.refNumber}/status`, { status: 'reviewed' })).statusCode).toBe(200);
    expect((await post(`/api/references/${r.refNumber}/status`, { status: 'approved_publication' })).statusCode).toBe(200);
    expect((await post(`/api/references/${r.refNumber}/status`, { status: 'manually_published', publication: { platform: 'instagram' } })).statusCode).toBe(200);
    const rep = await db().query('SELECT verification, platform FROM publication_reports');
    expect(rep.rows).toEqual([{ verification: 'user_reported', platform: 'instagram' }]);
    // decisions can always be revisited
    expect((await post(`/api/references/${r.refNumber}/status`, { status: 'archived' })).statusCode).toBe(200);
  });

  it('keeps notes, tag corrections and attribution reports as history', async () => {
    const { r, post } = await setup();
    await post(`/api/references/${r.refNumber}/notes`, { body: 'Check the original magazine scan.' });
    await post(`/api/references/${r.refNumber}/tags`, { tag: 'Frutiger Aero', action: 'add' });
    await post(`/api/references/${r.refNumber}/report`, { kind: 'attribution_incorrect', notes: 'Creator is the uploader' });
    const ref = await db().query('SELECT attribution_status, verification_status FROM reference_items WHERE id = $1', [r.id]);
    expect(ref.rows[0]).toEqual({ attribution_status: 'reported_incorrect', verification_status: 'disputed' });
    const types = (await db().query('SELECT decision_type FROM editorial_decisions ORDER BY created_at')).rows.map((x) => x.decision_type);
    expect(types).toEqual(['note_added', 'tag_edit', 'report_attribution']);
  });

  it('validates request bodies', async () => {
    const { r, post } = await setup();
    const bad = await post(`/api/references/${r.refNumber}/status`, { status: 'published_everywhere' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('validation_failed');
    const del = await post(`/api/references/${r.refNumber}/delete`, {});
    expect(del.statusCode).toBe(400); // deletion requires explicit confirmation
  });
});
