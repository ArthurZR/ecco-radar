import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { db, closeDb } from '../src/db/pool.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { analyzeReferenceImage, queuePendingVisualAnalysis } from '../src/modules/references/visual.js';
import { analyzeImage } from '../src/lib/visual.js';
import { cosine } from '../src/lib/embedding.js';
import { hammingHex } from '../src/modules/references/duplicates.js';
import { scoreReference, type EditorialProfile } from '../src/modules/ranking/score.js';
import { DEFAULT_WEIGHTS } from '../src/modules/ranking/config.js';
import { FakeHttp, appWithSession, resetDb, useFakeHttp } from './helpers.js';

// Synthetic images drawn in the test; no real artwork is used.
const drawing = (a: string, b: string, size = 200) =>
  sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size * 0.75)}"><defs><linearGradient id="g"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="30%" cy="45%" r="18%" fill="#000"/></svg>`,
  )).png().toBuffer();

const ctx = { method: 'manual_import' as const, path: [{ kind: 'manual' as const, label: 'test' }] };
const item = (n: number, thumb: string) => ({
  sourceId: 'manual', originalUrl: `https://example.com/item/${n}`, title: `Synthetic visual item ${n}`, mediaType: 'image' as const, thumbnailUrl: thumb,
});

beforeEach(resetDb);
afterEach(() => useFakeHttp(undefined));
afterAll(closeDb);

describe('local image analysis', () => {
  it('gives near-identical hashes and vectors for a resized, recompressed copy', async () => {
    const original = await drawing('#3cc04c', '#ffffff');
    const copy = await sharp(original).resize(90).jpeg({ quality: 55 }).toBuffer();
    const other = await drawing('#c03c3c', '#202020');
    const [a, b, c] = await Promise.all([analyzeImage(original), analyzeImage(copy), analyzeImage(other)]);
    expect(a.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(hammingHex(a.dhash, b.dhash)).toBeLessThanOrEqual(6);
    expect(hammingHex(a.dhash, c.dhash)).toBeGreaterThan(20);
    expect(cosine(a.embedding, b.embedding)).toBeGreaterThan(0.95);
    expect(cosine(a.embedding, c.embedding)).toBeLessThan(0.7);
  });

  it('rejects data that is not an image', async () => {
    await expect(analyzeImage(Buffer.from('<html>not an image</html>'))).rejects.toThrow();
  });
});

describe('reference visual analysis', () => {
  it('stores the vector, flags a visual duplicate and lists visually similar items', async () => {
    const green = await drawing('#3cc04c', '#ffffff');
    const greenCopy = await sharp(green).resize(120).jpeg({ quality: 70 }).toBuffer();
    const fake = new FakeHttp([
      { match: (u) => u.pathname === '/a.png', body: green, contentType: 'image/png' },
      { match: (u) => u.pathname === '/b.jpg', body: greenCopy, contentType: 'image/jpeg' },
    ]);
    useFakeHttp(fake);
    const a = await ingestReference(item(1, 'https://img.example.com/a.png'), ctx);
    const b = await ingestReference({ ...item(2, 'https://img.example.com/b.jpg'), title: 'Different title' }, ctx);
    expect(await analyzeReferenceImage(a.id)).toEqual({ ok: true });
    expect(await analyzeReferenceImage(b.id)).toEqual({ ok: true });

    const row = (await db().query('SELECT visual_embedding, visual_embedding_model, visual_hash FROM reference_items WHERE id = $1', [b.id])).rows[0];
    expect(row.visual_embedding).toHaveLength(76);
    expect(row.visual_embedding_model).toBe('colour-tone-v1');
    const dup = await db().query(`SELECT method FROM reference_relations WHERE kind = 'duplicate_candidate' AND from_id = $1 AND to_id = $2`, [b.id, a.id]);
    expect(dup.rows[0]?.method).toBe('dhash');

    const { app, cookie } = await appWithSession();
    const detail = (await app.inject({ url: `/api/references/${a.refNumber}`, headers: { cookie } })).json();
    expect(detail.related.visual.map((x: { id: string }) => x.id)).toContain(b.id);
    expect(detail.reference.visualAnalysis.state).toBe('analysed');
    // Visual affinity stays empty until enough approved items have analysed images
    expect(detail.score.components.find((c: { key: string }) => c.key === 'visual_affinity').value).toBeNull();
    await app.close();
  });

  it('records why analysis failed and does not pretend it worked', async () => {
    useFakeHttp(new FakeHttp([{ match: () => true, body: '<html></html>', contentType: 'text/html' }]));
    const a = await ingestReference(item(3, 'https://img.example.com/page'), ctx);
    const out = await analyzeReferenceImage(a.id);
    expect(out.ok).toBe(false);
    const row = (await db().query('SELECT visual_embedding, visual_error, visual_analyzed_at FROM reference_items WHERE id = $1', [a.id])).rows[0];
    expect(row.visual_embedding).toBeNull();
    expect(row.visual_error).toMatch(/not an image/);
    expect(row.visual_analyzed_at).not.toBeNull();
  });

  it('only queues work when visual analysis is enabled', async () => {
    await ingestReference(item(4, 'https://img.example.com/x.png'), ctx);
    expect(await queuePendingVisualAnalysis()).toBe(1);
    await db().query(`DELETE FROM jobs`);
    await db().query(`INSERT INTO app_settings(key, value) VALUES ('visual_analysis_enabled', 'false')`);
    expect(await queuePendingVisualAnalysis()).toBe(0);
  });
});

describe('visual affinity scoring', () => {
  it('scores colour and tone against approved references only when enough exist', async () => {
    const [green, red] = await Promise.all([analyzeImage(await drawing('#3cc04c', '#ffffff')), analyzeImage(await drawing('#c03c3c', '#202020'))]);
    const profile = (count: number): EditorialProfile => ({
      approvedCentroid: null, approvedCount: 0, approvedVisualCentroid: green.embedding, approvedVisualCount: count, historyCentroid: null, historyCount: 0,
      featureWeights: new Map(), archiveEmbeddings: [], historyEmbeddings: [], approvedEntityIds: new Set(), sourceReliability: new Map(), resonance: [], resonanceBasis: 'test',
    });
    const ref = (v: number[]) => ({
      id: 'x', source_id: 'manual', creator_name: null, creator_url: null, title: 't', description: null, published_date: null, license: null,
      rights_statement: null, preview_url: 'https://e.com/i.png', attribution_status: 'source_provided', text_embedding: null, visual_embedding: v, tags: [], entity_ids: [],
    });
    const va = (v: number[], n: number) => scoreReference(ref(v), profile(n), DEFAULT_WEIGHTS, { mode: 'adjacent', novelty: 0.5 }).components.find((c) => c.key === 'visual_affinity')!;
    expect(va(green.embedding, 2).value).toBeNull();
    expect(va(green.embedding, 3).value).toBeGreaterThan(0.9);
    expect(va(red.embedding, 3).value!).toBeLessThan(0.3);
    expect(va(green.embedding, 3).note).toMatch(/does not recognise subjects or style/);
  });
});
