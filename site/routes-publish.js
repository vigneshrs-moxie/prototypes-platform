// POST /api/publish: the laptop's upload, from publish.py (reference/publish.md in the wireframe
// skill is the contract). Multipart, with a publish token. The first publish makes the feature; each
// one after adds revision n+1. Requirements and decisions, when sent, take the same n.
//
// Blobs are written first under a fresh id, then one transaction records everything, so two
// publishes at once get different numbers and a failed publish leaves nothing behind.

import crypto from 'node:crypto';
import { HttpError, readBody, sendJson } from './http.js';
import { parseMultipart } from './multipart.js';
import { iso } from './sessions.js';

export const LIMITS = { page: 5e6, pdf: 25e6, markdown: 1e6, manifest: 1e6, perHour: 60 };
const MAX_REQUEST = LIMITS.page + LIMITS.pdf + 2 * LIMITS.markdown + LIMITS.manifest + 1e5;
const KEY = /^[a-z0-9][a-z0-9-]{0,79}$/;
const HOUR = 60 * 60 * 1000;

const bad = (why) => new HttpError(400, why);
const MB = (n) => `${n / 1e6} MB`;

/** A text part, trimmed; '' when it's missing. */
function text(parts, name, max) {
  const p = parts.get(name);
  if (!p) return '';
  if (p.filename !== null && !['requirements', 'decisions'].includes(name)) throw bad(`${name} must be text, not a file.`);
  const s = p.data.toString('utf8').trim();
  if (s.length > max) throw bad(`${name} is too long: at most ${max} characters.`);
  return s;
}

function file(parts, name, limit) {
  const p = parts.get(name);
  if (!p) return null;
  if (!p.data.length) throw bad(`${name} is empty.`);
  if (p.data.length > limit) throw new HttpError(413, `${name} is too big: at most ${MB(limit)}.`);
  return p.data;
}

function markdown(parts, name) {
  const p = parts.get(name);
  if (p && p.data.length > LIMITS.markdown) throw new HttpError(413, `${name} is too big: at most ${MB(LIMITS.markdown)}.`);
  return text(parts, name, LIMITS.markdown) || null;
}

function manifestOf(parts) {
  const p = parts.get('manifest');
  if (!p) throw bad('The manifest is missing.');
  if (p.data.length > LIMITS.manifest) throw new HttpError(413, `manifest is too big: at most ${MB(LIMITS.manifest)}.`);
  let m;
  try { m = JSON.parse(p.data.toString('utf8')); } catch { throw bad('The manifest isn’t valid JSON.'); }
  if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('The manifest must be a JSON object.');
  for (const list of ['screens', 'choices', 'questions', 'history']) {
    if (!Array.isArray(m[list])) throw bad(`The manifest’s ${list} must be a list.`);
  }
  return m;
}

/** The request, checked. Nothing here has touched storage yet. */
function checked(parts) {
  const key = text(parts, 'key', 80);
  if (!KEY.test(key)) throw bad('The key must be lower-case letters, numbers and dashes.');
  const title = text(parts, 'title', 200);
  if (!title) throw bad('The title is missing.');
  const pageVersion = text(parts, 'page_version', 9);
  if (!/^\d+$/.test(pageVersion)) throw bad('page_version must be a number.');
  const page = file(parts, 'page', LIMITS.page);
  if (!page) throw bad('The page is missing.');
  const ticketUrl = text(parts, 'ticket_url', 500);
  if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) throw bad('ticket_url must start with http:// or https://.');
  return {
    key, title, page, ticketUrl: ticketUrl || null,
    pageVersion: Number(pageVersion),
    ticketKey: text(parts, 'ticket_key', 40) || null,
    jobSlug: text(parts, 'job_slug', 120) || null,
    changes: text(parts, 'changes', 1000) || null,
    pdf: file(parts, 'pdf', LIMITS.pdf),
    manifest: manifestOf(parts),
    requirements: markdown(parts, 'requirements'),
    decisions: markdown(parts, 'decisions'),
  };
}

