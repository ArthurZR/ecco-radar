import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { commitImport, validateImport, rollbackImport } from '../src/modules/imports/service.js';
import { resetDb } from './helpers.js';

// SYNTHETIC fixtures shaped like the Meta and X exports described in DATA_SOURCES.md.
// They do not contain eccö's real analytics.
const IG = Buffer.from(
  [
    'Post ID,Account ID,Account username,Account name,Description,Duration (sec),Publish time,Permalink,Post type,Date,Views,Reach,Likes,Shares,Follows,Comments,Saves',
    '1001,1,ecco.archive,eccö,"Windows XP Luna theme, 2001 #frutigeraero #interface",0,10/05/2026 14:00,https://www.instagram.com/p/AAA/,IG image,Lifetime,"1,200",900,120,10,2,4,30',
    '1002,1,ecco.archive,eccö,"Sega Dreamcast advertisement #videogame",0,10/13/2026 09:30,https://www.instagram.com/p/BBB/,IG carousel,Lifetime,800,700,90,5,,3,12',
    '2001,2,someone.else,Other,"Unrelated account post",0,10/06/2026 10:00,https://www.instagram.com/p/CCC/,IG image,Lifetime,50,40,3,0,0,0,0',
    '1003,1,ecco.archive,eccö,"Broken metric row",0,10/14/2026 10:00,https://www.instagram.com/p/DDD/,IG image,Lifetime,lots,10,1,0,0,0,0',
  ].join('\n'),
);
const IG_MAPPING = {
  post_id: 'Post ID', account_handle: 'Account username', account_name: 'Account name', caption: 'Description', permalink: 'Permalink',
  format: 'Post type', published_at: 'Publish time', duration_seconds: 'Duration (sec)', views: 'Views', reach: 'Reach', likes: 'Likes',
  shares: 'Shares', follows: 'Follows', comments: 'Comments', saves: 'Saves',
};
const X = Buffer.from(['Date,Impressions,Likes,Engagements,Bookmarks,Shares,New follows,Unfollows,Replies,Reposts,Profile visits', '"Sun, Oct 5, 2025",1500,30,80,2,1,3,0,4,5,9', '"Mon, Oct 6, 2025",900,12,40,0,0,1,1,2,1,4'].join('\n'));
const X_MAPPING = { date: 'Date', impressions: 'Impressions', likes: 'Likes', engagements: 'Engagements', bookmarks: 'Bookmarks', shares: 'Shares', new_follows: 'New follows', unfollows: 'Unfollows', replies: 'Replies', reposts: 'Reposts', profile_visits: 'Profile visits' };

beforeEach(resetDb);
afterAll(closeDb);

describe('Instagram post import', () => {
  it('filters other accounts, reports invalid rows and never invents metrics', async () => {
    const v = await validateImport(IG, { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' });
    expect(v.summary).toMatchObject({ total: 4, newRecords: 2, skippedAccount: 1, invalid: 1 });
    const res = await commitImport(IG, 'ig.csv', { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' }, null);
    expect(res.summary.newRecords).toBe(2);
    const posts = await db().query(`SELECT account_handle, published_at FROM historical_posts ORDER BY platform_post_id`);
    expect(posts.rows.every((p) => p.account_handle === 'ecco.archive')).toBe(true);
    expect(new Date(posts.rows[0].published_at).toISOString()).toBe('2026-10-05T14:00:00.000Z');
    // "Follows" was blank for post 1002: absent, not zero
    const follows = await db().query(`SELECT p.platform_post_id FROM historical_post_metrics m JOIN historical_posts p ON p.id = m.post_id WHERE metric = 'follows'`);
    expect(follows.rows.map((r) => r.platform_post_id)).toEqual(['1001']);
    const views = await db().query(`SELECT value FROM historical_post_metrics m JOIN historical_posts p ON p.id = m.post_id WHERE p.platform_post_id = '1001' AND metric = 'views'`);
    expect(views.rows[0].value).toBe(1200);
    // originals preserved
    const raw = await db().query(`SELECT count(*)::int AS n FROM import_raw_rows`);
    expect(raw.rows[0].n).toBe(4);
  });

  it('refuses to import the identical file twice and supports rollback', async () => {
    const opts = { kind: 'instagram_posts' as const, mapping: IG_MAPPING, dateOrder: 'auto' as const, account: 'ecco.archive' };
    const first = await commitImport(IG, 'ig.csv', opts, null);
    await expect(commitImport(IG, 'ig-again.csv', opts, null)).rejects.toMatchObject({ status: 409 });
    await rollbackImport(first.batchId, null);
    expect((await db().query('SELECT count(*)::int AS n FROM historical_posts')).rows[0].n).toBe(0);
    // after rollback the same file may be imported again
    const again = await commitImport(IG, 'ig.csv', opts, null);
    expect(again.summary.newRecords).toBe(2);
  });

  it('treats posts already imported from a different file as duplicates with fresh observations', async () => {
    const opts = { kind: 'instagram_posts' as const, mapping: IG_MAPPING, dateOrder: 'auto' as const, account: 'ecco.archive' };
    await commitImport(IG, 'ig.csv', opts, null);
    const updated = Buffer.from(IG.toString().replace('"1,200"', '"1,500"'));
    const res = await commitImport(updated, 'ig-later.csv', opts, null);
    expect(res.summary).toMatchObject({ newRecords: 0, duplicates: 2 });
    expect((await db().query('SELECT count(*)::int AS n FROM historical_posts')).rows[0].n).toBe(2);
  });

  it('asks for a date order when dates are ambiguous', async () => {
    const amb = Buffer.from(IG.toString().replace('10/13/2026', '10/12/2026').replace('10/14/2026', '10/11/2026'));
    await expect(validateImport(amb, { kind: 'instagram_posts', mapping: IG_MAPPING, dateOrder: 'auto', account: 'ecco.archive' })).rejects.toMatchObject({ status: 422 });
  });
});

describe('X account overview import', () => {
  it('stores daily account totals separately and never as post metrics', async () => {
    const res = await commitImport(X, 'account_overview_analytics.csv', { kind: 'x_account_daily', mapping: X_MAPPING, dateOrder: 'auto', account: 'ecco_archive' }, null);
    expect(res.summary.newRecords).toBe(2);
    expect(res.warnings.join(' ')).toMatch(/never attributed to individual posts/);
    expect((await db().query('SELECT count(*)::int AS n FROM historical_posts')).rows[0].n).toBe(0);
    expect((await db().query('SELECT count(*)::int AS n FROM historical_post_metrics')).rows[0].n).toBe(0);
    const d = await db().query(`SELECT metric_date::text, value FROM account_daily_metrics WHERE metric = 'impressions' ORDER BY metric_date`);
    expect(d.rows).toEqual([{ metric_date: '2025-10-05', value: 1500 }, { metric_date: '2025-10-06', value: 900 }]);
  });
});
