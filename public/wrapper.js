// The site's side of the bridge to the prototype page, on the feature page. The page runs in a
// sandboxed frame with an opaque origin: no cookie, no storage, no network. Everything it wants
// saved comes here by postMessage, is checked, goes to the site's API under this page's session,
// and the fresh state goes back down. reference/prototype.md (the wireframe skill) has the messages.
//
// A message counts only if it came from this frame's window. Its origin is "null", so the origin
// can't say anything; for the same reason messages go down with "*", to that one window only.

(function () {
  const area = document.currentScript.parentElement;
  const { key, rev } = area.dataset;
  const base = `/api/features/${key}/state`;
  const SCREEN = /^s-[a-z0-9-]{1,118}$/;
  const GROUP = /^c-[a-z0-9-]{1,118}$/;
  const KINDS = ['change', 'question', 'idea'];

  const frame = () => area.querySelector('iframe');
  const toPage = (m) => frame().contentWindow.postMessage(m, '*');

  let state = null;
  let started = false;
  let loads = 0;
  // One write at a time, in the order the page sent them: an edit can't overtake its note's add.
  let line = Promise.resolve();
  // The page names a new note itself until the site gives it an id.
  const saved = new Map();

  function say(words, signIn = false) {
    const p = area.querySelector('[data-frame-status]');
    if (!p) return;
    p.textContent = words;
    p.hidden = !words;
    if (signIn) {
      const a = document.createElement('a');
      a.href = '/sign-in';
      a.textContent = ' Sign in again';
      p.append(a);
    }
  }

  async function call(method, path, body) {
    const write = method !== 'GET';
    const res = await fetch(`${base}${path}?r=${rev}`, {
      method,
      credentials: 'same-origin',
      headers: write ? { 'Content-Type': 'application/json', 'X-Requested-With': 'prototypes' } : {},
      body: write ? JSON.stringify(body ?? {}) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || 'The site didn’t answer.'), { status: res.status });
    return data;
  }

  // Coming from a link, the page starts on its first tab, whatever tab was open last time. A reload
  // or the browser's Back keeps the person's place. The notes panel starts closed, so the prototype
  // gets the room; once someone has opened it, that's saved and it stays open for them.
  const how = globalThis.performance?.getEntriesByType?.('navigation')?.[0]?.type;
  let startFresh = how !== 'reload' && how !== 'back_forward';

  function show(next) {
    const { created, ...fresh } = next;
    state = fresh;
    const { page, ...kept } = fresh.view ?? {};
    const view = { side: false, ...(startFresh ? kept : fresh.view) };
    toPage({ type: 'wireframes-state', ...fresh, view });
    startFresh = false;
    const label = document.querySelector('[data-note-count]');
    if (label) label.textContent = `${fresh.notes.length} note${fresh.notes.length === 1 ? '' : 's'}`;
  }

  const refresh = () => call('GET', '').then(show);

  /** The page already shows what it sent, so when it didn't save, say so and put the truth back. */
  function failed(err) {
    if (err.status === 401) say('You’re signed out, so that didn’t save.', true);
    else say(`That didn’t save. ${err.status ? err.message : 'Check your connection and try again.'}`);
    return refresh().catch(() => {});
  }

  const enqueue = (write) => {
    line = line.then(write).then((next) => { if (next) { say(''); show(next); } }).catch(failed);
  };

  const fraction = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  const fits = (v) => v === undefined || v === null || (typeof v === 'string' && v.length <= 200);

  /** What's wrong with a note from the page, in words, or '' when it can go on to the site. */
  function problem(op, n) {
    if (!n || typeof n !== 'object') return 'That note can’t be used.';
    if (op === 'remove') return '';
    if (!KINDS.includes(n.kind)) return 'A note is a change, a question or an idea.';
    if (typeof n.screen !== 'string' || !SCREEN.test(n.screen)) return 'A note needs a screen.';
    if (typeof n.text !== 'string' || !n.text.trim() || n.text.length > 2000) return 'A note needs text, at most 2,000 characters.';
    const p = n.pin;
    if (p !== null && p !== undefined && !(typeof p === 'object' && fraction(p.x) && fraction(p.y) && fits(p.anchor) && fits(p.anchor_text) && fits(p.label))) return 'That pin can’t be used.';
    return '';
  }

  function note({ op, note: n }) {
    const wrong = ['add', 'edit', 'move', 'remove'].includes(op) ? problem(op, n) : 'That note can’t be used.';
    if (wrong) { failed({ status: 400, message: wrong }); return; }
    enqueue(async () => {
      if (op === 'add') {
        const next = await call('POST', '/notes', n);
        saved.set(n.id, next.created);
        return next;
      }
      const id = saved.get(n.id) ?? n.id;
      if (!/^\d+$/.test(String(id))) throw Object.assign(new Error('That note was never saved.'), { status: 400 });
      if (op === 'remove') return call('DELETE', `/notes/${id}`);
      return call('PATCH', `/notes/${id}`, op === 'move' ? { pin: n.pin } : { text: n.text, kind: n.kind });
    });
  }

  function choice({ key: group, choice: picked, why }) {
    if (typeof group !== 'string' || !GROUP.test(group) || typeof picked !== 'string' || picked.length > 120) { failed({ status: 400, message: 'That pick can’t be used.' }); return; }
    enqueue(() => call('PUT', '/choices', { key: group, choice: picked, why: typeof why === 'string' ? why : '' }));
  }

  /** Settings go quietly: nothing the page shows depends on the answer. */
  function view({ view: v }) {
    if (!v || typeof v !== 'object') return;
    enqueue(async () => { await call('PUT', '/view', { view: v }); });
  }

  /** Only ever the link the site gave: the page's own url isn't used. The frame can't download. */
  function pdf() {
    if (!state?.pdf) { toPage({ type: 'wireframes-pdf', ok: false, reason: 'There’s no PDF for this revision' }); return; }
    const a = document.createElement('a');
    a.href = state.pdf;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    toPage({ type: 'wireframes-pdf', ok: true });
  }

  window.addEventListener('message', (e) => {
    const f = frame();
    if (!f || e.source !== f.contentWindow) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'wireframes' && !started) {
      started = true;
      refresh().catch(failed);
    } else if (m.type === 'wireframes-note') note(m);
    else if (m.type === 'wireframes-choice') choice(m);
    else if (m.type === 'wireframes-view') view(m);
    else if (m.type === 'wireframes-pdf') pdf();
    else if (m.type === 'wireframes-gone') window.history.back(); // Back reached an entry the frame can't reopen
  });

  // A frame that loads again (the page reloaded itself) has forgotten everything.
  document.addEventListener('load', (e) => {
    if (e.target === frame() && ++loads > 1) refresh().catch(failed);
  }, true);
})();
