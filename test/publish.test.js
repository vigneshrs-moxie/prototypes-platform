// The publish API and tokens, against reference/publish.md's contract. A real database is used:
// PGlite, or Postgres with TEST_DATABASE_URL.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultipart } from '../site/multipart.js';
import { LIMITS } from '../site/routes-publish.js';
import { ADA, makeToken, MANIFEST, multipart, onSite, person, publish, publishFields, SAM, SITE, withFeature, withToken } from './helpers.js';

const revisions = (s) => s.db.query(`SELECT d.type, r.n, r.page_blob, r.pdf_blob, r.body, r.changes, r.page_version FROM revisions r JOIN documents d ON d.id = r.document_id ORDER BY r.n, d.type`);

test('the first publish makes the feature at revision 1; the next is revision 2', onSite(async (s) => {
  const ada = await person(s, ADA, 'Ada Admin');
  const token = await makeToken(ada);
  const one = await publish(s, token);
  assert.equal(one.status, 200);
  assert.deepEqual(one.body, { key: 'orbit-296-freeze-header', revision: 1, url: `${SITE}/f/orbit-296-freeze-header`, created: true });
  const two = await publish(s, token, publishFields({ title: 'Freeze the header', changes: 'Tighter rows', page_version: '2' }));
  assert.deepEqual(two.body, { key: 'orbit-296-freeze-header', revision: 2, url: `${SITE}/f/orbit-296-freeze-header`, created: false });
  const f = (await s.db.query('SELECT title FROM features')).rows;
  assert.deepEqual(f, [{ title: 'Freeze the header' }], 'one feature, with the newest title');
  const page = await ada.page('/f/orbit-296-freeze-header');
  assert.match(page.text, /Revision 2 \(latest\)/);
  assert.match(page.text, /Tighter rows/);
  assert.equal((await ada.get('/f/orbit-296-freeze-header?r=1')).status, 200);
  assert.equal((await ada.get('/f/orbit-296-freeze-header?r=9')).status, 404);
}));

test('the page and PDF go to private storage, the markdown to the revision, all under one number', onSite(async (s) => {
  const { token } = await withFeature(s);
  const r = await publish(s, token, publishFields({
    page_version: '7', changes: 'Second go',
    pdf: { filename: 'pack.pdf', type: 'application/pdf', data: '%PDF-made-up' },
    requirements: '# Requirements\n\nFR-001', decisions: '| who | why |',
    ticket_key: 'ORBIT-296', ticket_url: 'https://orbit.example.test/t/296', job_slug: 'orbit-296-job',
  }));
  assert.equal(r.status, 200);
  const rows = (await revisions(s)).rows.filter((x) => x.n === 2);
  assert.deepEqual(rows.map((x) => x.type), ['decisions', 'prototype', 'requirements']);
  const proto = rows.find((x) => x.type === 'prototype');
  assert.equal(proto.page_version, 7);
  assert.equal(proto.changes, 'Second go');
  assert.equal((await s.blob.read(proto.page_blob)).contentType, 'text/html; charset=utf-8');
  assert.equal((await s.blob.read(proto.pdf_blob)).bytes.toString(), '%PDF-made-up');
  assert.equal(rows.find((x) => x.type === 'requirements').body, '# Requirements\n\nFR-001');
  const f = (await s.db.query('SELECT ticket_key, ticket_url, job_slug FROM features')).rows[0];
  assert.deepEqual({ ...f }, { ticket_key: 'ORBIT-296', ticket_url: 'https://orbit.example.test/t/296', job_slug: 'orbit-296-job' });
}));

test('a later publish without a ticket keeps the one already there', onSite(async (s) => {
  const { token } = await withFeature(s, publishFields({ ticket_key: 'ORBIT-296' }));
  await publish(s, token);
  assert.equal((await s.db.query('SELECT ticket_key FROM features')).rows[0].ticket_key, 'ORBIT-296');
}));

test('two publishes at once get different numbers', onSite(async (s) => {
  const { token } = await withFeature(s);
  const both = await Promise.all([publish(s, token), publish(s, token), publish(s, token)]);
  assert.deepEqual(both.map((b) => b.status), [200, 200, 200]);
  assert.deepEqual(both.map((b) => b.body.revision).sort(), [2, 3, 4]);
}));

