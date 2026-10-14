import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { sphericalKMeans, suggestedK } from '../src/lib/kmeans.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { commitImport } from '../src/modules/imports/service.js';
import { resetDb, appWithSession } from './helpers.js';

beforeEach(resetDb);
afterAll(closeDb);

describe('spherical k-means', () => {
  it('separates two clear directions and is deterministic', () => {
    const a = [[1, 0.1, 0], [0.9, 0.2, 0], [1, 0, 0.1], [0.95, 0.1, 0.05]];
    const b = [[0, 0.1, 1], [0.1, 0, 0.9], [0, 0.2, 1], [0.05, 0.05, 1]];
    const vectors = [...a, ...b];
    const first = sphericalKMeans(vectors, 2);
    const again = sphericalKMeans(vectors, 2);
    expect(first.assignment).toEqual(again.assignment);
    expect(new Set(first.assignment.slice(0, 4)).size).toBe(1);
    expect(new Set(first.assignment.slice(4)).size).toBe(1);
    expect(first.assignment[0]).not.toBe(first.assignment[4]);
  });
  it('never asks for more groups than items and keeps the count modest', () => {
    expect(sphericalKMeans([[1, 0]], 5).centroids).toHaveLength(1);
    expect(suggestedK(6)).toBe(2);
    expect(suggestedK(200)).toBe(10);
    expect(suggestedK(5000)).toBe(12);
  });
});

// SYNTHETIC references in two obvious territories.
const GAMES = ['Dreamcast controller ad', 'Dreamcast console box art', 'Sega Dreamcast launch poster', 'Dreamcast VMU memory card ad'];
const WEB = ['Geocities homepage banner', 'Geocities guestbook page', 'Geocities neighbourhood index', 'Geocities under construction gif'];

async function seedTerritories() {
  let i = 0;
  for (const t of GAMES) await ingestReference({ sourceId: 'manual', originalUrl: `https://example.com/g${++i}`, title: `SYNTHETIC ${t}`, tags: ['video games', 'dreamcast'], mediaType: 'image' }, { method: 'manual_import', path: [] });
  for (const t of WEB) await ingestReference({ sourceId: 'manual', originalUrl: `https://example.com/w${++i}`, title: `SYNTHETIC ${t}`, tags: ['web', 'geocities'], mediaType: 'image' }, { method: 'manual_import', path: [] });
}

describe('clusters API', () => {
  it('groups references by wording and names each group by the tags its members share', async () => {
    await seedTerritories();
    const { app, cookie } = await appWithSession();
    const res = (await app.inject({ url: '/api/clusters?basis=text', headers: { cookie } })).json();
    expect(res).toMatchObject({ basis: 'text', model: 'lexical-hash-v1', considered: 8, withoutVector: 0 });
    expect(res.clusters).toHaveLength(2);
    const tagSets = res.clusters.map((c: { sharedTags: { tag: string }[] }) => c.sharedTags.map((t) => t.tag).sort());
    expect(tagSets).toEqual(expect.arrayContaining([['dreamcast', 'video games'], ['geocities', 'web']]));
    for (const c of res.clusters) expect(c.statusCounts).toEqual({ discovered: 4 });
  });

  it('reports visual grouping as unavailable rather than guessing when images are not analysed', async () => {
    await seedTerritories();
    const { app, cookie } = await appWithSession();
    const res = (await app.inject({ url: '/api/clusters?basis=visual', headers: { cookie } })).json();
    expect(res).toMatchObject({ basis: 'visual', considered: 0, withoutVector: 8, clusters: [] });
  });

  it('leaves rejected references out of the groups', async () => {
    await seedTerritories();
    await db().query(`UPDATE reference_items SET status = 'rejected' WHERE ref_number = 1`);
    const { app, cookie } = await appWithSession();
    const res = (await app.inject({ url: '/api/clusters', headers: { cookie } })).json();
    expect(res.considered).toBe(7);
  });
});

// SYNTHETIC Instagram export: one post links to the reference's recorded publication.
const IG = Buffer.from(
  [
    'Post ID,Account username,Description,Publish time,Permalink,Post type,Reach,Likes,Shares,Comments,Saves',
    '9001,ecco.archive,"SYNTHETIC Dreamcast launch poster, 1999 #dreamcast",10/13/2026 14:00,https://www.instagram.com/p/SYN1/,IG image,1000,80,5,4,11',
    '9002,ecco.archive,"SYNTHETIC Dreamcast controller ad scan #dreamcast",10/14/2026 14:00,https://www.instagram.com/p/SYN2/,IG image,500,20,1,1,3',
    '9003,ecco.archive,"SYNTHETIC unrelated textile archive",10/15/2026 14:00,https://www.instagram.com/p/SYN3/,IG image,400,10,0,0,1',
  ].join('\n'),
);
const IG_MAPPING = {
  post_id: 'Post ID', account_handle: 'Account username', caption: 'Description', permalink: 'Permalink', format: 'Post type',
  published_at: 'Publish time', reach: 'Reach', likes: 'Likes', shares: 'Shares', comments: 'Comments', saves: 'Saves',
};
const X = Buffer.from(['Date,Impressions,Likes', '"Sun, Oct 5, 2025",1500,30'].join('\n'));

describe('reference performance', () => {
  it('shows the matching post for a recorded publication, similar captions, and never X daily totals', async () => {
    const r = await ingestReference({ sourceId: 'manual', originalUrl: 'https://example.com/poster', title: 'SYNTHETIC Dreamcast launch poster', tags: ['dreamcast'], mediaType: 'image' }, { method: 'manual_import', path: [] });
    const { app, cookie } = await appWithSession();

    const empty = (await app.inject({ url: `/api/references/${r.refNumber}/performance`, headers: { cookie } })).json();
    expect(empty).toMatchObject({ published: [], similarCaptions: [], baseline: null });
    expect(empty.notes.join(' ')).toMatch(/No post-level analytics/);

    await commitImport(IG, 'SYNTHETIC-ig.csv', { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' }, null);
    await commitImport(X, 'SYNTHETIC-x.csv', { kind: 'x_account_daily', mapping: { date: 'Date', impressions: 'Impressions', likes: 'Likes' }, dateOrder: 'auto', account: 'ecco' }, null);
    await db().query(`INSERT INTO publication_reports(reference_id, platform, permalink, published_on) VALUES ($1, 'instagram', 'https://instagram.com/p/SYN1', '2026-10-05')`, [r.id]);
    await db().query(`INSERT INTO publication_reports(reference_id, platform, permalink) VALUES ($1, 'x', 'https://x.com/ecco/status/1')`, [r.id]);

    const res = (await app.inject({ url: `/api/references/${r.refNumber}/performance`, headers: { cookie } })).json();
    expect(res.published).toHaveLength(1);
    expect(res.published[0]).toMatchObject({ platform: 'instagram', metrics: { reach: 1000, likes: 80, saves: 11 } });
    expect(res.published[0].engagementPerReach).toBeCloseTo(0.1, 5);
    expect(res.unmatchedReports).toEqual([{ platform: 'x', permalink: 'https://x.com/ecco/status/1', publishedOn: null }]);
    // The published post is not repeated among similar captions; the unrelated one is not similar.
    const similar = res.similarCaptions.map((p: { permalink: string }) => p.permalink);
    expect(similar).toContain('https://www.instagram.com/p/SYN2/');
    expect(similar).not.toContain('https://www.instagram.com/p/SYN1/');
    expect(similar).not.toContain('https://www.instagram.com/p/SYN3/');
    expect(res.baseline.n).toBe(3);
    expect(JSON.stringify(res)).not.toMatch(/impressions/);
  });
});
