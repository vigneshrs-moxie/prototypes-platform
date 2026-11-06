// The schema's migrations: migrations/NNN-name.sql, applied in order, each once.
//
// All of them run in one transaction that first takes a Postgres advisory lock (held until the
// transaction ends), so two builds deploying at once wait for each other instead of racing, and a
// migration that fails leaves the database as it was. schema_migrations names each file applied
// with its checksum; a file changed after it was applied is refused, in plain words, rather than
// quietly skipped. Safe to run on every build: with nothing new it changes nothing.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
/** The advisory lock's key: any fixed number, the same for every build of this site. */
export const MIGRATION_LOCK = 4480_2026_11;
const NAME = /^(\d{3})-[a-z0-9-]+\.sql$/;

export class MigrationError extends Error {}

/** The migration files in order: [{ name, sql, checksum }]. */
export async function readMigrations(dir = MIGRATIONS_DIR) {
  let names = [];
  try { names = (await fs.readdir(dir)).filter((n) => n.endsWith('.sql')).sort(); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) throw new MigrationError(`${name} isn’t named like the others (three digits, a dash, then lower-case words, like 001-people.sql).`);
    if (seen.has(m[1])) throw new MigrationError(`Two migrations share the number ${m[1]}.`);
    seen.add(m[1]);
    const sql = await fs.readFile(path.join(dir, name), 'utf8');
    out.push({ name, sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') });
  }
  return out;
}

/** Applies what is new. Resolves { applied: [names], already: n }. */
export async function migrate(db, { dir = MIGRATIONS_DIR, log = () => {} } = {}) {
  const files = await readMigrations(dir);
  return db.tx(async (q) => {
    await q.query('SELECT pg_advisory_xact_lock($1::bigint)', [MIGRATION_LOCK]);
    await q.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Map((await q.query('SELECT name, checksum FROM schema_migrations')).rows.map((r) => [r.name, r.checksum]));
    const applied = [];
    for (const f of files) {
      if (done.has(f.name)) {
        if (done.get(f.name) !== f.checksum) throw new MigrationError(`${f.name} was changed after it was applied. Put it back as it was and add a new migration instead.`);
        continue;
      }
      log(`applying ${f.name}`);
      await q.exec(f.sql);
      await q.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [f.name, f.checksum]);
      applied.push(f.name);
    }
    return { applied, already: done.size };
  });
}
