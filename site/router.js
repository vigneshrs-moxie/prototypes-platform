// The site's one router. Vercel runs it as one Node function (api/index.js; vercel.json rewrites
// every page and /api/* there); the local server (dev.js) runs exactly the same handler under
// node:http, so tests and a laptop use the code Vercel runs.
//
// createSite({ db, config, blob, fetch, now, staticDir, log }) → handler(req, res), with .close().
//
// The routes live in routes-*.js, each a list of { method, path, auth, run }:
//   path   an exact path, or a RegExp whose groups the route reads (call.m)
//   auth   'public'   anyone
//          'session'  a signed-in person (call.person, call.session; call.token is their form token)
//          'admin'    the same, and the person's email is in ADMIN_EMAILS
//          'token'    a publish token (call.publisher); never a browser's session
//   ready  false for the one route that answers before the site is set up (/healthz)
//
// A change from a browser must come from the site's own pages: Origin equal to SITE_URL, then
//   a form        the session's token in _token. HTML has no DELETE, so a form says _method=DELETE
//   JSON          the header X-Requested-With: prototypes
// A page that needs a signed-in person sends a stranger to /sign-in; /api/* answers 401 in JSON.
// Errors on a page are a page, in words; errors under /api/ are JSON.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { FRAME_GONE, HttpError, PAGE_HEADERS, redirect, readForm, send, sendHtml, sendJson, SITE_HEADERS } from './http.js';
import { html, layout } from './render.js';
import authRoutes, { signInFirst } from './routes-auth.js';
import homeRoutes from './routes-home.js';
import featureRoutes from './routes-feature.js';
import shareRoutes from './routes-shares.js';
import settingsRoutes from './routes-settings.js';
import publishRoutes from './routes-publish.js';
import apiRoutes from './routes-api.js';
import pageRoutes from './routes-page.js';
import notesRoutes from './routes-notes.js';
import { tokenAuth } from './tokens.js';

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const TYPES = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** The lists of routes, in the order they are tried. */
export const ROUTE_LISTS = [authRoutes, homeRoutes, shareRoutes, featureRoutes, pageRoutes, settingsRoutes, publishRoutes, apiRoutes, notesRoutes];

