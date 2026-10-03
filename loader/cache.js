// Mods are run once per combination: the extract (what they registered and
// what their ABMs do) is kept in IndexedDB under a fingerprint of everything
// that went into it, and reused until any of that changes.
//
// The fingerprint covers every installed package's files (not just its
// version: a zip dropped in has none, and a re-release can keep one),
// the loader itself (extract.lua and EXTRACT_VERSION) and NodeCore's
// bundled Lua. Mods run together and can change one another, so a result
// belongs to the whole set, not to one mod. The trees are rebuilt from the
// extract each time, so changes to how they are drawn need no recompute.
//
// Like store.js, everything fails soft: without IndexedDB nothing is kept.

const DB = 'nc-discovery-tree-cache';
const STORE = 'extracts';
const KEEP = 6;          // combinations remembered

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const enc = new TextEncoder();

/** SHA-256 of a list of strings and byte arrays, in order, each length-prefixed. */
export async function digest(parts) {
  const chunks = [];
  let size = 0;
  for (const p of parts) {
    const bytes = typeof p === 'string' ? enc.encode(p) : p;
    const len = enc.encode(`${bytes.length}:`);
    chunks.push(len, bytes);
    size += len.length + bytes.length;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.length; }
  return hex(await crypto.subtle.digest('SHA-256', all));
}

/** A fingerprint of one package's files: Map(path -> bytes). */
export function filesDigest(files) {
  const paths = [...files.keys()].sort();
  const parts = [];
  for (const p of paths) parts.push(p, files.get(p));
  return digest(parts);
}

/**
 * The cache key for running `packages` ([{key, files}]) on a loader
 * described by `loader` (strings: version, hashes of its code).
 */
export async function extractKey(packages, loader) {
  const each = await Promise.all(packages.map(async (p) => `${p.key}=${await filesDigest(p.files)}`));
  return digest(['extract', ...loader, ...each.sort()]);
}

function open() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no IndexedDB')); return; }
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(req && req.result); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  }));
}

export class ExtractCache {
  /** {key, out, saved, seconds} or undefined. */
  async get(key) {
    try { return await run('readonly', (s) => s.get(key)); } catch { return undefined; }
  }

  /** Keep `out` under `key`, forgetting the oldest beyond KEEP. */
  async put(key, out, seconds) {
    try {
      await run('readwrite', (s) => s.put({ key, out, seconds, saved: Date.now() }));
      const all = (await run('readonly', (s) => s.getAll())) || [];
      const stale = all.sort((a, b) => b.saved - a.saved).slice(KEEP);
      if (stale.length) await run('readwrite', (s) => { stale.forEach((r) => s.delete(r.key)); return null; });
      return true;
    } catch { return false; }
  }

  async clear() {
    try { await run('readwrite', (s) => s.clear()); return true; } catch { return false; }
  }
}
