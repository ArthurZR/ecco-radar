import { buildApp } from './app.js';
import { env } from './config/env.js';
import { db, closeDb } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { syncSources } from './modules/sources/registry.js';
import { startWorker } from './modules/jobs/worker.js';
import { purgeExpiredSessions } from './auth/sessions.js';

const config = env();
const app = await buildApp({ logger: true });
await migrate(db(), (m) => app.log.info(m));
await syncSources();
await purgeExpiredSessions();
const stopWorker = config.RUN_WORKER ? startWorker((msg, extra) => app.log.warn({ extra }, msg)) : () => {};
await app.listen({ port: config.PORT, host: config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopWorker();
    await app.close();
    await closeDb();
    process.exit(0);
  });
}
