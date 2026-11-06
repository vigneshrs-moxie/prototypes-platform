// The pages: what each person sees, requests and shares, the rules for changes, the strict headers
// on every answer, and what the logs may carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { migrate } from '../site/migrate.js';
import { ADA, browser, makeSite, makeToken, onSite, person, publish, publishFields, SAM, SITE, STU, withFeature, withToken } from './helpers.js';

test('the home differs: all for an admin, shared for a person, nothing for a stranger', onSite(async (s) => {
  const { ada, key, token } = await withFeature(s);
  await publish(s, token, publishFields({ key: 'orbit-300-other', title: 'Other thing' }));
  await ada.post(`/f/${key}/shares`, { email: SAM });
  const sam = await person(s, SAM);
  const stu = await person(s, STU);
  const a = (await ada.page('/')).text;
  assert.match(a, /All features/); assert.match(a, /Freeze header/); assert.match(a, /Other thing/);
  const b = (await sam.page('/')).text;
  assert.match(b, /Shared with you/); assert.match(b, /Freeze header/); assert.doesNotMatch(b, /Other thing/);
  const c = (await stu.page('/')).text;
  assert.match(c, /Nothing is shared with you yet/); assert.doesNotMatch(c, /Freeze header/);
}));

test('an admin’s nav has People and Settings; a person’s doesn’t', onSite(async (s) => {
  const ada = await person(s, ADA);
  const sam = await person(s, SAM);
  assert.match((await ada.page('/')).text, /href="\/settings"/);
  assert.doesNotMatch((await sam.page('/')).text, /href="\/settings"/);
}));

test('request access: asked once, shown to the admin, resolved by adding them', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const stu = await person(s, STU, 'Stu Stranger');
  const first = await stu.page(`/f/${key}`);
  assert.equal(first.status, 403);
  assert.match(first.text, /Request access/);
  const asked = await stu.post(`/f/${key}/request-access`);
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /Asked\. An admin will add you\./);
  assert.match((await stu.page(`/f/${key}`)).text, /Asked\. An admin will add you\./, 'it stays asked on the next visit');
  await stu.post(`/f/${key}/request-access`);
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM access_requests')).rows[0].n, 1, 'one open request, however many presses');
  const home = (await ada.page('/')).text;
  assert.match(home, /Access requests/);
  assert.match(home, /Stu Stranger/);
  await ada.post(`/f/${key}/shares`, { email: STU });
  assert.doesNotMatch((await ada.page('/')).text, /Access requests/);
  assert.equal((await stu.get(`/f/${key}`)).status, 200);
}));

test('a request can be dismissed, and asked again later', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const stu = await person(s, STU);
  await stu.post(`/f/${key}/request-access`);
  const id = (await s.db.query('SELECT id FROM access_requests')).rows[0].id;
  assert.equal((await stu.post(`/f/${key}/requests/${id}`, { _method: 'DELETE' })).status, 403);
  assert.equal((await ada.post(`/f/${key}/requests/${id}`, { _method: 'DELETE' })).status, 302);
  assert.doesNotMatch((await ada.page('/')).text, /Access requests/);
  assert.equal((await stu.get(`/f/${key}`)).status, 403);
  await stu.post(`/f/${key}/request-access`);
  assert.match((await ada.page('/')).text, /Access requests/);
}));

