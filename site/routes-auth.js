// Signing in with Google, and out.
//   GET  /auth/google?return=/f/key   off to Google (state, nonce, PKCE); `return` is where to land
//                                     afterwards (this site's own pages only)
//   GET  /auth/callback               Google's answer: every check, then a session
//   POST /auth/sign-out               this browser's session ends
//   GET  /sign-in                     the sign-in page; ?problem=<code> says why the last try failed
//
// The callback refuses, with no session, a state that isn't this browser's (the pt_signin cookie
// set at the start), one used before or older than ten minutes, and any ID token that fails
// site/google.js verify().

import { googleClient, pkceChallenge, randomToken, sha256, SignInRefused } from './google.js';
import { fakeGoogle } from './fake-google.js';
import { cookie, HttpError, parseCookies, redirect, sendHtml } from './http.js';
import { html, layout } from './render.js';
import { iso, sessionStore } from './sessions.js';

const SIGNIN_COOKIE = 'pt_signin';
const SIGNIN_MINUTES = 10;
const RETURN = /^\/(?!\/)[A-Za-z0-9/_\-?=&.]*$/;

const PROBLEMS = {
  domain: 'This site is for Moxie accounts only. Sign in with your Moxie Google account.',
  cancelled: 'You cancelled the sign-in.',
  state: 'That sign-in ran out or was already used. Try again.',
  expired: 'Google’s answer ran out before it reached the site. Try again.',
  'bad-token': 'Google’s answer couldn’t be checked, so it wasn’t trusted. Try again.',
  google: 'Google couldn’t be reached. Try again in a moment.',
  account: 'That address belongs to another Google account the site already knows. Ask an admin.',
  'signed-out': 'You’re signed out.',
};

export const safeReturn = (v) => (typeof v === 'string' && v.length <= 200 && RETURN.test(v) ? v : '/');

export default function authRoutes(ctx) {
  const { db, config, now } = ctx;
  const google = googleClient({ config, fetch: ctx.fetch, now });
  const sessions = sessionStore({ db, config, now });
  ctx.sessions = sessions;
  if (config.authFake) (ctx.extraHandlers ??= []).push(fakeGoogle({ config, now }));

  const refused = (res, code) => redirect(res, `/sign-in?problem=${encodeURIComponent(code)}`, [cookie(SIGNIN_COOKIE, '', { maxAge: 0, path: '/auth' })]);

  /** The person for these claims: found by Google's sub, kept up to date. */
  async function personFor(claims) {
    const t = iso(now());
    return db.tx(async (q) => {
      const found = (await q.query('SELECT id FROM people WHERE google_sub = $1', [claims.sub])).rows[0];
      if (found) {
        await q.query('UPDATE people SET email = $2, name = $3, last_sign_in_at = $4 WHERE id = $1', [found.id, claims.email, claims.name, t]);
        return Number(found.id);
      }
      // An address can move to a new Google account only by its owner re-creating it; refuse quietly to merge.
      const sameEmail = (await q.query('SELECT id FROM people WHERE email = $1', [claims.email])).rows[0];
      if (sameEmail) throw new SignInRefused('account', 'That address belongs to another Google account the site already knows.');
      return Number((await q.query('INSERT INTO people (google_sub, email, name, created_at, last_sign_in_at) VALUES ($1, $2, $3, $4, $4) RETURNING id', [claims.sub, claims.email, claims.name, t])).rows[0].id);
    });
  }

  return [
    {
      method: 'GET', path: '/sign-in', auth: 'public',
      async run({ req, res, url }) {
        const back = safeReturn(url.searchParams.get('return'));
        if (await sessions.find(req, res)) return redirect(res, back);
        const problem = PROBLEMS[url.searchParams.get('problem')];
        const to = `/auth/google${back === '/' ? '' : `?return=${encodeURIComponent(back)}`}`;
        sendHtml(res, 200, layout({
          title: 'Sign in',
          plain: true,
          body: html`<section class="card signin">
  <span class="mark big" aria-hidden="true"></span>
  <h1>Orbit Prototypes</h1>
  <p class="muted">See what’s being built, and leave notes on it.</p>
  ${problem && html`<p class="notice" role="status">${problem}</p>`}
  <a class="btn primary wide" href="${to}">Sign in with Google</a>
</section>`,
        }));
      },
    },
    {
      method: 'GET', path: '/auth/google', auth: 'public',
      async run({ res, url }) {
        const state = randomToken(32);
        const nonce = randomToken(32);
        const verifier = randomToken(48);
        const t = now();
        await db.query('DELETE FROM sign_ins WHERE created_at < $1', [iso(t - 24 * 60 * 60 * 1000)]);
        await db.query('INSERT INTO sign_ins (state_hash, nonce, verifier, return_to, created_at) VALUES ($1, $2, $3, $4, $5)', [sha256(state), nonce, verifier, safeReturn(url.searchParams.get('return')), iso(t)]);
        let to;
        try { to = await google.authorizeUrl({ state, nonce, challenge: pkceChallenge(verifier) }); } catch (err) {
          if (err instanceof SignInRefused) return refused(res, err.code);
          throw err;
        }
        redirect(res, to, [cookie(SIGNIN_COOKIE, state, { maxAge: SIGNIN_MINUTES * 60, path: '/auth' })]);
      },
    },
    {
      method: 'GET', path: '/auth/callback', auth: 'public',
      async run({ req, res, url }) {
        const q = url.searchParams;
        if (q.get('error')) return refused(res, 'cancelled');
        const state = q.get('state') ?? '';
        const code = q.get('code') ?? '';
        const mine = parseCookies(req.headers.cookie)[SIGNIN_COOKIE] ?? '';
        if (!state || !code || state !== mine) return refused(res, 'state');
        const t = now();
        // Used once: the row is taken in the same statement that checks it.
        const row = (await db.query(
          'UPDATE sign_ins SET used_at = $2 WHERE state_hash = $1 AND used_at IS NULL AND created_at > $3 RETURNING nonce, verifier, return_to',
          [sha256(state), iso(t), iso(t - SIGNIN_MINUTES * 60 * 1000)],
        )).rows[0];
        if (!row) return refused(res, 'state');
        try {
          const idToken = await google.exchange(code, row.verifier);
          const claims = await google.verify(idToken, row.nonce);
          const personId = await personFor(claims);
          const sessionCookie = await sessions.create(personId);
          redirect(res, safeReturn(row.return_to), [sessionCookie, cookie(SIGNIN_COOKIE, '', { maxAge: 0, path: '/auth' })]);
        } catch (err) {
          if (err instanceof SignInRefused) return refused(res, err.code);
          throw err;
        }
      },
    },
    {
      method: 'POST', path: '/auth/sign-out', auth: 'session',
      async run({ res, session }) {
        await sessions.revoke(session.idHash);
        redirect(res, '/sign-in?problem=signed-out', [sessions.clearCookie()]);
      },
    },
  ];
}

/** A page that needs a signed-in person sends the rest here. */
export const signInFirst = (path) => {
  const back = safeReturn(path);
  return back === '/' ? '/sign-in' : `/sign-in?return=${encodeURIComponent(back)}`;
};

export const notSignedIn = () => new HttpError(401, 'Sign in first.', { signIn: true });