for (const [what, over, status, words] of [
  ['a key with capitals', { key: 'Orbit-296' }, 400, /key/],
  ['a key with a slash', { key: 'a/../b' }, 400, /key/],
  ['no title', { title: undefined }, 400, /title/],
  ['no page', { page: undefined }, 400, /page/],
  ['an empty page', { page: { filename: 'page.html', type: 'text/html', data: '' } }, 400, /page/],
  ['a page_version that isn’t a number', { page_version: 'four' }, 400, /page_version/],
  ['no manifest', { manifest: undefined }, 400, /manifest/],
  ['a broken manifest', { manifest: '{nope' }, 400, /JSON/],
  ['a manifest with no lists', { manifest: '{"screens":1}' }, 400, /list/],
  ['a ticket link that could run script', { ticket_url: 'javascript:alert(1)' }, 400, /ticket_url/],
  ['a page over its limit', { page: { filename: 'page.html', type: 'text/html', data: Buffer.alloc(LIMITS.page + 1) } }, 413, /page is too big/],
  ['a PDF over its limit', { pdf: { filename: 'pack.pdf', type: 'application/pdf', data: Buffer.alloc(LIMITS.pdf + 1) } }, 413, /pdf is too big/],
  ['requirements over their limit', { requirements: 'x'.repeat(LIMITS.markdown + 1) }, 413, /requirements is too big/],
]) {
  test(`refused, with nothing stored: ${what}`, onSite(async (s) => {
    const ada = await person(s, ADA);
    const token = await makeToken(ada);
    const r = await publish(s, token, publishFields(over));
    assert.equal(r.status, status, JSON.stringify(r.body));
    assert.match(r.body.error, words);
    assert.equal((await s.db.query('SELECT count(*)::int AS n FROM features')).rows[0].n, 0);
    assert.equal(s.blob.files.size, 0);
  }));
}

test('a publish that fails after storing its files takes them back', onSite(async (s) => {
  const { token } = await withFeature(s);
  await s.db.query("UPDATE features SET archived_at = now()");
  const before = s.blob.files.size;
  const r = await publish(s, token);
  assert.equal(r.status, 409);
  assert.match(r.body.error, /archived/);
  assert.equal(s.blob.files.size, before);
}));

test('a token is shown once and kept only as a hash', onSite(async (s) => {
  const ada = await person(s, ADA);
  const token = await makeToken(ada);
  assert.match(token, /^ptp_[\w-]{43}$/);
  const row = (await s.db.query('SELECT token_hash FROM publish_tokens')).rows[0];
  assert.notEqual(row.token_hash, token);
  assert.doesNotMatch((await ada.page('/settings')).text, new RegExp(token));
}));

test('no token, a wrong one, and a revoked one are refused; last_used_at moves', onSite(async (s) => {
  const ada = await person(s, ADA);
  const token = await makeToken(ada);
  const { body, type } = multipart(publishFields());
  assert.equal((await s.fetch(`${SITE}/api/publish`, { method: 'POST', headers: { 'content-type': type }, body })).status, 401);
  assert.equal((await publish(s, 'ptp_notarealtokennotarealtokennotarealtoken')).status, 401);
  assert.equal((await s.db.query('SELECT last_used_at FROM publish_tokens')).rows[0].last_used_at, null);
  assert.equal((await publish(s, token)).status, 200);
  assert.ok((await s.db.query('SELECT last_used_at FROM publish_tokens')).rows[0].last_used_at);
  const id = (await s.db.query('SELECT id FROM publish_tokens')).rows[0].id;
  assert.equal((await ada.post(`/settings/tokens/${id}`, { _method: 'DELETE' })).status, 302);
  assert.equal((await publish(s, token)).status, 401);
  assert.match((await ada.page('/settings')).text, /Revoked/);
}));

test('a token stops working when its owner stops being an admin', onSite(async (s) => {
  const ada = await person(s, ADA);
  const token = await makeToken(ada);
  s.env.ADMIN_EMAILS = 'someone.else@example.test';
  const r = await publish(s, token);
  assert.equal(r.status, 403);
  assert.match(r.body.error, /isn’t an admin/);
}));

