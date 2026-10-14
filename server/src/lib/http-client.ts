import { Agent, request } from 'undici';
import { assertSafeUrlShape, BlockedUrlError, guardedLookup } from './ssrf.js';
import { sharedRateLimiter } from './rate-limiter.js';

/**
 * The only outbound HTTP client used by source adapters and URL imports.
 * It is deliberately read-only: it exposes GET and nothing else, so no adapter can send
 * content to any platform. (The AI provider has its own client pinned to its API host.)
 */

export class HttpError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface GetOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBytes?: number;
  /** rate-limit bucket key, usually the source id */
  rateKey?: string;
  ratePerMinute?: number;
  retries?: number;
}

export interface HttpResponse {
  status: number;
  url: string;
  contentType: string;
  body: string;
}

export interface HttpClient {
  getText(url: string, opts?: GetOptions): Promise<HttpResponse>;
  getJson<T = unknown>(url: string, opts?: GetOptions): Promise<T>;
}

const guardedAgent = new Agent({
  connect: { lookup: guardedLookup as never, timeout: 10_000 },
  headersTimeout: 15_000,
  bodyTimeout: 20_000,
});

const MAX_REDIRECTS = 4;

function parseRetryAfter(value: string | string[] | undefined): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.min(secs * 1000, 120_000);
  const date = Date.parse(v);
  return Number.isNaN(date) ? null : Math.max(0, Math.min(date - Date.now(), 120_000));
}

async function readLimited(body: AsyncIterable<Uint8Array>, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.byteLength;
    if (total > maxBytes) throw new HttpError(`Response exceeded ${maxBytes} bytes`, null);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getOnce(rawUrl: string, opts: Required<Pick<GetOptions, 'timeoutMs' | 'maxBytes'>> & GetOptions, userAgent: string): Promise<HttpResponse> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = assertSafeUrlShape(current); // every hop is re-validated
    const res = await request(url, {
      method: 'GET',
      dispatcher: guardedAgent,
      headers: { 'user-agent': userAgent, accept: '*/*', ...opts.headers },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      await res.body.dump();
      current = new URL(String(res.headers.location), url).toString();
      continue;
    }
    const contentType = String(res.headers['content-type'] ?? '');
    if (res.statusCode >= 400) {
      await res.body.dump();
      throw new HttpError(`HTTP ${res.statusCode} from ${url.hostname}`, res.statusCode, parseRetryAfter(res.headers['retry-after']));
    }
    const body = await readLimited(res.body, opts.maxBytes);
    return { status: res.statusCode, url: url.toString(), contentType, body };
  }
  throw new HttpError('Too many redirects', null);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
  if (err instanceof BlockedUrlError) return false;
  if (err instanceof HttpError) return err.status === null ? false : err.status === 429 || err.status >= 500;
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === 'ESSRF') return false;
  return true; // network errors and timeouts
}

export function createHttpClient(userAgent: string): HttpClient {
  const getText: HttpClient['getText'] = async (url, opts = {}) => {
    const o = { timeoutMs: 15_000, maxBytes: 5_000_000, retries: 2, ...opts };
    let attempt = 0;
    for (;;) {
      if (o.rateKey) await sharedRateLimiter.acquire(o.rateKey, o.ratePerMinute ?? 30);
      try {
        return await getOnce(url, o, userAgent);
      } catch (err) {
        if (attempt >= o.retries || !isRetryable(err)) throw err;
        const retryAfter = err instanceof HttpError ? err.retryAfterMs : null;
        await sleep(retryAfter ?? Math.min(8000, 500 * 2 ** attempt + Math.random() * 250));
        attempt++;
      }
    }
  };
  return {
    getText,
    async getJson<T>(url: string, opts?: GetOptions) {
      const res = await getText(url, { ...opts, headers: { accept: 'application/json', ...opts?.headers } });
      try {
        return JSON.parse(res.body) as T;
      } catch {
        throw new HttpError(`Invalid JSON from ${new URL(res.url).hostname}`, res.status);
      }
    },
  };
}
