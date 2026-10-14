import { XMLParser } from 'fast-xml-parser';
import { stripHtml, tokenize } from '../../../lib/text.js';
import { asArray, firstString, safeUrl, type SourceAdapter } from '../adapter.js';
import type { DiscoveredItem } from '../../references/types.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  processEntities: true,
  htmlEntities: true,
  // XXE is not possible: fast-xml-parser does not resolve external entities or DTDs
});

type Node = Record<string, unknown>;
const text = (v: unknown): string | undefined => {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (v && typeof v === 'object' && '#text' in v) return String((v as Node)['#text']);
  return undefined;
};

function imageFrom(item: Node): string | undefined {
  for (const key of ['media:content', 'media:thumbnail']) {
    for (const m of asArray(item[key] as Node | Node[])) {
      const url = safeUrl(m?.['@_url'] as string);
      const medium = String(m?.['@_medium'] ?? m?.['@_type'] ?? 'image');
      if (url && /image/.test(medium)) return url;
    }
  }
  for (const g of asArray(item['media:group'] as Node | Node[])) {
    const found = imageFrom(g);
    if (found) return found;
  }
  for (const e of asArray(item.enclosure as Node | Node[])) {
    if (String(e?.['@_type'] ?? '').startsWith('image/')) return safeUrl(e['@_url'] as string);
  }
  const html = text(item['content:encoded']) ?? text(item.description) ?? text(item.content) ?? text(item.summary) ?? '';
  const img = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i)?.[1];
  return safeUrl(img);
}

export interface FeedEntry {
  item: DiscoveredItem;
  haystack: string;
}

/** Parses RSS 2.0 or Atom into discovered items. Pure, so it can be tested with fixtures. */
export function parseFeed(xml: string, feedUrl: string, sourceId = 'rss'): { title?: string; entries: FeedEntry[] } {
  const doc = parser.parse(xml) as Node;
  const rss = doc.rss as Node | undefined;
  const channel = (rss?.channel ?? doc['rdf:RDF']) as Node | undefined;
  const atom = doc.feed as Node | undefined;
  const feedTitle = text(channel?.title) ?? text(atom?.title);
  const raw = channel ? asArray((channel.item ?? (doc['rdf:RDF'] as Node)?.item) as Node | Node[]) : asArray(atom?.entry as Node | Node[]);
  const entries: FeedEntry[] = [];
  for (const it of raw) {
    let link = text(it.link);
    if (!link && it.link) {
      const links = asArray(it.link as Node | Node[]);
      const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate');
      link = (alt?.['@_href'] as string) ?? undefined;
    }
    const url = safeUrl(link ? new URL(link, feedUrl).toString() : undefined);
    if (!url) continue;
    const title = stripHtml(text(it.title)).slice(0, 500) || undefined;
    const body = stripHtml(text(it.description) ?? text(it.summary) ?? text(it['content:encoded']) ?? text(it.content)).slice(0, 4000);
    const categories = asArray(it.category as unknown).map((c) => text(c) ?? text((c as Node)?.['@_term'])).filter((c): c is string => !!c);
    const image = imageFrom(it);
    const item: DiscoveredItem = {
      sourceId,
      sourceItemId: firstString(text(it.guid) ?? text(it.id)) ?? url,
      originalUrl: url,
      title,
      description: [feedTitle ? `From the feed "${stripHtml(feedTitle)}".` : '', body].filter(Boolean).join(' ') || undefined,
      // Article authors are not necessarily the creators of the images they feature, so they are not recorded as creator.
      creatorName: undefined,
      publishedRaw: (text(it.pubDate) ?? text(it.published) ?? text(it.updated) ?? text(it['dc:date']))?.slice(0, 60),
      previewUrl: image,
      thumbnailUrl: image,
      mediaType: image ? 'image' : 'webpage',
      tags: categories.map((c) => c.toLowerCase().slice(0, 100)).slice(0, 15),
      entities: [],
      researchSources: [{ url: feedUrl, title: feedTitle ? stripHtml(feedTitle) : 'RSS feed', kind: 'article' }],
    };
    entries.push({ item, haystack: `${title ?? ''} ${body} ${categories.join(' ')}` });
  }
  return { title: feedTitle ? stripHtml(feedTitle) : undefined, entries };
}

/** Matches an entry when it contains all query tokens (or any, for long queries). */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = tokenize(query);
  if (q.length === 0) return true;
  const h = new Set(tokenize(haystack));
  const hits = q.filter((t) => h.has(t)).length;
  return q.length <= 2 ? hits === q.length : hits >= Math.ceil(q.length / 2);
}

export const rss: SourceAdapter = {
  id: 'rss',
  name: 'RSS / Atom feeds',
  connectorType: 'rss',
  baseUrl: '',
  termsUrl: '',
  attribution: 'Link to the original article; credit the publication. Image rights belong to their owners.',
  baselineReliability: 0.6,
  ratePerMinute: 30,
  requiresCredentials: false,
  allowsMediaCaching: false,
  capabilities: { search: true, pagination: false, creator: false, previews: true, dates: true, licenses: false },
  accessNotes:
    'Reads RSS/Atom feeds you add on the Sources page (curated cultural sites, blogs, museum news). Search filters recent feed items by your query; feeds only expose their latest entries.',
  missingConfiguration: () => [],
  async search({ query, page, perPage }, { http, feeds }) {
    if (!feeds?.length || page > 1) return { items: [], hasMore: false };
    const out: DiscoveredItem[] = [];
    const errors: string[] = [];
    for (const f of feeds) {
      try {
        const res = await http.getText(f.url, { rateKey: `rss:${new URL(f.url).hostname}`, ratePerMinute: 10, maxBytes: 3_000_000 });
        const parsed = parseFeed(res.body, f.url);
        for (const e of parsed.entries) if (matchesQuery(e.haystack, query)) out.push(e.item);
      } catch (err) {
        errors.push(`${new URL(f.url).hostname}: ${(err as Error).message}`);
      }
      if (out.length >= perPage) break;
    }
    if (errors.length === feeds.length) throw new Error(`All feeds failed (${errors.join('; ')})`);
    return { items: out.slice(0, perPage), hasMore: false };
  },
};
