import { db } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http-client.js';
import { BlockedUrlError } from '../../lib/ssrf.js';
import { SourceError, type SearchParams, type SearchResult } from './adapter.js';
import { getAdapter, httpClient } from './registry.js';

export interface SourceRunOutcome {
  ok: boolean;
  result?: SearchResult;
  error?: string;
  status: string;
}

function classify(err: unknown): { status: string; message: string; retryAfterMs?: number } {
  if (err instanceof SourceError) {
    const status = err.kind === 'not_configured' ? 'needs_configuration' : err.kind === 'rate_limited' ? 'rate_limited' : 'unavailable';
    return { status, message: err.message };
  }
  if (err instanceof HttpError) {
    if (err.status === 429) return { status: 'rate_limited', message: 'Rate limited by the source', retryAfterMs: err.retryAfterMs ?? 60_000 };
    if (err.status === 401 || err.status === 403) return { status: 'unavailable', message: `Access denied (HTTP ${err.status}). Check credentials or network policy.` };
    return { status: 'unavailable', message: err.message };
  }
  if (err instanceof BlockedUrlError) return { status: 'unavailable', message: err.message };
  const e = err as NodeJS.ErrnoException & { cause?: { code?: string } };
  const code = e.code ?? e.cause?.code;
  return { status: 'unavailable', message: code ? `Network error (${code})` : (e.message ?? 'Unknown error') };
}

/**
 * Runs one search against one source and records the outcome on the source row, so the Sources
 * page always shows real state: a source only becomes "active" after a successful live response.
 */
export async function runSourceSearch(sourceId: string, params: SearchParams): Promise<SourceRunOutcome> {
  const adapter = getAdapter(sourceId);
  if (!adapter?.search) return { ok: false, status: 'unavailable', error: `Source ${sourceId} does not support search` };
  const row = await db().query<{ enabled: boolean; rate_limited_until: string | null }>('SELECT enabled, rate_limited_until FROM sources WHERE id = $1', [sourceId]);
  const src = row.rows[0];
  if (!src?.enabled) return { ok: false, status: 'disabled', error: `${adapter.name} is disabled` };
  if (src.rate_limited_until && new Date(src.rate_limited_until) > new Date()) {
    return { ok: false, status: 'rate_limited', error: `${adapter.name} is rate-limited until ${new Date(src.rate_limited_until).toISOString()}` };
  }
  const missing = adapter.missingConfiguration(env());
  if (missing.length) {
    await db().query(`UPDATE sources SET status = 'needs_configuration', updated_at = now() WHERE id = $1`, [sourceId]);
    return { ok: false, status: 'needs_configuration', error: `Missing configuration: ${missing.join(', ')}` };
  }
  const feeds = sourceId === 'rss'
    ? (await db().query<{ url: string; title: string | null }>('SELECT url, title FROM rss_feeds WHERE enabled')).rows
    : undefined;
  try {
    const result = await adapter.search({ ...params, query: params.query.slice(0, 300) }, { http: httpClient(), env: env(), feeds });
    await db().query(
      `UPDATE sources SET status = 'active', last_success_at = now(), rate_limited_until = NULL, updated_at = now() WHERE id = $1`,
      [sourceId],
    );
    return { ok: true, status: 'active', result };
  } catch (err) {
    const c = classify(err);
    await db().query(
      `UPDATE sources SET status = $2, last_error = $3, last_error_at = now(),
         rate_limited_until = CASE WHEN $4::int IS NULL THEN rate_limited_until ELSE now() + $4::int * interval '1 millisecond' END,
         updated_at = now() WHERE id = $1`,
      [sourceId, c.status, c.message.slice(0, 1000), c.retryAfterMs ?? null],
    );
    return { ok: false, status: c.status, error: c.message };
  }
}
