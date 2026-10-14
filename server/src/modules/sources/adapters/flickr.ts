import { SourceError, safeUrl, type SourceAdapter } from '../adapter.js';

interface FlickrPhoto {
  id: string;
  owner: string;
  title?: string;
  ownername?: string;
  pathalias?: string | null;
  datetaken?: string;
  datetakenunknown?: string | number;
  description?: { _content?: string };
  tags?: string;
  license?: string;
  url_l?: string;
  url_m?: string;
  width_l?: number | string;
  height_l?: number | string;
  width_m?: number | string;
  height_m?: number | string;
}
interface FlickrResponse {
  stat: 'ok' | 'fail';
  code?: number;
  message?: string;
  photos?: { page: number; pages: number; total: number | string; photo: FlickrPhoto[] };
}

// https://www.flickr.com/services/api/flickr.photos.licenses.getInfo.html
const LICENSES: Record<string, string> = {
  '0': 'All Rights Reserved', '1': 'CC BY-NC-SA 2.0', '2': 'CC BY-NC 2.0', '3': 'CC BY-NC-ND 2.0', '4': 'CC BY 2.0',
  '5': 'CC BY-SA 2.0', '6': 'CC BY-ND 2.0', '7': 'No known copyright restrictions', '8': 'United States Government Work',
  '9': 'CC0 1.0', '10': 'Public Domain Mark 1.0',
};

export const flickr: SourceAdapter = {
  id: 'flickr',
  name: 'Flickr',
  connectorType: 'api',
  baseUrl: 'https://api.flickr.com/services/rest/',
  termsUrl: 'https://www.flickr.com/services/api/tos/',
  attribution: 'Show the photographer name and link back to the Flickr photo page; respect each photo licence.',
  baselineReliability: 0.65,
  ratePerMinute: 30,
  requiresCredentials: true,
  allowsMediaCaching: false,
  capabilities: { search: true, pagination: true, creator: true, previews: true, dates: true, licenses: true },
  accessNotes:
    'Official REST API, needs FLICKR_API_KEY (free for non-commercial use, 3,600 calls/hour). Uploader is the account owner; that is usually but not always the photographer. Flickr API terms forbid storing photos beyond caching, so RADAR hot-links previews.',
  missingConfiguration: (env) => (env.FLICKR_API_KEY ? [] : ['FLICKR_API_KEY']),
  async search({ query, page, perPage }, { http, env }) {
    if (!env.FLICKR_API_KEY) throw new SourceError(this.id, 'not_configured', 'FLICKR_API_KEY is not set');
    const url = new URL(this.baseUrl);
    Object.entries({
      method: 'flickr.photos.search', api_key: env.FLICKR_API_KEY, text: query, sort: 'relevance', safe_search: '1',
      content_types: '0', media: 'photos', extras: 'owner_name,path_alias,date_taken,description,tags,license,url_m,url_l',
      per_page: String(perPage), page: String(page), format: 'json', nojsoncallback: '1',
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const data = await http.getJson<FlickrResponse>(url.toString(), { rateKey: this.id, ratePerMinute: this.ratePerMinute });
    if (data.stat !== 'ok' || !data.photos) {
      throw new SourceError(this.id, data.code === 100 ? 'not_configured' : 'bad_response', data.message ?? 'Flickr API error');
    }
    const items = data.photos.photo.map((p) => {
      const owner = p.pathalias || p.owner;
      const unknownDate = String(p.datetakenunknown ?? '0') === '1';
      const w = Number(p.width_l ?? p.width_m) || undefined;
      const h = Number(p.height_l ?? p.height_m) || undefined;
      return {
        sourceId: this.id,
        sourceItemId: p.id,
        originalUrl: `https://www.flickr.com/photos/${encodeURIComponent(owner)}/${p.id}`,
        title: p.title || undefined,
        description: p.description?._content || undefined,
        creatorName: p.ownername || undefined,
        creatorUrl: `https://www.flickr.com/photos/${encodeURIComponent(owner)}/`,
        publishedRaw: unknownDate ? undefined : p.datetaken?.slice(0, 10),
        previewUrl: safeUrl(p.url_l ?? p.url_m),
        thumbnailUrl: safeUrl(p.url_m),
        mediaType: 'image' as const,
        width: w,
        height: h,
        license: p.license ? LICENSES[p.license] : undefined,
        tags: (p.tags ?? '').split(' ').filter(Boolean).slice(0, 20),
        entities: [],
        researchSources: [],
      };
    });
    return { items, hasMore: data.photos.page < data.photos.pages, total: Number(data.photos.total) };
  },
};
