// Files on the site: page HTML and PDFs, in a private Vercel Blob store, or a fake one in tests and
// on a laptop. The bytes only ever leave through a route that has checked access first.
//
//   put(pathname, bytes, type)   stored under exactly that path
//   read(pathname)               { bytes, contentType } or null
//   remove(pathnames)            gone (a publish that failed halfway)
//
// The fake keeps files in memory, or in a folder when given one, so a laptop's restart keeps them.
// Never in a production build: there, without a connected store, a publish says it isn't set up.

import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../site/http.js';

const notSetUp = () => new HttpError(503, 'File storage isn’t connected to the site yet.');

/** Which store this site uses: 'real' (a connected store), 'fake' (not production) or null. */
export function blobKind({ production, env = process.env }) {
  if (env.BLOB_READ_WRITE_TOKEN) return 'real';
  return production ? null : 'fake';
}

export function makeBlob({ config, env = process.env, dir = null, sdk = null }) {
  const kind = blobKind({ production: config.production, env });
  if (kind === 'real') return realBlob({ sdk });
  if (kind === 'fake') return fakeBlob({ dir });
  const no = async () => { throw notSetUp(); };
  return { kind: 'none', put: no, read: no, remove: async () => {} };
}

function realBlob({ sdk }) {
  let lib = sdk;
  const load = async () => (lib ??= await import('@vercel/blob'));
  return {
    kind: 'real',
    async put(pathname, bytes, type) {
      const { put } = await load();
      await put(pathname, bytes, { access: 'private', contentType: type, addRandomSuffix: false, allowOverwrite: false });
    },
    async read(pathname) {
      const { get } = await load();
      const got = await get(pathname, { access: 'private' });
      if (!got || got.statusCode !== 200) return null;
      return { bytes: Buffer.from(await new Response(got.stream).arrayBuffer()), contentType: got.blob.contentType };
    },
    async remove(pathnames) {
      if (!pathnames.length) return;
      const { del } = await load();
      await del(pathnames).catch(() => {});
    },
  };
}

export function fakeBlob({ dir = null } = {}) {
  const files = new Map(); // pathname -> { bytes, contentType }
  const onDisk = (pathname) => path.join(dir, encodeURIComponent(pathname));
  return {
    kind: 'fake',
    files,
    async put(pathname, bytes, type) {
      const file = { bytes: Buffer.from(bytes), contentType: type };
      files.set(pathname, file);
      if (dir) {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(onDisk(pathname), file.bytes);
        await fs.writeFile(`${onDisk(pathname)}.type`, type);
      }
    },
    async read(pathname) {
      if (files.has(pathname)) return files.get(pathname);
      if (!dir) return null;
      try {
        return { bytes: await fs.readFile(onDisk(pathname)), contentType: await fs.readFile(`${onDisk(pathname)}.type`, 'utf8') };
      } catch { return null; }
    },
    async remove(pathnames) {
      for (const p of pathnames) {
        files.delete(p);
        if (dir) { await fs.rm(onDisk(p), { force: true }); await fs.rm(`${onDisk(p)}.type`, { force: true }); }
      }
    },
  };
}
