import { SourceError, type SourceAdapter } from '../adapter.js';

interface AicSearch {
  pagination?: { total: number; total_pages: number; current_page: number };
  data?: { id: number }[];
}
interface AicArtwork {
  id: number;
  title?: string;
  artist_display?: string;
  artist_title?: string;
  artist_id?: number;
  date_display?: string;
  date_start?: number;
  image_id?: string | null;
  medium_display?: string;
  is_public_domain?: boolean;
  credit_line?: string;
  style_title?: string | null;
  classification_title?: string | null;
  term_titles?: string[];
  thumbnail?: { width?: number; height?: number; alt_text?: string } | null;
  description?: string | null;
  short_description?: string | null;
}
interface AicArtworks {
  data?: AicArtwork[];
  config?: { iiif_url?: string };
}

const FIELDS = 'id,title,artist_display,artist_title,artist_id,date_display,date_start,image_id,medium_display,is_public_domain,credit_line,style_title,classification_title,term_titles,thumbnail,short_description';

export const artInstituteChicago: SourceAdapter = {
  id: 'art_institute_chicago',
  name: 'Art Institute of Chicago',
  connectorType: 'api',
  baseUrl: 'https://api.artic.edu/api/v1',
  termsUrl: 'https://www.artic.edu/terms',
  attribution: 'Credit "Art Institute of Chicago" with the credit line. Only public-domain images are CC0.',
  baselineReliability: 0.9,
  ratePerMinute: 50,
  requiresCredentials: false,
  allowsMediaCaching: false,
  capabilities: { search: true, pagination: true, creator: true, previews: true, dates: true, licenses: true },
  accessNotes:
    'Public JSON API (no key; metadata CC0). Museum-catalogued posters, graphic design, photography, textiles and prints with curated artist, date and medium. Images via IIIF; only works marked public domain are freely reusable.',
  missingConfiguration: () => [],
  async search({ query, page, perPage }, { http, env }) {
    const headers = { 'AIC-User-Agent': `ecco-radar (${env.SOURCE_CONTACT})` };
    const s = new URL(`${this.baseUrl}/artworks/search`);
    s.searchParams.set('q', query);
    s.searchParams.set('page', String(page));
    s.searchParams.set('limit', String(perPage));
    s.searchParams.set('fields', 'id');
    const hits = await http.getJson<AicSearch>(s.toString(), { headers, rateKey: this.id, ratePerMinute: this.ratePerMinute });
    if (!hits.data || !hits.pagination) throw new SourceError(this.id, 'bad_response', 'Unexpected AIC search response');
    if (hits.data.length === 0) return { items: [], hasMore: false, total: hits.pagination.total };
    const d = new URL(`${this.baseUrl}/artworks`);
    d.searchParams.set('ids', hits.data.map((h) => h.id).join(','));
    d.searchParams.set('fields', FIELDS);
    const works = await http.getJson<AicArtworks>(d.toString(), { headers, rateKey: this.id, ratePerMinute: this.ratePerMinute });
    const iiif = works.config?.iiif_url ?? 'https://www.artic.edu/iiif/2';
    const byId = new Map((works.data ?? []).map((w) => [w.id, w]));
    const items = hits.data.flatMap((h) => {
      const w = byId.get(h.id);
      // Works the museum has not photographed have nothing to show.
      if (!w || !w.image_id) return [];
      return [{
        sourceId: this.id,
        sourceItemId: String(w.id),
        originalUrl: `https://www.artic.edu/artworks/${w.id}`,
        title: w.title,
        description: [w.short_description, w.thumbnail?.alt_text, w.medium_display].filter(Boolean).join('\n') || undefined,
        creatorName: w.artist_title ?? undefined,
        creatorUrl: w.artist_id ? `https://www.artic.edu/artists/${w.artist_id}` : undefined,
        publishedRaw: w.date_display ?? undefined,
        previewUrl: w.image_id ? `${iiif}/${w.image_id}/full/843,/0/default.jpg` : undefined,
        thumbnailUrl: w.image_id ? `${iiif}/${w.image_id}/full/400,/0/default.jpg` : undefined,
        mediaType: 'image' as const,
        width: w.thumbnail?.width || undefined,
        height: w.thumbnail?.height || undefined,
        license: w.is_public_domain ? 'Public domain (CC0 image)' : 'In copyright or rights restricted',
        rightsStatement: w.credit_line ?? undefined,
        tags: [w.classification_title, w.style_title, ...(w.term_titles ?? [])].filter((x): x is string => !!x).slice(0, 20),
        entities: [
          ...(w.artist_title ? [{ label: w.artist_title, kind: 'other' as const, predicate: 'created_by' as const, provenance: 'AIC artist_title' }] : []),
          ...(w.style_title ? [{ label: w.style_title, kind: 'movement' as const, predicate: 'related_movement' as const, provenance: 'AIC style_title' }] : []),
        ],
        researchSources: [],
      }];
    });
    return { items, hasMore: hits.pagination.current_page < hits.pagination.total_pages, total: hits.pagination.total };
  },
};
