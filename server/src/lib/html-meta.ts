import { stripHtml } from './text.js';

/**
 * Extracts metadata from untrusted HTML using plain text matching. Nothing from the page is
 * executed or rendered; values are decoded, stripped of markup and length-limited.
 */
export interface PageMeta {
  title?: string;
  description?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  author?: string;
  siteName?: string;
  canonical?: string;
  published?: string;
  type?: string;
  keywords: string[];
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([a-zA-Z_:.-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1]!.toLowerCase()] = m[3] ?? m[4] ?? m[5] ?? '';
  }
  return out;
}

const clean = (s: string | undefined, max = 2000) => {
  if (!s) return undefined;
  const t = stripHtml(s).trim();
  return t ? t.slice(0, max) : undefined;
};

export function parsePageMeta(html: string, baseUrl: string): PageMeta {
  const head = html.slice(0, 400_000);
  const metas = new Map<string, string>();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property ?? a.name ?? a.itemprop ?? '').toLowerCase();
    if (key && a.content !== undefined && !metas.has(key)) metas.set(key, a.content);
  }
  let canonical: string | undefined;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    if ((a.rel ?? '').toLowerCase() === 'canonical' && a.href) canonical = a.href;
  }
  const abs = (u: string | undefined) => {
    if (!u) return undefined;
    try {
      const url = new URL(u, baseUrl);
      return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
    } catch {
      return undefined;
    }
  };
  const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return {
    title: clean(metas.get('og:title') ?? metas.get('twitter:title') ?? titleTag, 500),
    description: clean(metas.get('og:description') ?? metas.get('description') ?? metas.get('twitter:description')),
    image: abs(metas.get('og:image:secure_url') ?? metas.get('og:image') ?? metas.get('twitter:image') ?? metas.get('twitter:image:src')),
    imageWidth: Number(metas.get('og:image:width')) || undefined,
    imageHeight: Number(metas.get('og:image:height')) || undefined,
    // Only explicit author metadata counts; social handles are not treated as creators.
    author: clean(metas.get('author') ?? metas.get('article:author') ?? metas.get('dc.creator'), 300),
    siteName: clean(metas.get('og:site_name'), 200),
    canonical: abs(canonical ?? metas.get('og:url')),
    published: clean(metas.get('article:published_time') ?? metas.get('datepublished') ?? metas.get('dc.date'), 60),
    type: clean(metas.get('og:type'), 60),
    keywords: (metas.get('keywords') ?? '').split(',').map((k) => k.trim().toLowerCase()).filter((k) => k && k.length < 60).slice(0, 15),
  };
}
