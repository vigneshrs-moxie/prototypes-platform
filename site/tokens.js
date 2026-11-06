// The publish token check. Valid only on the routes marked auth: 'token', never for a browser page.
// A token belongs to one admin, so it stops working the moment that person leaves ADMIN_EMAILS.

import { sha256 } from './google.js';
import { HttpError } from './http.js';
import { iso } from './sessions.js';

const BEARER = /^Bearer (ptp_[A-Za-z0-9_-]{20,100})$/;

export function tokenAuth({ db, config, now }) {
  return async function checkToken(req) {
    const given = BEARER.exec(String(req.headers.authorization ?? ''))?.[1];
    if (!given) throw new HttpError(401, 'Send your publish token as “Authorization: Bearer ptp_…”.');
    const row = (await db.query(
      `SELECT t.id, p.id AS person_id, p.email, p.name
         FROM publish_tokens t JOIN people p ON p.id = t.person_id
        WHERE t.token_hash = $1 AND t.revoked_at IS NULL`,
      [sha256(given)],
    )).rows[0];
    if (!row) throw new HttpError(401, 'That token isn’t valid. Make a new one on the site’s Settings page.');
    if (!config.adminEmails().has(row.email)) throw new HttpError(403, 'That token’s owner isn’t an admin any more.');
    await db.query('UPDATE publish_tokens SET last_used_at = $2 WHERE id = $1', [row.id, iso(now())]);
    return { id: Number(row.id), person: { id: Number(row.person_id), email: row.email, name: row.name, admin: true } };
  };
}
