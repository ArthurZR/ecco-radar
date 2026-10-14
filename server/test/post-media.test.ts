import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import yazl from 'yazl';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { commitImport } from '../src/modules/imports/service.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { fixMetaEncoding, matchExportPosts, readPostsJson, type CandidatePost } from '../src/modules/post-media/instagram-export.js';
import { colourfulnessOf, toneOf } from '../src/modules/post-media/service.js';
import { invalidateProfile } from '../src/modules/ranking/profile.js';
import { resetDb, appWithSession } from './helpers.js';

beforeEach(resetDb);
afterAll(closeDb);

const H = 3600_000;
const T0 = Date.UTC(2026, 9, 13, 14, 0, 0);

describe('Instagram export reading', () => {
  it('repairs the Latin-1 escaped UTF-8 Meta writes, and leaves correct text alone', () => {
    expect(fixMetaEncoding('CafÃ© Tacvba â\u0080\u0094 1999')).toBe('Café Tacvba — 1999');
    expect(fixMetaEncoding('Café — já')).toBe('Café — já');
    expect(fixMetaEncoding('plain ascii')).toBe('plain ascii');
  });

  it('reads single images and carousels, taking caption and time from wherever Instagram put them', () => {
    const posts = readPostsJson([
      { media: [{ uri: 'media/posts/202610/a.jpg', creation_timestamp: 1760364000, title: 'SYNTHETIC single' }] },
      { media: [{ uri: 'media/posts/202610/b1.jpg' }, { uri: 'media/posts/202610/b2.mp4' }], title: 'SYNTHETIC carousel', creation_timestamp: 1760450400 },
      { media: [] },
      'junk',
    ], 'posts_1.json');
    expect(posts).toEqual([
      { key: 'posts_1.json#1', caption: 'SYNTHETIC single', timestamp: 1760364000, media: [{ uri: 'media/posts/202610/a.jpg', position: 0 }] },
      { key: 'posts_1.json#2', caption: 'SYNTHETIC carousel', timestamp: 1760450400, media: [{ uri: 'media/posts/202610/b1.jpg', position: 0 }, { uri: 'media/posts/202610/b2.mp4', position: 1 }] },
    ]);
    expect(() => readPostsJson({ not: 'a list' }, 'posts_1.json')).toThrow(/JSON format/);
  });
});

describe('matching exported posts to imported posts', () => {
  const ep = (key: string, caption: string, ms: number | null) => ({ key, caption, timestamp: ms === null ? null : ms / 1000, media: [] });
  const cands: CandidatePost[] = [
    { id: 'a', caption: 'SYNTHETIC Dreamcast launch poster, 1999 #dreamcast', publishedAt: T0 },
    { id: 'b', caption: 'SYNTHETIC Geocities guestbook. A long caption that the analytics export cut short because it keeps going', publishedAt: T0 + 48 * H },
    { id: 'c', caption: 'SYNTHETIC repeated caption', publishedAt: T0 + 100 * H },
    { id: 'd', caption: 'SYNTHETIC repeated caption', publishedAt: T0 + 101 * H },
    { id: 'e', caption: 'SYNTHETIC repeated caption', publishedAt: T0 + 300 * H },
    { id: 'f', caption: null, publishedAt: T0 + 500 * H },
  ];

  it('ties a post by caption even when the analytics times are in another time zone', () => {
    const [m] = matchExportPosts([ep('x', 'SYNTHETIC  Dreamcast launch poster, 1999 #Dreamcast', T0 - 5 * H)], cands);
    expect(m).toEqual({ key: 'x', postId: 'a', note: 'Caption and date match.' });
  });

  it('accepts a cut caption as a prefix, but not a short one', () => {
    const [long] = matchExportPosts([ep('x', 'SYNTHETIC Geocities guestbook. A long caption that the analytics export cut short because it keeps going on and on', T0 + 48 * H)], cands);
    expect(long).toMatchObject({ postId: 'b' });
    const [short] = matchExportPosts([ep('y', 'SYNTHETIC Dreamcast', T0)], cands);
    expect(short).toMatchObject({ postId: null });
  });

  it('uses time only to choose between identical captions, and gives up when it cannot', () => {
    const [far] = matchExportPosts([ep('x', 'SYNTHETIC repeated caption', T0 + 300 * H)], cands);
    expect(far).toMatchObject({ postId: 'e' });
    const [close] = matchExportPosts([ep('y', 'SYNTHETIC repeated caption', T0 + 100.5 * H)], cands);
    expect(close).toMatchObject({ postId: null });
    expect((close as { reason: string }).reason).toMatch(/matches 2 imported posts/);
  });

  it('matches a post without caption only on the exact minute', () => {
    expect(matchExportPosts([ep('x', '', T0 + 500 * H + 30_000)], cands)[0]).toMatchObject({ postId: 'f' });
    expect(matchExportPosts([ep('y', '', T0 + 501 * H)], cands)[0]).toMatchObject({ postId: null });
  });

  it('never gives one post the images of two export entries', () => {
    const out = matchExportPosts([ep('x', 'SYNTHETIC Dreamcast launch poster, 1999 #dreamcast', T0), ep('y', 'SYNTHETIC Dreamcast launch poster, 1999 #dreamcast', T0 + H)], cands);
    expect(out.every((m) => m.postId === null)).toBe(true);
  });

  it('describes tone and colourfulness from pixel means only', () => {
    expect([toneOf(0.1), toneOf(0.5), toneOf(0.9)]).toEqual(['dark', 'mid-tone', 'light']);
    expect([colourfulnessOf(0.05), colourfulnessOf(0.3), colourfulnessOf(0.8)]).toEqual(['muted', 'moderate', 'vivid']);
  });
});

