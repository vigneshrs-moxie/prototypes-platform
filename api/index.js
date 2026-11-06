// The one Vercel Function. vercel.json rewrites every page and /api/* request here; the request
// keeps its own path, and site/router.js routes it. One instance serves many requests, so the
// database pool and the site are made once per instance, on the first request.
//
// A setting that would make the site unsafe (AUTH_FAKE in production: site/config.js) stops the
// function from starting at all: every request then answers 500 and the log says why.

import { makeBlob } from '../lib/blob.js';
import { readConfig } from '../site/config.js';
import { openPostgres } from '../site/db.js';
import { createSite } from '../site/router.js';

let opening = null;

async function open() {
  const config = readConfig(process.env);
  const db = config.databaseUrl ? await openPostgres(config.databaseUrl) : null;
  return createSite({ db, config, blob: makeBlob({ config }) });
}

export default async function handler(req, res) {
  let site;
  try {
    site = await (opening ??= open());
  } catch (err) {
    opening = null;
    console.error('The site couldn’t start:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'The site isn’t set up correctly. The details are in its Vercel logs.' }));
    return;
  }
  return site(req, res);
}
