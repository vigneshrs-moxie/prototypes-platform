// Notes, pins and picks from the page: the validator, who may do what, and what the laptop then reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkChoice, checkNote, checkPin, checkView, wireNote } from '../site/routes-notes.js';
import { ADA, onSite, person, publish, publishFields, SAM, SITE, STU, withFeature, withToken } from './helpers.js';

const NOTE = { screen: 's-team', device: 'phone', kind: 'change', text: 'Row is too tight' };
const PIN = { x: 0.42, y: 0.18, s: 1, ox: 0.5, oy: 0.5, anchor: 's-team [data-id="theo"]', anchor_text: 'Theo Brandt', label: 'Theo Brandt' };

/** A write as the wrapper sends it. */
const send = (b, method, path, body = {}, headers = {}) => b.get(path, {
  method,
  headers: { 'content-type': 'application/json', origin: SITE, 'x-requested-with': 'prototypes', ...headers },
  body: JSON.stringify(body),
});
const json = async (r) => ({ status: r.status, body: await r.json() });

async function setUp(s, fields) {
  const { ada, key, token } = await withFeature(s, fields);
  await ada.post(`/f/${key}/shares`, { email: SAM });
  const sam = await person(s, SAM, 'Sam Shared');
  const api = `/api/features/${key}/state`;
  return { ada, sam, key, token, api };
}

test('the validator takes a good note and keeps only what it knows', () => {
  const n = checkNote({ ...NOTE, pin: { ...PIN, evil: 1 }, path: ['team', 'needs'], role: 'tech', options: { 'c-nav': 'A' }, by: { id: 1 }, at: '2001-01-01', id: 'x', by_label: 'Someone else' });
  assert.deepEqual(n, { screen: 's-team', device: 'phone', kind: 'change', text: 'Row is too tight', pin: PIN, place: { path: ['team', 'needs'], role: 'tech', options: { 'c-nav': 'A' } } });
});

for (const [name, change, why] of [
  ['an unknown kind', { kind: 'bug' }, /change, a question or an idea/],
  ['no screen', { screen: undefined }, /screen/],
  ['a screen with no s-', { screen: 'team' }, /screen/],
  ['a screen with markup', { screen: 's-<b>' }, /screen/],
  ['an unknown device', { device: 'tablet' }, /phone or a laptop/],
  ['no text', { text: '   ' }, /some text/],
  ['too much text', { text: 'x'.repeat(2001) }, /at most 2000/],
  ['a pin past the edge', { pin: { x: 1.2, y: 0 } }, /between 0 and 1/],
  ['a pin with a word for a place', { pin: { x: '0.5', y: 0 } }, /between 0 and 1/],
  ['an anchor too long', { pin: { x: 0, y: 0, anchor: 'a'.repeat(201) } }, /at most 200/],
  ['a place too long', { path: ['a'.repeat(2001)] }, /too long/],
]) test(`the validator refuses ${name}`, () => { assert.throws(() => checkNote({ ...NOTE, ...change }), why); });

test('text of exactly 2,000 characters and a pin on the edge are fine', () => {
  assert.equal(checkNote({ ...NOTE, text: 'x'.repeat(2000) }).text.length, 2000);
  assert.equal(checkPin({ x: 0, y: 1 }).y, 1);
});

test('picks and settings: checked, and an un-pick loses its reason', () => {
  assert.deepEqual(checkChoice({ key: 'c-nav', choice: '', why: 'old' }), { key: 'c-nav', choice: '', why: '' });
  assert.throws(() => checkChoice({ key: 'nav', choice: 'A' }), /question/);
  assert.deepEqual(checkView({ theme: 'dark', side: true, side2: 1, page: 5 }), { theme: 'dark', side: true });
  const place = { ids: ['team', 'needs'], tabs: { role: 'tech', 'c-nav': 'A' } };
  assert.deepEqual(checkView({ place: { ...place, evil: 1 } }), { place });
  for (const bad of [{ ids: 'team', tabs: {} }, { ids: ['team'] }, { ids: [5], tabs: {} }, { ids: ['team'], tabs: { role: 5 } }, { ids: Array(41).fill('a'), tabs: {} }, { ids: ['x'.repeat(81)], tabs: {} }]) {
    assert.deepEqual(checkView({ place: bad }), {}, JSON.stringify(bad).slice(0, 40));
  }
});

