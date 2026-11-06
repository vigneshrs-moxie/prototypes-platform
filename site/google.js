// Google sign-in, as an OpenID Connect client: the authorization code flow with PKCE (S256), a
// state and a nonce (https://developers.google.com/identity/openid-connect/openid-connect).
//
//   authorizeUrl({ state, nonce, challenge })  where the browser goes to choose an account
//   exchange(code, verifier)                    the code for tokens, at Google's token endpoint
//   verify(idToken, nonce)                      the ID token's claims, or a SignInRefused:
//     its signature against Google's keys (jose, the JWKS from the discovery document), then its
//     issuer, audience and expiry, then the nonce, then email_verified and hd === ALLOWED_DOMAIN.
//     hd sent in the request only narrows Google's account picker; the claim is what counts.
//
// The endpoints come from the discovery document, fetched once per instance. With AUTH_FAKE the
// same code talks to the fake issuer (site/fake-google.js) instead; nothing else changes.

import crypto from 'node:crypto';
import { createRemoteJWKSet, customFetch, errors, jwtVerify } from 'jose';

/** Why a sign-in was refused: `code` is what the page is told (/sign-in?problem=<code>). */
export class SignInRefused extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const randomToken = (bytes = 32) => b64url(crypto.randomBytes(bytes));
export const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
export const pkceChallenge = (verifier) => b64url(crypto.createHash('sha256').update(verifier).digest());

export function googleClient({ config, fetch: fetchFn, now }) {
  let discovery = null;
  let jwks = null;

  async function doc() {
    if (discovery && discovery.until > now()) return discovery.doc;
    let res;
    try { res = await fetchFn(config.google.discovery, { headers: { accept: 'application/json' } }); } catch { throw new SignInRefused('google', 'Google couldn’t be reached. Try again in a moment.'); }
    if (!res.ok) throw new SignInRefused('google', 'Google couldn’t be reached. Try again in a moment.');
    const d = await res.json();
    if (!config.google.issuers.includes(d.issuer)) throw new SignInRefused('google', 'Google’s sign-in answered from an address the site doesn’t expect.');
    discovery = { doc: d, until: now() + 60 * 60 * 1000 };
    jwks = createRemoteJWKSet(new URL(d.jwks_uri), { [customFetch]: (url, opts) => fetchFn(url, opts) });
    return d;
  }

  return {
    async authorizeUrl({ state, nonce, challenge }) {
      const d = await doc();
      const u = new URL(d.authorization_endpoint);
      u.search = new URLSearchParams({
        client_id: config.google.clientId,
        redirect_uri: config.redirectUri,
        response_type: 'code',
        scope: 'openid email profile',
        state, nonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        // Only a hint for Google's account picker: the hd claim is checked in verify().
        ...(config.allowedDomain ? { hd: config.allowedDomain } : {}),
        prompt: 'select_account',
      }).toString();
      return u.toString();
    },

    async exchange(code, verifier) {
      const d = await doc();
      let res;
      try {
        res = await fetchFn(d.token_endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: new URLSearchParams({
            code, client_id: config.google.clientId, client_secret: config.google.clientSecret,
            redirect_uri: config.redirectUri, grant_type: 'authorization_code', code_verifier: verifier,
          }).toString(),
        });
      } catch { throw new SignInRefused('google', 'Google couldn’t be reached. Try again in a moment.'); }
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.id_token !== 'string') throw new SignInRefused('google', 'Google didn’t accept that sign-in. Try again.');
      return body.id_token;
    },

    async verify(idToken, nonce) {
      await doc();
      let claims;
      try {
        ({ payload: claims } = await jwtVerify(idToken, jwks, {
          issuer: config.google.issuers,
          audience: config.google.clientId,
          algorithms: ['RS256'],
          requiredClaims: ['sub', 'exp', 'iat'],
          currentDate: new Date(now()),
          clockTolerance: 30,
        }));
      } catch (err) {
        if (err instanceof errors.JWTExpired) throw new SignInRefused('expired', 'Google’s answer had run out before it reached the site. Sign in again.');
        throw new SignInRefused('bad-token', 'Google’s answer couldn’t be checked, so it wasn’t trusted. Sign in again.');
      }
      if (typeof claims.nonce !== 'string' || claims.nonce.length !== nonce.length || !crypto.timingSafeEqual(Buffer.from(claims.nonce), Buffer.from(nonce))) {
        throw new SignInRefused('bad-token', 'Google’s answer wasn’t for this sign-in, so it wasn’t trusted. Sign in again.');
      }
      const email = typeof claims.email === 'string' ? claims.email.toLowerCase() : '';
      const domainOk = Boolean(config.allowedDomain) && claims.hd === config.allowedDomain && email.endsWith(`@${config.allowedDomain}`);
      if (claims.email_verified !== true || !domainOk) throw new SignInRefused('domain', 'This site is for Moxie accounts only.');
      return { sub: String(claims.sub), email, name: typeof claims.name === 'string' ? claims.name.slice(0, 200) : '' };
    },
  };
}
