// Tiny HTML templating. html`…` escapes every value unless it came from html`…` or raw(), so a
// title, a name or a note can't become markup. layout() is the page around every screen.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

class Safe {
  constructor(text) { this.text = text; }
  toString() { return this.text; }
}

/** Text that is already safe HTML (the markdown helper's output, say). */
export const raw = (text) => new Safe(String(text));

const piece = (v) => {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (Array.isArray(v)) return v.map(piece).join('');
  return v instanceof Safe ? v.text : escapeHtml(v);
};

export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += piece(v) + strings[i + 1]; });
  return new Safe(out);
}

const DAY = { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', year: 'numeric' };

/** A date as people read it, in Phoenix. */
export const dateLabel = (t) => (t ? new Date(t).toLocaleDateString('en-US', DAY) : '');

/** "1 note", "2 notes". */
export const count = (n, word) => `${n} ${word}${Number(n) === 1 ? '' : 's'}`;

/** The hidden field every form carries. */
export const formField = (token) => html`<input type="hidden" name="_token" value="${token}">`;

/** A form with one button: the page's way to send a change. method DELETE goes as a field. */
export function buttonForm({ action, token, label, method = 'POST', cls = 'btn', fields = {} }) {
  return html`<form class="inline" method="post" action="${action}">${formField(token)}${method === 'POST' ? '' : html`<input type="hidden" name="_method" value="${method}">`}${Object.entries(fields).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}<button class="${cls}" type="submit">${label}</button></form>`;
}

function header({ person, token, section }) {
  const link = (href, label, key) => html`<a href="${href}"${section === key ? raw(' aria-current="page"') : ''}>${label}</a>`;
  return html`<header class="bar">
  <a class="brand" href="/"><span class="mark" aria-hidden="true"></span>Orbit Prototypes</a>
  ${person && html`<nav class="nav" aria-label="Main">${link('/', 'Features', 'home')}${person.admin && link('/people', 'People', 'people')}${person.admin && link('/settings', 'Settings', 'settings')}</nav>`}
  <div class="who">
    <button class="btn quiet" type="button" data-theme-toggle hidden>Dark</button>
    ${person && html`<span class="name">${person.name || person.email}</span>${buttonForm({ action: '/auth/sign-out', token, label: 'Sign out', cls: 'btn quiet' })}`}
  </div>
</header>`;
}

/** A whole page. person and token are empty on the sign-in page. */
export function layout({ title, person = null, token = '', section = '', body, plain = false }) {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Orbit Prototypes</title>
<link rel="stylesheet" href="/site.css">
<script src="/site.js"></script>
</head>
<body>
${!plain && header({ person, token, section })}
<main class="${plain ? 'center' : 'page'}">${body}</main>
</body>
</html>
`;
}
