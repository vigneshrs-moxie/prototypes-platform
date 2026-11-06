// A feature's page and the pages around it.
//   GET  /f/<key>                 the feature (a shell: P5 fills the frame), or Request access
//   POST /f/<key>/request-access  records the request
// The page, the PDF, and the Requirements and Decisions pages are P5's; until then they check
// access and say "not yet", and the blob is never sent.
//
// Someone who can't see a feature gets the same Request access page whether or not it exists, and
// nothing about it: not its title, not its ticket. Only an admin ever gets a 404.

import { canSee, loadFeature } from './access.js';
import { HttpError, redirect, sendHtml } from './http.js';
import { buttonForm, count, dateLabel, html, layout } from './render.js';
import { iso } from './sessions.js';

export const KEY = '([a-z0-9][a-z0-9-]{0,79})';

function askPage({ person, token, key, asked }) {
  return layout({
    title: 'Request access', person, token,
    body: html`<section class="card narrow">
  <h1>You don’t have access to this yet</h1>
  ${asked
    ? html`<p class="notice" role="status">Asked. An admin will add you.</p>`
    : html`<p class="muted">Ask for access and an admin will add you. You’ll see it on your home page once they do.</p>
  ${buttonForm({ action: `/f/${key}/request-access`, token, label: 'Request access', cls: 'btn primary' })}`}
</section>`,
  });
}

/** The feature, if this person may see it. Otherwise this answers the request and returns null. */
export async function featureOr403(ctx, { res, person, token }, key) {
  const feature = await loadFeature(ctx.db, key, person);
  if (canSee(person, feature)) return feature;
  if (person.admin) throw new HttpError(404, 'There’s no feature at this address.');
  const asked = feature ? (await ctx.db.query('SELECT 1 FROM access_requests WHERE feature_id = $1 AND person_id = $2 AND resolved_at IS NULL', [feature.id, person.id])).rows.length > 0 : false;
  sendHtml(res, 403, askPage({ person, token, key, asked }));
  return null;
}

/** What's new in this revision: the page's own history entry, else the publish's changes line. */
function whatsNew(revision) {
  const history = revision.manifest?.history;
  const entry = Array.isArray(history) ? history.find((h) => h?.rev === revision.page_version) ?? null : null;
  const note = entry?.note || revision.changes;
  const names = (list) => (Array.isArray(list) ? list.map((c) => c?.name).filter(Boolean) : []);
  const groups = [['Changed', names(entry?.changed)], ['Added', names(entry?.added)], ['Removed', names(entry?.removed)]].filter(([, n]) => n.length);
  if (!note && !groups.length) return null;
  return html`<section class="block"><h2>What’s new</h2>
${note && html`<p>${note}</p>`}
${groups.length > 0 && html`<dl class="changes">${groups.map(([word, list]) => html`<dt>${word}</dt><dd>${list.join(', ')}</dd>`)}</dl>`}
</section>`;
}

export function featureHeader({ feature, person, section, noteCount, r }) {
  const here = (key) => (section === key ? 'tab on' : 'tab');
  const suffix = r ? `?r=${r}` : '';
  return html`<div class="feature-head">
  <div class="grow">
    <h1>${feature.title}</h1>
    <p class="muted">
      ${feature.ticket_url ? html`<a href="${feature.ticket_url}" rel="noopener noreferrer">${feature.ticket_key || 'Ticket'}</a> · ` : feature.ticket_key && `${feature.ticket_key} · `}
      Updated ${dateLabel(feature.updated_at)}${feature.archived_at && ' · Archived'}
    </p>
  </div>
  ${person.admin && html`<a class="btn" href="/f/${feature.key}/shares">Sharing</a>`}
</div>
<nav class="tabs" aria-label="This feature">
  <a class="${here('prototype')}" href="/f/${feature.key}${suffix}">Prototype</a>
  <a class="${here('requirements')}" href="/f/${feature.key}/requirements${suffix}">Requirements</a>
  <a class="${here('decisions')}" href="/f/${feature.key}/decisions${suffix}">Decisions</a>
  <span class="tab count">${count(noteCount, 'note')}</span>
</nav>`;
}