test('the state: me, the pdf link, and notes as the page reads them', onSite(async (s) => {
  const { sam, key, api } = await setUp(s, publishFields({ page_version: '7', pdf: { filename: 'pack.pdf', type: 'application/pdf', data: '%PDF' } }));
  const first = await json(await sam.get(`${api}?r=1`));
  assert.equal(first.status, 200);
  assert.equal(first.body.me.name, 'Sam Shared');
  assert.equal(first.body.me.admin, false);
  assert.equal(first.body.pdf, `/f/${key}/r1/pack.pdf`);
  assert.deepEqual(first.body.view, {});
  const { body } = await json(await send(sam, 'POST', `${api}/notes?r=1`, { ...NOTE, pin: PIN, path: ['team'], role: 'tech', id: 'n1' }));
  const n = body.notes[0];
  assert.equal(n.id, body.created);
  assert.equal(n.by.id, body.me.id, 'the page tells its reader’s own notes by this');
  assert.equal(n.by.name, 'Sam Shared');
  assert.equal(n.revision, 7, 'the page’s own number, which it compares with its own');
  assert.deepEqual(n.path, ['team']);
  assert.equal(n.role, 'tech');
  assert.equal(n.pin.anchor_text, 'Theo Brandt');
}));

test('a note goes on the revision it was written on; the laptop reads it with the site’s number', onSite(async (s) => {
  const { sam, key, token, api } = await setUp(s);
  await publish(s, token, publishFields({ page_version: '2' }));
  await send(sam, 'POST', `${api}/notes?r=1`, NOTE);
  await send(sam, 'POST', `${api}/notes`, { ...NOTE, text: 'On the latest' });
  const { body } = await withToken(s, token, `/api/features/${key}/notes`);
  assert.deepEqual(body.notes.map((n) => [n.text, n.revision]), [['Row is too tight', 1], ['On the latest', 2]]);
  assert.equal(body.notes[0].by.email, SAM);
}));

test('a note can’t be written under another name or time', onSite(async (s) => {
  const { sam, key, token, api } = await setUp(s);
  await send(sam, 'POST', `${api}/notes`, { ...NOTE, by_label: 'Raj', by: { id: '1', name: 'Raj' }, at: '2001-01-01T00:00:00Z' });
  const n = (await withToken(s, token, `/api/features/${key}/notes`)).body.notes[0];
  assert.equal(n.by.email, SAM);
  assert.equal(n.at, new Date(s.clock.t).toISOString());
  const r = await send(sam, 'POST', `/api/features/${key}/notes`, { notes: [{ ...NOTE, at: n.at, by_label: 'Raj' }] });
  assert.equal(r.status, 401, 'a session can’t reach the import');
}));

test('edit: your own only; moving a pin puts it on this revision', onSite(async (s) => {
  const { ada, sam, key, token, api } = await setUp(s);
  const id = (await json(await send(sam, 'POST', `${api}/notes?r=1`, { ...NOTE, pin: PIN }))).body.created;
  await publish(s, token, publishFields({ page_version: '2' }));
  const edited = await json(await send(sam, 'PATCH', `${api}/notes/${id}?r=1`, { text: 'Better words', kind: 'idea' }));
  assert.equal(edited.status, 200);
  assert.equal(edited.body.notes[0].text, 'Better words');
  assert.equal(edited.body.notes[0].kind, 'idea');
  assert.equal(edited.body.notes[0].edited, true);
  assert.equal(edited.body.notes[0].pin.x, PIN.x, 'an edit leaves the pin');
  const moved = await json(await send(sam, 'PATCH', `${api}/notes/${id}?r=2`, { pin: { ...PIN, x: 0.9 } }));
  assert.equal(moved.body.notes[0].pin.x, 0.9);
  assert.equal(moved.body.notes[0].revision, 2);
  assert.equal(moved.body.notes[0].text, 'Better words');
  const admin = await send(ada, 'PATCH', `${api}/notes/${id}`, { text: 'An admin’s words' });
  assert.equal(admin.status, 403, 'admins delete, they don’t rewrite');
  const { body } = await withToken(s, token, `/api/features/${key}/notes`);
  assert.equal(body.notes[0].text, 'Better words');
}));

