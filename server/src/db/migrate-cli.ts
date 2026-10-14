import { db, closeDb } from './pool.js';
import { migrate } from './migrate.js';

const ran = await migrate(db(), (m) => console.log(m));
console.log(ran.length ? `${ran.length} migration(s) applied` : 'database is up to date');
await closeDb();