export default function publishRoutes(ctx) {
  const { db, config, now } = ctx;

  /** This feature's document of this type, made the first time it's published. */
  async function documentId(q, featureId, type, t) {
    await q.query("INSERT INTO documents (feature_id, type, audience, created_at) VALUES ($1, $2, 'people', $3) ON CONFLICT (feature_id, type) DO NOTHING", [featureId, type, t]);
    return (await q.query('SELECT id FROM documents WHERE feature_id = $1 AND type = $2', [featureId, type])).rows[0].id;
  }

  async function record(p, { pageBlob, pdfBlob, publisher }) {
    const t = iso(now());
    return db.tx(async (q) => {
      const personId = publisher.person.id;
      const made = (await q.query(
        `INSERT INTO features (key, title, ticket_key, ticket_url, job_slug, created_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7) ON CONFLICT (key) DO NOTHING RETURNING id`,
        [p.key, p.title, p.ticketKey, p.ticketUrl, p.jobSlug, personId, t],
      )).rows[0];
      // This row's lock is what makes two publishes take turns for a number.
      const feature = (await q.query('SELECT id, archived_at FROM features WHERE key = $1 FOR UPDATE', [p.key])).rows[0];
      if (feature.archived_at) throw new HttpError(409, 'This feature is archived, so it can’t take a new revision.');
      if (!made) {
        await q.query(
          `UPDATE features SET title = $2, updated_at = $3, ticket_key = COALESCE($4, ticket_key),
              ticket_url = COALESCE($5, ticket_url), job_slug = COALESCE($6, job_slug) WHERE id = $1`,
          [feature.id, p.title, t, p.ticketKey, p.ticketUrl, p.jobSlug],
        );
      }
      const prototype = await documentId(q, feature.id, 'prototype', t);
      const n = (await q.query('SELECT COALESCE(max(n), 0) + 1 AS n FROM revisions WHERE document_id = $1', [prototype])).rows[0].n;
      await q.query(
        `INSERT INTO revisions (document_id, n, page_blob, pdf_blob, manifest, changes, page_version, published_by, token_id, published_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [prototype, n, pageBlob, pdfBlob, JSON.stringify(p.manifest), p.changes, p.pageVersion, personId, publisher.id, t],
      );
      for (const [type, body] of [['requirements', p.requirements], ['decisions', p.decisions]]) {
        if (!body) continue;
        const doc = await documentId(q, feature.id, type, t);
        await q.query('INSERT INTO revisions (document_id, n, body, published_by, published_at) VALUES ($1, $2, $3, $4, $5)', [doc, n, body, personId, t]);
      }
      return { revision: Number(n), created: Boolean(made) };
    });
  }

  return [
    {
      method: 'POST', path: '/api/publish', auth: 'token',
      async run({ req, res, publisher, note }) {
        const since = iso(now() - HOUR);
        const used = (await db.query('SELECT count(*)::int AS n FROM revisions WHERE token_id = $1 AND published_at > $2', [publisher.id, since])).rows[0].n;
        if (used >= LIMITS.perHour) throw new HttpError(429, `That’s ${LIMITS.perHour} publishes this hour, the most a token may do. Try again later.`);
        const p = checked(parseMultipart(await readBody(req, { max: MAX_REQUEST }), req.headers['content-type']));
        note.key = p.key;
        const base = `features/${p.key}/${crypto.randomUUID()}`;
        const pageBlob = `${base}/page.html`;
        const pdfBlob = p.pdf ? `${base}/pack.pdf` : null;
        await ctx.blob.put(pageBlob, p.page, 'text/html; charset=utf-8');
        if (pdfBlob) await ctx.blob.put(pdfBlob, p.pdf, 'application/pdf');
        try {
          const { revision, created } = await record(p, { pageBlob, pdfBlob, publisher });
          sendJson(res, 200, { key: p.key, revision, url: `${config.siteUrl}/f/${p.key}`, created });
        } catch (err) {
          await ctx.blob.remove([pageBlob, pdfBlob].filter(Boolean));
          throw err;
        }
      },
    },
  ];
}