test('someone who can already see a feature doesn’t ask', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const r = await ada.post(`/f/${key}/request-access`);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/f/${key}`);
}));

test('shares: lower-cased, Moxie addresses only, and the page gives the link to send', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  await ada.post(`/f/${key}/shares`, { email: '  Sam.Shared@EXAMPLE.test ' });
  await ada.post(`/f/${key}/shares`, { email: SAM });
  assert.deepEqual((await s.db.query('SELECT email FROM shares')).rows, [{ email: SAM }]);
  const page = await ada.page(`/f/${key}/shares`);
  assert.match(page.text, new RegExp(`${SITE}/f/${key}`));
  const outside = await ada.post(`/f/${key}/shares`, { email: 'pat@elsewhere.test' });
  assert.equal(outside.status, 400);
  assert.match(await outside.text(), /Only example\.test accounts/);
  assert.equal((await ada.post(`/f/${key}/shares`, { email: 'not an address' })).status, 400);
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM shares')).rows[0].n, 1);
}));

test('an admin gets a 404 for a feature that isn’t there', onSite(async (s) => {
  const ada = await person(s, ADA);
  assert.equal((await ada.get('/f/orbit-999-none')).status, 404);
  assert.equal((await ada.get('/f/orbit-999-none/shares')).status, 404);
  assert.equal((await ada.get('/nowhere')).status, 404);
}));

test('the ticket: a real link when the job gave one, plain words otherwise', onSite(async (s) => {
  const { ada, key, token } = await withFeature(s, publishFields({ ticket_key: 'ORBIT-296' }));
  const plain = (await ada.page(`/f/${key}`)).text;
  assert.match(plain, /ORBIT-296/);
  assert.doesNotMatch(plain, /<a href="[^"]*"[^>]*>ORBIT-296/);
  await publish(s, token, publishFields({ ticket_url: 'https://orbit.example.test/t/296' }));
  assert.match((await ada.page(`/f/${key}`)).text, /<a href="https:\/\/orbit\.example\.test\/t\/296" rel="noopener noreferrer">ORBIT-296<\/a>/);
}));

test('what a publish says is text on every page, never markup', onSite(async (s) => {
  const evil = '<script>alert(1)</script>"\'><img src=x onerror=alert(1)>';
  const { ada, key } = await withFeature(s, publishFields({ title: evil, changes: evil, ticket_key: 'X<b>' }));
  for (const path of ['/', `/f/${key}`, `/f/${key}/shares`]) {
    const { text } = await ada.page(path);
    assert.doesNotMatch(text, /<script>alert/, path);
    assert.doesNotMatch(text, /<img src=x/, path);
    assert.match(text, /&lt;script&gt;alert/, path);
  }
}));

test('strict headers on every answer: pages, errors, redirects, sign-in and the API', onSite(async (s) => {
  const { ada, key, token } = await withFeature(s);
  const stu = await person(s, STU);
  const answers = [
    await ada.get('/'), await ada.get(`/f/${key}`), await ada.get(`/f/${key}/shares`), await ada.get('/settings'), await ada.get('/people'),
    await ada.get(`/f/${key}/requirements`), await ada.get('/nowhere'), await stu.get(`/f/${key}`), await stu.get('/settings'),
    await browser(s.fetch).get('/'), await browser(s.fetch).get('/sign-in'), await browser(s.fetch).get('/healthz'),
    (await withToken(s, token, '/api/features')).res, await ada.post(`/f/${key}/shares`, { email: SAM }),
  ];
  for (const r of answers) {
    const csp = r.headers.get('content-security-policy');
    assert.match(csp ?? '', /script-src 'self'/);
    assert.match(csp, /frame-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.doesNotMatch(csp, /unsafe/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('referrer-policy'), 'same-origin');
    assert.equal(r.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.match(r.headers.get('strict-transport-security'), /max-age=/);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
}));

test('no page has an inline script or style, which the strict policy would block', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  for (const path of ['/', `/f/${key}`, `/f/${key}/shares`, '/settings', '/people', '/nowhere']) {
    const { text } = await ada.page(path);
    assert.doesNotMatch(text, /<script(?![^>]*\bsrc=)|<style|\sstyle="|\son[a-z]+="/, path);
  }
}));

test('a change needs the site’s own origin and the form’s token', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const token = await ada.formToken();
  const add = (headers, t = token) => ada.post(`/f/${key}/shares`, { email: SAM }, { headers, token: t });
  assert.equal((await add({ origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await add({ origin: 'null' })).status, 403, 'a sandboxed frame is refused');
  assert.equal((await add({ origin: '' })).status, 403);
  assert.equal((await add({}, 'not-the-token')).status, 403);
  const other = await person(s, 'bea.boss@example.test');
  assert.equal((await add({}, await other.formToken())).status, 403, 'another session’s token');
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM shares')).rows[0].n, 0);
  assert.equal((await add({})).status, 302);
}));

test('a JSON change needs X-Requested-With; any other kind of body is refused', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const post = (headers, body = '{"email":"x"}') => ada.get(`/f/${key}/shares`, { method: 'POST', headers: { origin: SITE, ...headers }, body });
  assert.equal((await post({ 'content-type': 'application/json' })).status, 403);
  assert.equal((await post({ 'content-type': 'application/json', 'x-requested-with': 'prototypes' })).status, 400);
  assert.equal((await post({ 'content-type': 'text/plain' })).status, 415);
}));

test('a signed-out change goes to sign in and changes nothing', onSite(async (s) => {
  const { key } = await withFeature(s);
  const r = await browser(s.fetch).get(`/f/${key}/shares`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, body: `email=${SAM}` });
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/sign-in/);
}));

test('healthz: open to anyone, with the migration number', onSite(async (s) => {
  const r = await browser(s.fetch).get('/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, migration: '006-page-state' });
}));

test('with a setting missing, every page says which, and healthz still answers', onSite(async (s) => {
  const b = browser(s.fetch);
  const r = await b.page('/');
  assert.equal(r.status, 503);
  assert.match(r.text, /ADMIN_EMAILS/);
  assert.equal((await b.get('/healthz')).status, 200);
}, { env: { ADMIN_EMAILS: '' } }));

test('migrations run clean twice: the second applies nothing', onSite(async (s) => {
  const again = await migrate(s.db);
  assert.deepEqual(again.applied, []);
  assert.equal(again.already, 6);
}));

test('there is no role column, and no table the plan doesn’t name', onSite(async (s) => {
  const cols = (await s.db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'people' AND table_schema = current_schema()")).rows.map((r) => r.column_name);
  assert.ok(!cols.includes('role'));
  const tables = (await s.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1")).rows.map((r) => r.table_name);
  assert.deepEqual(tables, ['access_requests', 'choices', 'documents', 'features', 'notes', 'people', 'publish_tokens', 'revisions', 'schema_migrations', 'sessions', 'shares', 'sign_ins', 'views']);
}));

test('logs carry route, status, person and key: no tokens, note text or emails', async () => {
  const s = await makeSite();
  try {
    const { ada, key, token } = await withFeature(s);
    await ada.post(`/f/${key}/shares`, { email: SAM });
    await withToken(s, token, `/api/features/${key}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: [{ screen: 's-a', kind: 'idea', text: 'a private thought', at: '2026-11-01T00:00:00Z', by_label: 'Made Up' }] }) });
    const all = JSON.stringify(s.logs);
    assert.ok(s.logs.length > 3);
    assert.ok(s.logs.some((l) => l.key === key && l.person && l.status === 200));
    for (const secret of [token, 'a private thought', ADA, SAM, 'pt_session']) assert.ok(!all.includes(secret), secret);
  } finally { await s.close(); }
});

test('a fresh token reads back only through the settings answer', onSite(async (s) => {
  const ada = await person(s, ADA);
  const token = await makeToken(ada, 'Second');
  assert.equal((await publish(s, token)).status, 200);
}));

test('every page points at the logo, and the files are there', onSite(async (s) => {
  const { text } = await (await person(s, SAM)).page('/');
  assert.match(text, /<link rel="icon" href="\/favicon\.ico"/);
  assert.match(text, /<link rel="icon" href="\/icon\.png"/);
  const bytes = (name) => fs.readFileSync(new URL(`../public/${name}`, import.meta.url));
  assert.deepEqual([...bytes('favicon.ico').subarray(0, 4)], [0, 0, 1, 0], 'an icon file');
  assert.equal(bytes('icon.png').subarray(1, 4).toString(), 'PNG');
}));
