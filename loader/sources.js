// (nc_discovery_tree: copied from nodecore_light_logic_sim's src/mods/sources.js,
// with a `wanted` option so a page that only reads code can skip textures.)
//
// Getting a mod's files. ContentDB's zips cannot be read by a web page
// from another site (they carry no CORS header), so, in order:
//
//  1. the local server (npm run serve) fetches the ContentDB zip - the
//     very file Luanti installs, for any package;
//  2. the mod's source repository, at the git commit ContentDB built the
//     release from: GitHub, GitLab and Codeberg let a page read a repo
//     file by file (GitHub may also hand over the whole zip at once);
//  3. failing both, a person downloads the zip and drops it in.

import { readZip } from './zip.js';
import { CONTENTDB } from './contentdb.js';

/** What a mod needs to run and be drawn; sounds, screenshots and the like are skipped. */
export function wantedFile(path) {
  const p = path.toLowerCase();
  const base = p.split('/').pop();
  if (/(^|\/)\.git/.test(p)) return false;
  if (/\.(lua|conf)$/.test(p)) return true;
  if (base === 'depends.txt' || base === 'modpack.txt' || base === 'description.txt') return true;
  if (/(^|\/)(textures|models|media)\//.test(p) && /\.(png|jpe?g|obj)$/.test(p)) return true;
  return false;
}

/** A repository link as ContentDB gives it -> {host, owner, repo, path}, or null. */
export function parseRepo(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  const parts = u.pathname.replace(/\.git$/, '').replace(/\/+$/, '').split('/').filter(Boolean);
  // GitLab puts extra pages after "/-/"
  const cut = parts.indexOf('-');
  if (cut >= 0) parts.length = cut;
  if (parts.length < 2) return null;
  const host = u.hostname.toLowerCase();
  if (host === 'github.com' || host === 'www.github.com') return { host: 'github', owner: parts[0], repo: parts[1], path: `${parts[0]}/${parts[1]}` };
  if (host === 'gitlab.com') return { host: 'gitlab', owner: parts[0], repo: parts[parts.length - 1], path: parts.join('/') };
  if (host === 'codeberg.org') return { host: 'codeberg', owner: parts[0], repo: parts[1], path: `${parts[0]}/${parts[1]}` };
  return null;
}

/** Run `fn` over `items` with at most `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

async function ok(res, what) {
  if (!res.ok) {
    const limit = res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining');
    if (res.status === 403 && limit === '0') throw new Error(`${what}: GitHub's hourly limit for this browser is used up`);
    throw new Error(`${what}: HTTP ${res.status}`);
  }
  return res;
}

async function bytesOf(res) { return new Uint8Array(await res.arrayBuffer()); }

/** Fetch every wanted file, given the list of paths and a URL for each. */
async function fileByFile(paths, urlOf, fetch, onProgress, wanted = wantedFile) {
  const want = paths.filter(wanted);
  let done = 0;
  const files = new Map();
  await pool(want, 8, async (path) => {
    const res = await ok(await fetch(urlOf(path)), path);
    files.set(path, await bytesOf(res));
    done++;
    if (onProgress) onProgress(done, want.length);
  });
  return files;
}

const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

async function fromGitHub(r, commit, fetch, onProgress, wanted) {
  // the whole tree as one zip, if the browser is let read it
  try {
    const res = await fetch(`https://codeload.github.com/${r.owner}/${r.repo}/zip/${commit}`);
    if (res.ok) return await readZip(await bytesOf(res));
  } catch { /* blocked: go file by file */ }
  const res = await ok(await fetch(`https://api.github.com/repos/${r.owner}/${r.repo}/git/trees/${commit}?recursive=1`), 'GitHub file list');
  const tree = await res.json();
  if (tree.truncated) throw new Error('GitHub file list: repository too large to list');
  const paths = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
  return fileByFile(paths, (p) => `https://raw.githubusercontent.com/${r.owner}/${r.repo}/${commit}/${encPath(p)}`, fetch, onProgress, wanted);
}

async function fromGitLab(r, commit, fetch, onProgress, wanted) {
  const id = encodeURIComponent(r.path);
  const paths = [];
  let page = '1';
  while (page) {
    const res = await ok(await fetch(`https://gitlab.com/api/v4/projects/${id}/repository/tree?recursive=true&per_page=100&ref=${commit}&page=${page}`), 'GitLab file list');
    for (const t of await res.json()) if (t.type === 'blob') paths.push(t.path);
    page = (res.headers.get('x-next-page') || '').trim();
  }
  return fileByFile(paths, (p) => `https://gitlab.com/api/v4/projects/${id}/repository/files/${encodeURIComponent(p)}/raw?ref=${commit}`, fetch, onProgress, wanted);
}

async function fromCodeberg(r, commit, fetch, onProgress, wanted) {
  const paths = [];
  for (let page = 1; ; page++) {
    const res = await ok(await fetch(`https://codeberg.org/api/v1/repos/${r.owner}/${r.repo}/git/trees/${commit}?recursive=true&per_page=1000&page=${page}`), 'Codeberg file list');
    const tree = await res.json();
    for (const t of tree.tree || []) if (t.type === 'blob') paths.push(t.path);
    if (!tree.truncated) break;
  }
  return fileByFile(paths, (p) => `https://codeberg.org/api/v1/repos/${r.owner}/${r.repo}/raw/${encPath(p)}?ref=${commit}`, fetch, onProgress, wanted);
}

/** A repository's files at `commit`: Map path -> bytes (only what a mod needs). */
export async function fetchSource(repo, commit, { fetch = (...a) => globalThis.fetch(...a), onProgress, wanted } = {}) {
  const r = typeof repo === 'string' ? parseRepo(repo) : repo;
  if (!r) throw new Error(`no way to read ${repo} from here`);
  if (!/^[0-9a-f]{7,40}$/i.test(commit || '')) throw new Error('the release names no git commit');
  if (r.host === 'github') return fromGitHub(r, commit, fetch, onProgress, wanted);
  if (r.host === 'gitlab') return fromGitLab(r, commit, fetch, onProgress, wanted);
  return fromCodeberg(r, commit, fetch, onProgress, wanted);
}

/** Is the editor's own server there to fetch ContentDB zips for it? */
export async function localProxy({ fetch = (...a) => globalThis.fetch(...a), base = '/contentdb' } = {}) {
  try {
    const res = await fetch(`${base}/ping`);
    return res.ok && (await res.text()).trim() === 'contentdb-proxy';
  } catch {
    return false;
  }
}

/** The ContentDB zip of a release, through the local server. */
export async function fetchContentDBZip(author, name, release, { fetch = (...a) => globalThis.fetch(...a), base = '/contentdb' } = {}) {
  const res = await ok(await fetch(`${base}/packages/${encodeURIComponent(author)}/${encodeURIComponent(name)}/releases/${release}/download/`), 'ContentDB download');
  return readZip(await bytesOf(res));
}

/** Thrown when neither route works: the person has to fetch the zip. */
export class ManualDownload extends Error {
  constructor(pkg, url, reasons) {
    super(`Download ${pkg} from ContentDB and drop the .zip on the Mods tab (${reasons.join('; ')})`);
    this.url = url;
    this.reasons = reasons;
  }
}

/**
 * Get one package's files, the best way available. Returns
 * {files, source: {via, release, commit?, repo?}, info}.
 */
export async function downloadPackage(cdb, author, name, { fetch = (...a) => globalThis.fetch(...a), proxy = false, onProgress, wanted } = {}) {
  const info = await cdb.package(author, name);
  const releaseId = info.release;
  if (!releaseId) throw new Error(`${author}/${name} has no release on ContentDB`);
  const release = await cdb.release(author, name, releaseId);
  const reasons = [];
  if (proxy) {
    try {
      return { files: await fetchContentDBZip(author, name, releaseId, { fetch }), source: { via: 'contentdb', release: releaseId, commit: release.commit || undefined }, info };
    } catch (e) {
      reasons.push(`local server: ${e.message}`);
    }
  }
  const repo = parseRepo(info.repo);
  if (repo && release.commit) {
    try {
      const files = await fetchSource(repo, release.commit, { fetch, onProgress, wanted });
      return { files, source: { via: repo.host, repo: info.repo, release: releaseId, commit: release.commit }, info };
    } catch (e) {
      reasons.push(`${repo.host}: ${e.message}`);
    }
  } else if (!info.repo) reasons.push('no source repository listed');
  else if (!repo) reasons.push(`source at ${new URL(info.repo).hostname}, which the editor cannot read`);
  else reasons.push('the release names no git commit');
  throw new ManualDownload(`${author}/${name}`, `${CONTENTDB}/packages/${author}/${name}/`, reasons);
}