// --- API ---------------------------------------------------------------------------------------

// SYNTHETIC Instagram analytics export: three posts, times written as UTC.
const IG = Buffer.from(
  [
    'Post ID,Account username,Description,Publish time,Permalink,Post type,Reach,Likes,Shares,Comments,Saves',
    '9001,ecco.archive,"SYNTHETIC Aqua button study, 2003",10/13/2026 14:00,https://www.instagram.com/p/SYN1/,IG image,1000,80,5,4,11',
    '9002,ecco.archive,"SYNTHETIC chrome logo sheet",10/14/2026 14:00,https://www.instagram.com/p/SYN2/,IG carousel,500,20,1,1,3',
    '9003,ecco.archive,"SYNTHETIC post with no export match",10/15/2026 14:00,https://www.instagram.com/p/SYN3/,IG image,400,10,0,0,1',
  ].join('\n'),
);
const IG_MAPPING = {
  post_id: 'Post ID', account_handle: 'Account username', caption: 'Description', permalink: 'Permalink', format: 'Post type',
  published_at: 'Publish time', reach: 'Reach', likes: 'Likes', shares: 'Shares', comments: 'Comments', saves: 'Saves',
};

const solid = (r: number, g: number, b: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g, b } } }).jpeg().toBuffer();
// A non-uniform image, so its perceptual hash carries structure (a solid colour hashes to all zeros).
const stripes = () => sharp(Buffer.from(Array.from({ length: 64 * 64 * 3 }, (_, i) => ((Math.floor(i / 3) % 64) < 32 ? 30 : 220))), { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();

async function exportZip(): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  const posts = [
    { media: [{ uri: 'media/posts/202610/aqua.jpg', creation_timestamp: Date.UTC(2026, 9, 13, 11, 0) / 1000, title: 'SYNTHETIC Aqua button study, 2003' }] },
    {
      media: [{ uri: 'media/posts/202610/chrome1.png' }, { uri: 'media/posts/202610/chrome2.jpg' }, { uri: 'media/posts/202610/clip.mp4' }, { uri: 'media/posts/202610/missing.jpg' }],
      title: 'SYNTHETIC chrome logo sheet', creation_timestamp: Date.UTC(2026, 9, 14, 14, 0) / 1000,
    },
    { media: [{ uri: 'media/posts/202601/old.jpg', creation_timestamp: Date.UTC(2026, 0, 1) / 1000, title: 'SYNTHETIC older post not in the analytics' }] },
  ];
  const root = 'instagram-ecco.archive-2026-10-14/';
  zip.addBuffer(Buffer.from(JSON.stringify(posts)), `${root}your_instagram_activity/content/posts_1.json`);
  zip.addBuffer(await solid(20, 60, 200), `${root}media/posts/202610/aqua.jpg`);
  zip.addBuffer(await stripes(), `${root}media/posts/202610/chrome1.png`);
  zip.addBuffer(await solid(240, 240, 240), `${root}media/posts/202610/chrome2.jpg`);
  zip.addBuffer(Buffer.from('not really a video'), `${root}media/posts/202610/clip.mp4`);
  zip.addBuffer(await solid(10, 10, 10), `${root}media/posts/202601/old.jpg`);
  zip.end();
  const chunks: Buffer[] = [];
  for await (const c of zip.outputStream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function multipart(filename: string, content: Buffer, type: string) {
  const boundary = '----radar-test-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

const mediaFiles = () => (existsSync(resolve(process.env.MEDIA_DIR!)) ? readdirSync(resolve(process.env.MEDIA_DIR!)).filter((n) => n.endsWith('.webp')) : []);

describe('post images API', () => {
  it('imports images from an Instagram export, reports what it could not tie, and can undo it', async () => {
    const batch = await commitImport(IG, 'SYNTHETIC-ig.csv', { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' }, null);
    const { app, cookie } = await appWithSession();
    const before = mediaFiles().length;

    const up = multipart('instagram-ecco.archive.zip', await exportZip(), 'application/zip');
    const res = await app.inject({ method: 'POST', url: '/api/post-media/instagram-export', headers: { cookie, ...up.headers }, payload: up.payload });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s).toMatchObject({ postsInExport: 3, matchedPosts: 2, imagesAdded: 3, videosSkipped: 1, missingFiles: 1, unreadableImages: 0 });
    expect(s.unmatched).toHaveLength(1);
    expect(s.unmatched[0].caption).toMatch(/older post/);
    expect(mediaFiles().length - before).toBe(3);

    // Coverage, post list and features follow.
    const summary = (await app.inject({ url: '/api/post-media/summary', headers: { cookie } })).json();
    expect(summary).toMatchObject({ posts: 3, with_media: 2, images: 3, from_export: 3 });
    const without = (await app.inject({ url: '/api/historical-posts?media=without', headers: { cookie } })).json();
    expect(without.total).toBe(1);
    expect(without.posts[0].caption).toMatch(/no export match/);
    const withMedia = (await app.inject({ url: '/api/historical-posts?media=with', headers: { cookie } })).json();
    const carousel = withMedia.posts.find((p: { caption: string }) => p.caption.includes('chrome'));
    expect(carousel.media).toHaveLength(2);
    expect(carousel.media[0].matchNote).toMatch(/Caption and date match/);
    const features = (await db().query(`SELECT feature_kind, value FROM historical_post_features WHERE evidence = 'media' ORDER BY feature_kind, value`)).rows;
    expect(features).toContainEqual({ feature_kind: 'tone', value: 'dark' });
    expect(features).toContainEqual({ feature_kind: 'colourfulness', value: 'vivid' });

    const img = await app.inject({ url: `/api/post-media/${carousel.media[0].id}/image`, headers: { cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/webp');
    expect((await sharp(img.rawPayload).metadata()).format).toBe('webp');
    expect((await app.inject({ url: `/api/post-media/${carousel.media[0].id}/image` })).statusCode).toBe(401);

    // Importing the same export again adds nothing.
    const again = await app.inject({ method: 'POST', url: '/api/post-media/instagram-export', headers: { cookie, ...up.headers }, payload: up.payload });
    expect(again.json()).toMatchObject({ imagesAdded: 0, imagesAlreadyAttached: 3, importId: null });

    const imports = (await app.inject({ url: '/api/post-media/imports', headers: { cookie } })).json();
    expect(imports).toHaveLength(1);
    const undo = await app.inject({ method: 'DELETE', url: `/api/post-media/imports/${imports[0].id}`, headers: { cookie } });
    expect(undo.json()).toEqual({ removed: 3 });
    expect(mediaFiles().length).toBe(before);
    expect((await db().query(`SELECT count(*)::int AS n FROM historical_posts WHERE media_available`)).rows[0].n).toBe(0);
    expect((await db().query(`SELECT count(*)::int AS n FROM historical_post_features WHERE evidence = 'media'`)).rows[0].n).toBe(0);
    void batch;
  });

  it('refuses archives without a posts file, and non-ZIP uploads', async () => {
    await commitImport(IG, 'SYNTHETIC-ig.csv', { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' }, null);
    const { app, cookie } = await appWithSession();
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from('hello'), 'readme.txt');
    zip.end();
    const chunks: Buffer[] = [];
    for await (const c of zip.outputStream) chunks.push(c as Buffer);
    const empty = multipart('export.zip', Buffer.concat(chunks), 'application/zip');
    const r1 = await app.inject({ method: 'POST', url: '/api/post-media/instagram-export', headers: { cookie, ...empty.headers }, payload: empty.payload });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().message).toMatch(/posts_1\.json/);
    const notZip = multipart('export.zip', Buffer.from('definitely not a zip'), 'application/zip');
    const r2 = await app.inject({ method: 'POST', url: '/api/post-media/instagram-export', headers: { cookie, ...notZip.headers }, payload: notZip.payload });
    expect(r2.statusCode).toBe(400);
    expect(r2.json().message).toMatch(/not a readable ZIP/);
    const csv = multipart('export.csv', Buffer.from('a,b'), 'text/csv');
    const r3 = await app.inject({ method: 'POST', url: '/api/post-media/instagram-export', headers: { cookie, ...csv.headers }, payload: csv.payload });
    expect(r3.statusCode).toBe(400);
  });

  it('lets the editor attach and remove an image by hand, and removes stored files when the CSV import is rolled back', async () => {
    const batch = await commitImport(IG, 'SYNTHETIC-ig.csv', { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' }, null);
    const { app, cookie } = await appWithSession();
    const post = (await app.inject({ url: '/api/historical-posts?media=without&limit=1', headers: { cookie } })).json().posts[0];
    const before = mediaFiles().length;

    const bad = multipart('notes.txt', Buffer.from('not an image'), 'text/plain');
    expect((await app.inject({ method: 'POST', url: `/api/historical-posts/${post.id}/media`, headers: { cookie, ...bad.headers }, payload: bad.payload })).statusCode).toBe(400);

    const up = multipart('cover.jpg', await solid(200, 30, 30), 'image/jpeg');
    const added = await app.inject({ method: 'POST', url: `/api/historical-posts/${post.id}/media`, headers: { cookie, ...up.headers }, payload: up.payload });
    expect(added.statusCode).toBe(200);
    const dup = await app.inject({ method: 'POST', url: `/api/historical-posts/${post.id}/media`, headers: { cookie, ...up.headers }, payload: up.payload });
    expect(dup.statusCode).toBe(409);
    const removed = await app.inject({ method: 'DELETE', url: `/api/post-media/${added.json().mediaId}`, headers: { cookie } });
    expect(removed.json()).toEqual({ removed: true });
    expect(mediaFiles().length).toBe(before);

    await app.inject({ method: 'POST', url: `/api/historical-posts/${post.id}/media`, headers: { cookie, ...up.headers }, payload: up.payload });
    expect(mediaFiles().length).toBe(before + 1);
    const rb = await app.inject({ method: 'POST', url: `/api/imports/${batch.batchId}/rollback`, headers: { cookie } });
    expect(rb.statusCode).toBe(200);
    expect(mediaFiles().length).toBe(before);
  });

  it('notices when a reference is an image eccö already posted, and says so in ranking and performance', async () => {
    await commitImport(IG, 'SYNTHETIC-ig.csv', { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' }, null);
    const { app, cookie } = await appWithSession();
    const post = (await app.inject({ url: '/api/historical-posts?limit=1', headers: { cookie } })).json().posts[0];
    const image = await stripes();
    const up = multipart('cover.png', image, 'image/png');
    await app.inject({ method: 'POST', url: `/api/historical-posts/${post.id}/media`, headers: { cookie, ...up.headers }, payload: up.payload });

    const r = await ingestReference({ sourceId: 'manual', originalUrl: 'https://example.com/stripes', title: 'SYNTHETIC stripes', mediaType: 'image' }, { method: 'manual_import', path: [] });
    // Same picture, recompressed and resized: the perceptual hash still matches.
    const { analyzeImage } = await import('../src/lib/visual.js');
    const a = await analyzeImage(await sharp(image).resize(200, 200).jpeg({ quality: 60 }).toBuffer());
    await db().query(`UPDATE reference_items SET visual_hash = $2, visual_embedding = $3, visual_analyzed_at = now() WHERE id = $1`, [r.id, a.dhash, a.embedding]);
    invalidateProfile();

    const perf = (await app.inject({ url: `/api/references/${r.refNumber}/performance`, headers: { cookie } })).json();
    expect(perf.alreadyPosted).toHaveLength(1);
    expect(perf.alreadyPosted[0]).toMatchObject({ permalink: post.permalink, imageId: expect.any(String) });
    expect(perf.postsWithImages).toBe(1);
    expect(perf.notes.join(' ')).toMatch(/Already posted/);

    const detail = (await app.inject({ url: `/api/references/${r.refNumber}`, headers: { cookie } })).json();
    const penalties = JSON.stringify(detail);
    expect(penalties).toMatch(/eccö already posted this image/);
  });
});