export function createSite({ db, config, blob, fetch: fetchFn = globalThis.fetch, now = () => Date.now(), staticDir = null, extraRoutes = [], log = (line) => console.log(JSON.stringify(line)) }) {
  const closers = [];
  const ctx = { db, config, blob, now, fetch: fetchFn, onClose: (fn) => closers.push(fn) };
  const routes = [...ROUTE_LISTS, ...extraRoutes].flatMap((list) => list(ctx));
  const extraHandlers = ctx.extraHandlers ?? [];
  const checkToken = tokenAuth(ctx);

  function find(method, urlPath) {
    const want = method === 'HEAD' ? 'GET' : method;
    let pathMatched = false;
    for (const r of routes) {
      const m = typeof r.path === 'string' ? (r.path === urlPath ? [urlPath] : null) : r.path.exec(urlPath);
      if (!m) continue;
      pathMatched = true;
      if (r.method === want) return { r, m };
    }
    return pathMatched ? 'method' : null;
  }

  const refuse = () => new HttpError(403, 'This change must come from the site’s own page. Reload the page and try again.');

  /** A browser's change: same origin, and the mark of the kind of request it is. */
  function checkChange(req, call) {
    if (req.headers.origin !== config.siteOrigin) throw refuse();
    if (call.form) {
      if (!ctx.sessions.formTokenOk(call.session, call.form.get('_token'))) throw refuse();
      return;
    }
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw new HttpError(415, 'Send a form or JSON.');
    if (req.headers['x-requested-with'] !== 'prototypes') throw refuse();
  }

  async function authorize(r, req, res, call) {
    if (r.auth === 'public') return;
    if (r.auth === 'token') {
      call.publisher = await checkToken(req);
      call.person = call.publisher.person;
      call.note.person = call.person.id;
      return;
    }
    if (r.auth === 'session' || r.auth === 'admin') {
      const s = await ctx.sessions.find(req, res);
      if (!s) throw new HttpError(401, 'Sign in first.', { signIn: true });
      call.person = s.person;
      call.session = s.session;
      call.token = ctx.sessions.formToken(s.session);
      call.note.person = s.person.id;
      if (WRITES.has(req.method)) checkChange(req, call);
      if (r.auth === 'admin' && !s.person.admin) throw new HttpError(403, 'Only an admin can do this.');
      return;
    }
    throw new Error(`A route without a known auth: ${r.method} ${r.path}`);
  }

  async function serveStatic(urlPath, res) {
    const file = path.resolve(staticDir, urlPath.slice(1));
    if (!file.startsWith(path.resolve(staticDir) + path.sep)) return false;
    let body;
    try { body = await fsp.readFile(file); } catch { return false; }
    res.writeHead(200, { ...SITE_HEADERS, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=300' });
    res.end(body);
    return true;
  }

  function errorPage(res, call, status, message, extra = {}) {
    const titles = { 403: 'Not for you', 404: 'Not found', 503: 'Not set up yet' };
    sendHtml(res, status, layout({
      title: titles[status] ?? 'Something went wrong',
      person: call?.person ?? null,
      token: call?.token ?? '',
      body: html`<section class="card narrow"><h1>${titles[status] ?? 'Something went wrong'}</h1><p>${message}</p><p><a href="/">Back to the home page</a></p></section>`,
    }), extra);
  }

  // Requests still being answered: close() waits for them, so nothing touches a closed database.
  const inflight = new Set();
  async function handler(req, res) {
    const p = answer(req, res);
    inflight.add(p);
    try { return await p; } finally { inflight.delete(p); }
  }

  async function answer(req, res) {
    let url;
    let urlPath;
    try {
      url = new URL(req.url, config.siteUrl);
      urlPath = decodeURIComponent(url.pathname);
    } catch { return send(res, 400, 'Bad request'); }
    // What a log line says: route, status, person id, feature key. Never a token, a note or an email.
    const note = { route: `${req.method} ${url.pathname}`, person: null, key: /^\/f\/([a-z0-9-]+)/.exec(urlPath)?.[1] ?? null };
    const isApi = urlPath.startsWith('/api/');
    let call = null;
    try {
      for (const h of extraHandlers) if (h.owns(urlPath)) return await h.handle(req, res, url);
      // A form says what it means in _method, so it's read before the route is found.
      let form = null;
      if (req.method === 'POST' && String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) form = await readForm(req);
      const method = form?.get('_method') === 'DELETE' ? 'DELETE' : req.method;
      const hit = find(method, urlPath);
      if (!(hit?.r?.ready === false) && config.missing.length) {
        throw new HttpError(503, `The site isn’t set up yet. These settings are missing: ${config.missing.join(', ')}.`, { missing: config.missing });
      }
      if (hit === 'method') throw new HttpError(405, 'That address doesn’t take this kind of request.');
      if (!hit) {
        if (staticDir && (req.method === 'GET' || req.method === 'HEAD') && await serveStatic(urlPath, res)) return;
        throw new HttpError(404, 'There’s nothing at this address.');
      }
      call = { req, res, url, m: hit.m, form, person: null, session: null, token: '', publisher: null, note };
      await authorize(hit.r, req, res, call);
      return await hit.r.run(call);
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      const status = err instanceof HttpError ? err.status : 500;
      const words = err instanceof HttpError ? err.message : 'Something went wrong on the site. Try again in a moment.';
      if (isApi) return sendJson(res, status, { error: words, ...(err.extra ?? {}) });
      if (status === 401 && req.headers['sec-fetch-dest'] === 'iframe') {
        res.writeHead(401, { ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(FRAME_GONE);
      }
      if (status === 401) return redirect(res, signInFirst(url.pathname + url.search));
      return errorPage(res, call, status, words);
    } finally {
      log({ ...note, status: res.statusCode });
    }
  }

  handler.ctx = ctx;
  handler.close = async () => {
    for (const fn of closers.splice(0)) await fn();
    await Promise.allSettled([...inflight]);
  };
  return handler;
}
