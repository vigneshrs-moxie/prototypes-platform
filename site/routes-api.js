// What the laptop reads, with a publish token (reference/publish.md is the contract).
//   GET  /api/features                the list, for publish.py and the weekly skill
//   GET  /api/features/<key>/notes    notes and picks, ?since=<iso> for what changed after it
//   POST /api/features/<key>/notes    the pilot's one-time import; the only way to set by_label
//
// The browser's note writes are in routes-notes.js, at an address of their own.

import { HttpError, readJson, sendJson } from './http.js';
import { iso } from './sessions.js';
import { KEY } from './routes-feature.js';

const KINDS = new Set(['change', 'question', 'idea']);
const MAX_TEXT = 2000;
const MAX_ROWS = 5000;

const isoOf = (t) => (t ? new Date(t).toISOString() : null);
const by = (r) => (r.person_email ? { name: r.person_name || r.person_email, email: r.person_email } : { name: r.by_label, email: null });

function sinceOf(url) {
  const given = url.searchParams.get('since');
  if (given === null) return null;
  const t = Date.parse(given);
  if (Number.isNaN(t)) throw new HttpError(400, 'since must be a time, like 2026-11-05T21:30:00Z.');
  return new Date(t).toISOString();
}

const need = (ok, why) => { if (!ok) throw new HttpError(400, why); };
const shortText = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const timeOf = (v) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

function checkNote(n, i) {
  const where = `Note ${i + 1}`;
  need(n && typeof n === 'object', `${where} isn’t an object.`);
  need(shortText(n.screen, 120), `${where} has no screen.`);
  need(KINDS.has(n.kind), `${where} has an unknown kind.`);
  need(shortText(n.text, MAX_TEXT), `${where} needs text, at most ${MAX_TEXT} characters.`);
  need(shortText(n.by_label, 200), `${where} has no by_label.`);
  const at = timeOf(n.at);
  need(at, `${where} has no time.`);
  const pin = n.pin ?? null;
  need(pin === null || (typeof pin === 'object' && !Array.isArray(pin) && JSON.stringify(pin).length <= 2000), `${where} has a pin that can’t be used.`);
  return { screen: n.screen, device: typeof n.device === 'string' ? n.device.slice(0, 20) : '', kind: n.kind, text: n.text, pin, at, label: n.by_label };
}

function checkChoice(c, i, t) {
  const where = `Choice ${i + 1}`;
  need(c && typeof c === 'object', `${where} isn’t an object.`);
  need(shortText(c.group, 120), `${where} has no group.`);
  need(typeof c.choice === 'string' && c.choice.length <= 120, `${where} has no choice.`);
  need(shortText(c.by_label, 200), `${where} has no by_label.`);
  return { group: c.group, choice: c.choice, label: c.by_label, at: timeOf(c.at) ?? t };
}

