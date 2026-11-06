// Google sign-in (through the fake issuer), every refusal, sessions and sign-out. Made-up people only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, readConfig } from '../site/config.js';
import { ADA, browser, onSite, person, signIn, SITE, STU, TEST_ENV } from './helpers.js';

const DAY = 24 * 60 * 60 * 1000;

test('the start: PKCE (S256), a state, a nonce, hd as a hint, and the redirect path /auth/callback', onSite(async (s) => {
  const r = await browser(s.fetch).get('/auth/google');
  const u = new URL(r.headers.get('location'));
  assert.equal(u.searchParams.get('redirect_uri'), `${SITE}/auth/callback`);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.match(u.searchParams.get('code_challenge'), /^[\w-]{43}$/);
  assert.ok(u.searchParams.get('state').length >= 40 && u.searchParams.get('nonce').length >= 40);
  assert.equal(u.searchParams.get('hd'), 'example.test');
  const row = (await s.db.query('SELECT state_hash FROM sign_ins')).rows[0];
  assert.notEqual(row.state_hash, u.searchParams.get('state'), 'the state is kept only as its hash');
}));

test('a session cookie is pt_session, HttpOnly, Secure, SameSite=Lax, 30 days; only its hash is stored', onSite(async (s) => {
  const b = browser(s.fetch);
  const start = await b.get('/auth/google');
  const g = new URL(start.headers.get('location'));
  const cont = new URL(`${SITE}/fake-google/continue`);
  for (const [k, v] of g.searchParams) cont.searchParams.set(k, v);
  cont.searchParams.set('email', STU);
  const cb = await b.get((await b.get(cont.toString())).headers.get('location'));
  const sc = cb.headers.getSetCookie().find((x) => x.startsWith('pt_session='));
  assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/); assert.match(sc, /SameSite=Lax/); assert.match(sc, /Path=\//); assert.match(sc, /Max-Age=2592000/);
  const id = decodeURIComponent(sc.split(';')[0].split('=')[1]).split('.')[0];
  const stored = (await s.db.query('SELECT id_hash FROM sessions')).rows.map((r) => r.id_hash);
  assert.equal(stored.length, 1);
  assert.ok(!stored.includes(id));
}));

for (const [what, args, problem] of [
  ['an account from another domain', { email: 'pat.outside@elsewhere.test' }, 'domain'],
  ['email_verified false', { email: 'una.unverified@example.test', fakeCase: 'unverified' }, 'domain'],
  ['a personal account (no hd claim)', { email: 'nora.nohd@example.test', fakeCase: 'no-hd' }, 'domain'],
  ['a bad signature', { email: 'bea.badsig@example.test', fakeCase: 'bad-signature' }, 'bad-token'],
  ['an expired token', { email: 'eve.expired@example.test', fakeCase: 'expired' }, 'expired'],
  ['a wrong nonce', { email: 'nell.nonce@example.test', fakeCase: 'wrong-nonce' }, 'bad-token'],
]) {
  test(`refused, with no session: ${what}`, onSite(async (s) => {
    const b = browser(s.fetch);
    const r = await signIn(b, args);
    assert.equal(r.location, `/sign-in?problem=${problem}`);
    assert.equal(b.jar.get('pt_session'), undefined);
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM people')).rows[0].n, 0, 'nobody is recorded');
    const page = await b.page(r.location);
    assert.equal(page.status, 200);
    assert.match(page.text, /class="notice"/, 'the page says why');
  }));
}

test('a replayed state is refused, and so is a callback in another browser', onSite(async (s) => {
  const b = browser(s.fetch);
  const r = await signIn(b, { email: STU });
  assert.equal(r.location, '/');
  assert.equal((await b.get(r.callback)).headers.get('location'), '/sign-in?problem=state');
  assert.equal((await browser(s.fetch).get(r.callback)).headers.get('location'), '/sign-in?problem=state');
}));

test('a sign-in left more than ten minutes is refused', onSite(async (s) => {
  const b = browser(s.fetch);
  const g = new URL((await b.get('/auth/google')).headers.get('location'));
  const cont = new URL(`${SITE}/fake-google/continue`);
  for (const [k, v] of g.searchParams) cont.searchParams.set(k, v);
  cont.searchParams.set('email', STU);
  const callback = (await b.get(cont.toString())).headers.get('location');
  s.clock.t += 11 * 60 * 1000;
  assert.equal((await b.get(callback)).headers.get('location'), '/sign-in?problem=state');
}));