test('one admin can’t revoke another’s token; a non-admin can’t make one', onSite(async (s) => {
  const ada = await person(s, ADA);
  const bea = await person(s, 'bea.boss@example.test');
  const token = await makeToken(ada);
  const id = (await s.db.query('SELECT id FROM publish_tokens')).rows[0].id;
  await bea.post(`/settings/tokens/${id}`, { _method: 'DELETE' });
  assert.equal((await publish(s, token)).status, 200);
  const sam = await person(s, SAM);
  assert.equal((await sam.post('/settings/tokens', { label: 'mine' })).status, 403);
}));

test('a token opens no browser page, and a session opens no token route', onSite(async (s) => {
  const { ada, token, key } = await withFeature(s);
  for (const path of ['/', `/f/${key}`, '/settings', '/people']) {
    assert.equal((await withToken(s, token, path)).res.status, 302, path);
  }
  assert.equal((await ada.get('/api/features')).status, 401);
  assert.equal((await ada.get(`/api/features/${key}/notes`)).status, 401);
}));

test('sixty publishes an hour per token, then a plain refusal; the next hour is fine', onSite(async (s) => {
  const { token } = await withFeature(s);
  await s.db.query(`INSERT INTO revisions (document_id, n, token_id, published_at)
    SELECT d.id, g, t.id, $1 FROM documents d, publish_tokens t, generate_series(100, 158) g`, [new Date(s.clock.t).toISOString()]);
  const r = await publish(s, token);
  assert.equal(r.status, 429);
  assert.match(r.body.error, /60 publishes/);
  s.clock.t += 61 * 60 * 1000;
  assert.equal((await publish(s, token)).status, 200);
}));

test('GET /api/features lists what the weekly skill needs', onSite(async (s) => {
  const { token } = await withFeature(s, publishFields({ job_slug: 'orbit-296-job', ticket_key: 'ORBIT-296' }));
  const r = await withToken(s, token, '/api/features');
  assert.equal(r.status, 200);
  const [f] = r.body.features;
  assert.deepEqual({ key: f.key, job_slug: f.job_slug, ticket_key: f.ticket_key, latest_revision: f.latest_revision, note_count: f.note_count, last_note_at: f.last_note_at, archived: f.archived },
    { key: 'orbit-296-freeze-header', job_slug: 'orbit-296-job', ticket_key: 'ORBIT-296', latest_revision: 1, note_count: 0, last_note_at: null, archived: false });
}));

const importBody = (notes, choices = []) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes, choices }) });
const aNote = (over = {}) => ({ screen: 's-team', device: 'laptop', kind: 'question', text: 'Who sees this?', pin: null, at: '2026-11-01T10:00:00.000Z', by_label: 'Made Up Person', ...over });

test('import keeps its times and names, attaches to the latest revision, and reads back in the contract’s shape', onSite(async (s) => {
  const { token, key } = await withFeature(s);
  await publish(s, token);
  const pin = { label: 'Collection', px: { x: 442, y: 272, s: 1 } };
  const put = await withToken(s, token, `/api/features/${key}/notes`, importBody(
    [aNote(), aNote({ text: 'Row is tight', kind: 'change', screen: 's-needs', pin })],
    [{ group: 'c-nav', choice: 'A', at: null, by_label: 'Someone on the artifact' }],
  ));
  assert.equal(put.status, 200);
  assert.deepEqual(put.body, { notes: 2, choices: 1 });
  const got = await withToken(s, token, `/api/features/${key}/notes`);
  assert.deepEqual(got.body.feature, { key, title: 'Freeze header', ticket_key: null, ticket_url: null, latest_revision: 2 });
  const [first, second] = got.body.notes;
  assert.equal(first.revision, 2);
  assert.equal(first.at, '2026-11-01T10:00:00.000Z');
  assert.deepEqual(first.by, { name: 'Made Up Person', email: null });
  assert.equal(first.deleted, false);
  assert.deepEqual(second.pin, pin);
  assert.deepEqual(got.body.choices.map((c) => [c.group, c.choice, c.by.name, c.by.email]), [['c-nav', 'A', 'Someone on the artifact', null]]);
}));

