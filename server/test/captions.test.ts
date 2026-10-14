import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { buildFactSheet, flagUnsupported, groundedTemplate } from '../src/modules/captions/grounding.js';
import { setTextProvider, type TextGenerationProvider } from '../src/ai/provider.js';
import { resetDb, appWithSession } from './helpers.js';

beforeEach(resetDb);
afterEach(() => setTextProvider(undefined));
afterAll(closeDb);

const baseRef = {
  title: 'Aqua button study', creator_name: 'Test Designer', attribution_status: 'source_provided', published_raw: '2003',
  published_precision: 'year', description: 'Glossy interface button rendered for a desktop theme. Second sentence.', source_name: 'Wikimedia Commons',
  original_url: 'https://commons.wikimedia.org/wiki/File:A.png', license: 'CC BY-SA 4.0', media_type: 'image',
};

describe('grounding', () => {
  it('builds a fact sheet that marks unknowns and drops disputed attribution', () => {
    const sheet = buildFactSheet({ ...baseRef, attribution_status: 'reported_incorrect', published_raw: null }, [], []);
    expect(sheet.facts.find((f) => f.key === 'creator')).toBeUndefined();
    expect(sheet.unknown).toContain('date');
    expect(sheet.unknown.join(' ')).toMatch(/reported incorrect/);
  });
  it('assembles a restrained caption from facts only', () => {
    const sheet = buildFactSheet(baseRef, [], []);
    expect(groundedTemplate(sheet, 'short')).toBe('Aqua button study, Test Designer, 2003.');
    expect(groundedTemplate(sheet, 'medium')).toBe('Aqua button study, Test Designer, 2003. Glossy interface button rendered for a desktop theme.');
    expect(groundedTemplate(buildFactSheet({ ...baseRef, title: null, creator_name: null, published_raw: null, description: null }, [], []), 'short')).toBe('Creator and date unknown.');
  });
  it('flags years, names and claims the facts do not support', () => {
    const sheet = buildFactSheet(baseRef, [], []);
    const flags = flagUnsupported('Designed by Susan Kare in 1999, this iconic button by Test Designer dates from 2003.', sheet);
    const claims = flags.map((f) => f.claim);
    expect(claims).toContain('1999');
    expect(claims).toContain('Susan Kare');
    expect(claims).toContain('iconic');
    expect(claims).not.toContain('2003');
    expect(claims).not.toContain('Test Designer');
  });
});

describe('Caption Studio API', () => {
  async function setup() {
    const r = await ingestReference({ sourceId: 'manual', originalUrl: 'https://example.com/c', title: 'Aqua button study', creatorName: 'Test Designer', publishedRaw: '2003', mediaType: 'image' }, { method: 'manual_import', path: [] });
    return { r, ...(await appWithSession()) };
  }

  it('explains when no AI provider is configured and still offers the grounded template', async () => {
    const { r, app, cookie } = await setup();
    setTextProvider(null);
    const ai = await app.inject({ method: 'POST', url: `/api/captions/${r.refNumber}/generate`, headers: { cookie }, payload: { method: 'ai' } });
    expect(ai.statusCode).toBe(409);
    const t = await app.inject({ method: 'POST', url: `/api/captions/${r.refNumber}/generate`, headers: { cookie }, payload: { method: 'grounded_template', length: 'short' } });
    expect(t.json().drafts[0]).toMatchObject({ version: 1, origin: 'grounded_template', body: 'Aqua button study, Test Designer, 2003.' });
  });

  it('versions every draft, keeps generated and final text apart, and flags unsupported claims', async () => {
    const { r, app, cookie } = await setup();
    const fake: TextGenerationProvider = { name: 'fake', model: 'fake-1', generate: async () => 'A button by Test Designer, first shown in 1997.' };
    setTextProvider(fake);
    const gen = await app.inject({ method: 'POST', url: `/api/captions/${r.refNumber}/generate`, headers: { cookie }, payload: { method: 'ai', alternatives: 2 } });
    const drafts = gen.json().drafts;
    expect(drafts.map((d: { version: number }) => d.version)).toEqual([1, 2]);
    expect(drafts[0].verification_flags.map((f: { claim: string }) => f.claim)).toEqual(expect.arrayContaining(['1997', 'first']));
    const edit = await app.inject({ method: 'POST', url: `/api/captions/${r.refNumber}/drafts`, headers: { cookie }, payload: { body: 'Aqua button study by Test Designer (2003).', parentDraftId: drafts[0].id } });
    expect(edit.json()).toMatchObject({ version: 3, origin: 'editor_edited' });
    await app.inject({ method: 'PUT', url: `/api/captions/${r.refNumber}/final`, headers: { cookie }, payload: { body: 'Final words.', basedOnDraftId: edit.json().id } });
    await app.inject({ method: 'POST', url: `/api/captions/${r.refNumber}/generate`, headers: { cookie }, payload: { method: 'ai' } });
    const final = (await db().query('SELECT body FROM final_captions WHERE reference_id = $1', [r.id])).rows[0];
    expect(final.body).toBe('Final words.'); // generation never touches the final text
    const exp = (await app.inject({ url: `/api/captions/${r.refNumber}/export`, headers: { cookie } })).json();
    expect(exp.caption).toBe('Final words.');
    expect(exp.caption).not.toMatch(/https?:/); // sources stay out of the caption
  });
});

describe('AI usage limit', () => {
  it('refuses AI once the last 24 hours reach the limit, and lifts when the editor raises it', async () => {
    const r = await ingestReference({ sourceId: 'manual', originalUrl: 'https://example.com/b', title: 'Budget test', mediaType: 'image' }, { method: 'manual_import', path: [] });
    const { app, cookie } = await appWithSession();
    setTextProvider({ name: 'fake', model: 'fake-1', generate: async () => 'A draft.' });
    await db().query(`INSERT INTO ai_usage(provider, model, purpose, input_tokens, output_tokens, succeeded) VALUES ('fake','fake-1','caption_draft', 150000, 60000, true)`);
    // An older call outside the 24-hour window does not count.
    await db().query(`INSERT INTO ai_usage(provider, model, purpose, input_tokens, output_tokens, succeeded, created_at) VALUES ('fake','fake-1','caption_draft', 900000, 0, true, now() - interval '2 days')`);

    const s = (await app.inject({ url: '/api/settings', headers: { cookie } })).json();
    expect(s.ai.budget).toEqual({ limit: 200000, usedLast24h: 210000 });
    const refused = await app.inject({ method: 'POST', url: `/api/captions/${r.refNumber}/generate`, headers: { cookie }, payload: { method: 'ai' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toMatch(/daily AI limit/);

    const bad = await app.inject({ method: 'PUT', url: '/api/settings/ai_daily_token_limit', headers: { cookie }, payload: { value: 5 } });
    expect(bad.statusCode).toBe(400);
    await app.inject({ method: 'PUT', url: '/api/settings/ai_daily_token_limit', headers: { cookie }, payload: { value: 500000 } });
    const ok = await app.inject({ method: 'POST', url: `/api/captions/${r.refNumber}/generate`, headers: { cookie }, payload: { method: 'ai' } });
    expect(ok.statusCode).toBe(200);

    await app.inject({ method: 'PUT', url: '/api/settings/ai_daily_token_limit', headers: { cookie }, payload: { value: null } });
    expect((await app.inject({ url: '/api/settings', headers: { cookie } })).json().ai.budget.limit).toBeNull();
  });
});
