// A multipart/form-data body, parsed by hand: the publish request is the only one, and it comes
// whole (a request is at most a few MB), so this works on one Buffer with no framework.
//
// parseMultipart(body, contentType) → Map(name → { filename, type, data })
// Anything that isn't what publish.py or `curl -F` sends is refused with a 400, in words.

import { HttpError } from './http.js';

const MAX_PARTS = 40;
const bad = (why) => new HttpError(400, `That upload couldn’t be read: ${why}.`);

function boundaryOf(contentType) {
  const m = /^multipart\/form-data\s*;.*\bboundary=(?:"([^"]{1,200})"|([^\s;"]{1,200}))/i.exec(String(contentType ?? ''));
  if (!m) throw new HttpError(415, 'Send multipart/form-data.');
  return m[1] ?? m[2];
}

/** The name and filename from a Content-Disposition line. */
function disposition(line) {
  if (!/^form-data\b/i.test(line)) throw bad('a part isn’t form-data');
  const name = /\bname="([^"]*)"/i.exec(line)?.[1];
  if (!name) throw bad('a part has no name');
  return { name, filename: /\bfilename="([^"]*)"/i.exec(line)?.[1] ?? null };
}

export function parseMultipart(body, contentType) {
  const dash = Buffer.from(`--${boundaryOf(contentType)}`);
  const sep = Buffer.from(`\r\n--${dash.subarray(2).toString('latin1')}`, 'latin1');
  const parts = new Map();
  if (body.indexOf(dash) !== 0) throw bad('it doesn’t start with its boundary');
  let at = dash.length;
  for (;;) {
    if (body.subarray(at, at + 2).toString('latin1') === '--') return parts;
    if (body.subarray(at, at + 2).toString('latin1') !== '\r\n') throw bad('a boundary is broken');
    at += 2;
    const headEnd = body.indexOf('\r\n\r\n', at, 'latin1');
    if (headEnd < 0) throw bad('a part has no end to its headers');
    const headers = {};
    for (const line of body.subarray(at, headEnd).toString('utf8').split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const end = body.indexOf(sep, headEnd + 4);
    if (end < 0) throw bad('it stops before its last boundary');
    const { name, filename } = disposition(headers['content-disposition'] ?? '');
    if (parts.has(name)) throw bad(`it has two parts called ${name}`);
    if (parts.size >= MAX_PARTS) throw bad('it has too many parts');
    parts.set(name, { filename, type: headers['content-type'] ?? '', data: body.subarray(headEnd + 4, end) });
    at = end + sep.length;
  }
}
