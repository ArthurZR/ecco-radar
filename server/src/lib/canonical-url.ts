/**
 * URL canonicalisation used for duplicate detection. The original URL is always stored as-is;
 * the canonical form is only a comparison key.
 */

const TRACKING_PARAMS = new Set([
  'fbclid', 'gclid', 'dclid', 'msclkid', 'igshid', 'igsh', 'mc_cid', 'mc_eid', 'ref', 'ref_src',
  'ref_url', 'si', 'spm', 'yclid', '_ga', '_gl', 'utm', 's', 'feature', 'share_id',
]);

const HOST_ALIASES: Record<string, string> = {
  'twitter.com': 'x.com',
  'mobile.twitter.com': 'x.com',
  'm.youtube.com': 'youtube.com',
  'commons.m.wikimedia.org': 'commons.wikimedia.org',
  'en.m.wikipedia.org': 'en.wikipedia.org',
  'm.flickr.com': 'flickr.com',
  'm.imdb.com': 'imdb.com',
};

export function canonicalizeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme: ${url.protocol}`);
  }
  let host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('www.')) host = host.slice(4);
  host = HOST_ALIASES[host] ?? host;

  let pathname = url.pathname.replace(/\/{2,}/g, '/');
  const params = new URLSearchParams();
  const raw = [...url.searchParams.entries()];

  // youtu.be/<id> -> youtube.com/watch?v=<id>
  if (host === 'youtu.be') {
    const id = pathname.split('/')[1];
    host = 'youtube.com';
    pathname = '/watch';
    if (id) raw.push(['v', id]);
  }

  const entries = raw
    .filter(([k]) => !k.toLowerCase().startsWith('utm_') && !TRACKING_PARAMS.has(k.toLowerCase()))
    .sort(([a, av], [b, bv]) => (a === b ? av.localeCompare(bv) : a.localeCompare(b)));
  for (const [k, v] of entries) params.append(k, v);

  // Instagram/X post URLs carry no meaningful query parameters
  if (host === 'instagram.com' || host === 'x.com') {
    for (const k of [...params.keys()]) params.delete(k);
  }

  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
  const query = params.toString();
  // Scheme is normalised to https: the same resource is commonly served on both.
  return `https://${host}${pathname}${query ? `?${query}` : ''}`;
}

export function tryCanonicalizeUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  try {
    return canonicalizeUrl(input);
  } catch {
    return null;
  }
}
