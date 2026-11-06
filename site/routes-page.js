// What a feature holds, each behind the same check.
//   GET /f/<key>/r<n>/page       the prototype, only ever inside the sandboxed frame
//   GET /f/<key>/r<n>/pack.pdf   the PDF, as a download
//   GET /f/<key>/requirements    ?r=<n>: as of that revision
//   GET /f/<key>/decisions       ?r=<n>: as of that revision

import { canSee } from './access.js';
import { HttpError, PAGE_HEADERS, redirect, sendHtml, SITE_HEADERS } from './http.js';
import { renderMarkdown } from './markdown.js';
import { html, layout, raw } from './render.js';
import { featureHeader, featureOr403, KEY, noteCount } from './routes-feature.js';

/** One revision of a feature's prototype, or its latest when n is null. Null when there's none. */
export async function prototypeRevision(db, feature, n = null) {
  const { rows } = await db.query(
    `SELECT r.id, r.n, r.page_blob, r.pdf_blob, d.audience
       FROM revisions r JOIN documents d ON d.id = r.document_id
      WHERE d.feature_id = $1 AND d.type = 'prototype' AND ($2::int IS NULL OR r.n = $2)
      ORDER BY r.n DESC LIMIT 1`,
    [feature.id, n],
  );
  return rows[0] ?? null;
}

/** The address's file name for a download: letters and numbers in the plain one, the rest in filename*. */
export function attachment(title, n) {
  const name = `${String(title).replace(/[\r\n"\\/]+/g, ' ').trim() || 'Prototype'} r${n}.pdf`;
  const plain = name.replace(/[^\x20-\x7e]+/g, '-');
  return `attachment; filename="${plain}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Comments in a decisions file are notes to the Foreman, not for readers. */
const withoutComments = (text) => String(text).replace(/<!--[\s\S]*?-->/g, '');

/**
 * A decisions table with the words "Ops not asked" beside each row still waiting on ops (D26). The
 * row's why starts with those words; who stops being the Foreman once someone confirms it.
 */
export function markOpsNotAsked(rendered) {
  return String(rendered).replace(/<tr>[\s\S]*?<\/tr>/g, (row) => {
    const cells = [...row.matchAll(/<td>([\s\S]*?)<\/td>/g)];
    const at = cells.findIndex((c) => c[1].startsWith('Ops not asked:'));
    if (at < 2 || cells[at - 2][1].trim() !== 'Foreman') return row;
    return row.replace(cells[at][0], `<td><span class="tag">Ops not asked</span> ${cells[at][1]}</td>`);
  });
}

export default function pageRoutes(ctx) {
  const { db, blob } = ctx;

  /** The feature and this revision of it, if this person may see them; null once it has answered. */
  async function revisionOr403(call) {
    const feature = await featureOr403(ctx, call, call.m[1]);
    if (!feature) return null;
    const revision = await prototypeRevision(db, feature, Number(call.m[2]));
    if (!revision) throw new HttpError(404, `This feature has no revision ${call.m[2]}.`);
    if (!canSee(call.person, feature, revision)) throw new HttpError(403, 'This is for admins only.');
    return { feature, revision };
  }

  /** The newest body of a requirements or decisions document at or before revision n. */
  async function documentAt(feature, type, n) {
    const { rows } = await db.query(
      `SELECT r.n, r.body, d.audience FROM revisions r JOIN documents d ON d.id = r.document_id
        WHERE d.feature_id = $1 AND d.type = $2 AND ($3::int IS NULL OR r.n <= $3) ORDER BY r.n DESC LIMIT 1`,
      [feature.id, type, n],
    );
    return rows[0] ?? null;
  }

  const documentPage = (type, word, finish = (x) => x) => ({
    method: 'GET', path: new RegExp(`^/f/${KEY}/${type}$`), auth: 'session',
    async run(call) {
      const { res, person, token, url } = call;
      const feature = await featureOr403(ctx, call, call.m[1]);
      if (!feature) return;
      const given = url.searchParams.get('r');
      if (given !== null && !/^\d{1,6}$/.test(given)) throw new HttpError(404, 'There’s no such revision.');
      const latest = (await prototypeRevision(db, feature))?.n ?? null;
      const n = given === null ? latest : Number(given);
      const doc = await documentAt(feature, type, n);
      if (doc && !canSee(person, feature, doc)) throw new HttpError(403, 'This is for admins only.');
      sendHtml(res, 200, layout({
        title: `${word} · ${feature.title}`, person, token,
        body: html`${featureHeader({ feature, person, section: type, noteCount: await noteCount(db, feature), r: n === latest ? null : n })}
${doc
  ? html`<p class="muted">As of revision ${doc.n}.</p><article class="doc">${raw(finish(renderMarkdown(withoutComments(doc.body))))}</article>`
  : html`<p class="empty">No ${word.toLowerCase()} published yet.</p>`}`,
      }));
    },
  });

  return [
    {
      method: 'GET', path: new RegExp(`^/f/${KEY}/r(\\d{1,6})/page$`), auth: 'session',
      async run(call) {
        const { req, res, m } = call;
        const found = await revisionOr403(call);
        if (!found) return;
        // Asked for as a document, not a frame: the page must never run as the top page.
        if (req.headers['sec-fetch-dest'] === 'document') return redirect(res, `/f/${m[1]}?r=${m[2]}`);
        const file = await blob.read(found.revision.page_blob);
        if (!file) throw new HttpError(404, 'This revision’s page is missing from storage.');
        res.writeHead(200, { ...PAGE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(file.bytes);
      },
    },
    {
      method: 'GET', path: new RegExp(`^/f/${KEY}/r(\\d{1,6})/pack\\.pdf$`), auth: 'session',
      async run(call) {
        const found = await revisionOr403(call);
        if (!found) return;
        if (!found.revision.pdf_blob) throw new HttpError(404, 'This revision has no PDF.');
        const file = await blob.read(found.revision.pdf_blob);
        if (!file) throw new HttpError(404, 'This revision’s PDF is missing from storage.');
        call.res.writeHead(200, { ...SITE_HEADERS, 'Content-Type': 'application/pdf', 'Content-Disposition': attachment(found.feature.title, found.revision.n) });
        call.res.end(file.bytes);
      },
    },
    documentPage('requirements', 'Requirements'),
    documentPage('decisions', 'Decisions', markOpsNotAsked),
  ];
}
