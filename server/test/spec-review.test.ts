import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/pool.js';
import { setTextProvider } from '../src/ai/provider.js';
import { createSession, runExploration } from '../src/modules/exploration/engine.js';
import { strategiesFor } from '../src/modules/exploration/expansion.js';
import { computeLearnedFeatures } from '../src/modules/ranking/profile.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { report } from '../src/modules/references/actions.js';
import { FakeHttp, appWithSession, resetDb, useFakeHttp } from './helpers.js';

beforeEach(resetDb);
afterEach(() => {
  useFakeHttp(undefined);
  setTextProvider(undefined);
});
afterAll(closeDb);

// SYNTHETIC Commons-shaped answer: three items per query.
function commons(url: string) {
  const u = new URL(url);
  const q = u.searchParams.get('gsrsearch') ?? 'x';
  const slug = q.replace(/\W+/g, '-');
  return {
    status: 200, url, contentType: 'application/json',
    body: JSON.stringify({ query: { pages: [1, 2, 3].map((i) => ({ pageid: Number(`${slug.length}${i}${q.length}`), index: i, title: `File:${q} ${i}.jpg`,
      imageinfo: [{ thumburl: `https://upload.wikimedia.org/${slug}-${i}.jpg`, descriptionurl: `https://commons.wikimedia.org/wiki/File:${slug}-${i}.jpg`, mime: 'image/jpeg' }] })) } }),
  };
}

describe('processing limits per run', () => {
  it('stops asking the AI provider once the run has spent its token allowance', async () => {
    const fake = new FakeHttp([]);
    fake.getText = async (url: string) => commons(url);
    useFakeHttp(fake);
    let calls = 0;
    setTextProvider({
      name: 'fake', model: 'fake-1',
      // SYNTHETIC provider: records 15,000 tokens against the run, like the real one does.
      generate: async (req) => {
        calls++;
        await db().query(`INSERT INTO ai_usage(provider, model, purpose, input_tokens, output_tokens, succeeded, exploration_session_id) VALUES ('fake','fake-1',$1,10000,5000,true,$2)`, [req.purpose, req.explorationSessionId]);
        return `suggested term ${calls}`;
      },
    });
    const id = await createSession(
      { query: 'web 2.0', concepts: ['aqua interface', 'glossy icons'], mode: 'experimental', sourceIds: ['wikimedia_commons'], depth: 1, maxQueries: 20, maxResults: 100, useExternalAi: true, maxAiTokens: 20000 },
      { actorId: null },
    );
    await runExploration(id);
    expect(calls).toBe(2); // 15k after the first, 30k after the second: the third is refused
    const s = (await db().query('SELECT status, error_summary FROM exploration_sessions WHERE id = $1', [id])).rows[0];
    expect(s.status).toBe('completed');
    expect(s.error_summary).toMatch(/AI limit is reached \(30000 of 20000 tokens\)/);
  });

  it('never calls the AI provider when the run allows 0 tokens', async () => {
    const fake = new FakeHttp([]);
    fake.getText = async (url: string) => commons(url);
    useFakeHttp(fake);
    let calls = 0;
    setTextProvider({ name: 'fake', model: 'fake-1', generate: async () => { calls++; return 'x'; } });
    const id = await createSession({ query: 'y2k', mode: 'experimental', sourceIds: ['wikimedia_commons'], depth: 1, maxQueries: 4, useExternalAi: true, maxAiTokens: 0 }, { actorId: null });
    await runExploration(id);
    expect(calls).toBe(0);
    expect((await db().query('SELECT error_summary FROM exploration_sessions WHERE id = $1', [id])).rows[0].error_summary).toMatch(/0 AI tokens/);
  });
});

describe('relationship to eccö history', () => {
  it('puts eccö history first, leaves it as one strategy, or removes it', () => {
    expect(strategiesFor('adjacent', 'close').slice(0, 2)).toEqual(['history', 'approved_tags']);
    expect(strategiesFor('adjacent', 'balanced')).toEqual(['concept', 'history', 'approved_tags', 'seed_map', 'knowledge_graph', 'creator']);
    expect(strategiesFor('familiar', 'away')).toEqual(['concept']);
    expect(strategiesFor('experimental', 'away')).not.toContain('history');
  });
});

