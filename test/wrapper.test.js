// public/wrapper.js, run with a stand-in for the browser. No test here can prove the sandbox: that's
// checked by hand in a real browser. These check the wrapper's own rules.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const CODE = fs.readFileSync(new URL('../public/wrapper.js', import.meta.url), 'utf8');
const NOTE = { id: 'ntemp', screen: 's-team', device: 'phone', kind: 'change', text: 'Too tight', pin: null };
const STATE = { me: { id: '2', name: 'Sam', admin: false }, notes: [], choices: {}, others: [], pdf: '/f/k/r3/pack.pdf', view: {} };

function page({ answers = [], state = STATE } = {}) {
  const sent = [];
  const calls = [];
  const clicks = [];
  const backs = { n: 0 };
  const pageWindow = { postMessage: (m, to) => sent.push({ m, to }) };
  const status = { textContent: '', hidden: true, append() {} };
  const iframe = { contentWindow: pageWindow };
  const counter = { textContent: '' };
  const area = { dataset: { key: 'k', rev: '3' }, querySelector: (q) => (q === 'iframe' ? iframe : status) };
  let onMessage;
  let onLoad;
  const context = {
    window: { addEventListener: (t, fn) => { if (t === 'message') onMessage = fn; }, history: { back: () => { backs.n++; } } },
    document: {
      currentScript: { parentElement: area },
      addEventListener: (t, fn) => { if (t === 'load') onLoad = fn; },
      querySelector: () => counter,
      createElement: () => ({ click() { clicks.push(this.href); }, remove() {} }),
      body: { append() {} },
    },
    fetch: async (url, init) => {
      calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
      const a = answers.shift() ?? { status: 200, body: state };
      return { ok: a.status < 400, status: a.status, json: async () => a.body };
    },
    Object, Promise, Error, JSON, Map, String, console,
  };
  vm.runInNewContext(CODE, context);
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return {
    sent, calls, clicks, backs, status, counter, settle, iframe,
    fromPage: async (m) => { onMessage({ source: pageWindow, origin: 'null', data: m }); await settle(); },
    fromElsewhere: async (m, origin = 'https://prototypes.moxieorbit.com') => { onMessage({ source: {}, origin, data: m }); await settle(); },
    loaded: async () => { onLoad({ target: iframe }); await settle(); },
  };
}

const states = (p) => p.sent.filter((x) => x.m.type === 'wireframes-state');

test('it waits for the page’s first message, then sends the state once, to that frame', async () => {
  const p = page();
  await p.settle();
  assert.equal(p.calls.length, 0);
  await p.fromPage({ type: 'wireframes', version: '4', current: 'overview', screens: [] });
  await p.fromPage({ type: 'wireframes', version: '4', current: 's-team', screens: [] });
  assert.equal(p.calls.length, 1);
  assert.equal(p.calls[0].url, '/api/features/k/state?r=3');
  assert.equal(states(p).length, 1);
  assert.equal(states(p)[0].to, '*', 'a named origin would be dropped: the frame’s is opaque');
  assert.equal(states(p)[0].m.pdf, STATE.pdf);
});

test('a message from any other window is ignored, even one with the site’s own origin', async () => {
  const p = page();
  await p.fromElsewhere({ type: 'wireframes' });
  await p.fromElsewhere({ type: 'wireframes-note', op: 'add', note: NOTE });
  assert.equal(p.calls.length, 0);
});

test('a note goes to the API with the marks a change needs, and the fresh state comes back', async () => {
  const p = page({ answers: [{ status: 200, body: { ...STATE, notes: [{ id: '9' }], created: '9' } }] });
  await p.fromPage({ type: 'wireframes-note', op: 'add', note: NOTE });
  const c = p.calls[0];
  assert.equal(c.url, '/api/features/k/state/notes?r=3');
  assert.equal(c.method, 'POST');
  assert.equal(c.headers['X-Requested-With'], 'prototypes');
  assert.equal(states(p).at(-1).m.created, undefined);
  assert.equal(p.counter.textContent, '1 note');
});

for (const [name, note] of [
  ['an unknown kind', { ...NOTE, kind: 'bug' }],
  ['a bad screen', { ...NOTE, screen: 'team' }],
  ['too much text', { ...NOTE, text: 'x'.repeat(2001) }],
  ['a pin past the edge', { ...NOTE, pin: { x: 2, y: 0 } }],
  ['a long anchor', { ...NOTE, pin: { x: 0, y: 0, anchor: 'a'.repeat(201) } }],
]) test(`${name} never reaches the API, and the person is told`, async () => {
  const p = page();
  await p.fromPage({ type: 'wireframes-note', op: 'add', note });
  assert.ok(!p.calls.some((c) => c.method === 'POST'));
  assert.match(p.status.textContent, /didn’t save/);
  assert.equal(p.status.hidden, false);
});

