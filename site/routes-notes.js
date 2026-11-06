// A person's notes, pins and picks, written from the wrapper page (public/wrapper.js).
//   GET    /api/features/<key>/state?r=<n>             all the page needs
//   POST   /api/features/<key>/state/notes?r=<n>       a new note on that revision
//   PATCH  /api/features/<key>/state/notes/<id>?r=<n>  edit or move your own
//   DELETE /api/features/<key>/state/notes/<id>?r=<n>  your own; an admin, anyone's
//   PUT    /api/features/<key>/state/choices?r=<n>     your pick on one option group
//   PUT    /api/features/<key>/state/view              your settings on this page
//
// Every one answers with the fresh state. They have their own address, apart from
// /api/features/<key>/notes, because that one is for a publish token: a session can't reach it,
// so it can't write a note under someone else's name (by_label).
//
// Nothing is deleted: a note gets deleted_at, and an un-picked choice keeps its row with an empty
// choice, so a pull with ?since= sees that it changed.

import { canSee, loadFeature } from './access.js';
import { HttpError, readJson, sendJson } from './http.js';
import { prototypeRevision } from './routes-page.js';
import { KEY } from './routes-feature.js';
import { iso } from './sessions.js';

const KINDS = new Set(['change', 'question', 'idea']);
const SCREEN = /^s-[a-z0-9-]{1,118}$/;
const GROUP = /^c-[a-z0-9-]{1,118}$/;
const MAX_TEXT = 2000;
const MAX_ANCHOR = 200;
const MAX_PLACE = 2000;

const need = (ok, why) => { if (!ok) throw new HttpError(400, why); };
const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const fraction = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const short = (v, max) => v === undefined || v === null || (typeof v === 'string' && v.length <= max);

/** A pin from the page: fractions of the screen and how to find the spot again. Nothing else is kept. */
export function checkPin(pin) {
  if (pin === null || pin === undefined) return null;
  need(isObject(pin), 'That pin can’t be used.');
  need(fraction(pin.x) && fraction(pin.y), 'A pin’s place must be between 0 and 1.');
  for (const k of ['ox', 'oy']) need(pin[k] === undefined || fraction(pin[k]), 'A pin’s place must be between 0 and 1.');
  for (const k of ['anchor', 'anchor_text', 'label']) need(short(pin[k], MAX_ANCHOR), `A pin’s ${k} can be at most ${MAX_ANCHOR} characters.`);
  need(pin.s === undefined || pin.s === 0 || pin.s === 1, 'That pin can’t be used.');
  const { x, y, ox = 0, oy = 0, s = 0, anchor = '', anchor_text = '', label = '' } = pin;
  return { x, y, ox, oy, s, anchor: anchor ?? '', anchor_text: anchor_text ?? '', label: label ?? '' };
}

const checkText = (text) => {
  need(typeof text === 'string' && text.trim().length > 0, 'A note needs some text.');
  need(text.length <= MAX_TEXT, `A note can be at most ${MAX_TEXT} characters.`);
  return text;
};

/** Where the note was written: what puts a reader back there. */
function checkPlace({ path, role, options }) {
  const place = { path: Array.isArray(path) ? path : [], role: typeof role === 'string' ? role : null, options: isObject(options) ? options : {} };
  need(JSON.stringify(place).length <= MAX_PLACE, 'That note’s place is too long.');
  return place;
}

/** A new note from the page. What the page says about who and when is ignored. */
export function checkNote(n) {
  need(isObject(n), 'That note can’t be used.');
  need(typeof n.screen === 'string' && SCREEN.test(n.screen), 'A note needs a screen.');
  need(KINDS.has(n.kind), 'A note is a change, a question or an idea.');
  need(n.device === undefined || n.device === null || n.device === '' || n.device === 'phone' || n.device === 'laptop', 'A note is on a phone or a laptop.');
  return { screen: n.screen, device: n.device ?? '', kind: n.kind, text: checkText(n.text), pin: checkPin(n.pin), place: checkPlace(n) };
}

export function checkChoice(c) {
  need(isObject(c), 'That pick can’t be used.');
  need(typeof c.key === 'string' && GROUP.test(c.key), 'A pick needs its question.');
  need(typeof c.choice === 'string' && c.choice.length <= 120, 'That pick can’t be used.');
  need(c.why === undefined || (typeof c.why === 'string' && c.why.length <= 500), 'A reason can be at most 500 characters.');
  return { key: c.key, choice: c.choice, why: c.choice ? (c.why ?? '') : '' };
}

