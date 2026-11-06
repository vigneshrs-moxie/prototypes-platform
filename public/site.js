// The site's one script, under the strict policy. The pages all work without it: it only adds the
// Light/Dark switch and the Copy buttons, which stay hidden if it doesn't run.

(function () {
  const root = document.documentElement;
  const saved = () => { try { return localStorage.getItem('pt-theme'); } catch { return null; } };
  const save = (v) => { try { localStorage.setItem('pt-theme', v); } catch { /* private window: this page only */ } };
  const dark = saved() ? saved() === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'dark' : 'light';

  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      const paint = () => { toggle.textContent = root.dataset.theme === 'dark' ? 'Light' : 'Dark'; };
      paint();
      toggle.hidden = false;
      toggle.addEventListener('click', () => {
        root.dataset.theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
        save(root.dataset.theme);
        paint();
      });
    }
    for (const b of document.querySelectorAll('[data-copy]')) {
      if (!navigator.clipboard) continue;
      b.hidden = false;
      const word = b.textContent;
      b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; } catch { b.textContent = 'Couldn’t copy'; }
        setTimeout(() => { b.textContent = word; }, 1500);
      });
    }
  });
})();