test('since: strictly after, compared at milliseconds, so the last note doesn’t come back', onSite(async (s) => {
  const { token, key } = await withFeature(s);
  await withToken(s, token, `/api/features/${key}/notes`, importBody([aNote()]));
  // Postgres keeps microseconds: this note is 0.4 ms past the time the answer writes.
  await s.db.query("UPDATE notes SET updated_at = '2026-11-01T10:00:00.000400Z'");
  const url = `/api/features/${key}/notes?since=${encodeURIComponent('2026-11-01T10:00:00.000Z')}`;
  assert.deepEqual((await withToken(s, token, url)).body.notes, []);
  const earlier = `/api/features/${key}/notes?since=${encodeURIComponent('2026-11-01T09:59:59.999Z')}`;
  assert.equal((await withToken(s, token, earlier)).body.notes.length, 1);
  assert.equal((await withToken(s, token, `/api/features/${key}/notes?since=yesterday`)).status, 400);
}));

test('a deleted note still comes down, marked deleted, so a pull can drop it', onSite(async (s) => {
  const { token, key } = await withFeature(s);
  await withToken(s, token, `/api/features/${key}/notes`, importBody([aNote()]));
  await s.db.query("UPDATE notes SET deleted_at = '2026-11-02T00:00:00Z', updated_at = '2026-11-02T00:00:00Z'");
  const got = await withToken(s, token, `/api/features/${key}/notes?since=2026-11-01T12:00:00Z`);
  assert.equal(got.body.notes[0].deleted, true);
}));

test('import is all or nothing, and checks every row', onSite(async (s) => {
  const { token, key } = await withFeature(s);
  for (const [bad, words] of [
    [aNote({ kind: 'rant' }), /kind/], [aNote({ text: '' }), /text/], [aNote({ text: 'x'.repeat(2001) }), /text/],
    [aNote({ at: 'soon' }), /time/], [aNote({ by_label: undefined }), /by_label/], [aNote({ screen: '' }), /screen/],
  ]) {
    const r = await withToken(s, token, `/api/features/${key}/notes`, importBody([aNote(), bad]));
    assert.equal(r.status, 400);
    assert.match(r.body.error, words);
  }
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM notes')).rows[0].n, 0);
}));

test('an unknown key is a 404 on the notes API', onSite(async (s) => {
  const { token } = await withFeature(s);
  assert.equal((await withToken(s, token, '/api/features/orbit-999-none/notes')).status, 404);
}));

test('the multipart parser: binary survives, and malformed bodies are refused in words', () => {
  const bytes = Buffer.from([0, 13, 10, 45, 45, 255, 13, 10]);
  const { body, type } = multipart({ a: 'one', page: { filename: 'x.bin', type: 'application/octet-stream', data: bytes } });
  const parts = parseMultipart(body, type);
  assert.equal(parts.get('a').data.toString(), 'one');
  assert.equal(parts.get('a').filename, null);
  assert.deepEqual(parts.get('page').data, bytes);
  assert.equal(parts.get('page').filename, 'x.bin');
  assert.throws(() => parseMultipart(Buffer.from('nope'), type), /doesn’t start/);
  assert.throws(() => parseMultipart(body.subarray(0, body.length - 20), type), /stops before/);
  assert.throws(() => parseMultipart(body, 'text/plain'), /multipart/);
  const twice = Buffer.concat([body.subarray(0, body.lastIndexOf('--', body.length - 5)), multipart({}).body]);
  assert.throws(() => parseMultipart(twice, type));
  const b = 'BB';
  const dup = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--${b}\r\nContent-Disposition: form-data; name="a"\r\n\r\n2\r\n--${b}--\r\n`);
  assert.throws(() => parseMultipart(dup, `multipart/form-data; boundary=${b}`), /two parts/);
});

test('the manifest is stored as sent', onSite(async (s) => {
  const manifest = { ...MANIFEST, history: [{ rev: 1, note: 'First look', changed: [{ id: 'a', device: 'phone', name: 'Team', path: [] }], added: [], removed: [] }] };
  const { ada, key } = await withFeature(s, publishFields({ manifest: JSON.stringify(manifest) }));
  const stored = (await s.db.query('SELECT manifest FROM revisions')).rows[0].manifest;
  assert.deepEqual(stored, manifest);
  const page = await ada.page(`/f/${key}`);
  assert.match(page.text, /First look/);
  assert.match(page.text, /Changed/);
}));
