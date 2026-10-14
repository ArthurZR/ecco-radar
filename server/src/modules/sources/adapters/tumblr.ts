import { stripHtml } from '../../../lib/text.js';
import { SourceError, safeUrl, type SourceAdapter } from '../adapter.js';

interface TumblrPost {
  id_string?: string;
  id?: number;
  blog_name?: string;
  post_url?: string;
  type?: string;
  timestamp?: number;
  summary?: string;
  caption?: string;
  tags?: string[];
  source_url?: string;
  source_title?: string;
  photos?: { original_size?: { url?: string; width?: number; height?: number }; alt_sizes?: { url?: string; width?: number }[] }[];
}
interface TumblrResponse {
  meta?: { status: number; msg: string };
  response?: TumblrPost[];
}

export const tumblr: SourceAdapter = {
  id: 'tumblr',
  name: 'Tumblr',
  connectorType: 'api',
  baseUrl: 'https://api.tumblr.com/v2/tagged',
  termsUrl: 'https://www.tumblr.com/docs/en/api_agreement',
  attribution: 'Link to the Tumblr post. The blog that posted an image is often not its creator; check the reblog source.',
  baselineReliability: 0.3,
  ratePerMinute: 20,
  requiresCredentials: true,
  allowsMediaCaching: false,
  capabilities: { search: true, pagination: true, creator: false, previews: true, dates: true, licenses: false },
  accessNotes:
    'Official API v2 /tagged endpoint, needs TUMBLR_API_KEY (OAuth consumer key). Searches by a single tag, not free text; the query is converted to a tag. Posting blogs are usually reposters, so RADAR records them as "posted by", never as creator.',
  missingConfiguration: (env) => (env.TUMBLR_API_KEY ? [] : ['TUMBLR_API_KEY']),
  async search({ query, page, perPage }, { http, env }) {
    if (!env.TUMBLR_API_KEY) throw new SourceError(this.id, 'not_configured', 'TUMBLR_API_KEY is not set');
    if (page > 1) return { items: [], hasMore: false }; // timestamp-cursor pagination is driven by the exploration engine depth instead
    const url = new URL(this.baseUrl);
    url.searchParams.set('tag', query.toLowerCase().trim());
    url.searchParams.set('api_key', env.TUMBLR_API_KEY);
    url.searchParams.set('limit', String(Math.min(perPage, 20)));
    const data = await http.getJson<TumblrResponse>(url.toString(), { rateKey: this.id, ratePerMinute: this.ratePerMinute });
    if (data.meta?.status !== 200 || !data.response) throw new SourceError(this.id, 'bad_response', data.meta?.msg ?? 'Tumblr API error');
    const items = data.response.flatMap((p) => {
      const photo = p.photos?.[0];
      const postUrl = safeUrl(p.post_url);
      if (!postUrl || !photo?.original_size?.url) return [];
      const posted = p.blog_name ? `Posted on Tumblr by ${p.blog_name}. ` : '';
      const source = p.source_url ? `Reblog source given: ${p.source_title ?? p.source_url}. ` : '';
      return [{
        sourceId: this.id,
        sourceItemId: p.id_string ?? String(p.id),
        originalUrl: postUrl,
        title: p.summary ? stripHtml(p.summary).slice(0, 300) : undefined,
        description: `${posted}${source}${stripHtml(p.caption).slice(0, 4000)}`.trim() || undefined,
        creatorName: undefined, // poster is not the creator
        publishedRaw: p.timestamp ? new Date(p.timestamp * 1000).toISOString().slice(0, 10) : undefined,
        previewUrl: safeUrl(photo.original_size.url),
        thumbnailUrl: safeUrl(photo.alt_sizes?.find((a) => (a.width ?? 0) <= 500)?.url),
        mediaType: 'image' as const,
        width: photo.original_size.width,
        height: photo.original_size.height,
        tags: (p.tags ?? []).slice(0, 20),
        entities: [],
        researchSources: p.source_url && safeUrl(p.source_url) ? [{ url: safeUrl(p.source_url)!, title: p.source_title, kind: 'article' as const }] : [],
      }];
    });
    return { items, hasMore: false };
  },
};
