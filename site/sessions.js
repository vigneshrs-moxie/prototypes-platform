// Sessions: who a browser is.
//   The cookie pt_session = <id>.<sig>: id is 32 random bytes, sig its HMAC-SHA256 with
//   SESSION_SECRET (so a made-up cookie is refused before the database is asked). HttpOnly, Secure,
//   SameSite=Lax.
//   The sessions table keeps only the id's SHA-256, so it can be revoked.
//   30 days, sliding: each use pushes the end back to 30 days from now (written at most once an
//   hour, so a busy page isn't a write per request).
//
// Forms carry formToken(session): an HMAC of the session, so a page can't be posted to from outside.

import crypto from 'node:crypto';
import { cookie, parseCookies } from './http.js';
import { randomToken, sha256 } from './google.js';

export const SESSION_COOKIE = 'pt_session';
export const SESSION_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;
const TOUCH_EVERY = 60 * 60 * 1000;

export const iso = (ms) => new Date(ms).toISOString();

export function sessionStore({ db, config, now }) {
  const hmac = (text) => crypto.createHmac('sha256', config.sessionSecret).update(text).digest('base64url');
  const cookieFor = (id) => cookie(SESSION_COOKIE, `${id}.${hmac(id)}`, { maxAge: SESSION_DAYS * DAY / 1000 });

  /** The session id from a request's cookie, if its signature is right. */
  function idFrom(req) {
    const raw = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!raw) return null;
    const dot = raw.lastIndexOf('.');
    if (dot < 1) return null;
    const id = raw.slice(0, dot);
    const sig = Buffer.from(raw.slice(dot + 1));
    const want = Buffer.from(hmac(id));
    return sig.length === want.length && crypto.timingSafeEqual(sig, want) ? id : null;
  }

  return {
    /** A new session for a person: its Set-Cookie value. */
    async create(personId) {
      const id = randomToken(32);
      const t = now();
      await db.query('INSERT INTO sessions (id_hash, person_id, created_at, last_seen_at, expires_at) VALUES ($1, $2, $3, $3, $4)', [sha256(id), personId, iso(t), iso(t + SESSION_DAYS * DAY)]);
      return cookieFor(id);
    },

    /** { session, person } for the request, or null. Renews the session (and its cookie on `res`). */
    async find(req, res) {
      const id = idFrom(req);
      if (!id) return null;
      const t = now();
      const { rows } = await db.query(
        `SELECT s.id_hash, s.last_seen_at, p.id, p.email, p.name
           FROM sessions s JOIN people p ON p.id = s.person_id
          WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2`,
        [sha256(id), iso(t)],
      );
      const row = rows[0];
      if (!row) return null;
      if (t - new Date(row.last_seen_at).getTime() > TOUCH_EVERY) {
        await db.query('UPDATE sessions SET last_seen_at = $2, expires_at = $3 WHERE id_hash = $1', [row.id_hash, iso(t), iso(t + SESSION_DAYS * DAY)]);
        res?.setHeader?.('Set-Cookie', cookieFor(id));
      }
      return {
        session: { idHash: row.id_hash },
        person: { id: Number(row.id), email: row.email, name: row.name, admin: config.adminEmails().has(row.email) },
      };
    },

    /** The token this session's forms carry. */
    formToken: (session) => hmac(`form:${session.idHash}`),
    /** Whether a posted token is this session's. */
    formTokenOk(session, given) {
      const want = Buffer.from(hmac(`form:${session.idHash}`));
      const got = Buffer.from(String(given ?? ''));
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    },

    async revoke(idHash) { await db.query('UPDATE sessions SET revoked_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL', [idHash, iso(now())]); },
    async revokeAll(personId) { await db.query('UPDATE sessions SET revoked_at = $2 WHERE person_id = $1 AND revoked_at IS NULL', [personId, iso(now())]); },
    /** The Set-Cookie that forgets the session in the browser. */
    clearCookie: () => cookie(SESSION_COOKIE, '', { maxAge: 0 }),
  };
}
