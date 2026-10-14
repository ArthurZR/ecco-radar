import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { db, closeDb } from '../src/db/pool.js';
import { buildApp } from '../src/app.js';
import { ingestReference } from '../src/modules/references/ingest.js';
import { createHttpClient } from '../src/lib/http-client.js';
import { resetDb, appWithSession, createUser, FakeHttp, useFakeHttp } from './helpers.js';

beforeEach(resetDb);
afterEach(() => {
  useFakeHttp(undefined);
  vi.restoreAllMocks();
});
afterAll(closeDb);

describe('authentication and authorization', () => {
  it('protects every API route except health and login', async () => {
    const app = await buildApp();
    for (const url of ['/api/references', '/api/sources', '/api/insights/overview', '/api/settings', '/api/ranking', '/api/imports', '/api/explorations']) {
      expect((await app.inject({ url })).statusCode, url).toBe(401);
    }
    expect((await app.inject({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('rejects wrong passwords and invalid sessions', async () => {
    await createUser();
    const app = await buildApp();
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'editor@example.com', password: 'nope-nope-nope' } });
    expect(bad.statusCode).toBe(401);
    expect((await app.inject({ url: '/api/references', headers: { cookie: 'radar_session=forged' } })).statusCode).toBe(401);
  });

  it('sets an httpOnly SameSite=Strict session cookie and logout invalidates it', async () => {
    await createUser();
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'editor@example.com', password: 'correct-horse-battery' } });
    const c = res.cookies.find((x) => x.name === 'radar_session')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
    const cookie = `radar_session=${c.value}`;
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    const stored = await db().query('SELECT token_hash FROM sessions');
    expect(stored.rows.every((r) => r.token_hash !== c.value)).toBe(true);
  });

  it('rejects cross-origin writes', async () => {
    const { app, cookie } = await appWithSession();
    const res = await app.inject({ method: 'POST', url: '/api/import-url', headers: { cookie, origin: 'https://evil.example' }, payload: { url: 'https://example.com' } });
    expect(res.statusCode).toBe(403);
  });

  it('rate-limits login attempts', async () => {
    const app = await buildApp();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'x@example.com', password: 'y' } })).statusCode;
    expect(last).toBe(429);
  });

  it('refuses URL imports aimed at private networks', async () => {
    const { app, cookie } = await appWithSession();
    for (const url of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/admin', 'http://[::1]/']) {
      const res = await app.inject({ method: 'POST', url: '/api/import-url', headers: { cookie }, payload: { url } });
      expect(res.statusCode, url).toBe(400);
    }
  });
});

describe('no automatic publishing', () => {
  it('walking an item through every status triggers no outbound request at all', async () => {
    const fake = new FakeHttp([]);
    useFakeHttp(fake);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await ingestReference({ sourceId: 'manual', originalUrl: 'https://example.com/p', title: 'T', mediaType: 'image' }, { method: 'manual_import', path: [] });
    const { app, cookie } = await appWithSession();
    const post = (status: string, extra = {}) => app.inject({ method: 'POST', url: `/api/references/${r.refNumber}/status`, headers: { cookie }, payload: { status, ...extra } });
    await post('saved');
    await post('approved_consideration');
    await post('caption_draft');
    await app.inject({ method: 'PUT', url: `/api/captions/${r.refNumber}/final`, headers: { cookie }, payload: { body: 'Caption.' } });
    for (const s of ['reviewed', 'approved_publication']) expect((await post(s)).statusCode).toBe(200);
    expect((await post('manually_published', { publication: { platform: 'instagram' } })).statusCode).toBe(200);
    await app.inject({ url: `/api/captions/${r.refNumber}/export`, headers: { cookie } });
    expect(fake.calls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    const jobs = await db().query('SELECT count(*)::int AS n FROM jobs');
    expect(jobs.rows[0].n).toBe(0);
  });

  it('the job queue cannot hold a publishing job', async () => {
    await expect(db().query(`INSERT INTO jobs(kind, payload) VALUES ('publish_post', '{}')`)).rejects.toThrow(/check constraint/);
  });

  it('the outbound HTTP client used by sources is read-only (GET only)', () => {
    const client = createHttpClient('test');
    expect(Object.keys(client).sort()).toEqual(['getJson', 'getText']);
    const src = readFileSync(path.join(__dirname, '../src/lib/http-client.ts'), 'utf8');
    expect(src.match(/method:\s*'([A-Z]+)'/g)).toEqual(["method: 'GET'"]);
  });

  it('the codebase contains no social platform publishing endpoints', () => {
    const forbidden = [
      /graph\.facebook\.com/i, /graph\.instagram\.com/i, /api\.twitter\.com/i, /api\.x\.com/i, /upload\.twitter\.com/i,
      /\/v2\/blog\/[^'"`]*\/post/i, /media_publish/i, /statuses\/update/i, /\/2\/tweets/i, /threads\.net/i,
    ];
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d).forEach((f) => {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx|sql)$/.test(f)) files.push(p);
    });
    walk(path.join(__dirname, '../src'));
    walk(path.join(__dirname, '../../web/src'));
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      for (const re of forbidden) expect(re.test(text), `${f} matches ${re}`).toBe(false);
    }
  });
});
