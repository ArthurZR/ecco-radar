import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { formatRefNumber, parseRefNumber } from '../src/modules/references/types.js';
import { resetDb, appWithSession } from './helpers.js';

const item = (n: number, extra: Record<string, unknown> = {}) => ({
  sourceId: 'manual',
  originalUrl: `https://example.com/item/${n}`,
  title: `Synthetic test item ${n}`,
  mediaType: 'image' as const,
  ...extra,
});
const ctx = { method: 'manual_import' as const, path: [{ kind: 'manual' as const, label: 'test' }] };

beforeEach(resetDb);
afterAll(closeDb);

describe('permanent reference numbers', () => {
  it('formats and parses identifiers', () => {
    expect(formatRefNumber(1)).toBe('#00001');
    expect(formatRefNumber(123456)).toBe('#123456');
    expect(parseRefNumber('#00042')).toBe(42);
    expect(parseRefNumber('42')).toBe(42);
    expect(parseRefNumber('abc')).toBeNull();
  });

  it('assigns unique numbers under concurrent creation', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => ingestReference(item(i), ctx)));
    const numbers = results.map((r) => r.refNumber);
    expect(new Set(numbers).size).toBe(40);
    expect(results.every((r) => r.created)).toBe(true);
  });

  it('is idempotent for the same URL, even when ingested concurrently', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => ingestReference(item(1, { originalUrl: 'https://example.com/same?utm_source=a' }), ctx)));
    expect(new Set(results.map((r) => r.refNumber)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);
    const disc = await db().query('SELECT count(*)::int AS n FROM reference_discoveries');
    expect(disc.rows[0].n).toBe(8); // every rediscovery keeps provenance
  });

  it('never renumbers, never hard-deletes, and never reuses a number after deletion', async () => {
    const a = await ingestReference(item(1), ctx);
    await expect(db().query('UPDATE reference_items SET ref_number = 999 WHERE id = $1', [a.id])).rejects.toThrow(/permanent/);
    await expect(db().query('DELETE FROM reference_items WHERE id = $1', [a.id])).rejects.toThrow(/never hard-deleted/);
    const { app, cookie } = await appWithSession();
    const del = await app.inject({ method: 'POST', url: `/api/references/${a.refNumber}/delete`, headers: { cookie }, payload: { confirm: true } });
    expect(del.statusCode).toBe(200);
    const b = await ingestReference(item(2), ctx);
    expect(b.refNumber).toBeGreaterThan(a.refNumber);
    // re-discovering a deleted URL does not resurrect or renumber it
    const again = await ingestReference(item(1), ctx);
    expect(again.refNumber).toBe(a.refNumber);
    expect(again.tombstoned).toBe(true);
  });

  it('keeps the identifier separate from feed position', async () => {
    for (let i = 0; i < 5; i++) await ingestReference(item(i), ctx);
    const { app, cookie } = await appWithSession();
    const recent = (await app.inject({ url: '/api/references?sort=recent', headers: { cookie } })).json();
    const byNumber = (await app.inject({ url: '/api/references?sort=ref_number', headers: { cookie } })).json();
    expect(recent.items.map((x: { refLabel: string }) => x.refLabel).sort()).toEqual(byNumber.items.map((x: { refLabel: string }) => x.refLabel).sort());
    const lookup = (await app.inject({ url: '/api/references/%2300003', headers: { cookie } })).json();
    expect(lookup.reference.refLabel).toBe('#00003');
  });
});

describe('duplicate detection', () => {
  it('flags same title + creator from different URLs as a candidate, not a merge', async () => {
    const a = await ingestReference(item(1, { title: 'Aqua Interface Study', creatorName: 'Test Designer' }), ctx);
    const b = await ingestReference(item(2, { title: 'aqua interface study.jpg', creatorName: 'test designer' }), ctx);
    expect(b.created).toBe(true);
    expect(b.duplicateCandidates).toBe(1);
    const rel = await db().query('SELECT kind, method FROM reference_relations WHERE from_id = $1 AND to_id = $2', [b.id, a.id]);
    expect(rel.rows[0]).toMatchObject({ kind: 'duplicate_candidate', method: 'title_creator' });
  });

  it('respects an editor dismissal', async () => {
    const a = await ingestReference(item(1, { title: 'Glossy Button Set', creatorName: 'X' }), ctx);
    const { app, cookie } = await appWithSession();
    const b = await ingestReference(item(2, { title: 'Glossy Button Set', creatorName: 'X' }), ctx);
    const res = await app.inject({ method: 'POST', url: `/api/references/${b.refNumber}/report`, headers: { cookie }, payload: { kind: 'not_duplicate_of', otherId: a.id } });
    expect(res.statusCode).toBe(200);
    const left = await db().query(`SELECT count(*)::int AS n FROM reference_relations WHERE kind = 'duplicate_candidate'`);
    expect(left.rows[0].n).toBe(0);
  });
});