/** The page's settings, the ones it's known to send. */
export function checkView(view) {
  need(isObject(view), 'Those settings can’t be used.');
  const out = {};
  for (const k of ['theme', 'dev', 'page', 'panel']) if (typeof view[k] === 'string' && view[k].length <= 40) out[k] = view[k];
  if (typeof view.side === 'boolean') out.side = view.side;
  const place = checkViewPlace(view.place);
  if (place) out.place = place;
  return out;
}

/** Where the person is in the page: the path of screens, and the tabs and role that let them see it. */
function checkViewPlace(place) {
  if (!isObject(place) || !Array.isArray(place.ids) || !isObject(place.tabs)) return null;
  const word = (v) => typeof v === 'string' && v.length > 0 && v.length <= 80;
  const tabs = Object.entries(place.tabs);
  if (place.ids.length > 40 || !place.ids.every(word)) return null;
  if (tabs.length > 40 || !tabs.every(([k, v]) => word(k) && word(v))) return null;
  return { ids: place.ids, tabs: place.tabs };
}

/** An artifact's pin came in pixels with no fractions: the page draws anything above 1 as pixels. */
const wirePin = (pin) => (pin?.px ? { label: pin.label ?? '', x: pin.px.x, y: pin.px.y, s: pin.px.s ?? 0 } : pin ?? null);

/**
 * One note as the page reads it. revision is the page's own number, which it compares with its own
 * to see which pins to follow. A note from an import has no account, so it gets an id of its own:
 * the page takes a note with no author for the reader's own.
 */
export function wireNote(n) {
  return {
    id: String(n.id), screen: n.screen, device: n.device, kind: n.kind, text: n.text, pin: wirePin(n.pin),
    ...(n.place ?? {}),
    revision: n.page_version, at: new Date(n.created_at).toISOString(),
    by: n.person_id === null ? { id: `import:${n.by_label}`, name: n.by_label } : { id: String(n.person_id), name: n.name || n.email },
  };
}