test('delete: your own, or anyone’s if you’re an admin; a stranger neither', onSite(async (s) => {
  const { ada, sam, key, token, api } = await setUp(s);
  const adas = (await json(await send(ada, 'POST', `${api}/notes`, NOTE))).body.created;
  const sams = (await json(await send(sam, 'POST', `${api}/notes`, NOTE))).body.created;
  assert.equal((await send(sam, 'DELETE', `${api}/notes/${adas}`)).status, 403);
  const stu = await person(s, STU);
  assert.equal((await send(stu, 'DELETE', `${api}/notes/${sams}`)).status, 403);
  assert.equal((await json(await send(sam, 'DELETE', `${api}/notes/${sams}`))).body.notes.length, 1);
  assert.equal((await send(sam, 'DELETE', `${api}/notes/${sams}`)).status, 404, 'once');
  const again = (await json(await send(sam, 'POST', `${api}/notes`, NOTE))).body.created;
  assert.equal((await json(await send(ada, 'DELETE', `${api}/notes/${again}`))).body.notes.length, 1);
  const { rows } = await s.db.query('SELECT count(*)::int AS n FROM notes WHERE deleted_at IS NOT NULL');
  assert.equal(rows[0].n, 2, 'soft: the rows are still there');
  const { body } = await withToken(s, token, `/api/features/${key}/notes`);
  assert.equal(body.notes.filter((n) => n.deleted).length, 2, 'and a pull sees them go');
}));

test('a note on another feature can’t be reached through this one', onSite(async (s) => {
  const { ada, token, api } = await setUp(s);
  await publish(s, token, publishFields({ key: 'orbit-300-other', title: 'Other' }));
  const other = (await json(await send(ada, 'POST', '/api/features/orbit-300-other/state/notes', NOTE))).body.created;
  assert.equal((await send(ada, 'DELETE', `${api}/notes/${other}`)).status, 404);
}));

test('a stranger gets the same answer whether or not the feature is there', onSite(async (s) => {
  const { api } = await setUp(s);
  const stu = await person(s, STU);
  const here = await json(await stu.get(api));
  const gone = await json(await stu.get('/api/features/no-such-thing/state'));
  assert.equal(here.status, 403);
  assert.deepEqual(here, gone);
  assert.equal((await send(stu, 'POST', `${api}/notes`, NOTE)).status, 403);
  assert.equal((await send(stu, 'PUT', `${api}/choices`, { key: 'c-nav', choice: 'A' })).status, 403);
  assert.equal((await send(stu, 'PUT', `${api}/view`, { view: {} })).status, 403);
}));

test('the state needs a session; a token is no use here', onSite(async (s) => {
  const { token, api, sam } = await setUp(s);
  const noCookie = await s.fetch(`${SITE}${api}`);
  assert.equal(noCookie.status, 401, 'what the frame gets, if its request ever left the page');
  assert.equal((await withToken(s, token, api)).status, 401);
  assert.equal((await sam.get(api)).status, 200);
}));

test('a write from the frame’s origin, or without the mark, is refused', onSite(async (s) => {
  const { sam, api } = await setUp(s);
  assert.equal((await send(sam, 'POST', `${api}/notes`, NOTE, { origin: 'null' })).status, 403);
  assert.equal((await send(sam, 'POST', `${api}/notes`, NOTE, { origin: 'https://elsewhere.example' })).status, 403);
  const b = await sam.get(`${api}/notes`, { method: 'POST', headers: { 'content-type': 'application/json', origin: SITE }, body: JSON.stringify(NOTE) });
  assert.equal(b.status, 403);
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM notes')).rows[0].n, 0);
}));

test('picks: one row a person, changed in place, with a reason; others are listed apart', onSite(async (s) => {
  const { ada, sam, key, token, api } = await setUp(s);
  await send(sam, 'PUT', `${api}/choices`, { key: 'c-nav', choice: 'A', why: 'Fewer taps' });
  const changed = await json(await send(sam, 'PUT', `${api}/choices`, { key: 'c-nav', choice: 'B', why: 'Clearer' }));
  assert.deepEqual(changed.body.choices, { 'c-nav': { choice: 'B', why: 'Clearer' } });
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM choices')).rows[0].n, 1);
  const seen = await json(await ada.get(api));
  assert.deepEqual(seen.body.choices, {});
  assert.deepEqual(seen.body.others, [{ group: 'c-nav', choice: 'B', by: { name: 'Sam Shared' } }]);
  const pulled = (await withToken(s, token, `/api/features/${key}/notes`)).body;
  assert.equal(pulled.choices[0].choice, 'B');
}));

