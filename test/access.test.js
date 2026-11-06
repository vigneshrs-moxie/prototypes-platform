// canSee: the one function every feature route asks. Plan section 4's table, cell by cell, then the
// same answers through the real routes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canSee, isAdmin } from '../site/access.js';
import { readConfig } from '../site/config.js';
import { ADA, onSite, person, publish, publishFields, SAM, STU, TEST_ENV, withFeature } from './helpers.js';

const admin = { email: ADA, admin: true };
const someone = { email: SAM, admin: false };
const open = { shared: true, archived_at: null };
const notShared = { shared: false, archived_at: null };
const archived = { shared: true, archived_at: '2026-11-01T00:00:00Z' };
const people = { audience: 'people' };
const adminOnly = { audience: 'admin' };

test('an admin sees everything', () => {
  for (const f of [open, notShared, archived]) {
    assert.equal(canSee(admin, f), true);
    assert.equal(canSee(admin, f, people), true);
    assert.equal(canSee(admin, f, adminOnly), true);
  }
});

test('a shared person sees people-facing documents only', () => {
  assert.equal(canSee(someone, open), true);
  assert.equal(canSee(someone, open, people), true);
  assert.equal(canSee(someone, open, adminOnly), false);
});

test('a stranger sees nothing', () => {
  assert.equal(canSee(someone, notShared), false);
  assert.equal(canSee(someone, notShared, people), false);
});

test('an archived feature is admin-only, even when shared', () => {
  assert.equal(canSee(someone, archived), false);
  assert.equal(canSee(someone, archived, people), false);
});

test('nobody and nothing see nothing', () => {
  assert.equal(canSee(null, open), false);
  assert.equal(canSee(admin, null), false);
});

test('isAdmin reads the list, ignoring case, and reads it fresh each time (D12)', () => {
  const env = { ...TEST_ENV };
  const config = readConfig(env);
  assert.equal(isAdmin({ email: 'BEA.BOSS@example.test' }, config), true);
  assert.equal(isAdmin({ email: STU }, config), false);
  assert.equal(isAdmin(null, config), false);
  env.ADMIN_EMAILS = STU;
  assert.equal(isAdmin({ email: STU }, config), true);
  assert.equal(isAdmin({ email: ADA }, config), false);
});

test('a new document type is admin-only unless someone says otherwise (D19)', onSite(async (s) => {
  const { key } = await withFeature(s);
  const f = (await s.db.query('SELECT id FROM features WHERE key = $1', [key])).rows[0];
  await s.db.query("INSERT INTO documents (feature_id, type, created_at) VALUES ($1, 'transcript', now())", [f.id]);
  const rows = (await s.db.query('SELECT type, audience FROM documents WHERE feature_id = $1 ORDER BY type', [f.id])).rows;
  assert.deepEqual(rows, [{ type: 'prototype', audience: 'people' }, { type: 'transcript', audience: 'admin' }]);
}));

test('being an admin takes effect on the next request, with no new sign-in', onSite(async (s) => {
  const stu = await person(s, STU);
  assert.equal((await stu.get('/settings')).status, 403);
  s.env.ADMIN_EMAILS = `${ADA},${STU}`;
  assert.equal((await stu.get('/settings')).status, 200);
  s.env.ADMIN_EMAILS = ADA;
  assert.equal((await stu.get('/settings')).status, 403);
}));

test('a removed share stops working at once', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const sam = await person(s, SAM);
  await ada.post(`/f/${key}/shares`, { email: SAM });
  assert.equal((await sam.get(`/f/${key}`)).status, 200);
  await ada.post(`/f/${key}/shares`, { email: SAM, _method: 'DELETE' });
  assert.equal((await sam.get(`/f/${key}`)).status, 403);
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM shares')).rows[0].n, 1, 'the row stays: the site deletes nothing');
}));

test('an archived feature leaves a shared person’s home and page, and stays for an admin', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const sam = await person(s, SAM);
  await ada.post(`/f/${key}/shares`, { email: SAM });
  await s.db.query('UPDATE features SET archived_at = now() WHERE key = $1', [key]);
  assert.equal((await sam.get(`/f/${key}`)).status, 403);
  assert.doesNotMatch((await sam.page('/')).text, /Freeze header/);
  assert.match((await ada.page('/')).text, /Archived/);
  assert.equal((await ada.get(`/f/${key}`)).status, 200);
}));

test('every feature route checks access, not just the page', onSite(async (s) => {
  const { key } = await withFeature(s);
  const stu = await person(s, STU);
  for (const path of [`/f/${key}`, `/f/${key}/r1/page`, `/f/${key}/r1/pack.pdf`, `/f/${key}/requirements`, `/f/${key}/decisions`]) {
    const r = await stu.page(path);
    assert.equal(r.status, 403, path);
    assert.doesNotMatch(r.text, /Freeze header/, `${path} says nothing about the feature`);
    assert.match(r.text, /Request access/, path);
  }
  for (const path of [`/f/${key}/shares`, '/settings', '/people']) assert.equal((await stu.get(path)).status, 403, path);
}));

test('a stranger can’t tell a feature that exists from one that doesn’t', onSite(async (s) => {
  const { key } = await withFeature(s);
  const stu = await person(s, STU);
  const real = await stu.page(`/f/${key}`);
  const none = await stu.page('/f/orbit-999-nothing');
  assert.equal(real.status, none.status);
  assert.equal(real.text.replaceAll(key, 'K'), none.text.replaceAll('orbit-999-nothing', 'K'));
  const asked = await stu.post('/f/orbit-999-nothing/request-access');
  assert.equal(asked.status, 200);
  assert.equal((await s.db.query('SELECT count(*)::int AS n FROM access_requests')).rows[0].n, 0);
}));

test('a share matches the address alone, so it works before the person ever signs in', onSite(async (s) => {
  const { ada, key, token } = await withFeature(s);
  await ada.post(`/f/${key}/shares`, { email: 'New.Hire@example.test' });
  const hire = await person(s, 'new.hire@example.test');
  assert.equal((await hire.get(`/f/${key}`)).status, 200);
  assert.ok((await publish(s, token, publishFields({ key: 'orbit-300-other', title: 'Other' }))).status === 200);
  assert.equal((await hire.get('/f/orbit-300-other')).status, 403, 'and only for that feature');
}));
