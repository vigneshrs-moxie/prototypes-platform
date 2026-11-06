# Orbit Prototypes

The site at `prototypes.moxieorbit.com`: a folder per feature holding its prototype, requirements, decisions and notes. People sign in with their Moxie Google account. Admins see everything; everyone else sees what's shared with them.

One Node function on Vercel, Postgres (Neon) for what people write, private Vercel Blob for pages and PDFs. Pages are server-rendered with one small script. No framework, no build step.

## Run it locally

Needs Node 22. No accounts: sign-in is a pretend Google, and the database is PGlite (Postgres running inside Node).

```bash
npm install
AUTH_FAKE=1 node dev.js            # http://localhost:4480
```

Sign in as `ada.admin@example.test` to be an admin, or any other `@example.test` address to be a regular person. Data stays in `.data/`. `node dev.js --memory` starts fresh each time.

To use a real Postgres, set `DATABASE_URL`. To change who is an admin, set `ADMIN_EMAILS`.

## Test it

```bash
node --test "test/*.test.js"                                                          # PGlite, offline
TEST_DATABASE_URL=postgresql://localhost/prototypes_test node --test "test/*.test.js"  # a real Postgres
```

With `TEST_DATABASE_URL`, each test site gets its own schema and drops it afterwards. No test reaches the network or sends anything.

## Publish to it

Make a token on the Settings page, then use `publish.py` from the wireframe skill. The skill's `reference/publish.md` is the contract for every request, and `site/routes-publish.js` and `site/routes-api.js` are built to it. If the two disagree, change them together.

```bash
python3 <skill>/publish.py --page <slug>.html --title "A title" --site http://localhost:4480
```

## Settings

`.env.example` lists them. On Vercel they go in Settings → Environment Variables, never in this repository, which is public.

`NODEJS_HELPERS=0` must be set on Vercel. Without it, Vercel's body helpers can swallow a multipart publish.

A Vercel request is capped at 4.5 MB, so that's the real limit on one publish, whatever the per-file limits say.

## Where things are

| Path | What |
|---|---|
| `api/index.js` | The one Vercel function |
| `dev.js` | The same site on a laptop |
| `site/router.js` | Routing, sign-in checks, the rules for changes, errors |
| `site/access.js` | `canSee`: who sees what |
| `site/routes-*.js` | The routes, by area |
| `site/render.js` | HTML templating with escaping, and the page layout |
| `site/google.js`, `sessions.js`, `fake-google.js` | Sign-in |
| `site/tokens.js` | Publish tokens |
| `lib/blob.js` | File storage, real and fake |
| `migrations/` | The schema; `npm run migrate` applies it |
| `public/` | `site.css` and `site.js` |

## Rules worth keeping

- Every route that returns feature content calls `canSee`. A stranger gets the same page whether or not a feature exists.
- Being an admin is `ADMIN_EMAILS`, read on every request. There's no role column.
- The site deletes nothing: notes, features, shares and tokens are marked, not removed.
- No email is sent, and nothing calls Orbit.
- Status is never shown by colour alone: every state has a word.
- Logs carry route, status, person id and feature key. Never tokens, note text or emails.
