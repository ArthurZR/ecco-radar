import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { runSourceSearch } from '../src/modules/sources/service.js';
import { parseFeed, matchesQuery } from '../src/modules/sources/adapters/rss.js';
import { parsePageMeta } from '../src/lib/html-meta.js';
import { importFromUrl } from '../src/modules/sources/adapters/manual-url.js';
import { HttpError } from '../src/lib/http-client.js';
import { resetDb, FakeHttp, useFakeHttp } from './helpers.js';

// SYNTHETIC responses shaped like each documented API. They test parsing and error handling only;
// they are not evidence that a live integration works. Live checks run from the Sources page.
const COMMONS = {
  continue: { gsroffset: 2 },
  query: { pages: [
    { pageid: 2, index: 2, title: 'File:Second.png', imageinfo: [{ url: 'https://upload.wikimedia.org/b.png', thumburl: 'https://upload.wikimedia.org/thumb/b.png', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Second.png', width: 800, height: 600, mime: 'image/png', extmetadata: {} }] },
    { pageid: 1, index: 1, title: 'File:Aqua button.jpg', imageinfo: [{ url: 'https://upload.wikimedia.org/a.jpg', thumburl: 'https://upload.wikimedia.org/thumb/a.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Aqua_button.jpg', width: 1024, height: 768, mime: 'image/jpeg',
      extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Tester">Tester</a>' }, DateTimeOriginal: { value: '2003-05-01' }, ImageDescription: { value: '<p>A glossy <b>button</b></p>' }, LicenseShortName: { value: 'CC BY-SA 4.0' }, Categories: { value: 'Aqua (GUI)|CC-BY-SA-4.0|Buttons' } } }] },
  ] },
};
const IA = { response: { numFound: 3, start: 0, docs: [
  { identifier: 'pc-magazine-1999', title: 'PC Magazine 1999', creator: ['Ziff Davis'], date: '1999-03-01T00:00:00Z', mediatype: 'texts', subject: 'computers; magazines' },
  { identifier: 'bad id with spaces', title: 'should be dropped' },
] } };

beforeEach(resetDb);
afterEach(() => useFakeHttp(undefined));
afterAll(closeDb);

describe('source adapters', () => {
  it('parses Wikimedia Commons results in search order, keeping attribution and licence', async () => {
    useFakeHttp(new FakeHttp([{ match: (u) => u.hostname === 'commons.wikimedia.org', body: COMMONS }]));
    const out = await runSourceSearch('wikimedia_commons', { query: 'aqua', page: 1, perPage: 2 });
    expect(out.ok).toBe(true);
    const [a, b] = out.result!.items;
    expect(a).toMatchObject({ sourceItemId: '1', creatorName: 'Tester', license: 'CC BY-SA 4.0', publishedRaw: '2003-05-01', description: 'A glossy button', mediaType: 'image' });
    expect(a!.creatorUrl).toBe('https://commons.wikimedia.org/wiki/User:Tester');
    expect(a!.tags).toEqual(['Aqua (GUI)', 'Buttons']); // licence categories removed
    expect(b!.creatorName).toBeUndefined(); // unknown stays unknown
    expect(out.result!.hasMore).toBe(true);
    const src = await db().query(`SELECT status, last_success_at FROM sources WHERE id = 'wikimedia_commons'`);
    expect(src.rows[0].status).toBe('active');
  });

  it('parses Internet Archive results and drops malformed identifiers', async () => {
    useFakeHttp(new FakeHttp([{ match: (u) => u.hostname === 'archive.org', body: IA }]));
    const out = await runSourceSearch('internet_archive', { query: 'pc magazine', page: 1, perPage: 10 });
    expect(out.result!.items).toHaveLength(1);
    expect(out.result!.items[0]).toMatchObject({ originalUrl: 'https://archive.org/details/pc-magazine-1999', creatorName: 'Ziff Davis', mediaType: 'text', tags: ['computers', 'magazines'] });
  });

  it('reports missing credentials instead of pretending to search', async () => {
    const out = await runSourceSearch('flickr', { query: 'y2k', page: 1, perPage: 5 });
    expect(out).toMatchObject({ ok: false, status: 'needs_configuration' });
    expect(out.error).toMatch(/FLICKR_API_KEY/);
  });

  it('records network failures and rate limits on the source', async () => {
    useFakeHttp(new FakeHttp([]));
    const out = await runSourceSearch('internet_archive', { query: 'x', page: 1, perPage: 5 });
    expect(out).toMatchObject({ ok: false, status: 'unavailable' });
    const throttled = { getText: async () => { throw new HttpError('HTTP 429', 429, 30_000); }, getJson: async () => { throw new HttpError('HTTP 429', 429, 30_000); } };
    useFakeHttp(throttled as never);
    const rl = await runSourceSearch('wikimedia_commons', { query: 'x', page: 1, perPage: 5 });
    expect(rl.status).toBe('rate_limited');
    const again = await runSourceSearch('wikimedia_commons', { query: 'x', page: 1, perPage: 5 });
    expect(again.error).toMatch(/rate-limited until/);
  });

  it('skips disabled sources', async () => {
    await db().query(`UPDATE sources SET enabled = false WHERE id = 'internet_archive'`);
    expect((await runSourceSearch('internet_archive', { query: 'x', page: 1, perPage: 5 })).status).toBe('disabled');
  });
});

describe('RSS and page metadata parsing', () => {
  it('parses RSS with media and Atom entries', () => {
    const rss = `<?xml version="1.0"?><rss xmlns:media="http://search.yahoo.com/mrss/"><channel><title>Design Archive</title>
      <item><title>Swiss posters &amp; grids</title><link>https://example.org/a</link><guid>a1</guid><category>Typography</category>
        <description><![CDATA[<p>A look at <img src="https://example.org/i.jpg"> posters</p>]]></description><pubDate>Mon, 06 Oct 2025 10:00:00 GMT</pubDate></item>
      <item><title>No link</title></item></channel></rss>`;
    const parsed = parseFeed(rss, 'https://example.org/feed');
    expect(parsed.title).toBe('Design Archive');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]!.item).toMatchObject({ title: 'Swiss posters & grids', previewUrl: 'https://example.org/i.jpg', tags: ['typography'], creatorName: undefined });
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>E</title><id>e1</id><link rel="alternate" href="/post/1"/><summary>Hi</summary></entry></feed>`;
    expect(parseFeed(atom, 'https://blog.example/feed').entries[0]!.item.originalUrl).toBe('https://blog.example/post/1');
    expect(matchesQuery('Swiss posters and grids', 'swiss poster')).toBe(false);
    expect(matchesQuery('Swiss posters and grids', 'swiss grids')).toBe(true);
  });

  it('reads OpenGraph metadata without executing anything', () => {
    const html = `<html><head><title>Fallback</title><meta property="og:title" content="Real &amp; Title"><meta property="og:image" content="/img.png">
      <meta name="author" content="Jane Doe"><script>alert(1)</script><link rel="canonical" href="https://site.example/c"></head></html>`;
    const m = parsePageMeta(html, 'https://site.example/page');
    expect(m).toMatchObject({ title: 'Real & Title', image: 'https://site.example/img.png', author: 'Jane Doe', canonical: 'https://site.example/c' });
  });

  it('manual import of a direct image link does not invent metadata', async () => {
    const out = await importFromUrl('https://cdn.example.com/archive/aqua_icon.png', new FakeHttp([]));
    expect(out.fetched).toBe(false);
    expect(out.item).toMatchObject({ title: 'aqua_icon', mediaType: 'image' });
    expect(out.item.creatorName).toBeUndefined();
  });

  it('manual import refuses private addresses', async () => {
    await expect(importFromUrl('http://169.254.169.254/latest', new FakeHttp([]))).rejects.toThrow();
  });
});