export default function notesRoutes(ctx) {
  const { db, now } = ctx;

  async function stateOf(person, feature, revision) {
    const { rows: notes } = await db.query(
      `SELECT n.id, n.person_id, n.by_label, n.screen, n.device, n.kind, n.text, n.pin, n.place, n.created_at, r.page_version, p.name, p.email
         FROM notes n JOIN revisions r ON r.id = n.revision_id LEFT JOIN people p ON p.id = n.person_id
        WHERE n.feature_id = $1 AND n.deleted_at IS NULL ORDER BY n.created_at, n.id`,
      [feature.id],
    );
    const { rows: picks } = await db.query(
      `SELECT c.person_id, c.by_label, c.group_key, c.choice, c.why, p.name, p.email
         FROM choices c LEFT JOIN people p ON p.id = c.person_id
        WHERE c.feature_id = $1 AND c.choice <> '' ORDER BY c.updated_at, c.id`,
      [feature.id],
    );
    const view = (await db.query('SELECT view FROM views WHERE feature_id = $1 AND person_id = $2', [feature.id, person.id])).rows[0]?.view ?? {};
    const mine = (c) => c.person_id !== null && String(c.person_id) === String(person.id);
    return {
      me: { id: String(person.id), name: person.name || person.email, admin: Boolean(person.admin) },
      notes: notes.map(wireNote),
      choices: Object.fromEntries(picks.filter(mine).map((c) => [c.group_key, { choice: c.choice, why: c.why }])),
      others: picks.filter((c) => !mine(c)).map((c) => ({ group: c.group_key, choice: c.choice, by: { name: c.by_label ?? (c.name || c.email) } })),
      pdf: revision.pdf_blob ? `/f/${feature.key}/r${revision.n}/pack.pdf` : null,
      view,
    };
  }

  /** The same answer for a feature that isn't there and one that isn't yours. */
  async function seen({ m, person, url, note }) {
    note.key = m[1];
    const feature = await loadFeature(db, m[1], person);
    if (!canSee(person, feature)) throw new HttpError(403, 'You don’t have access to this feature.');
    const given = url.searchParams.get('r');
    if (given !== null && !/^\d{1,6}$/.test(given)) throw new HttpError(404, 'There’s no such revision.');
    const revision = await prototypeRevision(db, feature, given === null ? null : Number(given));
    if (!revision) throw new HttpError(404, 'There’s no such revision.');
    if (!canSee(person, feature, revision)) throw new HttpError(403, 'You don’t have access to this feature.');
    return { feature, revision };
  }

  const answer = async (res, person, { feature, revision }, extra = {}) => sendJson(res, 200, { ...await stateOf(person, feature, revision), ...extra });

  async function noteOf(feature, id) {
    const n = (await db.query('SELECT id, person_id, place FROM notes WHERE id = $1 AND feature_id = $2 AND deleted_at IS NULL', [id, feature.id])).rows[0];
    if (!n) throw new HttpError(404, 'That note isn’t there any more.');
    return n;
  }
  const isOwn = (n, person) => n.person_id !== null && String(n.person_id) === String(person.id);

  const NOTE = new RegExp(`^/api/features/${KEY}/state/notes/(\\d{1,18})$`);

  return [
    {
      method: 'GET', path: new RegExp(`^/api/features/${KEY}/state$`), auth: 'session',
      async run(call) { await answer(call.res, call.person, await seen(call)); },
    },
    {
      method: 'POST', path: new RegExp(`^/api/features/${KEY}/state/notes$`), auth: 'session',
      async run(call) {
        const { req, res, person } = call;
        const found = await seen(call);
        const n = checkNote(await readJson(req));
        const t = iso(now());
        const { rows } = await db.query(
          `INSERT INTO notes (feature_id, revision_id, person_id, screen, device, kind, text, pin, place, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
          [found.feature.id, found.revision.id, person.id, n.screen, n.device, n.kind, n.text, n.pin && JSON.stringify(n.pin), JSON.stringify(n.place), t],
        );
        await answer(res, person, found, { created: String(rows[0].id) });
      },
    },
    {
      method: 'PATCH', path: NOTE, auth: 'session',
      async run(call) {
        const { req, res, person, m } = call;
        const found = await seen(call);
        const n = await noteOf(found.feature, m[2]);
        if (!isOwn(n, person)) throw new HttpError(403, 'You can only change your own notes.');
        const body = await readJson(req);
        need(body.text !== undefined || body.pin !== undefined, 'There’s nothing to change.');
        need(body.kind === undefined || KINDS.has(body.kind), 'A note is a change, a question or an idea.');
        const text = body.text === undefined ? null : checkText(body.text);
        const pin = body.pin === undefined ? undefined : checkPin(body.pin);
        // Moving a pin puts it on the revision it was moved on; words only say they were edited.
        const place = text === null ? n.place : { ...(n.place ?? {}), edited: true };
        await db.query(
          `UPDATE notes SET text = COALESCE($2, text), kind = COALESCE($3, kind), pin = CASE WHEN $4 THEN $5::jsonb ELSE pin END,
              revision_id = CASE WHEN $4 THEN $6 ELSE revision_id END, place = $7, updated_at = $8 WHERE id = $1`,
          [n.id, text, body.kind ?? null, pin !== undefined, pin ? JSON.stringify(pin) : null, found.revision.id, place && JSON.stringify(place), iso(now())],
        );
        await answer(res, person, found);
      },
    },
    {
      method: 'DELETE', path: NOTE, auth: 'session',
      async run(call) {
        const { res, person, m } = call;
        const found = await seen(call);
        const n = await noteOf(found.feature, m[2]);
        if (!isOwn(n, person) && !person.admin) throw new HttpError(403, 'You can only delete your own notes.');
        const t = iso(now());
        await db.query('UPDATE notes SET deleted_at = $2, updated_at = $2 WHERE id = $1', [n.id, t]);
        await answer(res, person, found);
      },
    },
    {
      method: 'PUT', path: new RegExp(`^/api/features/${KEY}/state/choices$`), auth: 'session',
      async run(call) {
        const { req, res, person } = call;
        const found = await seen(call);
        const c = checkChoice(await readJson(req));
        await db.query(
          `INSERT INTO choices (feature_id, person_id, group_key, choice, why, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (feature_id, person_id, group_key) WHERE person_id IS NOT NULL
           DO UPDATE SET choice = EXCLUDED.choice, why = EXCLUDED.why, updated_at = EXCLUDED.updated_at`,
          [found.feature.id, person.id, c.key, c.choice, c.why, iso(now())],
        );
        await answer(res, person, found);
      },
    },
    {
      method: 'PUT', path: new RegExp(`^/api/features/${KEY}/state/view$`), auth: 'session',
      async run(call) {
        const { req, res, person } = call;
        const found = await seen(call);
        const view = checkView((await readJson(req)).view);
        await db.query(
          `INSERT INTO views (feature_id, person_id, view, updated_at) VALUES ($1, $2, $3, $4)
           ON CONFLICT (feature_id, person_id) DO UPDATE SET view = EXCLUDED.view, updated_at = EXCLUDED.updated_at`,
          [found.feature.id, person.id, JSON.stringify(view), iso(now())],
        );
        sendJson(res, 200, { view });
      },
    },
  ];
}
