// `npm run migrate`: applies migrations/ to the database (site/migrate.js), in one transaction
// behind an advisory lock. It uses DATABASE_URL_UNPOOLED when set (a direct connection, best for
// schema changes), else DATABASE_URL. The local server migrates its own PGlite database.

import { openPostgres } from '../site/db.js';
import { migrate, MigrationError } from '../site/migrate.js';

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  console.log('No DATABASE_URL here, so nothing to migrate.');
  process.exit(0);
}

const db = await openPostgres(url);
try {
  const r = await migrate(db, { log: (l) => console.log(`migrate: ${l}`) });
  console.log(r.applied.length ? `migrate: applied ${r.applied.length} (${r.applied.join(', ')}).` : `migrate: nothing new (${r.already} applied before).`);
} catch (err) {
  console.error(err instanceof MigrationError ? `migrate: ${err.message}` : `migrate: it failed, and nothing was changed: ${err.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
