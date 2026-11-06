// Settings and people, for admins.
//   GET    /settings                  your publish tokens
//   POST   /settings/tokens           make one: shown once, on the answer to this post
//   DELETE /settings/tokens/<id>      revoke one of yours
//   GET    /people                    everyone who has signed in
//   POST   /people/<id>/revoke        ends all that person's sessions
//
// A token is 32 random bytes, ptp_<base64url>, kept only as a SHA-256 and tied to one admin. The
// token auth itself is in tokens.js.

import { randomToken, sha256 } from './google.js';
import { HttpError, redirect, sendHtml } from './http.js';
import { buttonForm, dateLabel, formField, html, layout } from './render.js';
import { iso } from './sessions.js';

export default function settingsRoutes(ctx) {
  const { db, config, now } = ctx;

  async function settings({ res, person, token }, { made = null, problem = null } = {}) {
    const { rows } = await db.query('SELECT id, label, created_at, last_used_at, revoked_at FROM publish_tokens WHERE person_id = $1 ORDER BY created_at DESC', [person.id]);
    sendHtml(res, problem ? 400 : 200, layout({
      title: 'Settings', person, token, section: 'settings',
      body: html`<h1>Settings</h1>
<section class="block"><h2>Publish tokens</h2>
<p class="muted">A token lets a laptop publish with <code>publish.py</code>. It’s yours alone, and it stops working if you stop being an admin.</p>
${made && html`<div class="notice" role="status">
  <p><strong>Copy this now. It won’t be shown again.</strong></p>
  <p class="linkline"><code>${made}</code> <button class="btn quiet" type="button" data-copy="${made}" hidden>Copy</button></p>
  <p>Put it in <code>~/.claude/prototypes.json</code> as <code>{"site": "${config.siteUrl}", "token": "…"}</code>, then <code>chmod 600</code> that file.</p>
</div>`}
<form class="add" method="post" action="/settings/tokens">${formField(token)}
  <label for="label">New token</label>
  <div class="field"><input id="label" name="label" required maxlength="80" autocomplete="off" placeholder="My laptop"><button class="btn primary" type="submit">Make token</button></div>
  ${problem && html`<p class="notice bad" role="alert">${problem}</p>`}
</form>
${rows.length
    ? html`<ul class="list">${rows.map((t) => html`<li class="row">
  <span class="grow"><strong>${t.label}</strong><small>Made ${dateLabel(t.created_at)} · ${t.last_used_at ? `Last used ${dateLabel(t.last_used_at)}` : 'Never used'}</small></span>
  ${t.revoked_at ? html`<span class="tag">Revoked</span>` : buttonForm({ action: `/settings/tokens/${t.id}`, token, label: 'Revoke', method: 'DELETE', cls: 'btn quiet' })}
</li>`)}</ul>`
    : html`<p class="empty">No tokens yet.</p>`}
</section>`,
    }));
  }

  return [
    { method: 'GET', path: '/settings', auth: 'admin', run: (call) => settings(call) },
    {
      method: 'POST', path: '/settings/tokens', auth: 'admin',
      async run(call) {
        const { person, form } = call;
        const label = String(form?.get('label') ?? '').trim().slice(0, 80);
        if (!label) return settings(call, { problem: 'Give the token a name.' });
        const made = `ptp_${randomToken(32)}`;
        await db.query('INSERT INTO publish_tokens (person_id, token_hash, label, created_at) VALUES ($1, $2, $3, $4)', [person.id, sha256(made), label, iso(now())]);
        await settings(call, { made });
      },
    },
    {
      method: 'DELETE', path: /^\/settings\/tokens\/(\d{1,18})$/, auth: 'admin',
      async run({ res, person, m }) {
        await db.query('UPDATE publish_tokens SET revoked_at = $3 WHERE id = $1 AND person_id = $2 AND revoked_at IS NULL', [m[1], person.id, iso(now())]);
        redirect(res, '/settings');
      },
    },
    {
      method: 'GET', path: '/people', auth: 'admin',
      async run({ res, person, token }) {
        const { rows } = await db.query(
          `SELECT p.id, p.name, p.email, p.last_sign_in_at,
              (SELECT count(*)::int FROM sessions s WHERE s.person_id = p.id AND s.revoked_at IS NULL AND s.expires_at > $1) AS live
             FROM people p ORDER BY p.name, p.email`,
          [iso(now())],
        );
        sendHtml(res, 200, layout({
          title: 'People', person, token, section: 'people',
          body: html`<h1>People</h1>
<p class="muted">Everyone who has signed in. Being an admin is a site setting, so it isn’t changed here.</p>
<ul class="list">${rows.map((p) => html`<li class="row">
  <span class="grow"><strong>${p.name || p.email}</strong><small>${p.email} · Last signed in ${dateLabel(p.last_sign_in_at)}</small></span>
  ${config.adminEmails().has(p.email) && html`<span class="tag">Admin</span>`}
  ${p.live > 0 ? buttonForm({ action: `/people/${p.id}/revoke`, token, label: 'Sign out everywhere', cls: 'btn quiet' }) : html`<span class="tag">Signed out</span>`}
</li>`)}</ul>`,
        }));
      },
    },
    {
      method: 'POST', path: /^\/people\/(\d{1,18})\/revoke$/, auth: 'admin',
      async run({ res, m }) {
        const found = (await db.query('SELECT id FROM people WHERE id = $1', [m[1]])).rows[0];
        if (!found) throw new HttpError(404, 'There’s nobody with that id.');
        await ctx.sessions.revokeAll(found.id);
        redirect(res, '/people');
      },
    },
  ];
}
