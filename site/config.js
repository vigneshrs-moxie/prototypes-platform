// The site's settings, from the environment. On Vercel they are set in Settings → Environment
// Variables; .env.example lists the names with empty values.
//
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   the Internal OAuth client
//   ALLOWED_DOMAIN                           the Workspace domain: only its accounts may sign in (hd)
//   ADMIN_EMAILS                             the admins, comma-separated (D12). Read on every request
//   SESSION_SECRET                           signs the session cookie and the form tokens
//   SITE_URL                                 the site's own address; on a preview, VERCEL_URL stands in
//   DATABASE_URL                             Neon's pooled address
//   BLOB_READ_WRITE_TOKEN                    the private Blob store (lib/blob.js)
//   AUTH_FAKE=1                              the fake Google of site/fake-google.js, for tests and a
//                                            laptop only: refused on Vercel and with NODE_ENV=production
//
// A missing setting doesn't crash the function: every route but /healthz says which setting is
// missing (names only, never a value).

export class ConfigError extends Error {}

export const DEV_PORT = 4480;
const REQUIRED = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ALLOWED_DOMAIN', 'ADMIN_EMAILS', 'SESSION_SECRET', 'DATABASE_URL'];

const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const noSlash = (u) => u.replace(/\/+$/, '');

/** Whether this is a production build: any Vercel deployment, or NODE_ENV=production. */
export const isProduction = (env) => Boolean(clean(env.VERCEL)) || clean(env.NODE_ENV) === 'production';

/** A comma-separated list of addresses, as a lower-case Set. */
export const parseEmails = (text) => new Set(clean(text).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));

/**
 * The settings. Throws ConfigError when AUTH_FAKE is on in a production build: the fake sign-in
 * lets anyone in as anyone, so such a build must not start at all.
 * overrides: what the tests and the local server set directly (PGlite needs no database address).
 */
export function readConfig(env = process.env, overrides = {}) {
  const production = isProduction(env);
  const authFake = clean(env.AUTH_FAKE) === '1';
  if (authFake && production) {
    throw new ConfigError('AUTH_FAKE is on in a production build. The fake Google sign-in is only for tests and a laptop; remove AUTH_FAKE from this deployment’s environment.');
  }
  const siteUrl = noSlash(clean(env.SITE_URL) || (clean(env.VERCEL_URL) ? `https://${clean(env.VERCEL_URL)}` : `http://localhost:${clean(env.PORT) || DEV_PORT}`));
  const config = {
    production,
    authFake,
    siteUrl,
    siteOrigin: new URL(siteUrl).origin,
    google: {
      clientId: clean(env.GOOGLE_CLIENT_ID),
      clientSecret: clean(env.GOOGLE_CLIENT_SECRET),
      // Google's discovery document (OpenID Connect). The fake one is served by this site itself.
      discovery: authFake ? `${siteUrl}/fake-google/.well-known/openid-configuration` : 'https://accounts.google.com/.well-known/openid-configuration',
      issuers: authFake ? [`${siteUrl}/fake-google`] : ['https://accounts.google.com', 'accounts.google.com'],
    },
    allowedDomain: clean(env.ALLOWED_DOMAIN).toLowerCase(),
    /** The admins, parsed fresh each time: being an admin is computed on every request (D12). */
    adminEmails: () => parseEmails(env.ADMIN_EMAILS),
    sessionSecret: clean(env.SESSION_SECRET),
    databaseUrl: clean(env.DATABASE_URL),
    ...overrides,
  };
  if (authFake) {
    config.google = { ...config.google, clientId: config.google.clientId || 'fake-client', clientSecret: config.google.clientSecret || 'fake-secret' };
  }
  config.redirectUri = `${config.siteUrl}/auth/callback`;
  config.missing = missingSettings(config);
  return Object.freeze(config);
}

/** The required settings this config lacks, by their environment names (a laptop's PGlite needs no DATABASE_URL). */
function missingSettings(c) {
  const have = {
    GOOGLE_CLIENT_ID: c.google.clientId, GOOGLE_CLIENT_SECRET: c.google.clientSecret, ALLOWED_DOMAIN: c.allowedDomain,
    ADMIN_EMAILS: c.adminEmails().size, SESSION_SECRET: c.sessionSecret, DATABASE_URL: c.databaseUrl || !c.production,
  };
  return REQUIRED.filter((k) => !have[k]);
}