test('where a sign-in lands: this site’s own pages only', onSite(async (s) => {
  assert.equal((await signIn(browser(s.fetch), { email: 'a.one@example.test', returnTo: '/f/orbit-1-x' })).location, '/f/orbit-1-x');
  assert.equal((await signIn(browser(s.fetch), { email: 'b.two@example.test', returnTo: 'https://elsewhere.test/' })).location, '/');
  assert.equal((await signIn(browser(s.fetch), { email: 'c.three@example.test', returnTo: '//elsewhere.test' })).location, '/');
  assert.equal((await signIn(browser(s.fetch), { email: 'd.four@example.test', returnTo: '/\\elsewhere.test' })).location, '/');
}));

test('a page sends a stranger to sign in and back; /api answers 401 in JSON', onSite(async (s) => {
  const b = browser(s.fetch);
  const r = await b.get('/f/orbit-1-x?r=2');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/sign-in?return=${encodeURIComponent('/f/orbit-1-x?r=2')}`);
  const page = await b.page(r.headers.get('location'));
  assert.match(page.text, /href="\/auth\/google\?return=%2Ff%2Forbit-1-x%3Fr%3D2"/);
  const api = await b.get('/api/features');
  assert.equal(api.status, 401);
  assert.match((await api.json()).error, /token/);
}));

test('sessions slide: used, they last 30 more days; unused for 30 days, they end', onSite(async (s) => {
  const b = await person(s, STU);
  s.clock.t += 20 * DAY;
  const r = await b.get('/');
  assert.equal(r.status, 200);
  assert.ok(r.headers.getSetCookie().some((c) => c.startsWith('pt_session=') && /Max-Age=2592000/.test(c)), 'the cookie is renewed');
  s.clock.t += 29 * DAY;
  assert.equal((await b.get('/')).status, 200);
  s.clock.t += 31 * DAY;
  assert.equal((await b.get('/')).status, 302);
}));

test('a made-up or altered cookie is refused', onSite(async (s) => {
  const b = await person(s, STU);
  const [id, sig] = b.jar.get('pt_session').split('.');
  b.jar.set('pt_session', `${id}x.${sig}`);
  assert.equal((await b.get('/')).status, 302);
  b.jar.set('pt_session', 'nonsense');
  assert.equal((await b.get('/')).status, 302);
}));

test('sign-out ends this browser’s session; others stay in', onSite(async (s) => {
  const one = await person(s, STU);
  const two = await person(s, STU);
  const out = await one.post('/auth/sign-out');
  assert.equal(out.status, 302);
  assert.equal(out.headers.get('location'), '/sign-in?problem=signed-out');
  assert.equal(one.jar.get('pt_session'), undefined);
  assert.equal((await two.get('/')).status, 200);
}));

test('an admin can sign someone out everywhere; a non-admin can’t', onSite(async (s) => {
  const ada = await person(s, ADA);
  const stu = await person(s, STU);
  const id = (await s.db.query('SELECT id FROM people WHERE email = $1', [STU])).rows[0].id;
  assert.equal((await stu.post(`/people/${id}/revoke`)).status, 403);
  assert.equal((await ada.post(`/people/${id}/revoke`)).status, 302);
  assert.equal((await stu.get('/')).status, 302);
}));

test('AUTH_FAKE is refused in a production build', () => {
  assert.throws(() => readConfig({ ...TEST_ENV, VERCEL: '1' }), ConfigError);
  assert.throws(() => readConfig({ ...TEST_ENV, NODE_ENV: 'production' }), ConfigError);
});

test('without AUTH_FAKE there is no fake Google, and a test never reaches the real one', onSite(async (s) => {
  const b = browser(s.fetch);
  assert.equal((await b.get('/fake-google/.well-known/openid-configuration')).status, 404);
  assert.equal((await b.get('/auth/google')).headers.get('location'), '/sign-in?problem=google');
}, { env: { AUTH_FAKE: '', GOOGLE_CLIENT_ID: 'a-client', GOOGLE_CLIENT_SECRET: 'a-secret' } }));