test('an edit right after an add waits for it, and uses the site’s id', async () => {
  const p = page({ answers: [{ status: 200, body: { ...STATE, created: '41' } }] });
  await p.fromPage({ type: 'wireframes-note', op: 'add', note: NOTE });
  await p.fromPage({ type: 'wireframes-note', op: 'edit', note: { ...NOTE, text: 'Better' } });
  await p.fromPage({ type: 'wireframes-note', op: 'move', note: { ...NOTE, pin: { x: 0.1, y: 0.2 } } });
  await p.fromPage({ type: 'wireframes-note', op: 'remove', note: { ...NOTE, deleted: true } });
  assert.deepEqual(p.calls.map((c) => [c.method, c.url]), [
    ['POST', '/api/features/k/state/notes?r=3'],
    ['PATCH', '/api/features/k/state/notes/41?r=3'],
    ['PATCH', '/api/features/k/state/notes/41?r=3'],
    ['DELETE', '/api/features/k/state/notes/41?r=3'],
  ]);
  assert.deepEqual(p.calls[1].body, { text: 'Better', kind: 'change' });
  assert.deepEqual(p.calls[2].body, { pin: { x: 0.1, y: 0.2 } });
});

test('a write that fails says why and puts the truth back in the page', async () => {
  const p = page({ answers: [{ status: 403, body: { error: 'You can only change your own notes.' } }] });
  await p.fromPage({ type: 'wireframes-note', op: 'edit', note: { ...NOTE, id: '7' } });
  assert.match(p.status.textContent, /You can only change your own notes\./);
  assert.equal(states(p).length, 1);
});

test('signed out: it says so, in words', async () => {
  const p = page({ answers: [{ status: 401, body: { error: 'Sign in first.' } }, { status: 401, body: {} }] });
  await p.fromPage({ type: 'wireframes-note', op: 'add', note: NOTE });
  assert.match(p.status.textContent, /signed out/);
});

test('the words clear on the next write that works', async () => {
  const p = page({ answers: [{ status: 500, body: { error: 'Something went wrong.' } }] });
  await p.fromPage({ type: 'wireframes-choice', key: 'c-nav', choice: 'A', why: '' });
  assert.match(p.status.textContent, /Something went wrong/);
  await p.fromPage({ type: 'wireframes-choice', key: 'c-nav', choice: 'A', why: '' });
  assert.equal(p.status.hidden, true);
});

test('a pick goes up as sent; a bad key doesn’t', async () => {
  const p = page();
  await p.fromPage({ type: 'wireframes-choice', key: 'c-nav', choice: '', why: 'x' });
  assert.deepEqual(p.calls[0].body, { key: 'c-nav', choice: '', why: 'x' });
  const q = page();
  await q.fromPage({ type: 'wireframes-choice', key: '../x', choice: 'A' });
  assert.ok(!q.calls.some((c) => c.method === 'PUT'));
});

test('settings are saved without sending the page a new state', async () => {
  const p = page();
  await p.fromPage({ type: 'wireframes-view', view: { theme: 'dark' } });
  assert.equal(p.calls[0].url, '/api/features/k/state/view?r=3');
  assert.equal(states(p).length, 0);
});

test('Download PDF uses the site’s link, never one from the page', async () => {
  const p = page();
  await p.fromPage({ type: 'wireframes' });
  await p.fromPage({ type: 'wireframes-pdf', url: 'https://elsewhere.example/evil.pdf' });
  assert.deepEqual(p.clicks, [STATE.pdf]);
  assert.equal(p.sent.at(-1).m.type, 'wireframes-pdf');
  assert.equal(p.sent.at(-1).m.ok, true);
});

test('with no PDF it answers in words and downloads nothing', async () => {
  const p = page({ state: { ...STATE, pdf: null } });
  await p.fromPage({ type: 'wireframes' });
  await p.fromPage({ type: 'wireframes-pdf', url: 'x' });
  assert.deepEqual(p.clicks, []);
  assert.equal(p.sent.at(-1).m.ok, false);
  assert.match(p.sent.at(-1).m.reason, /no PDF/);
});

test('a frame that can’t reopen an old entry sends Back on, and only that frame can ask', async () => {
  const p = page();
  await p.fromElsewhere({ type: 'wireframes-gone' });
  assert.equal(p.backs.n, 0);
  await p.fromPage({ type: 'wireframes-gone' });
  assert.equal(p.backs.n, 1);
});

test('a frame that loads a second time gets the state again', async () => {
  const p = page();
  await p.fromPage({ type: 'wireframes' });
  await p.loaded();
  assert.equal(states(p).length, 1, 'the first load is the one it already answered');
  await p.loaded();
  assert.equal(states(p).length, 2);
});
