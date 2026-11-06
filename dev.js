// `AUTH_FAKE=1 node dev.js`: the site on this laptop, at http://localhost:4480, running the very
// handler Vercel runs (site/router.js) under node:http, with:
//   - DATABASE_URL if set, else PGlite (Postgres in this process), kept in .data/ (--memory: a fresh
//     one each start);
//   - the fake Google unless GOOGLE_CLIENT_ID is set, for trying it with no account;
//   - files in .data/blobs/, unless BLOB_READ_WRITE_TOKEN is set.
// Settings come from the environment, then .env.local if there is one (never committed). With the
// fake Google, made-up defaults fill in what is missing: people at example.test, and
// ada.admin@example.test is an admin.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeBlob } from './lib/blob.js';
import { DEV_PORT, parseEmails, readConfig } from './site/config.js';
import { openPglite, openPostgres } from './site/db.js';
import { migrate } from './site/migrate.js';
import { createSite } from './site/router.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function startLocalSite({ port = DEV_PORT, env = process.env, dataDir = path.join(HERE, '.data'), quiet = false } = {}) {
  const fake = env.AUTH_FAKE === '1' || !env.GOOGLE_CLIENT_ID;
  const admins = env.ADMIN_EMAILS || (fake ? 'ada.admin@example.test' : '');
  const merged = {
    ...env,
    PORT: String(port),
    SITE_URL: env.SITE_URL || `http://localhost:${port}`,
    ADMIN_EMAILS: admins,
    ...(fake ? {
      AUTH_FAKE: '1',
      // The first admin's domain, so a made-up or real admin can sign in with no more settings.
      ALLOWED_DOMAIN: env.ALLOWED_DOMAIN || [...parseEmails(admins)][0].split('@')[1],
      SESSION_SECRET: env.SESSION_SECRET || crypto.randomBytes(32).toString('base64'),
    } : {}),
  };
  delete merged.VERCEL;
  const config = readConfig(merged);
  if (dataDir) fs.mkdirSync(dataDir, { recursive: true });
  const db = config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(dataDir ?? 'memory://');
  await migrate(db);
  const blob = makeBlob({ config, env: merged, dir: dataDir ? path.join(dataDir, 'blobs') : null });
  const site = createSite({ db, config, blob, staticDir: path.join(HERE, 'public'), log: () => {} });
  const server = http.createServer(site);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  if (!quiet) {
    console.log(`The site is running at ${config.siteUrl}  (Ctrl+C to stop)`);
    if (config.authFake) console.log(`  sign-in: the fake Google; people at ${config.allowedDomain}`);
    console.log(`  database: ${config.databaseUrl ? 'DATABASE_URL' : `PGlite ${dataDir ? `in ${dataDir}` : 'in memory'}`}`);
    if (config.missing.length) console.log(`  missing settings: ${config.missing.join(', ')}`);
  }
  return {
    url: config.siteUrl, config, db, site,
    async close() {
      await site.close();
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try { process.loadEnvFile(path.join(HERE, '.env.local')); } catch { /* none: the environment and the defaults */ }
  const s = await startLocalSite({ port: Number(process.env.PORT) || DEV_PORT, dataDir: process.argv.includes('--memory') ? null : path.join(HERE, '.data') });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { s.close().finally(() => process.exit(0)); });
}
