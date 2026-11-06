// The site's database, behind one small shape so the same routes run on both:
//   production  Postgres (Neon) through `pg`'s Pool: few connections, released after five idle seconds.
//   tests, dev  PGlite, Postgres compiled to WebAssembly, in this process: no server, no Docker.
//
// Every db is { query(sql, params) → { rows, rowCount }, exec(sql), tx(fn) → fn's result, close() }.
// exec runs several statements at once, with no parameters (the migrations). tx runs fn(q) inside
// one transaction (q has the same query() and exec()); a throw rolls it back.

/** A db over a `pg` Pool (or anything with pg's connect/query). */
export function pgDb(pool) {
  return {
    kind: 'pg',
    async query(sql, params = []) {
      const r = await pool.query(sql, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(sql) { await pool.query(sql); },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const q = {
          query: async (sql, params = []) => { const r = await client.query(sql, params); return { rows: r.rows, rowCount: r.rowCount ?? 0 }; },
          exec: async (sql) => { await client.query(sql); },
        };
        const out = await fn(q);
        await client.query('COMMIT');
        return out;
      } catch (err) {
        try { await client.query('ROLLBACK'); } catch { /* the connection is gone; nothing to undo */ }
        throw err;
      } finally {
        client.release();
      }
    },
    async close() { await pool.end(); },
  };
}

/** A db over a PGlite instance. */
export function pgliteDb(pg) {
  const norm = (r) => ({ rows: r.rows, rowCount: r.affectedRows ?? r.rows.length ?? 0 });
  return {
    kind: 'pglite',
    async query(sql, params = []) { return norm(await pg.query(sql, params)); },
    async exec(sql) { await pg.exec(sql); },
    async tx(fn) {
      return pg.transaction(async (t) => fn({ query: async (sql, params = []) => norm(await t.query(sql, params)), exec: async (sql) => { await t.exec(sql); } }));
    },
    async close() { await pg.close(); },
  };
}

/** A fresh in-memory PGlite db (tests), or one kept in a folder (the local dev server). */
export async function openPglite(dataDir = 'memory://') {
  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create(dataDir);
  return pgliteDb(pg);
}

/**
 * The production db: a pg Pool on DATABASE_URL. Neon's pooled address is what DATABASE_URL holds; it
 * takes TLS and the pool keeps few connections, since each function instance has its own pool.
 * options: extra pool settings (a test sets its own schema).
 */
export async function openPostgres(connectionString, options = {}) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString, max: 5, idleTimeoutMillis: 5000, connectionTimeoutMillis: 10000, ...options });
  return pgDb(pool);
}
