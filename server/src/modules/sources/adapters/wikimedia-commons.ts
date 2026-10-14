import { stripHtml } from '../../../lib/text.js';
import { SourceError, safeUrl, type SourceAdapter } from '../adapter.js';

interface CommonsPage {
  pageid: number;
  title: string;
  index?: number;
  imageinfo?: {
    url?: string;
    thumburl?: string;
    descriptionurl?: string;
    width?: number;
    height?: number;
    mime?: string;
    extmetadata?: Record<string, { value?: unknown } | undefined>;
  }[];
}
interface CommonsResponse {
  query?: { pages?: CommonsPage[] };
  continue?: { gsroffset?: number };
  error?: { info?: string };
}

const meta = (m: CommonsPage['imageinfo'] extends (infer I)[] | undefined ? I : never, key: string): string | undefined => {
  const v = m?.extmetadata?.[key]?.value;
  if (typeof v !== 'string') return undefined;
  const s = stripHtml(v).trim();
  return s || undefined;
};

/** Pulls a user/creator page link out of the Artist HTML when Commons provides one. */
function artistLink(html: unknown): string | undefined {
  if (typeof html !== 'string') return undefined;
  const m = html.match(/href="([^"]+)"/);
  return m ? safeUrl(m[1]!.startsWith('/') ? `https://commons.wikimedia.org${m[1]}` : m[1]) : undefined;
}

export const wikimediaCommons: SourceAdapter = {
  id: 'wikimedia_commons',
  name: 'Wikimedia Commons',
  connectorType: 'api',
  baseUrl: 'https://commons.wikimedia.org/w/api.php',
  termsUrl: 'https://foundation.wikimedia.org/wiki/Policy:Terms_of_Use',
  attribution: 'Credit the author and licence shown on each file page; licences vary per file.',
  baselineReliability: 0.75,
  ratePerMinute: 60,
  requiresCredentials: false,
  allowsMediaCaching: false,
  capabilities: { search: true, pagination: true, creator: true, previews: true, dates: true, licenses: true },
  accessNotes:
    'Public MediaWiki Action API (no key). Searches the File namespace and reads author, date, description and licence from extmetadata. Wikimedia asks clients to send a User-Agent with contact details (SOURCE_CONTACT).',
  missingConfiguration: () => [],
  async search({ query, page, perPage }, { http }) {
    const offset = (page - 1) * perPage;
    const url = new URL(this.baseUrl);
    Object.entries({
      action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: query,
      gsrnamespace: '6', gsrlimit: String(perPage), gsroffset: String(offset), prop: 'imageinfo',
      iiprop: 'url|size|mime|extmetadata', iiurlwidth: '800',
      iiextmetadatafilter: 'Artist|DateTimeOriginal|DateTime|ImageDescription|LicenseShortName|UsageTerms|Credit|Categories|ObjectName',
    }).forEach(([k, v]) => url.searchParams.set(k, v));
    const data = await http.getJson<CommonsResponse>(url.toString(), { rateKey: this.id, ratePerMinute: this.ratePerMinute });
    if (data.error) throw new SourceError(this.id, 'bad_response', data.error.info ?? 'Commons API error');
    const pages = [...(data.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const items = pages.flatMap((p) => {
      const info = p.imageinfo?.[0];
      const pageUrl = safeUrl(info?.descriptionurl) ?? `https://commons.wikimedia.org/wiki/${encodeURIComponent(p.title.replace(/ /g, '_'))}`;
      if (!info) return [];
      const mime = info.mime ?? '';
      const mediaType = mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'unknown';
      const categories = (meta(info, 'Categories') ?? '').split('|').map((c) => c.trim()).filter((c) => c && !/^(CC-|GFDL|PD-|Self-published|License|Files with|Uploaded|Media needing|Pages with)/i.test(c));
      const artist = meta(info, 'Artist');
      return [{
        sourceId: this.id,
        sourceItemId: String(p.pageid),
        originalUrl: pageUrl,
        title: meta(info, 'ObjectName') ?? p.title.replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, ''),
        description: meta(info, 'ImageDescription'),
        creatorName: artist && !/^unknown/i.test(artist) ? artist.slice(0, 300) : undefined,
        creatorUrl: artistLink(info.extmetadata?.Artist?.value),
        publishedRaw: meta(info, 'DateTimeOriginal')?.slice(0, 60),
        previewUrl: safeUrl(info.thumburl) ?? safeUrl(info.url),
        thumbnailUrl: safeUrl(info.thumburl),
        mediaType: mediaType as 'image' | 'video' | 'audio' | 'unknown',
        width: info.width || undefined,
        height: info.height || undefined,
        license: meta(info, 'LicenseShortName') ?? meta(info, 'UsageTerms'),
        rightsStatement: meta(info, 'Credit')?.slice(0, 2000),
        tags: categories.slice(0, 20),
        entities: [],
        researchSources: [],
      }];
    });
    return { items, hasMore: data.continue?.gsroffset !== undefined };
  },
};