test('un-picking keeps the row empty, so a pull sees it; the page no longer does', onSite(async (s) => {
  const { sam, key, token, api } = await setUp(s);
  await send(sam, 'PUT', `${api}/choices`, { key: 'c-nav', choice: 'A' });
  const since = new Date(s.clock.t).toISOString();
  s.clock.t += 5000;
  const off = await json(await send(sam, 'PUT', `${api}/choices`, { key: 'c-nav', choice: '' }));
  assert.deepEqual(off.body.choices, {});
  const { body } = await withToken(s, token, `/api/features/${key}/notes?since=${encodeURIComponent(since)}`);
  assert.deepEqual(body.choices.map((c) => c.choice), ['']);
}));

test('settings are one person’s, on one feature', onSite(async (s) => {
  const { ada, sam, api } = await setUp(s);
  await send(sam, 'PUT', `${api}/view`, { view: { theme: 'dark', dev: 'phone', side: true } });
  await send(sam, 'PUT', `${api}/view`, { view: { theme: 'light', dev: 'phone' } });
  assert.deepEqual((await json(await sam.get(api))).body.view, { theme: 'light', dev: 'phone' });
  assert.deepEqual((await json(await ada.get(api))).body.view, {});
}));

test('an imported note is someone else’s to the page, and its pixel pin can be drawn', onSite(async (s) => {
  const { sam, key, token, api } = await setUp(s);
  const r = await withToken(s, token, `/api/features/${key}/notes`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ notes: [{ ...NOTE, at: '2026-10-01T12:00:00Z', by_label: 'Dana Reyes', pin: { label: 'Collection', px: { x: 442, y: 272, s: 1 } } }] }),
  });
  assert.equal(r.status, 200);
  const { body } = await json(await sam.get(api));
  const n = body.notes[0];
  assert.equal(n.by.name, 'Dana Reyes');
  assert.ok(n.by.id, 'with no id the page would call it the reader’s own');
  assert.notEqual(n.by.id, body.me.id);
  assert.deepEqual(n.pin, { label: 'Collection', x: 442, y: 272, s: 1 });
  assert.equal((await send(sam, 'DELETE', `${api}/notes/${n.id}`)).status, 403);
  assert.equal((await send(sam, 'PATCH', `${api}/notes/${n.id}`, { text: 'Mine now' })).status, 403);
  const ada = await person(s, ADA, 'Ada Admin');
  assert.equal((await send(ada, 'DELETE', `${api}/notes/${n.id}`)).status, 200);
}));

test('wireNote leaves a fraction pin as it is', () => {
  const n = wireNote({ id: '5', person_id: '2', name: 'A', email: 'a@x', screen: 's-a', device: '', kind: 'idea', text: 't', pin: PIN, place: null, page_version: 3, created_at: '2026-11-05T00:00:00Z' });
  assert.deepEqual(n.pin, PIN);
  assert.equal(n.id, '5');
});

test('the home page counts notes and says when the last one was; a deleted one doesn’t count', onSite(async (s) => {
  const { ada, sam, api } = await setUp(s);
  assert.match((await ada.page('/')).text, /0 notes/);
  await send(sam, 'POST', `${api}/notes`, NOTE);
  const id = (await json(await send(sam, 'POST', `${api}/notes`, NOTE))).body.created;
  const home = (await ada.page('/')).text;
  assert.match(home, /2 notes/);
  assert.match(home, /Last Nov 5, 2026/);
  await send(sam, 'DELETE', `${api}/notes/${id}`);
  assert.match((await sam.page('/')).text, /1 note</);
}));

test('the log carries no note text', onSite(async (s) => {
  const { sam, api } = await setUp(s);
  await send(sam, 'POST', `${api}/notes`, { ...NOTE, text: 'A private thought' });
  assert.doesNotMatch(JSON.stringify(s.logs), /A private thought/);
  assert.ok(s.logs.some((l) => l.route.endsWith('/state/notes') && l.key));
}));
