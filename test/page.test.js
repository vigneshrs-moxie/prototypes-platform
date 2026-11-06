// The prototype page and what sits beside it: its policy, the redirect, the frame, the PDF, and the
// Requirements and Decisions pages.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PAGE_CSP } from '../site/http.js';
import { attachment, markOpsNotAsked } from '../site/routes-page.js';
import { browser, onSite, person, publish, publishFields, SAM, STU, withFeature } from './helpers.js';

const asFrame = { 'sec-fetch-dest': 'iframe' };
const pdf = { filename: 'pack.pdf', type: 'application/pdf', data: '%PDF-made-up' };

test('the page is served to a frame under its own policy, and to nothing else', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const r = await ada.get(`/f/${key}/r1/page`, { headers: asFrame });
  assert.equal(r.status, 200);
  assert.match(await r.text(), /made up<\/title>/);
  assert.equal(r.headers.get('content-security-policy'), PAGE_CSP);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-type'), /^text\/html/);
}));

test('the page policy says what plan §7 says, and keeps the page off the network', () => {
  for (const part of ["default-src 'none'", "script-src 'unsafe-inline' https://cdn.jsdelivr.net", "style-src 'unsafe-inline' https://fonts.googleapis.com", 'font-src https://fonts.gstatic.com', "img-src 'self' data:", "connect-src 'none'", "frame-ancestors 'self'", "base-uri 'none'", "form-action 'none'", 'sandbox allow-scripts']) {
    assert.ok(PAGE_CSP.includes(part), part);
  }
  assert.doesNotMatch(PAGE_CSP, /allow-same-origin|unsafe-eval/);
});

test('a top-level visit goes to the wrapper and never gets the page', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  const r = await ada.get(`/f/${key}/r1/page`, { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), `/f/${key}?r=1`);
  assert.doesNotMatch(await r.text(), /made up/);
}));

test('a frame with no session gets no page and no sign-in, only the word to go on', onSite(async (s) => {
  const { key } = await withFeature(s);
  const out = await browser(s.fetch).get(`/f/${key}/r1/page`, { headers: asFrame });
  assert.equal(out.status, 401);
  assert.equal(out.headers.get('location'), null);
  assert.equal(out.headers.get('content-security-policy'), PAGE_CSP);
  const text = await out.text();
  assert.match(text, /wireframes-gone/);
  assert.ok(text.length < 200, 'nothing of the page');
}));

test('the page needs a session and a share; the redirect tells a stranger nothing', onSite(async (s) => {
  const { key } = await withFeature(s);
  const out = await browser(s.fetch).get(`/f/${key}/r1/page`, { headers: { 'sec-fetch-dest': 'document' } });
  assert.equal(out.status, 302);
  assert.match(out.headers.get('location'), /sign-in/);
  const stu = await person(s, STU);
  for (const headers of [asFrame, { 'sec-fetch-dest': 'document' }]) {
    const r = await stu.get(`/f/${key}/r1/page`, { headers });
    assert.equal(r.status, 403);
    assert.doesNotMatch(await r.text(), /made up/);
  }
}));

test('a shared person sees the page; a revision that isn’t there is a 404', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  await ada.post(`/f/${key}/shares`, { email: SAM });
  const sam = await person(s, SAM);
  assert.equal((await sam.get(`/f/${key}/r1/page`, { headers: asFrame })).status, 200);
  assert.equal((await sam.get(`/f/${key}/r9/page`, { headers: asFrame })).status, 404);
}));

test('an admin-only document isn’t served to a shared person', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  await ada.post(`/f/${key}/shares`, { email: SAM });
  await s.db.query("UPDATE documents SET audience = 'admin' WHERE type = 'prototype'");
  const sam = await person(s, SAM);
  assert.equal((await sam.get(`/f/${key}/r1/page`, { headers: asFrame })).status, 403);
  assert.equal((await ada.get(`/f/${key}/r1/page`, { headers: asFrame })).status, 200);
}));

