// The small HTTP pieces every route uses: errors with a status and plain words, answers with the
// site's safety headers, request bodies (with a size cap), and cookies.

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

/**
 * The strict policy on every page and answer of the site's own. frame-src 'self' is there for the
 * sandboxed prototype frame; nothing else may be embedded, and nothing may embed the site.
 */
export const SITE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/**
 * Referrer-Policy is same-origin, not no-referrer: with no-referrer a browser sends "Origin: null"
 * on a form post, and the same-origin rule for changes could not tell it from a sandboxed frame.
 * same-origin still sends nothing to any other site.
 */
export const SITE_HEADERS = Object.freeze({
  'Content-Security-Policy': SITE_CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'Cache-Control': 'no-store',
});

export function send(res, status, body = '', type = 'text/plain; charset=utf-8', extra = {}) {
  if (res.headersSent) { res.end(); return; }
  const headers = { ...SITE_HEADERS, ...extra };
  if (body !== null && status !== 204 && status !== 304) headers['Content-Type'] = type;
  res.writeHead(status, headers);
  res.end(status === 204 ? undefined : body);
}

export const sendJson = (res, status, data, extra = {}) => send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', extra);
export const sendHtml = (res, status, page, extra = {}) => send(res, status, String(page), 'text/html; charset=utf-8', extra);

/** A redirect, with the cookies to set. */
export function redirect(res, location, cookies = []) {
  res.writeHead(302, { ...SITE_HEADERS, Location: location, ...(cookies.length ? { 'Set-Cookie': cookies } : {}) });
  res.end();
}

const tooMuch = (max) => new HttpError(413, `That is too much at once: at most ${max >= 1e6 ? `${Math.round(max / 1e6)} MB` : `${Math.round(max / 1000)} KB`}.`);

/**
 * The request's bytes, at most `max`. On Vercel the Node helpers can read the stream first; the
 * site sets NODEJS_HELPERS=0 so they don't, because they drop a multipart body. If they ran anyway,
 * req.body is used where it can be, and a body that is gone says so instead of looking empty.
 */
export async function readBody(req, { max = 64 * 1000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw tooMuch(max);
    chunks.push(c);
  }
  if (size || !Number(req.headers['content-length'] ?? 0)) return Buffer.concat(chunks);
  let pre;
  try { pre = req.body; } catch { pre = undefined; }
  let out = null;
  if (Buffer.isBuffer(pre)) out = pre;
  else if (typeof pre === 'string') out = Buffer.from(pre);
  else if (pre && typeof pre === 'object') {
    const isForm = String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded');
    out = Buffer.from(isForm ? new URLSearchParams(pre).toString() : JSON.stringify(pre));
  }
  if (!out) throw new HttpError(500, 'The site lost this request’s body. Set NODEJS_HELPERS=0 in Vercel and deploy again.');
  if (out.length > max) throw tooMuch(max);
  return out;
}

/** The JSON body, as an object. */
export async function readJson(req, { max = 64 * 1000 } = {}) {
  const text = (await readBody(req, { max })).toString('utf8');
  if (!text.trim()) return {};
  let body;
  try { body = JSON.parse(text); } catch { throw new HttpError(400, 'That wasn’t valid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Send a JSON object.');
  return body;
}

/** A form post, as URLSearchParams. */
export async function readForm(req, { max = 64 * 1000 } = {}) {
  return new URLSearchParams((await readBody(req, { max })).toString('utf8'));
}

/** The request's cookies, by name. */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 1) continue;
    const name = part.slice(0, eq).trim();
    if (!name || Object.hasOwn(out, name)) continue;
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* a malformed value: skip it */ }
  }
  return out;
}

/**
 * One Set-Cookie value: always HttpOnly, Secure and SameSite=Lax. Browsers keep Secure cookies
 * from http://localhost too (a secure context), so the local server needs no exception.
 */
export function cookie(name, value, { maxAge, path = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', 'Secure', 'SameSite=Lax'];
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return parts.join('; ');
}