export default function featureRoutes(ctx) {
  const { db, now } = ctx;
  const noteCount = async (feature) => (await db.query('SELECT count(*)::int AS n FROM notes WHERE feature_id = $1 AND deleted_at IS NULL', [feature.id])).rows[0].n;

  /** What P5 replaces: it checks access exactly as the real page will. */
  const notYet = (word) => async (call) => {
    const feature = await featureOr403(ctx, call, call.m[1]);
    if (!feature) return;
    throw new HttpError(404, `${word} isn’t on the site yet.`);
  };

  return [
    {
      method: 'GET', path: new RegExp(`^/f/${KEY}$`), auth: 'session',
      async run(call) {
        const { res, person, token, url } = call;
        const feature = await featureOr403(ctx, call, call.m[1]);
        if (!feature) return;
        const { rows: revisions } = await db.query(
          `SELECT r.n, r.changes, r.manifest, r.page_version, r.published_at, (r.pdf_blob IS NOT NULL) AS has_pdf
             FROM revisions r JOIN documents d ON d.id = r.document_id
            WHERE d.feature_id = $1 AND d.type = 'prototype' ORDER BY r.n DESC`,
          [feature.id],
        );
        const latest = revisions[0]?.n ?? 0;
        const asked = url.searchParams.has('r') ? Number(url.searchParams.get('r')) : latest;
        const revision = revisions.find((r) => r.n === asked);
        if (latest && !revision) throw new HttpError(404, `This feature has no revision ${url.searchParams.get('r')}.`);
        sendHtml(res, 200, layout({
          title: feature.title, person, token,
          body: html`${featureHeader({ feature, person, section: 'prototype', noteCount: await noteCount(feature), r: asked === latest ? null : asked })}
${revisions.length > 1 && html`<nav class="revisions" aria-label="Revisions">${revisions.map((r) => html`<a class="chip" href="/f/${feature.key}?r=${r.n}"${r.n === asked ? html` aria-current="true"` : ''}>Revision ${r.n}${r.n === latest && ' (latest)'}</a>`)}</nav>`}
<section class="frame-area" data-page="/f/${feature.key}/r${asked}/page">
  ${revision
    ? html`<p class="muted">Revision ${asked}, published ${dateLabel(revision.published_at)}. The prototype will open here.</p>`
    : html`<p class="muted">Nothing is published here yet.</p>`}
</section>
${revision && whatsNew(revision)}`,
        }));
      },
    },
    {
      method: 'POST', path: new RegExp(`^/f/${KEY}/request-access$`), auth: 'session',
      async run(call) {
        const { res, person, token } = call;
        const key = call.m[1];
        const feature = await loadFeature(db, key, person);
        if (canSee(person, feature)) return redirect(res, `/f/${key}`);
        if (feature) {
          await db.query('INSERT INTO access_requests (feature_id, person_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [feature.id, person.id, iso(now())]);
        }
        sendHtml(res, 200, askPage({ person, token, key, asked: true }));
      },
    },
    { method: 'GET', path: new RegExp(`^/f/${KEY}/r\\d{1,6}/page$`), auth: 'session', run: notYet('The prototype page') },
    { method: 'GET', path: new RegExp(`^/f/${KEY}/r\\d{1,6}/pack\\.pdf$`), auth: 'session', run: notYet('The PDF') },
    { method: 'GET', path: new RegExp(`^/f/${KEY}/requirements$`), auth: 'session', run: notYet('The requirements page') },
    { method: 'GET', path: new RegExp(`^/f/${KEY}/decisions$`), auth: 'session', run: notYet('The decisions page') },
  ];
}
