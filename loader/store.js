// Installed mods, kept in the browser (IndexedDB) so they load again on
// the next visit. Each record is one package: where it came from and its
// files. Everything here fails soft - a private window or blocked
// storage just means mods last until the page closes.

// (a database of its own, so it never mixes with the simulator's on a shared origin)
const DB = 'nc-discovery-tree-mods';
const STORE = 'packages';

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

export class ModStore {
  /** Every saved package, oldest first. */
  async all() {
    try {
      const list = await run('readonly', (s) => s.getAll());
      return (list || []).sort((a, b) => (a.added || 0) - (b.added || 0));
    } catch { return []; }
  }

  /** Save a package: {key, title, author, name, source, files: Map}. */
  async put(rec) {
    try {
      await run('readwrite', (s) => s.put({ ...rec, files: [...rec.files], added: rec.added || Date.now() }));
      return true;
    } catch { return false; }
  }

  async delete(key) {
    try { await run('readwrite', (s) => s.delete(key)); return true; } catch { return false; }
  }
}

/** A saved record's files back as a Map. */
export const recordFiles = (rec) => new Map(rec.files);
