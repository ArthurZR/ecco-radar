import { db } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { createHttpClient, type HttpClient } from '../../lib/http-client.js';
import type { SourceAdapter } from './adapter.js';
import { wikimediaCommons } from './adapters/wikimedia-commons.js';
import { internetArchive } from './adapters/internet-archive.js';
import { artInstituteChicago } from './adapters/art-institute-chicago.js';
import { flickr } from './adapters/flickr.js';
import { tumblr } from './adapters/tumblr.js';
import { rss } from './adapters/rss.js';
import { manualUrl } from './adapters/manual-url.js';
import { wikidataSource } from './adapters/wikidata.js';

export const ADAPTERS: SourceAdapter[] = [wikimediaCommons, internetArchive, artInstituteChicago, flickr, tumblr, rss, manualUrl, wikidataSource];

export function getAdapter(id: string): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === id);
}

export const searchableAdapters = () => ADAPTERS.filter((a) => typeof a.search === 'function');

let http: HttpClient | undefined;
export function httpClient(): HttpClient {
  http ??= createHttpClient(`eccoRADAR/0.1 (private research tool; contact: ${env().SOURCE_CONTACT})`);
  return http;
}
/** Test hook to substitute recorded responses. */
export function setHttpClient(client: HttpClient | undefined): void {
  http = client;
}

/** Keeps the sources table in step with the adapters in code, without touching runtime state. */
export async function syncSources(): Promise<void> {
  for (const a of ADAPTERS) {
    const missing = a.missingConfiguration(env());
    await db().query(
      `INSERT INTO sources(id, name, connector_type, base_url, requires_credentials, rate_limit_per_minute, baseline_reliability,
                           attribution_requirements, terms_url, allows_media_caching, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, connector_type = EXCLUDED.connector_type, base_url = EXCLUDED.base_url,
         requires_credentials = EXCLUDED.requires_credentials, rate_limit_per_minute = EXCLUDED.rate_limit_per_minute,
         baseline_reliability = EXCLUDED.baseline_reliability, attribution_requirements = EXCLUDED.attribution_requirements,
         terms_url = EXCLUDED.terms_url, allows_media_caching = EXCLUDED.allows_media_caching,
         status = CASE
           WHEN $12 THEN 'needs_configuration'
           WHEN sources.status = 'needs_configuration' THEN 'unverified'
           ELSE sources.status END,
         updated_at = now()`,
      [a.id, a.name, a.connectorType, a.baseUrl || null, a.requiresCredentials, a.ratePerMinute, a.baselineReliability,
        a.attribution, a.termsUrl || null, a.allowsMediaCaching, missing.length ? 'needs_configuration' : 'unverified', missing.length > 0],
    );
  }
}
