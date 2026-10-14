import { SourceError, asArray, firstString, type SourceAdapter } from '../adapter.js';
import type { MediaType } from '../../references/types.js';

interface IADoc {
  identifier: string;
  title?: string | string[];
  creator?: string | string[];
  date?: string;
  year?: string | number;
  description?: string | string[];
  mediatype?: string;
  subject?: string | string[];
  licenseurl?: string;
  collection?: string | string[];
}
interface IAResponse {
  response?: { numFound: number; start: number; docs: IADoc[] };
  error?: string;
}

const MEDIA: Record<string, MediaType> = {
  image: 'image', movies: 'video', audio: 'audio', etree: 'audio', texts: 'text', web: 'webpage', collection: 'collection', software: 'unknown', data: 'unknown',
};

export const internetArchive: SourceAdapter = {
  id: 'internet_archive',
  name: 'Internet Archive',
  connectorType: 'api',
  baseUrl: 'https://archive.org/advancedsearch.php',
  termsUrl: 'https://archive.org/about/terms.php',
  attribution: 'Link to the archive.org item page; credit the uploader-stated creator where given. Rights vary by item.',
  baselineReliability: 0.55,
  ratePerMinute: 30,
  requiresCredentials: false,
  allowsMediaCaching: false,
  capabilities: { search: true, pagination: true, creator: true, previews: true, dates: true, licenses: true },
  accessNotes:
    'Public Advanced Search API (no key). Covers images, scanned magazines/manuals, software and web collections. Metadata is uploader-supplied and of mixed quality, so reliability starts lower than curated institutions. Thumbnails come from archive.org/services/img.',
  missingConfiguration: () => [],
  async search({ query, page, perPage }, { http }) {
    const url = new URL(this.baseUrl);
    // Images and scanned print only: video, audio, software and whole collections rarely make a usable reference.
    url.searchParams.set('q', `(${query}) AND mediatype:(image OR texts)`);
    for (const f of ['identifier', 'title', 'creator', 'date', 'year', 'description', 'mediatype', 'subject', 'licenseurl', 'collection']) {
      url.searchParams.append('fl[]', f);
    }
    url.searchParams.set('rows', String(perPage));
    url.searchParams.set('page', String(page));
    url.searchParams.set('output', 'json');
    const data = await http.getJson<IAResponse>(url.toString(), { rateKey: this.id, ratePerMinute: this.ratePerMinute });
    if (!data.response) throw new SourceError(this.id, 'bad_response', data.error ?? 'Unexpected Internet Archive response');
    const items = data.response.docs.filter((d) => /^[A-Za-z0-9._-]+$/.test(d.identifier)).map((d) => ({
      sourceId: this.id,
      sourceItemId: d.identifier,
      originalUrl: `https://archive.org/details/${d.identifier}`,
      title: firstString(d.title),
      description: asArray(d.description).filter((x) => typeof x === 'string').join('\n').slice(0, 8000) || undefined,
      creatorName: firstString(d.creator),
      publishedRaw: d.date?.slice(0, 10) ?? (d.year ? String(d.year) : undefined),
      previewUrl: `https://archive.org/services/img/${d.identifier}`,
      thumbnailUrl: `https://archive.org/services/img/${d.identifier}`,
      mediaType: MEDIA[d.mediatype ?? ''] ?? 'unknown',
      license: d.licenseurl,
      tags: asArray(d.subject).flatMap((s) => String(s).split(/[;,]/)).map((s) => s.trim()).filter(Boolean).slice(0, 20),
      entities: [],
      researchSources: asArray(d.collection).slice(0, 2).map((c) => ({ url: `https://archive.org/details/${encodeURIComponent(String(c))}`, title: `Collection: ${c}`, kind: 'archive' as const })),
    }));
    return { items, hasMore: page * perPage < data.response.numFound, total: data.response.numFound };
  },
};
