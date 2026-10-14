import type { Env } from '../../config/env.js';
import type { HttpClient } from '../../lib/http-client.js';
import type { DiscoveredItem } from '../references/types.js';

/**
 * Contract every discovery source implements. Adapters only *read* from their source: the HTTP
 * client they receive has no method other than GET. Adapters never invent fields: anything the
 * source does not state is left undefined and shown as unknown.
 */
export interface SourceCapabilities {
  search: boolean;
  pagination: boolean;
  creator: boolean;
  previews: boolean;
  dates: boolean;
  licenses: boolean;
}

export interface SearchParams {
  query: string;
  page: number; // 1-based
  perPage: number;
}

export interface SearchResult {
  items: DiscoveredItem[];
  hasMore: boolean;
  total?: number;
}

export interface AdapterContext {
  http: HttpClient;
  env: Env;
  /** used by RSS to read configured feeds */
  feeds?: { url: string; title: string | null }[];
}

export interface SourceAdapter {
  id: string;
  name: string;
  connectorType: 'api' | 'rss' | 'manual' | 'knowledge';
  baseUrl: string;
  termsUrl: string;
  attribution: string;
  /** a prior on metadata quality, separate from editorial relevance */
  baselineReliability: number;
  ratePerMinute: number;
  requiresCredentials: boolean;
  allowsMediaCaching: boolean;
  capabilities: SourceCapabilities;
  /** human-readable notes on access method and limits, shown on the Sources page */
  accessNotes: string;
  missingConfiguration(env: Env): string[];
  search?(params: SearchParams, ctx: AdapterContext): Promise<SearchResult>;
}

export class SourceError extends Error {
  constructor(
    public readonly sourceId: string,
    public readonly kind: 'not_configured' | 'rate_limited' | 'unavailable' | 'bad_response',
    message: string,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}

export const asArray = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
export const firstString = (v: unknown): string | undefined => {
  const a = asArray(v as string | string[]).filter((x) => typeof x === 'string' && x.trim());
  return a[0]?.trim();
};
export const safeUrl = (u: string | undefined | null): string | undefined => {
  if (!u) return undefined;
  try {
    const url = new URL(u.startsWith('//') ? `https:${u}` : u);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};
