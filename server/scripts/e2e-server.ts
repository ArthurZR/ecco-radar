/**
 * Starts the API (serving the built web app) for the Playwright end-to-end tests.
 *
 * It empties its database and seeds SYNTHETIC references, so it refuses any database whose name
 * does not contain "test". All outbound HTTP is replaced by a client that refuses every request:
 * the browser tests run without touching any real source.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dbUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgres://radar:radar@localhost:5432/radar_test';
if (!/test/i.test(new URL(dbUrl).pathname)) {
  throw new Error(`Refusing to seed "${new URL(dbUrl).pathname}": the end-to-end database name must contain "test".`);
}
const port = Number(process.env.E2E_PORT ?? 8790);
const here = path.dirname(fileURLToPath(import.meta.url));
Object.assign(process.env, {
  NODE_ENV: 'test',
  DATABASE_URL: dbUrl,
  PORT: String(port),
  APP_ORIGIN: `http://localhost:${port}`,
  SESSION_SECRET: 'e2e-secret-0123456789abcdef0123456789abcdef',
  SOURCE_CONTACT: 'e2e@example.com',
  RUN_WORKER: 'false',
  WEB_DIST_DIR: path.resolve(here, '../../web/dist'),
  // Post images uploaded by the tests go to a throwaway folder.
  MEDIA_DIR: mkdtempSync(path.join(tmpdir(), 'radar-e2e-media-')),
});
delete process.env.ANTHROPIC_API_KEY;

const { db } = await import('../src/db/pool.js');
const { migrate } = await import('../src/db/migrate.js');
const { buildApp } = await import('../src/app.js');
const { hashPassword } = await import('../src/auth/password.js');
const { syncSources, setHttpClient } = await import('../src/modules/sources/registry.js');
const { ingestReference } = await import('../src/modules/references/ingest.js');

const refuse = async (url: string): Promise<never> => {
  throw Object.assign(new Error(`outbound request blocked in end-to-end tests: ${new URL(url).hostname}`), { code: 'ENOTFOUND' });
};
setHttpClient({ getText: refuse, getBytes: refuse, getJson: refuse });

await migrate(db());
const { rows } = await db().query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
await db().query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
await db().query(`ALTER SEQUENCE reference_number_seq RESTART WITH 1`);
await syncSources();
await db().query(`INSERT INTO app_settings(key, value) VALUES ('visual_analysis_enabled', 'false')`);
await db().query(`INSERT INTO users(email, display_name, password_hash) VALUES ('editor@example.com', 'Editor', $1)`, [await hashPassword('e2e-password-1234')]);

const seeds = [
  { title: 'SYNTHETIC Aqua button study', creatorName: 'Test Designer A', publishedRaw: '2003', tags: ['interface', 'y2k'] },
  { title: 'SYNTHETIC Desktop theme screenshot', creatorName: 'Test Designer B', publishedRaw: '2001', tags: ['interface', 'operating system'] },
  { title: 'SYNTHETIC Game magazine advert', publishedRaw: '1999', tags: ['video games', 'print'] },
  { title: 'SYNTHETIC Personal homepage banner', creatorName: 'Test Designer C', publishedRaw: '2004', tags: ['web', 'y2k'] },
  { title: 'SYNTHETIC Album sleeve detail', creatorName: 'Test Designer D', publishedRaw: '2002', tags: ['music', 'typography'] },
  { title: 'SYNTHETIC Arcade cabinet marquee', creatorName: 'Test Designer E', publishedRaw: '1998', tags: ['video games', 'print'] },
  { title: 'SYNTHETIC Webring navigation bar', creatorName: 'Test Designer F', publishedRaw: '2000', tags: ['web', 'y2k'] },
  { title: 'SYNTHETIC Mixtape cover scan', creatorName: 'Test Designer G', publishedRaw: '2001', tags: ['music', 'typography'] },
];
for (const [i, s] of seeds.entries()) {
  await ingestReference(
    { sourceId: 'manual', originalUrl: `https://example.com/synthetic/${i + 1}`, mediaType: 'image', description: 'Synthetic end-to-end test record.', ...s },
    { method: 'manual_import', path: [] },
  );
}

const app = await buildApp();
await app.listen({ port, host: '127.0.0.1' });
