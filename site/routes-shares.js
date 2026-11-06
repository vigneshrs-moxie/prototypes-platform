// Sharing, for admins. A share is an email address: no email is sent (D15), so the admin copies the
// link and sends it themselves.
//   GET    /f/<key>/shares               the share list and open requests
//   POST   /f/<key>/shares               add by email (also resolves that person's request)
//   DELETE /f/<key>/shares               remove (email in the form)
//   DELETE /f/<key>/requests/<id>         dismiss a request

import { HttpError, redirect, sendHtml } from './http.js';
import { buttonForm, dateLabel, formField, html, layout } from './render.js';
import { iso } from './sessions.js';
import { KEY } from './routes-feature.js';

const EMAIL = /^[^@\s]{1,100}@[^@\s]{1,150}$/;

export default function shareRoutes(ctx) {
  const { db, config, now } = ctx;

  async function feature(key) {
    const f = (await db.query('SELECT id, key, title FROM features WHERE key = $1', [key])).rows[0];
    if (!f) throw new HttpError(404, 'There’s no feature at this address.');
    return f;
  }

  async function page({ res, person, token }, f, { problem = null, email = '' } = {}) {
    const { rows: shares } = await db.query('SELECT email, added_at FROM shares WHERE feature_id = $1 AND removed_at IS NULL ORDER BY added_at', [f.id]);
    const { rows: asked } = await db.query(
      `SELECT a.id, a.created_at, p.name, p.email FROM access_requests a JOIN people p ON p.id = a.person_id
        WHERE a.feature_id = $1 AND a.resolved_at IS NULL ORDER BY a.created_at`,
      [f.id],
    );
    const link = `${config.siteUrl}/f/${f.key}`;
    sendHtml(res, problem ? 400 : 200, layout({
      title: `Sharing ${f.title}`, person, token,
      body: html`<p class="crumb"><a href="/f/${f.key}">← ${f.title}</a></p>
<h1>Sharing</h1>
<p class="muted">Admins always see this. Add anyone else by their Moxie email. Nobody gets an email, so send them the link yourself.</p>
<p class="linkline"><code>${link}</code> <button class="btn quiet" type="button" data-copy="${link}" hidden>Copy link</button></p>
<form class="add" method="post" action="/f/${f.key}/shares">${formField(token)}
  <label for="email">Add a person</label>
  <div class="field"><input id="email" name="email" type="email" required autocomplete="off" value="${email}" placeholder="name@${config.allowedDomain}"><button class="btn primary" type="submit">Add</button></div>
  ${problem && html`<p class="notice bad" role="alert">${problem}</p>`}
</form>
${asked.length > 0 && html`<section class="block"><h2>Asked for access</h2><ul class="list">${asked.map((a) => html`<li class="row">
  <span class="grow"><strong>${a.name || a.email}</strong><small>${a.email}, on ${dateLabel(a.created_at)}</small></span>
  ${buttonForm({ action: `/f/${f.key}/shares`, token, label: 'Add them', cls: 'btn primary', fields: { email: a.email } })}
  ${buttonForm({ action: `/f/${f.key}/requests/${a.id}`, token, label: 'Dismiss', method: 'DELETE', cls: 'btn quiet' })}
</li>`)}</ul></section>`}
<section class="block"><h2>Shared with</h2>
${shares.length
    ? html`<ul class="list">${shares.map((s) => html`<li class="row"><span class="grow"><strong>${s.email}</strong><small>Added ${dateLabel(s.added_at)}</small></span>${buttonForm({ action: `/f/${f.key}/shares`, token, label: 'Remove', method: 'DELETE', cls: 'btn quiet', fields: { email: s.email } })}</li>`)}</ul>`
    : html`<p class="empty">Not shared with anyone yet.</p>`}
</section>`,
    }));
  }

  return [
    {
      method: 'GET', path: new RegExp(`^/f/${KEY}/shares$`), auth: 'admin',
      async run(call) { await page(call, await feature(call.m[1])); },
    },
    {
      method: 'POST', path: new RegExp(`^/f/${KEY}/shares$`), auth: 'admin',
      async run(call) {
        const { res, person, form } = call;
        const f = await feature(call.m[1]);
        const email = String(form?.get('email') ?? '').trim().toLowerCase();
        if (!EMAIL.test(email)) return page(call, f, { problem: 'Type an email address.', email });
        if (!email.endsWith(`@${config.allowedDomain}`)) return page(call, f, { problem: `Only ${config.allowedDomain} accounts can sign in here.`, email });
        const t = iso(now());
        await db.tx(async (q) => {
          await q.query('INSERT INTO shares (feature_id, email, added_by, added_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [f.id, email, person.id, t]);
          await q.query(
            `UPDATE access_requests SET resolved_at = $3, resolved_by = $4
              WHERE feature_id = $1 AND resolved_at IS NULL AND person_id IN (SELECT id FROM people WHERE email = $2)`,
            [f.id, email, t, person.id],
          );
        });
        redirect(res, `/f/${f.key}/shares`);
      },
    },
    {
      method: 'DELETE', path: new RegExp(`^/f/${KEY}/shares$`), auth: 'admin',
      async run({ res, person, form, m }) {
        const f = await feature(m[1]);
        const email = String(form?.get('email') ?? '').trim().toLowerCase();
        await db.query('UPDATE shares SET removed_at = $3, removed_by = $4 WHERE feature_id = $1 AND email = $2 AND removed_at IS NULL', [f.id, email, iso(now()), person.id]);
        redirect(res, `/f/${f.key}/shares`);
      },
    },
    {
      method: 'DELETE', path: new RegExp(`^/f/${KEY}/requests/(\\d{1,18})$`), auth: 'admin',
      async run({ res, person, m }) {
        const f = await feature(m[1]);
        await db.query('UPDATE access_requests SET resolved_at = $3, resolved_by = $4 WHERE id = $1 AND feature_id = $2 AND resolved_at IS NULL', [m[2], f.id, iso(now()), person.id]);
        redirect(res, `/f/${f.key}/shares`);
      },
    },
  ];
}
