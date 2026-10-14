import { z } from 'zod';
import { normalizeHeader } from './normalize.js';

export const IMPORT_KINDS = ['instagram_posts', 'x_account_daily', 'x_posts'] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export const POST_METRICS = ['views', 'reach', 'impressions', 'likes', 'comments', 'shares', 'reposts', 'saves', 'bookmarks', 'follows', 'replies', 'profile_visits', 'engagements'] as const;
export type PostMetric = (typeof POST_METRICS)[number];

export const DAILY_METRICS = ['impressions', 'likes', 'engagements', 'bookmarks', 'shares', 'new_follows', 'unfollows', 'replies', 'reposts', 'profile_visits', 'create_post', 'video_views', 'media_views'] as const;

/** Target fields per import kind and the header names commonly used for them in platform exports. */
export const FIELD_ALIASES: Record<ImportKind, Record<string, string[]>> = {
  instagram_posts: {
    post_id: ['post id', 'media id', 'id'],
    account_handle: ['account username', 'username', 'account'],
    account_name: ['account name', 'name'],
    caption: ['description', 'caption', 'text'],
    permalink: ['permalink', 'post link', 'link', 'url'],
    format: ['post type', 'media type', 'type', 'format'],
    published_at: ['publish time', 'published', 'date', 'timestamp', 'created time'],
    duration_seconds: ['duration', 'duration sec'],
    views: ['views', 'plays', 'video views'],
    reach: ['reach', 'accounts reached'],
    impressions: ['impressions'],
    likes: ['likes', 'like count'],
    comments: ['comments', 'comment count'],
    shares: ['shares'],
    saves: ['saves', 'saved'],
    follows: ['follows', 'new follows'],
    profile_visits: ['profile visits'],
  },
  x_posts: {
    post_id: ['post id', 'tweet id', 'id'],
    caption: ['post text', 'tweet text', 'text'],
    permalink: ['post link', 'tweet permalink', 'permalink', 'link'],
    published_at: ['date', 'time', 'created at'],
    impressions: ['impressions'],
    likes: ['likes'],
    engagements: ['engagements'],
    bookmarks: ['bookmarks'],
    shares: ['shares'],
    reposts: ['reposts', 'retweets'],
    replies: ['replies'],
    follows: ['new follows', 'follows'],
    profile_visits: ['profile visits', 'user profile clicks'],
  },
  x_account_daily: {
    date: ['date', 'day'],
    impressions: ['impressions'],
    likes: ['likes'],
    engagements: ['engagements'],
    bookmarks: ['bookmarks'],
    shares: ['shares'],
    new_follows: ['new follows', 'follows'],
    unfollows: ['unfollows'],
    replies: ['replies'],
    reposts: ['reposts', 'retweets'],
    profile_visits: ['profile visits'],
    create_post: ['create post', 'posts created'],
    video_views: ['video views'],
    media_views: ['media views'],
  },
};

export function suggestMapping(kind: ImportKind, headers: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const norm = headers.map((h) => ({ h, n: normalizeHeader(h) }));
  for (const [field, aliases] of Object.entries(FIELD_ALIASES[kind])) {
    const hit = aliases.map((a) => norm.find((x) => x.n === a)).find(Boolean);
    if (hit && !Object.values(out).includes(hit.h)) out[field] = hit.h;
  }
  return out;
}

/** Guess what a file is from its headers. Never decides silently: the user confirms the kind. */
export function detectKind(headers: string[]): { kind: ImportKind | null; reason: string } {
  const n = new Set(headers.map(normalizeHeader));
  if ((n.has('permalink') || n.has('post id')) && (n.has('account username') || n.has('publish time'))) {
    return { kind: 'instagram_posts', reason: 'Has per-post permalinks and account usernames (Instagram/Meta post export).' };
  }
  if ((n.has('post id') || n.has('post link') || n.has('tweet id')) && n.has('impressions')) {
    return { kind: 'x_posts', reason: 'Has a post id/link per row with impressions (X post-level export).' };
  }
  if (n.has('date') && n.has('impressions') && !n.has('post id') && !n.has('permalink')) {
    return { kind: 'x_account_daily', reason: 'One row per date with totals and no post identifiers (X account overview).' };
  }
  return { kind: null, reason: 'Headers do not match a known export; choose the type and map columns manually.' };
}

export const ImportOptionsSchema = z.object({
  kind: z.enum(IMPORT_KINDS),
  mapping: z.record(z.string(), z.string().max(200)),
  dateOrder: z.enum(['auto', 'MDY', 'DMY', 'ISO']).default('auto'),
  /** Instagram: only rows from this account are imported. X: the account the file belongs to. */
  account: z.string().trim().min(1).max(100).optional(),
});
export type ImportOptions = z.infer<typeof ImportOptionsSchema>;
