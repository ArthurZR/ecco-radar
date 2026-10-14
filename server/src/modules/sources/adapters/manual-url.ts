import type { HttpClient } from '../../../lib/http-client.js';
import { parsePageMeta } from '../../../lib/html-meta.js';
import { assertSafeUrlShape } from '../../../lib/ssrf.js';
import type { DiscoveredItem } from '../../references/types.js';
import type { SourceAdapter } from '../adapter.js';

export const manualUrl: SourceAdapter = {
  id: 'manual',
  name: 'Manual URL import',
  connectorType: 'manual',
  baseUrl: '',
  termsUrl: '',
  attribution: 'Whatever the imported page states. Check attribution before use.',
  baselineReliability: 0.5,
  ratePerMinute: 20,
  requiresCredentials: false,
  allowsMediaCaching: false,
  capabilities: { search: false, pagination: false, creator: true, previews: true, dates: true, licenses: false },
  accessNotes:
    'Paste any public web page or image URL. RADAR fetches the page once (private and local network addresses are refused), reads its OpenGraph/meta tags, and stores the original URL. Use it for Instagram or other platforms without a permitted search API: RADAR never scrapes them, it only reads what the public page exposes.',
  missingConfiguration: () => [],
};

const IMAGE_EXT = /\.(jpe?g|png|gif|webp|avif|tiff?|bmp)$/i;

/** Builds a reference from a single user-supplied URL. Only stated metadata is used. */
export async function importFromUrl(rawUrl: string, http: HttpClient): Promise<{ item: DiscoveredItem; fetched: boolean; note: string }> {
  const url = assertSafeUrlShape(rawUrl);
  if (IMAGE_EXT.test(url.pathname)) {
    const file = decodeURIComponent(url.pathname.split('/').pop() ?? '').replace(IMAGE_EXT, '');
    return {
      fetched: false,
      note: 'Direct image link: only the URL is known. Add the creator and context manually after checking the source.',
      item: {
        sourceId: 'manual', originalUrl: url.toString(), title: file || undefined, previewUrl: url.toString(),
        thumbnailUrl: url.toString(), mediaType: 'image', tags: [], entities: [], researchSources: [],
      },
    };
  }
  const res = await http.getText(url.toString(), { maxBytes: 2_000_000, rateKey: 'manual', ratePerMinute: 20, headers: { accept: 'text/html,application/xhtml+xml' } });
  if (!/html|xml/i.test(res.contentType)) {
    return {
      fetched: true,
      note: `The URL returned ${res.contentType || 'an unknown type'}, not a web page; only the URL was stored.`,
      item: { sourceId: 'manual', originalUrl: url.toString(), mediaType: 'unknown', tags: [], entities: [], researchSources: [] },
    };
  }
  const meta = parsePageMeta(res.body, res.url);
  const isVideo = /video/i.test(meta.type ?? '');
  return {
    fetched: true,
    note: meta.image ? 'Metadata read from the page’s OpenGraph/meta tags.' : 'The page exposes no preview image.',
    item: {
      sourceId: 'manual',
      originalUrl: url.toString(),
      title: meta.title,
      description: [meta.siteName ? `Published on ${meta.siteName}.` : '', meta.description ?? ''].filter(Boolean).join(' ') || undefined,
      creatorName: meta.author,
      publishedRaw: meta.published,
      previewUrl: meta.image,
      thumbnailUrl: meta.image,
      width: meta.imageWidth,
      height: meta.imageHeight,
      mediaType: isVideo ? 'video' : meta.image ? 'image' : 'webpage',
      tags: meta.keywords,
      entities: [],
      researchSources: meta.canonical && meta.canonical !== url.toString() ? [{ url: meta.canonical, title: 'Canonical page', kind: 'original_source' }] : [],
    },
  };
}
