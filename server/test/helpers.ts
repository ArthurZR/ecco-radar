import type { FastifyInstance } from 'fastify';
import { db } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { buildApp } from '../src/app.js';
import { hashPassword } from '../src/auth/password.js';
import { syncSources, setHttpClient } from '../src/modules/sources/registry.js';
import { invalidateProfile } from '../src/modules/ranking/profile.js';
import type { BinaryResponse, HttpClient, HttpResponse } from '../src/lib/http-client.js';

let migrated = false;

/** Fresh schema state for each test file. reference_items blocks DELETE, so TRUNCATE is used. */
export async function resetDb(): Promise<void> {
  if (!migrated) {
    await migrate(db());
    migrated = true;
  }
  const { rows } = await db().query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  await db().query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  await db().query(`ALTER SEQUENCE reference_number_seq RESTART WITH 1`);
  await syncSources();
  invalidateProfile();
}

export const PASSWORD = 'correct-horse-battery';

export async function createUser(email = 'editor@example.com'): Promise<string> {
  const r = await db().query<{ id: string }>(
    `INSERT INTO users(email, display_name, password_hash) VALUES ($1, 'Editor', $2) RETURNING id`,
    [email, await hashPassword(PASSWORD)],
  );
  return r.rows[0]!.id;
}

export async function appWithSession(): Promise<{ app: FastifyInstance; cookie: string; userId: string }> {
  const userId = await createUser();
  const app = await buildApp();
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'editor@example.com', password: PASSWORD } });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'radar_session')!;
  return { app, cookie: `${cookie.name}=${cookie.value}`, userId };
}

/** Records every outbound request and answers from a route table. Unmatched URLs throw. */
export class FakeHttp implements HttpClient {
  calls: string[] = [];
  constructor(private routes: { match: (u: URL) => boolean; body: unknown; contentType?: string }[] = []) {}
  async getText(url: string): Promise<HttpResponse> {
    this.calls.push(url);
    const u = new URL(url);
    const r = this.routes.find((x) => x.match(u));
    if (!r) throw Object.assign(new Error(`no fake route for ${u.hostname}${u.pathname}`), { code: 'ENOTFOUND' });
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    return { status: 200, url, contentType: r.contentType ?? 'application/json', body };
  }
  async getJson<T>(url: string): Promise<T> {
    return JSON.parse((await this.getText(url)).body) as T;
  }
  async getBytes(url: string): Promise<BinaryResponse> {
    this.calls.push(url);
    const u = new URL(url);
    const r = this.routes.find((x) => x.match(u));
    if (!r) throw Object.assign(new Error(`no fake route for ${u.hostname}${u.pathname}`), { code: 'ENOTFOUND' });
    const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
    return { status: 200, url, contentType: r.contentType ?? 'application/octet-stream', body };
  }
}

export function useFakeHttp(fake: FakeHttp | undefined): void {
  setHttpClient(fake);
}