describe('background schedules', () => {
  const params = { query: 'frutiger aero', sourceIds: ['wikimedia_commons'], mode: 'adjacent' };

  it('can be edited after creation, run on demand, and switching one off stops its unfinished runs', async () => {
    const { app, cookie } = await appWithSession();
    const created = (await app.inject({ method: 'POST', url: '/api/schedules', headers: { cookie }, payload: { name: 'Aero', params, intervalMinutes: 1440 } })).json();
    expect(created).toMatchObject({ enabled: false });

    const edited = await app.inject({
      method: 'PATCH', url: `/api/schedules/${created.id}`, headers: { cookie },
      payload: { name: 'Aero weekly', intervalMinutes: 10080, params: { ...params, depth: 2, maxResults: 30, useExternalAi: true, maxAiTokens: 5000 } },
    });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ name: 'Aero weekly', interval_minutes: 10080, params: { depth: 2, maxResults: 30, maxAiTokens: 5000 } });
    const bad = await app.inject({ method: 'PATCH', url: `/api/schedules/${created.id}`, headers: { cookie }, payload: { params: { ...params, maxAiTokens: 10_000_000 } } });
    expect(bad.statusCode).toBe(400);

    // Run now: a session tied to the schedule, carrying the edited limits.
    const run = (await app.inject({ method: 'POST', url: `/api/schedules/${created.id}/run`, headers: { cookie } })).json();
    const s = (await db().query('SELECT schedule_id, depth, max_results, max_ai_tokens, status FROM exploration_sessions WHERE id = $1', [run.id])).rows[0];
    expect(s).toMatchObject({ schedule_id: created.id, depth: 2, max_results: 30, max_ai_tokens: 5000, status: 'queued' });

    await app.inject({ method: 'PATCH', url: `/api/schedules/${created.id}`, headers: { cookie }, payload: { enabled: true } });
    const off = (await app.inject({ method: 'PATCH', url: `/api/schedules/${created.id}`, headers: { cookie }, payload: { enabled: false } })).json();
    expect(off.stoppedRuns).toBe(1);
    expect((await db().query('SELECT status FROM exploration_sessions WHERE id = $1', [run.id])).rows[0].status).toBe('cancelled');
  });

  it('saves exploration presets only with settings the engine accepts', async () => {
    const { app, cookie } = await appWithSession();
    const ok = await app.inject({ method: 'POST', url: '/api/saved-searches', headers: { cookie }, payload: { name: 'Aero', scope: 'exploration', params: { ...params, categories: ['y2k'], historyRelation: 'close' } } });
    expect(ok.statusCode).toBe(200);
    const bad = await app.inject({ method: 'POST', url: '/api/saved-searches', headers: { cookie }, payload: { name: 'Broken', scope: 'exploration', params: { query: 'x', sourceIds: [] } } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('learning from "irrelevant" reports', () => {
  it('counts as a rejection with the scope the editor chose', async () => {
    const mk = (n: number) => ingestReference(
      { sourceId: 'manual', originalUrl: `https://example.com/synthetic-${n}`, title: `SYNTHETIC ${n}`, creatorName: 'Studio Synthetic', tags: ['chrome type'], mediaType: 'image' },
      { method: 'manual_import', path: [] },
    );
    const a = await mk(1);
    const b = await mk(2);
    await report(a.id, { kind: 'irrelevant', scope: 'creator' }, null);
    await report(b.id, { kind: 'irrelevant', scope: 'creator' }, null);
    const creator = (await computeLearnedFeatures()).find((f) => f.key === 'creator:studio synthetic');
    expect(creator?.weight).toBeLessThan(0);
    expect(creator?.evidence).toBe(2);
    // Topic not penalised by a creator-scoped report
    expect((await computeLearnedFeatures()).find((f) => f.key === 'tag:chrome type')).toBeUndefined();
  });
});

describe('local preview copies', () => {
  it('only treats licences that permit reuse as cacheable', async () => {
    const { licencePermitsCaching } = await import('../src/modules/references/preview-cache.js');
    for (const ok of ['Public domain', 'CC0', 'CC BY 4.0', 'CC BY-SA 3.0', 'cc-by-sa-4.0', 'PD-US']) expect(licencePermitsCaching(ok), ok).toBe(true);
    for (const no of [null, '', 'CC BY-NC 4.0', 'CC BY-ND 2.0', 'CC BY-NC-SA 3.0', 'All rights reserved', 'Copyrighted, fair use', 'Unknown']) expect(licencePermitsCaching(no), String(no)).toBe(false);
  });

  it('keeps a copy of an openly licensed preview, links the rest, and serves the copy', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 900, height: 600, channels: 3, background: { r: 200, g: 40, b: 40 } } }).png().toBuffer();
    useFakeHttp(new FakeHttp([{ match: () => true, body: png, contentType: 'image/png' }]));
    const { analyzeReferenceImage } = await import('../src/modules/references/visual.js');
    const mk = (n: string, license?: string) => ingestReference(
      { sourceId: 'manual', originalUrl: `https://example.com/${n}`, title: `SYNTHETIC ${n}`, previewUrl: `https://images.example.com/${n}.png`, license, mediaType: 'image' },
      { method: 'manual_import', path: [] },
    );
    const open = await mk('open', 'CC BY-SA 4.0');
    const closed = await mk('closed', 'All rights reserved');
    await analyzeReferenceImage(open.id);
    await analyzeReferenceImage(closed.id);
    const rows = (await db().query('SELECT id, cached_preview_path FROM reference_items ORDER BY ref_number')).rows;
    expect(rows[0].cached_preview_path).toBe(`previews/${open.id}.webp`);
    expect(rows[1].cached_preview_path).toBeNull();

    const { app, cookie } = await appWithSession();
    const img = await app.inject({ url: `/api/references/${open.refNumber}/cached-preview`, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    const meta = await sharp(img.rawPayload).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(640);
    expect((await app.inject({ url: `/api/references/${closed.refNumber}/cached-preview`, headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/references/${open.refNumber}/cached-preview` })).statusCode).toBe(401);
    const feed = (await app.inject({ url: '/api/references', headers: { cookie } })).json().items;
    expect(feed.find((i: { id: string }) => i.id === open.id).cachedPreviewUrl).toBe(`/api/references/${open.refNumber}/cached-preview`);
  });

  it('keeps nothing when the editor turns local copies off', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } } }).png().toBuffer();
    useFakeHttp(new FakeHttp([{ match: () => true, body: png, contentType: 'image/png' }]));
    const { app, cookie } = await appWithSession();
    await app.inject({ method: 'PUT', url: '/api/settings/preview_caching_enabled', headers: { cookie }, payload: { value: false } });
    const { analyzeReferenceImage } = await import('../src/modules/references/visual.js');
    const r = await ingestReference({ sourceId: 'manual', originalUrl: 'https://example.com/pd', title: 'SYNTHETIC pd', previewUrl: 'https://images.example.com/pd.png', license: 'Public domain', mediaType: 'image' }, { method: 'manual_import', path: [] });
    await analyzeReferenceImage(r.id);
    expect((await db().query('SELECT cached_preview_path FROM reference_items WHERE id = $1', [r.id])).rows[0].cached_preview_path).toBeNull();
  });
});

describe('knowledge graph suggestions', () => {
  it('suggests links to known entities named in a new item, which the editor can correct', async () => {
    await ingestReference(
      { sourceId: 'manual', originalUrl: 'https://example.com/a', title: 'SYNTHETIC poster', mediaType: 'image',
        entities: [{ label: 'Designers Republic', kind: 'organization', predicate: 'created_by', provenance: 'source credit line' }] },
      { method: 'manual_import', path: [] },
    );
    const b = await ingestReference(
      { sourceId: 'manual', originalUrl: 'https://example.com/b', title: 'SYNTHETIC sleeve in the style of The Designers Republic', mediaType: 'image' },
      { method: 'manual_import', path: [] },
    );
    const { app, cookie } = await appWithSession();
    const d = (await app.inject({ url: `/api/references/${b.refNumber}`, headers: { cookie } })).json();
    const suggestion = d.entities.find((e: { label: string }) => e.label === 'Designers Republic');
    expect(suggestion).toMatchObject({ evidence: 'inferred', predicate: 'associated_with', provenance: expect.stringMatching(/matched by RADAR/) });

    // Not counted as a preference signal while only inferred.
    const corrected = await app.inject({
      method: 'POST', url: `/api/references/${b.refNumber}/relationships`, headers: { cookie },
      payload: { entityId: suggestion.entity_id, predicate: 'associated_with', verdict: 'correct', correctPredicate: 'created_by' },
    });
    expect(corrected.statusCode).toBe(200);
    const after = (await app.inject({ url: `/api/references/${b.refNumber}`, headers: { cookie } })).json();
    const links = after.entities.filter((e: { label: string }) => e.label === 'Designers Republic').map((e: { predicate: string; evidence: string }) => `${e.predicate}:${e.evidence}`).sort();
    expect(links).toEqual(['associated_with:editor_rejected', 'created_by:editor_confirmed']);
    expect(after.decisions.some((x: { decision_type: string }) => x.decision_type === 'relationship_correct')).toBe(true);
  });
});

describe('reports and notes', () => {
  it('marks a duplicate by typing the other reference number, and logs note edits', async () => {
    const mk = (n: number) => ingestReference({ sourceId: 'manual', originalUrl: `https://example.com/dup-${n}`, title: `SYNTHETIC dup ${n}`, mediaType: 'image' }, { method: 'manual_import', path: [] });
    const a = await mk(1);
    const b = await mk(2);
    const { app, cookie } = await appWithSession();
    const ok = await app.inject({ method: 'POST', url: `/api/references/${b.refNumber}/report`, headers: { cookie }, payload: { kind: 'duplicate_of', otherRef: `#${String(a.refNumber).padStart(5, '0')}` } });
    expect(ok.statusCode).toBe(200);
    const groups = (await db().query('SELECT DISTINCT duplicate_group_id FROM reference_items')).rows;
    expect(groups).toHaveLength(1);
    expect((await app.inject({ method: 'POST', url: `/api/references/${b.refNumber}/report`, headers: { cookie }, payload: { kind: 'duplicate_of', otherRef: '#99999' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/api/references/${b.refNumber}/report`, headers: { cookie }, payload: { kind: 'duplicate_of' } })).statusCode).toBe(400);

    const note = (await app.inject({ method: 'POST', url: `/api/references/${a.refNumber}/notes`, headers: { cookie }, payload: { body: 'first' } })).json();
    await app.inject({ method: 'PATCH', url: `/api/references/${a.refNumber}/notes/${note.id}`, headers: { cookie }, payload: { body: 'second' } });
    const types = (await db().query(`SELECT decision_type FROM editorial_decisions WHERE reference_id = $1 ORDER BY created_at`, [a.id])).rows.map((r) => r.decision_type);
    expect(types).toEqual(['note_added', 'note_edited']);
  });
});
