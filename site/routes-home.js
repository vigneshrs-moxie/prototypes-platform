// The home page: your features (all of them, for an admin), and, for an admin, who has asked for
// access. And /healthz, which anyone may ask.

import { sendHtml, sendJson } from './http.js';
import { buttonForm, count, dateLabel, html, layout } from './render.js';

/** Features with their numbers: the latest revision, note count, last note. */
const LIST = `SELECT f.key, f.title, f.ticket_key, f.archived_at, f.updated_at,
    (SELECT max(r.n) FROM revisions r JOIN documents d ON d.id = r.document_id WHERE d.feature_id = f.id AND d.type = 'prototype') AS latest_revision,
    (SELECT count(*)::int FROM notes n WHERE n.feature_id = f.id AND n.deleted_at IS NULL) AS note_count,
    (SELECT max(n.created_at) FROM notes n WHERE n.feature_id = f.id AND n.deleted_at IS NULL) AS last_note_at
  FROM features f`;

export async function listFeatures(db, person) {
  const { rows } = person.admin
    ? await db.query(`${LIST} ORDER BY f.archived_at IS NOT NULL, f.updated_at DESC`)
    : await db.query(`${LIST} WHERE f.archived_at IS NULL AND EXISTS (SELECT 1 FROM shares s WHERE s.feature_id = f.id AND s.email = $1 AND s.removed_at IS NULL) ORDER BY f.updated_at DESC`, [person.email]);
  return rows;
}

const row = (f) => html`<li><a class="row" href="/f/${f.key}">
  <span class="grow"><strong>${f.title}</strong>
    <small>${f.ticket_key && `${f.ticket_key} · `}Revision ${f.latest_revision ?? 0} · Updated ${dateLabel(f.updated_at)}</small></span>
  ${f.archived_at && html`<span class="tag">Archived</span>`}
  <span class="meta">${count(f.note_count, 'note')}${f.last_note_at && html`<small>Last ${dateLabel(f.last_note_at)}</small>`}</span>
</a></li>`;

function requests(items, token) {
  if (!items.length) return null;
  return html`<section class="block"><h2>Access requests</h2>
<ul class="list">${items.map((r) => html`<li class="row">
  <span class="grow"><strong>${r.name || r.email}</strong><small>${r.email} asked for <a href="/f/${r.key}">${r.title}</a> on ${dateLabel(r.created_at)}</small></span>
  ${buttonForm({ action: `/f/${r.key}/shares`, token, label: 'Add them', cls: 'btn primary', fields: { email: r.email } })}
  ${buttonForm({ action: `/f/${r.key}/requests/${r.id}`, token, label: 'Dismiss', method: 'DELETE', cls: 'btn quiet' })}
</li>`)}</ul></section>`;
}

export default function homeRoutes(ctx) {
  const { db } = ctx;
  return [
    {
      method: 'GET', path: '/', auth: 'session',
      async run({ res, person, token }) {
        const features = await listFeatures(db, person);
        const asked = person.admin ? (await db.query(
          `SELECT a.id, a.created_at, f.key, f.title, p.name, p.email
             FROM access_requests a JOIN features f ON f.id = a.feature_id JOIN people p ON p.id = a.person_id
            WHERE a.resolved_at IS NULL ORDER BY a.created_at`,
        )).rows : [];
        const empty = person.admin
          ? 'Nothing is published yet. Publish a prototype from your laptop and it shows up here.'
          : 'Nothing is shared with you yet. When someone shares a feature, it shows up here.';
        sendHtml(res, 200, layout({
          title: 'Features', person, token, section: 'home',
          body: html`<h1>${person.admin ? 'All features' : 'Shared with you'}</h1>
${requests(asked, token)}
${features.length ? html`<ul class="list">${features.map(row)}</ul>` : html`<p class="empty">${empty}</p>`}`,
        }));
      },
    },
    {
      method: 'GET', path: '/healthz', auth: 'public', ready: false,
      async run({ res }) {
        try {
          const last = (await db.query('SELECT max(name) AS name FROM schema_migrations')).rows[0]?.name ?? '';
          sendJson(res, 200, { ok: true, migration: last.replace(/\.sql$/, '') });
        } catch {
          sendJson(res, 503, { ok: false, error: 'The database can’t be reached.' });
        }
      },
    },
  ];
}
