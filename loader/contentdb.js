// ContentDB (content.luanti.org): finding NodeCore mods, their releases
// and what they depend on - what Luanti's own content browser asks for
// (builtin/mainmenu/content/contentdb.lua). The API allows cross-origin
// requests, so the page asks it directly.

export const CONTENTDB = 'https://content.luanti.org';
export const NODECORE_GAME = 'Warr1024/nodecore';
// packages that are NodeCore itself: a dependency they satisfy is met by the simulator
const GAME_PACKAGES = new Set(['Warr1024/nodecore', 'Warr1024/nodecore_alpha']);

export class ContentDB {
  constructor({ fetch = (...a) => globalThis.fetch(...a), base = CONTENTDB } = {}) {
    this.fetch = fetch;
    this.base = base;
    this.cache = new Map();
  }

  async json(path) {
    if (this.cache.has(path)) return this.cache.get(path);
    const res = await this.fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`ContentDB ${res.status} for ${path}`);
    const data = await res.json();
    this.cache.set(path, data);
    return data;
  }

  /** NodeCore mods matching a search (all of them for an empty one). */
  search(q = '') {
    const qs = new URLSearchParams({ type: 'mod', game: NODECORE_GAME });
    if (q.trim()) qs.set('q', q.trim());
    return this.json(`/api/packages/?${qs}`);
  }

  /** Everything about a package: title, repo, latest release id, ... */
  package(author, name) {
    return this.json(`/api/packages/${encodeURIComponent(author)}/${encodeURIComponent(name)}/`);
  }

  /** One release: its title, the git commit it was made from, its zip. */
  release(author, name, id) {
    return this.json(`/api/packages/${encodeURIComponent(author)}/${encodeURIComponent(name)}/releases/${id}/`);
  }

  /** Hard dependencies: [{name, packages: ["author/name", ...]}]. */
  async dependencies(author, name) {
    const key = `${author}/${name}`;
    const data = await this.json(`/api/packages/${encodeURIComponent(author)}/${encodeURIComponent(name)}/dependencies/?only_hard=1`);
    return (data[key] || []).filter((d) => !d.is_optional);
  }

  /**
   * A package and every package it needs, dependencies first (the order
   * they should load). `have(modname)` says a mod is already there - the
   * simulator's NodeCore, or a mod already installed. A dependency that
   * no package provides lands in `unresolved`.
   */
  async resolve(author, name, have = () => false) {
    const order = [];
    const unresolved = [];
    const seen = new Set();
    const visit = async (a, n) => {
      const key = `${a}/${n}`;
      if (seen.has(key)) return;
      seen.add(key);
      for (const dep of await this.dependencies(a, n)) {
        if (have(dep.name)) continue;
        const candidates = (dep.packages || []).filter((p) => !GAME_PACKAGES.has(p));
        if ((dep.packages || []).some((p) => GAME_PACKAGES.has(p))) continue;   // NodeCore provides it
        if (!candidates.length) { unresolved.push({ mod: dep.name, neededBy: key }); continue; }
        // the dependency's own name under the same author, if there is one
        const pick = candidates.find((p) => p === `${a}/${dep.name}`)
          || candidates.find((p) => p.endsWith(`/${dep.name}`)) || candidates[0];
        const [pa, pn] = pick.split('/');
        await visit(pa, pn);
      }
      order.push({ author: a, name: n });
    };
    await visit(author, name);
    return { order, unresolved };
  }

  /** The page for a package on ContentDB, for a person to download from. */
  pageUrl(author, name) {
    return `${this.base}/packages/${encodeURIComponent(author)}/${encodeURIComponent(name)}/`;
  }
}
