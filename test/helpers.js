// What the tests share: a site on a fresh database, reached through an in-process fetch (no port is
// opened: the request goes straight to the router's handler), a clock the tests move, and a
// browser-like cookie jar per made-up person.
//
// The database is PGlite (Postgres in this process) unless TEST_DATABASE_URL is set; then each site
// gets its own schema there, dropped afterwards, so the same tests run on a real Postgres.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { fakeBlob } from '../lib/blob.js';
import { readConfig } from '../site/config.js';
import { openPglite, openPostgres } from '../site/db.js';
import { migrate } from '../site/migrate.js';
import { createSite } from '../site/router.js';

export const SITE = 'http://localhost:4480';
export const ADA = 'ada.admin@example.test';
export const SAM = 'sam.shared@example.test';
export const STU = 'stu.stranger@example.test';

export const TEST_ENV = Object.freeze({
  AUTH_FAKE: '1',
  SITE_URL: SITE,
  ALLOWED_DOMAIN: 'example.test',
  ADMIN_EMAILS: `${ADA}, Bea.Boss@example.test`,
  SESSION_SECRET: 'test-session-secret-not-a-real-one-000000',
});

async function openDb() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return openPglite();
  const schema = `t_${crypto.randomBytes(6).toString('hex')}`;
  const first = await openPostgres(url);
  await first.exec(`CREATE SCHEMA ${schema}`);
  await first.close();
  const db = await openPostgres(url, { options: `-c search_path=${schema}` });
  return { ...db, async close() { await db.exec(`DROP SCHEMA ${schema} CASCADE`); await db.close(); } };
}

/**
 * fetch() for one handler, in this process. A request to `origin` goes to the handler as a Node
 * request and response; anything else throws, so a test can never reach the network by mistake.
 */
export function inProcessFetch(getHandler, { origin = SITE } = {}) {
  return async function fetchIn(input, init = {}) {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (url.origin !== origin) throw new Error(`A test tried to reach ${url.origin}: only the site itself is allowed.`);
    const headers = {};
    new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    let body = init.body ?? null;
    if (body instanceof URLSearchParams) { body = body.toString(); headers['content-type'] ??= 'application/x-www-form-urlencoded'; }
    const buf = body === null ? Buffer.alloc(0) : Buffer.from(body);
    if (buf.length) headers['content-length'] = String(buf.length);
    headers.host ??= url.host;
    const req = Readable.from(buf.length ? [buf] : []);
    Object.assign(req, { method: (init.method ?? 'GET').toUpperCase(), url: url.pathname + url.search, headers });
    return new Promise((resolve, reject) => {
      const res = new EventEmitter();
      const chunks = [];
      let status = 200;
      let out = {};
      res.headersSent = false;
      res.writeHead = (s, h = {}) => { status = s; res.statusCode = s; out = { ...out, ...h }; res.headersSent = true; return res; };
      res.setHeader = (k, v) => { out[k] = v; };
      res.getHeader = (k) => out[k];
      res.write = (c) => { chunks.push(Buffer.from(c)); return true; };
      res.end = (c) => {
        if (c !== undefined && c !== null) chunks.push(Buffer.from(c));
        const h = new Headers();
        for (const [k, v] of Object.entries(out)) for (const one of [].concat(v)) h.append(k, String(one));
        const bodyOut = [204, 304].includes(status) ? null : Buffer.concat(chunks);
        res.emit('finish');
        resolve(new Response(bodyOut, { status, headers: h }));
      };
      Promise.resolve(getHandler()(req, res)).catch(reject);
    });
  };
}

/** A site on a fresh database. env: overrides of TEST_ENV (the same object the site reads). */
export async function makeSite({ env = {}, clock = { t: Date.parse('2026-11-05T16:00:00Z') } } = {}) {
  const db = await openDb();
  await migrate(db);
  const liveEnv = { ...TEST_ENV, ...env };
  const config = readConfig(liveEnv);
  const blob = fakeBlob();
  const logs = [];
  let site = null;
  const fetch = inProcessFetch(() => site);
  site = createSite({ db, config, blob, fetch, now: () => clock.t, log: (l) => logs.push(l) });
  return {
    site, db, config, clock, fetch, blob, logs, env: liveEnv,
    async close() { await site.close(); await db.close(); },
  };
}

/** Runs a test on a fresh site and closes it. */
export const onSite = (fn, opts) => async () => {
  const s = await makeSite(opts);
  try { await fn(s); } finally { await s.close(); }
};

