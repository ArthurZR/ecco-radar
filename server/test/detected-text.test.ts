import sharp from 'sharp';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeDb, db } from '../src/db/pool.js';
import { keepConfidentText, stopOcr } from '../src/lib/ocr.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { queuePendingTextDetection } from '../src/modules/references/detected-text.js';
import { FakeHttp, appWithSession, resetDb, useFakeHttp } from './helpers.js';

beforeEach(resetDb);
afterEach(() => useFakeHttp(undefined));
afterAll(async () => {
  await stopOcr();
  await closeDb();
});

describe('keeping only confident words', () => {
  it('drops low-confidence words and stray marks, keeping line breaks', () => {
    const r = keepConfidentText([
      { words: [{ text: 'WINDOWS', confidence: 93 }, { text: 'XP', confidence: 91 }] },
      { words: [{ text: '~;', confidence: 96 }, { text: 'k', confidence: 90 }, { text: 'Mllnr', confidence: 40 }] },
      { words: [{ text: '2001', confidence: 88 }] },
    ]);
    expect(r).toEqual({ text: 'WINDOWS XP\n2001', confidence: 91, words: 3 });
    expect(keepConfidentText([{ words: [{ text: 'blur', confidence: 30 }] }])).toEqual({ text: '', confidence: null, words: 0 });
  });
});

// SYNTHETIC images rendered here: one with clear type, one plain colour field.
const lettering = (text: string) => sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="200"><rect width="100%" height="100%" fill="#dfe8f5"/>
   <text x="30" y="120" font-family="sans-serif" font-weight="bold" font-size="64" fill="#10203a">${text}</text></svg>`,
)).png().toBuffer();
const plain = () => sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 60, g: 140, b: 90 } } }).png().toBuffer();

async function seed(title: string, previewUrl: string) {
  return ingestReference({ sourceId: 'manual', originalUrl: `https://example.com/${encodeURIComponent(title)}`, title, previewUrl, mediaType: 'image' }, { method: 'manual_import', path: [] });
}

describe('detected text', () => {
  it('reads text locally, keeps it as a suggestion, and makes it searchable until rejected', async () => {
    useFakeHttp(new FakeHttp([
      { match: (u) => u.pathname === '/boot.png', body: await lettering('AQUA DESKTOP 2003'), contentType: 'image/png' },
      { match: (u) => u.pathname === '/field.png', body: await plain(), contentType: 'image/png' },
    ]));
    const withText = await seed('SYNTHETIC boot screen', 'https://images.example.com/boot.png');
    const without = await seed('SYNTHETIC colour field', 'https://images.example.com/field.png');
    const { app, cookie } = await appWithSession();

    const run = await app.inject({ method: 'POST', url: `/api/references/${withText.refNumber}/detected-text/run`, headers: { cookie } });
    expect(run.statusCode).toBe(200);
    const d = run.json();
    expect(d).toMatchObject({ outcome: 'found', reviewState: 'suggested', confirmedText: null, model: expect.stringMatching(/tesseract/) });
    expect(d.text).toMatch(/AQUA/);
    expect(d.text).toMatch(/2003/);
    expect(d.confidence).toBeGreaterThanOrEqual(75);

    const none = (await app.inject({ method: 'POST', url: `/api/references/${without.refNumber}/detected-text/run`, headers: { cookie } })).json();
    expect(none).toMatchObject({ outcome: 'none', text: null, wordCount: 0 });

    // Suggested text is searchable; rejected text is not.
    const search = async () => (await app.inject({ url: '/api/references?q=desktop', headers: { cookie } })).json().items.map((i: { refNumber: number }) => i.refNumber);
    expect(await search()).toEqual([withText.refNumber]);
    await app.inject({ method: 'POST', url: `/api/references/${withText.refNumber}/detected-text/review`, headers: { cookie }, payload: { action: 'reject' } });
    expect(await search()).toEqual([]);

    // The detail view carries it, and nothing was fetched except the two images.
    const detail = (await app.inject({ url: `/api/references/${withText.refNumber}`, headers: { cookie } })).json();
    expect(detail.detectedText).toMatchObject({ reviewState: 'rejected' });
  });

  it('becomes a caption fact only after the editor confirms or corrects it, and a re-read keeps a correction', async () => {
    useFakeHttp(new FakeHttp([{ match: () => true, body: await lettering('CHROME LOGO 1999'), contentType: 'image/png' }]));
    const r = await seed('SYNTHETIC chrome logo', 'https://images.example.com/logo.png');
    const { app, cookie } = await appWithSession();
    await app.inject({ method: 'POST', url: `/api/references/${r.refNumber}/detected-text/run`, headers: { cookie } });

    const facts = async () => (await app.inject({ url: `/api/captions/${r.refNumber}`, headers: { cookie } })).json().factSheet.facts.map((f: { key: string; value: string }) => `${f.key}=${f.value}`);
    expect((await facts()).some((f: string) => f.startsWith('visible_text'))).toBe(false);

    const corrected = await app.inject({
      method: 'POST', url: `/api/references/${r.refNumber}/detected-text/review`, headers: { cookie },
      payload: { action: 'correct', text: 'Chrome Logo 1999' },
    });
    expect(corrected.json()).toMatchObject({ reviewState: 'corrected', confirmedText: 'Chrome Logo 1999' });
    expect(await facts()).toContain('visible_text=Chrome Logo 1999');

    const again = (await app.inject({ method: 'POST', url: `/api/references/${r.refNumber}/detected-text/run`, headers: { cookie } })).json();
    expect(again).toMatchObject({ reviewState: 'corrected', confirmedText: 'Chrome Logo 1999' });

    const blank = await app.inject({ method: 'POST', url: `/api/references/${r.refNumber}/detected-text/review`, headers: { cookie }, payload: { action: 'correct', text: '   ' } });
    expect(blank.statusCode).toBe(400);
    const reset = (await app.inject({ method: 'POST', url: `/api/references/${r.refNumber}/detected-text/review`, headers: { cookie }, payload: { action: 'reset' } })).json();
    expect(reset).toMatchObject({ reviewState: 'suggested', confirmedText: null });
  });

  it('records a failed read with its reason, and queues unread references only while enabled', async () => {
    useFakeHttp(new FakeHttp([{ match: () => true, body: '<html>not an image</html>', contentType: 'text/html' }]));
    const r = await seed('SYNTHETIC broken preview', 'https://images.example.com/broken.png');
    const { app, cookie } = await appWithSession();
    const failed = (await app.inject({ method: 'POST', url: `/api/references/${r.refNumber}/detected-text/run`, headers: { cookie } })).json();
    expect(failed).toMatchObject({ outcome: 'failed', error: expect.stringMatching(/not an image/) });

    await seed('SYNTHETIC unread', 'https://images.example.com/unread.png');
    expect(await queuePendingTextDetection()).toBe(1);
    await db().query(`DELETE FROM jobs`);
    await app.inject({ method: 'PUT', url: '/api/settings/text_detection_enabled', headers: { cookie }, payload: { value: false } });
    expect(await queuePendingTextDetection()).toBe(0);
    const settings = (await app.inject({ url: '/api/settings', headers: { cookie } })).json();
    expect(settings.textDetection).toMatchObject({ failed: 1, pending: 1 });
  });
});