export default function apiRoutes(ctx) {
  const { db, now } = ctx;

  async function feature(key) {
    const f = (await db.query(
      `SELECT f.id, f.key, f.title, f.ticket_key, f.ticket_url,
          (SELECT max(r.n) FROM revisions r JOIN documents d ON d.id = r.document_id WHERE d.feature_id = f.id AND d.type = 'prototype') AS latest_revision
         FROM features f WHERE f.key = $1`,
      [key],
    )).rows[0];
    if (!f) throw new HttpError(404, 'There’s no feature with that key.');
    return f;
  }

  return [
    {
      method: 'GET', path: '/api/features', auth: 'token',
      async run({ res }) {
        const { rows } = await db.query(
          `SELECT f.key, f.title, f.ticket_key, f.ticket_url, f.job_slug, f.updated_at, f.archived_at,
              (SELECT max(r.n) FROM revisions r JOIN documents d ON d.id = r.document_id WHERE d.feature_id = f.id AND d.type = 'prototype') AS latest_revision,
              (SELECT count(*)::int FROM notes n WHERE n.feature_id = f.id AND n.deleted_at IS NULL) AS note_count,
              (SELECT max(n.created_at) FROM notes n WHERE n.feature_id = f.id AND n.deleted_at IS NULL) AS last_note_at
             FROM features f ORDER BY f.updated_at DESC`,
        );
        sendJson(res, 200, {
          features: rows.map((f) => ({
            key: f.key, title: f.title, ticket_key: f.ticket_key, ticket_url: f.ticket_url, job_slug: f.job_slug,
            latest_revision: f.latest_revision === null ? null : Number(f.latest_revision), note_count: f.note_count,
            last_note_at: isoOf(f.last_note_at), updated_at: isoOf(f.updated_at), archived: Boolean(f.archived_at),
          })),
        });
      },
    },
    {
      method: 'GET', path: new RegExp(`^/api/features/${KEY}/notes$`), auth: 'token',
      async run({ res, url, m, note }) {
        note.key = m[1];
        const since = sinceOf(url);
        const f = await feature(m[1]);
        // Compared at the milliseconds the answer's times are written in: Postgres keeps
        // microseconds, so without this the last note would come back on every pull.
        const { rows: notes } = await db.query(
          `SELECT n.id, n.screen, n.device, n.kind, n.text, n.pin, n.by_label, n.created_at, n.updated_at, n.deleted_at,
              r.n AS revision, p.name AS person_name, p.email AS person_email
             FROM notes n JOIN revisions r ON r.id = n.revision_id LEFT JOIN people p ON p.id = n.person_id
            WHERE n.feature_id = $1 AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', n.updated_at) > $2::timestamptz)
            ORDER BY n.created_at, n.id`,
          [f.id, since],
        );
        const { rows: choices } = await db.query(
          `SELECT c.group_key, c.choice, c.by_label, c.updated_at, p.name AS person_name, p.email AS person_email
             FROM choices c LEFT JOIN people p ON p.id = c.person_id
            WHERE c.feature_id = $1 AND ($2::timestamptz IS NULL OR date_trunc('milliseconds', c.updated_at) > $2::timestamptz)
            ORDER BY c.updated_at, c.id`,
          [f.id, since],
        );
        sendJson(res, 200, {
          feature: { key: f.key, title: f.title, ticket_key: f.ticket_key, ticket_url: f.ticket_url, latest_revision: f.latest_revision === null ? null : Number(f.latest_revision) },
          notes: notes.map((n) => ({
            id: Number(n.id), revision: Number(n.revision), screen: n.screen, device: n.device, kind: n.kind, text: n.text,
            pin: n.pin ?? null, by: by(n), at: isoOf(n.created_at), updated_at: isoOf(n.updated_at), deleted: Boolean(n.deleted_at),
          })),
          choices: choices.map((c) => ({ group: c.group_key, choice: c.choice, by: by(c), at: isoOf(c.updated_at) })),
        });
      },
    },
    {
      method: 'POST', path: new RegExp(`^/api/features/${KEY}/notes$`), auth: 'token',
      async run({ req, res, m, note }) {
        note.key = m[1];
        const body = await readJson(req, { max: 8e6 });
        const f = await feature(m[1]);
        need(f.latest_revision !== null, 'This feature has no revision to attach notes to.');
        const t = iso(now());
        const rawNotes = body.notes ?? [];
        const rawChoices = body.choices ?? [];
        need(Array.isArray(rawNotes) && Array.isArray(rawChoices), 'notes and choices must be lists.');
        need(rawNotes.length <= MAX_ROWS && rawChoices.length <= MAX_ROWS, `At most ${MAX_ROWS} of each at once.`);
        const notes = rawNotes.map(checkNote);
        const choices = rawChoices.map((c, i) => checkChoice(c, i, t));
        await db.tx(async (q) => {
          const revision = (await q.query(
            `SELECT r.id FROM revisions r JOIN documents d ON d.id = r.document_id
              WHERE d.feature_id = $1 AND d.type = 'prototype' ORDER BY r.n DESC LIMIT 1`,
            [f.id],
          )).rows[0].id;
          for (const n of notes) {
            await q.query(
              `INSERT INTO notes (feature_id, revision_id, by_label, screen, device, kind, text, pin, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)`,
              [f.id, revision, n.label, n.screen, n.device, n.kind, n.text, n.pin === null ? null : JSON.stringify(n.pin), n.at],
            );
          }
          for (const c of choices) {
            await q.query(
              `INSERT INTO choices (feature_id, by_label, group_key, choice, updated_at) VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (feature_id, by_label, group_key) WHERE person_id IS NULL DO UPDATE SET choice = EXCLUDED.choice, updated_at = EXCLUDED.updated_at`,
              [f.id, c.label, c.group, c.choice, c.at],
            );
          }
        });
        sendJson(res, 200, { notes: notes.length, choices: choices.length });
      },
    },
  ];
}