/** A browser for one person: keeps the site's cookies and sends the page's own Origin on changes. */
export function browser(fetchFn) {
  const jar = new Map();
  const keep = (res) => {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const gone = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (gone || !value) jar.delete(name); else jar.set(name, value);
    }
  };
  async function go(pathOrUrl, init = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${SITE}${pathOrUrl}`;
    const headers = { ...(init.headers ?? {}) };
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetchFn(url, { ...init, headers, redirect: 'manual' });
    keep(res);
    return res;
  }
  const b = {
    jar,
    get: (p, init = {}) => go(p, init),
    async page(p) { const r = await go(p); return { status: r.status, text: await r.text(), res: r }; },
    /** The form token on the page a person sees. */
    async formToken() { return /name="_token" value="([^"]+)"/.exec((await b.page('/')).text)[1]; },
    /** A form post, as the browser sends it from one of the site's pages. */
    async post(p, fields = {}, { headers = {}, token = null } = {}) {
      const body = new URLSearchParams({ _token: token ?? await b.formToken(), ...fields });
      return go(p, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE, ...headers }, body });
    },
  };
  return b;
}

/** Signs a browser in through the fake Google. Resolves where the site sent it at the end. */
export async function signIn(b, { email, name = '', fakeCase = '', returnTo = null } = {}) {
  const start = await b.get(`/auth/google${returnTo ? `?return=${encodeURIComponent(returnTo)}` : ''}`);
  assert.equal(start.status, 302);
  const google = new URL(start.headers.get('location'));
  assert.equal(google.origin + google.pathname, `${SITE}/fake-google/authorize`);
  const cont = new URL(`${SITE}/fake-google/continue`);
  for (const [k, v] of google.searchParams) cont.searchParams.set(k, v);
  cont.searchParams.set('email', email);
  if (name) cont.searchParams.set('name', name);
  if (fakeCase) cont.searchParams.set('case', fakeCase);
  const back = await b.get(cont.toString());
  assert.equal(back.status, 302);
  const callback = back.headers.get('location');
  const done = await b.get(callback);
  assert.equal(done.status, 302);
  return { location: done.headers.get('location'), callback, google };
}

/** A signed-in browser. */
export async function person(s, email, name = '') {
  const b = browser(s.fetch);
  await signIn(b, { email, name });
  return b;
}

/** A multipart body from { name: text | { filename, type, data } }. */
export function multipart(fields) {
  const boundary = `----test${crypto.randomBytes(8).toString('hex')}`;
  const chunks = [];
  for (const [name, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    const isFile = typeof v === 'object';
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${isFile ? `; filename="${v.filename}"` : ''}\r\n${isFile ? `Content-Type: ${v.type}\r\n` : ''}\r\n`));
    chunks.push(Buffer.from(isFile ? v.data : v));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), type: `multipart/form-data; boundary=${boundary}` };
}

export const MANIFEST = Object.freeze({ version: 1, title: 'Freeze header', screens: [], choices: [], questions: [], history: [] });

export const publishFields = (over = {}) => ({
  key: 'orbit-296-freeze-header',
  title: 'Freeze header',
  page_version: '1',
  manifest: JSON.stringify(MANIFEST),
  page: { filename: 'page.html', type: 'text/html; charset=utf-8', data: '<!doctype html><title>made up</title>' },
  ...over,
});

/** Makes a token through the Settings page, as an admin does. */
export async function makeToken(admin, label = 'A laptop') {
  const r = await admin.post('/settings/tokens', { label });
  assert.equal(r.status, 200);
  return /<code>(ptp_[\w-]+)<\/code>/.exec(await r.text())[1];
}

/** POST /api/publish with a token, as publish.py does. */
export async function publish(s, token, fields = publishFields()) {
  const { body, type } = multipart(fields);
  const r = await s.fetch(`${SITE}/api/publish`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body });
  return { status: r.status, body: await r.json() };
}

/** A GET with a token. */
export async function withToken(s, token, path, init = {}) {
  const r = await s.fetch(`${SITE}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  return { status: r.status, body: await r.json().catch(() => null), res: r };
}

/** An admin, their token, and one published feature. */
export async function withFeature(s, fields) {
  const ada = await person(s, ADA, 'Ada Admin');
  const token = await makeToken(ada);
  const first = await publish(s, token, fields);
  assert.equal(first.status, 200);
  return { ada, token, key: first.body.key };
}
