// Starbase's Docs helper: renders Markdown (requirements, decisions) to safe HTML.
// Raw HTML in the source is shown as text, unsafe link schemes are dropped, and
// requirement IDs (FR-001, AC-003, D-005, …) become links to their definition.

import MarkdownIt from 'markdown-it';

// IDs the workflow uses: FR/AC/D/Q/R/S/M/P/A/G and review prefixes, e.g. FR-001, AC-9, G1b, R-2.
export const ID_PATTERN = /\b(?:FR|AC|NFR|D|Q|R|S|M|P|A|T|CONV|PERM|ERR|DB|UI|PERF|TEST|REV)-\d{1,3}[a-z]?\b/g;

const SAFE_LINK = /^(https?:|mailto:|#)/i;

function slugify(s) {
  return String(s).toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80);
}

export function createRenderer() {
  const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });
  // A link with a scheme must be a safe one; "//host" (and "/\host", which browsers read the same way;
  // markdown-it hands it over as "/%5Chost") would leave the site for another one without
  // saying so, so it is dropped too.
  md.validateLink = (url) => {
    const u = url.trim();
    if (/^(?:[\\/]|%5c){2}/i.test(u)) return false;
    return SAFE_LINK.test(u) || !/^[a-z][a-z0-9+.-]*:/i.test(u);
  };

  // Mark text tokens that sit inside links so IDs aren't nested inside another link.
  md.core.ruler.push('workshop_ids', (state) => {
    for (const block of state.tokens) {
      if (block.type !== 'inline' || !block.children) continue;
      let depth = 0;
      for (const tok of block.children) {
        if (tok.type === 'link_open') depth++;
        else if (tok.type === 'link_close') depth--;
        else if (tok.type === 'text' && depth > 0) tok.meta = { ...(tok.meta ?? {}), inLink: true };
      }
    }
  });

  // Task lists ("- [ ] to do", "- [x] done") show a ticked or empty box instead of the brackets.
  // The box is fixed markup (a disabled checkbox), never text from the document.
  md.core.ruler.push('workshop_tasks', (state) => {
    const toks = state.tokens;
    for (let i = 2; i < toks.length; i++) {
      const inline = toks[i];
      if (inline.type !== 'inline' || toks[i - 1].type !== 'paragraph_open' || toks[i - 2].type !== 'list_item_open') continue;
      const first = inline.children?.[0];
      const m = first?.type === 'text' ? /^\[([ xX])\]\s+/.exec(first.content) : null;
      if (!m) continue;
      const done = m[1] !== ' ';
      first.content = first.content.slice(m[0].length);
      const box = new state.Token('html_inline', '', 0);
      box.content = `<input class="task-box" type="checkbox" disabled${done ? ' checked' : ''} aria-label="${done ? 'Done' : 'Not done'}"> `;
      inline.children.unshift(box);
      toks[i - 2].attrJoin('class', 'task-item');
    }
  });

  const escape = md.utils.escapeHtml;
  md.renderer.rules.text = (tokens, idx, _opts, env) => {
    const tok = tokens[idx];
    const html = escape(tok.content);
    if (tok.meta?.inLink || !env?.idHref) return html;
    // IDs contain only [A-Za-z0-9-], so inserting them after escaping is safe.
    return html.replace(ID_PATTERN, (id) => `<a class="id-link" href="${escape(env.idHref(id))}" data-id="${id}">${id}</a>`);
  };

  // Headings get anchors (h-<slug>; a repeated heading gets -2, -3, …), so "#section" links in a
  // document can find them. Links with a scheme (the web,
  // mail) open in a new tab and never send a referrer.
  md.renderer.rules.heading_open = (tokens, idx, opts, env, self) => {
    const inline = tokens[idx + 1];
    const text = inline?.children?.map((c) => c.content).join('') ?? '';
    const seen = (env.headingIds ??= new Map());
    const id = `h-${slugify(text)}`;
    const n = (seen.get(id) ?? 0) + 1;
    seen.set(id, n);
    tokens[idx].attrSet('id', n === 1 ? id : `${id}-${n}`);
    return self.renderToken(tokens, idx, opts);
  };
  const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, opts, _env, self) => self.renderToken(tokens, idx, opts));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const href = tokens[idx].attrGet('href') ?? '';
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>';
  md.renderer.rules.table_close = () => '</table></div>';
  return md;
}

const renderer = createRenderer();

export function renderMarkdown(text, { idHref = null } = {}) {
  return renderer.render(String(text ?? ''), { idHref });
}