test('the feature page embeds the page sandboxed, allow-scripts and nothing else', onSite(async (s) => {
  const { ada, key, token } = await withFeature(s);
  await publish(s, token, publishFields({ page_version: '2' }));
  const text = (await ada.page(`/f/${key}?r=1`)).text;
  assert.match(text, new RegExp(`<iframe sandbox="allow-scripts" src="/f/${key}/r1/page"`));
  assert.doesNotMatch(text, /allow-same-origin/);
  assert.ok(text.indexOf('/wrapper.js') < text.indexOf('<iframe'), 'the wrapper listens before the frame loads');
  assert.match((await ada.page(`/f/${key}`)).text, new RegExp(`src="/f/${key}/r2/page"`), 'the latest, with no r');
}));

test('the page says in words when a revision has no PDF', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  assert.match((await ada.page(`/f/${key}`)).text, /This revision has no PDF\./);
  const r = await ada.page(`/f/${key}/r1/pack.pdf`);
  assert.equal(r.status, 404);
  assert.match(r.text, /This revision has no PDF\./);
}));

test('the PDF comes as a download named for the feature, behind the same check', onSite(async (s) => {
  const { ada, key } = await withFeature(s, publishFields({ pdf }));
  const r = await ada.get(`/f/${key}/r1/pack.pdf`);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/pdf');
  assert.match(r.headers.get('content-disposition'), /^attachment; filename="Freeze header r1\.pdf"/);
  assert.equal(await r.text(), '%PDF-made-up');
  assert.equal((await (await person(s, STU)).get(`/f/${key}/r1/pack.pdf`)).status, 403);
}));

test('a title can’t break out of the download’s header', () => {
  const v = attachment('A "quoted"\r\nSet-Cookie: x=1 / Fête', 2);
  assert.doesNotMatch(v, /[\r\n]/);
  assert.match(v, /^attachment; filename="A quoted Set-Cookie: x=1 F-te r2\.pdf"|^attachment; filename="A  quoted/);
  assert.match(v, /filename\*=UTF-8''/);
});

test('requirements render, as of the revision asked for', onSite(async (s) => {
  const { ada, key, token } = await withFeature(s, publishFields({ requirements: '| id | text |\n|---|---|\n| FR-001 | First <b>rule</b> |\n' }));
  await publish(s, token, publishFields({ requirements: '| id | text |\n|---|---|\n| FR-001 | Second rule |\n' }));
  await publish(s, token, publishFields());
  const latest = (await ada.page(`/f/${key}/requirements`)).text;
  assert.match(latest, /Second rule/);
  assert.match(latest, /As of revision 2\./, 'a publish with none keeps the one before');
  const first = (await ada.page(`/f/${key}/requirements?r=1`)).text;
  assert.match(first, /First &lt;b&gt;rule/, 'raw HTML in a spec is text');
  assert.doesNotMatch(first, /Second rule/);
}));

test('a feature with no decisions says so', onSite(async (s) => {
  const { ada, key } = await withFeature(s);
  assert.match((await ada.page(`/f/${key}/decisions`)).text, /No decisions published yet\./);
}));

const DECISIONS = `# ORBIT-296 · Freeze header

<!-- Written from the job’s record after every gate. -->

| id | question | options | choice | who | when | why |
|---|---|---|---|---|---|---|
| ORBIT-296.D1 | Go ahead? | approve | approve | You | 2026-11-05 | fine |
| ORBIT-296.F1 | Who sees it? | a · b | a | Foreman | 2026-11-05 | Ops not asked: managers run this today | <!-- foreman -->
| ORBIT-296.F2 | Keep export? | yes · no | yes | Dana Reyes | 2026-11-05 | Ops not asked: nobody said to remove it | <!-- foreman -->

## Not doing
- Phone layout (out of V1)
`;

test('decisions: rows waiting on ops get the words, a confirmed one doesn’t, comments don’t show', onSite(async (s) => {
  const { ada, key } = await withFeature(s, publishFields({ decisions: DECISIONS }));
  const text = (await ada.page(`/f/${key}/decisions`)).text;
  assert.match(text, /<span class="tag">Ops not asked<\/span> Ops not asked: managers run this today/);
  assert.equal(text.match(/class="tag">Ops not asked/g).length, 1, 'Dana Reyes confirmed the other one');
  assert.doesNotMatch(text, /foreman --|Written from the job/);
  assert.match(text, /Phone layout/);
}));

test('the tag leaves a table with no such row alone', () => {
  const plain = '<table><tr><td>a</td><td>b</td></tr></table>';
  assert.equal(markOpsNotAsked(plain), plain);
});
