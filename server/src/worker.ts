/** Standalone worker process, for deployments that run discovery separately from the API. */
import { db, closeDb } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { syncSources } from './modules/sources/registry.js';
import { startWorker } from './modules/jobs/worker.js';

await migrate(db());
await syncSources();
const stop = startWorker((msg, extra) => console.warn(msg, extra ?? ''));
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stop();
    await closeDb();
    process.exit(0);
  });
}
