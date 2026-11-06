// A small stand-in for Google's sign-in, for tests and a laptop only (AUTH_FAKE=1; a production
// build refuses to start with it: site/config.js). It is a real OpenID Connect issuer, so the
// site's own client (site/google.js) checks it exactly as it checks Google:
//
//   GET  /fake-google/.well-known/openid-configuration   the discovery document
//   GET  /fake-google/certs                                its signing key (JWKS)
//   GET  /fake-google/authorize                            "Choose an account": type any made-up
//                                                          email; nothing is sent anywhere
//   GET  /fake-google/continue                             the code back to the redirect address
//   POST /fake-google/token                                the code (with its PKCE verifier and the
//                                                          client secret) for a signed ID token
//
// `case` on /continue makes a broken answer for the tests of each refusal: bad-signature (signed
// with another key under the same key id), expired, wrong-nonce, unverified (email_verified false)
// and no-hd (a personal account). The hd claim is the email's domain otherwise.

import crypto from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { b64url, pkceChallenge } from './google.js';
import { HttpError, send, sendJson } from './http.js';

const CASES = new Set(['', 'bad-signature', 'expired', 'wrong-nonce', 'unverified', 'no-hd']);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function readForm(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function fakeGoogle({ config, now }) {
  const issuer = `${config.siteUrl}/fake-google`;
  const KID = 'fake-key-1';
  const keys = (async () => {
    const good = await generateKeyPair('RS256', { extractable: true });
    const other = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(good.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
    return { good, other, jwk };
  })();
  const codes = new Map();

  async function idToken(c) {
    const k = await keys;
    const t = Math.floor(now() / 1000);
    const domain = c.email.split('@')[1] ?? '';
    const claims = {
      email: c.email,
      email_verified: c.case !== 'unverified',
      name: c.name || c.email.split('@')[0],
      nonce: c.case === 'wrong-nonce' ? 'not-the-nonce-this-sign-in-sent' : c.nonce,
      ...(c.case === 'no-hd' ? {} : { hd: domain }),
    };
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: KID, typ: 'JWT' })
      .setIssuer(issuer)
      .setAudience(c.clientId)
      .setSubject(`fake-${crypto.createHash('sha256').update(c.email).digest('hex').slice(0, 20)}`)
      .setIssuedAt(c.case === 'expired' ? t - 7200 : t)
      .setExpirationTime(c.case === 'expired' ? t - 3600 : t + 3600);
    return jwt.sign(c.case === 'bad-signature' ? k.other.privateKey : k.good.privateKey);
  }

  function chooserPage(url) {
    const hidden = [...url.searchParams].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Choose an account (pretend Google)</title></head>
<body><main><h1>Choose an account</h1>
<p>This is the pretend Google sign-in for trying the site on a laptop. Type any made-up address: nothing is sent anywhere.</p>
<form method="get" action="/fake-google/continue">${hidden}
<p><label>Email <input name="email" type="email" required autocomplete="off"></label></p>
<p><label>Name <input name="name" type="text" autocomplete="off"></label></p>
<p><button type="submit">Continue</button></p></form></main></body></html>`;
  }

  async function handle(req, res, url) {
    const p = url.pathname;
    try {
      if (req.method === 'GET' && p === '/fake-google/.well-known/openid-configuration') {
        return sendJson(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/certs`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (req.method === 'GET' && p === '/fake-google/certs') return sendJson(res, 200, { keys: [(await keys).jwk] });
      if (req.method === 'GET' && p === '/fake-google/authorize') {
        if (url.searchParams.get('client_id') !== config.google.clientId) throw new HttpError(400, 'Unknown client.');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
        return res.end(chooserPage(url));
      }
      if (req.method === 'GET' && p === '/fake-google/continue') {
        const q = url.searchParams;
        const email = (q.get('email') ?? '').trim().toLowerCase();
        const fakeCase = q.get('case') ?? '';
        if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(400, 'Type an email address.');
        if (!CASES.has(fakeCase)) throw new HttpError(400, 'Unknown case.');
        if (q.get('client_id') !== config.google.clientId || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) throw new HttpError(400, 'Not a sign-in the fake Google can answer.');
        const code = b64url(crypto.randomBytes(24));
        codes.set(code, { email, name: (q.get('name') ?? '').trim(), case: fakeCase, nonce: q.get('nonce') ?? '', clientId: q.get('client_id'), redirectUri: q.get('redirect_uri'), challenge: q.get('code_challenge'), at: now() });
        const back = new URL(q.get('redirect_uri'));
        back.searchParams.set('code', code);
        back.searchParams.set('state', q.get('state') ?? '');
        res.writeHead(302, { Location: back.toString(), 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method === 'POST' && p === '/fake-google/token') {
        const f = await readForm(req);
        const c = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const bad = (why) => sendJson(res, 400, { error: 'invalid_grant', error_description: why });
        if (!c || now() - c.at > 5 * 60 * 1000) return bad('unknown or used code');
        if (f.get('client_id') !== config.google.clientId || f.get('client_secret') !== config.google.clientSecret) return bad('wrong client');
        if (f.get('redirect_uri') !== c.redirectUri || f.get('grant_type') !== 'authorization_code') return bad('wrong redirect');
        if (pkceChallenge(f.get('code_verifier') ?? '') !== c.challenge) return bad('wrong PKCE verifier');
        return sendJson(res, 200, { access_token: b64url(crypto.randomBytes(16)), token_type: 'Bearer', expires_in: 3600, scope: 'openid email profile', id_token: await idToken(c) });
      }
      return send(res, 404, 'Not found');
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, err.message);
      throw err;
    }
  }

  return { owns: (p) => p.startsWith('/fake-google/'), handle };
}
