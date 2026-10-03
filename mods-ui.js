// The Mods panel: find NodeCore mods on ContentDB and install them (the
// files come from the mod's source repository at the commit ContentDB
// built the release from), or add a zip by hand. Installed mods are kept
// in IndexedDB and run, with NodeCore, in a Web Worker; what they
// register is handed to the page to rebuild its trees.
//
// The ContentDB, download, zip and storage code in loader/ is taken from
// nodecore_light_logic_sim (src/mods/) as it is.
import { ContentDB } from './loader/contentdb.js';
import { downloadPackage, ManualDownload } from './loader/sources.js';
import { ModStore, recordFiles } from './loader/store.js';
import { readZip } from './loader/zip.js';
import { openPackage } from './loader/package.js';
import { NODECORE_MOD_NAMES, EXTRACT_VERSION } from './loader/extract.js';
import { ExtractCache, extractKey, digest } from './loader/cache.js';

const $ = (id) => document.getElementById(id);
// this page only runs a mod's code, so its textures, models and sounds are skipped
const codeOnly = (path) => !/(^|\/)\.git/.test(path) && /\.(lua|conf|txt|csv|json)$/i.test(path);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** What the loader is: its version and fingerprints of its Lua and NodeCore's (worked out once). */
let loaderParts = null;
function loaderFingerprint() {
  if (!loaderParts) {
    loaderParts = (async () => {
      const bytes = async (path) => {
        const res = await fetch(new URL(path, import.meta.url));
        if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      };
      const [lua, game] = await Promise.all([bytes('./loader/extract.lua'), bytes('./data/nodecore-src.zip')]);
      return [`v${EXTRACT_VERSION}`, await digest([lua]), await digest([game])];
    })();
    loaderParts.catch(() => { loaderParts = null; });
  }
  return loaderParts;
}

const ago = (t) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} minutes ago`;
  if (s < 129600) return `${Math.round(s / 3600)} hours ago`;
  return `${Math.round(s / 86400)} days ago`;
};

/** Run packages with NodeCore off the main thread (or on it, if workers fail). */
function runPackages(packages) {
  return new Promise((resolve, reject) => {
    let worker;
    const inline = async () => {
      try {
        const { runPackages: run } = await import('./loader/extract.js');
        resolve(await run(packages));
      } catch (e) { reject(e); }
    };
    try {
      worker = new Worker(new URL('./loader/worker.js', import.meta.url), { type: 'module' });
    } catch { inline(); return; }
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.out); else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => { e.preventDefault(); worker.terminate(); inline(); };
    worker.postMessage({ packages });
  });
}

export function initMods({ apply, openFromDetails }) {
  const store = new ModStore();
  const cache = new ExtractCache();
  const cdb = new ContentDB();
  const panel = $('modsPanel');
  const status = $('modsStatus');
  let packages = [];
  let lastRun = null;
  let busy = false;

  const open = () => { panel.hidden = false; $('cdbQuery').focus(); };
  const close = () => { panel.hidden = true; };
  $('modsBtn').addEventListener('click', () => (panel.hidden ? open() : close()));
  panel.addEventListener('click', (ev) => { if (ev.target.closest('[data-close-mods]')) close(); });
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !panel.hidden) close(); });
  openFromDetails(open);

  const say = (html, kind = '') => { status.className = `status ${kind}`; status.innerHTML = html; };

  const modNames = () => {
    const out = new Set();
    for (const p of packages) {
      try { for (const m of openPackage(recordFiles(p), { name: p.name }).mods) out.add(m.name); } catch { /* listed as broken */ }
    }
    return out;
  };

  function contribution(names) {
    if (!lastRun) return '';
    const items = Object.values(lastRun.items).filter((d) => names.includes(d.mod)).length;
    const recipes = lastRun.nc_recipes.filter((r) => names.includes(r.mod)).length + lastRun.crafts.filter((r) => names.includes(r.mod)).length;
    const hints = lastRun.hints.filter((h) => names.includes(h.mod)).length;
    return `${items} items · ${recipes} recipes · ${hints} hints`;
  }

  function renderInstalled() {
    const list = $('modsInstalled');
    const count = $('modsCount');
    count.hidden = !packages.length;
    count.textContent = packages.length;
    if (!packages.length) { list.innerHTML = '<li class="empty">None yet — NodeCore alone.</li>'; return; }
    list.innerHTML = packages.map((p) => {
      let mods = [];
      try { mods = openPackage(recordFiles(p), { name: p.name }).mods.map((m) => m.name); } catch (e) { mods = []; }
      const problems = [];
      if (lastRun) {
        for (const m of mods) {
          const r = lastRun.mods.find((x) => x.name === m);
          if (r && !r.ok) problems.push(`<div class="err"><strong>${esc(m)}</strong> stopped with an error: <code>${esc(r.error.split('\n')[0])}</code></div>`);
          if (lastRun.missing[m]) problems.push(`<div class="err"><strong>${esc(m)}</strong> was left out: it needs ${lastRun.missing[m].map((d) => `<button class="linkish" data-find="${esc(d)}">${esc(d)}</button>`).join(', ')}</div>`);
        }
      }
      const src = p.source && p.source.via ? `${p.source.via === 'file' ? 'from a file' : `ContentDB release ${p.source.release} via ${p.source.via}`}` : '';
      return `<li><div class="mod-row"><div><strong>${esc(p.title || p.name)}</strong>`
        + `${p.author ? ` <span class="sub">by ${esc(p.author)}</span>` : ''}`
        + `<div class="sub">${esc(mods.join(', '))}${src ? ` · ${esc(src)}` : ''}</div>`
        + `<div class="sub">${contribution(mods)}</div></div>`
        + `<button class="ghost small" data-remove="${esc(p.key)}">Remove</button></div>${problems.join('')}</li>`;
    }).join('');
  }

  async function refresh() {
    packages = await store.all();
    renderInstalled();
  }

  function summary(out) {
    const bad = out.mods.filter((m) => !m.ok && out.addons.includes(m.name)).length + Object.keys(out.missing).length;
    return {
      text: `${Object.keys(out.items).length} items, ${out.nc_recipes.length + out.crafts.length} recipes, ${out.hints.length} hints.`
        + (bad ? ' Some mods had problems — see below.' : ''),
      kind: bad ? 'warn' : 'ok',
    };
  }

  /**
   * Run NodeCore with the installed mods, or reuse what was worked out
   * last time for exactly these files (`force` runs them regardless).
   */
  async function run({ force = false } = {}) {
    if (!packages.length) {
      lastRun = null;
      apply(null);
      say('Showing NodeCore alone.');
      renderInstalled();
      return;
    }
    busy = true;
    try {
      const pkgs = packages.map((p) => ({ key: p.key, files: recordFiles(p), meta: { name: p.name, title: p.title, author: p.author } }));
      let key = null;
      try { key = await extractKey(pkgs, await loaderFingerprint()); } catch { /* no fingerprint: just run */ }
      const hit = key && !force ? await cache.get(key) : undefined;
      if (hit && hit.out) {
        lastRun = hit.out;
        apply(lastRun);
        const sum = summary(lastRun);
        say(`Loaded from this browser's cache (worked out ${ago(hit.saved)}${hit.seconds ? `, which took ${hit.seconds.toFixed(1)} s` : ''}). `
          + `${sum.text} <button class="linkish" data-recompute>Run again</button>`, sum.kind);
        cache.put(key, hit.out, hit.seconds);    // (keeps it among the recent ones)
        return;
      }
      say(`<span class="spin"></span> Running NodeCore with ${packages.length} mod package${packages.length > 1 ? 's' : ''}…`);
      const t = performance.now();
      lastRun = await runPackages(pkgs.map(({ files, meta }) => ({ files, meta })));
      const seconds = (performance.now() - t) / 1000;
      apply(lastRun);
      const saved = key ? await cache.put(key, lastRun, seconds) : false;
      const sum = summary(lastRun);
      say(`Ran ${lastRun.order.length} mods in ${seconds.toFixed(1)} s${saved ? ' (kept for next time)' : ''}. ${sum.text}`, sum.kind);
    } catch (e) {
      say(`Running the mods failed: <code>${esc(e.message)}</code>`, 'error');
    } finally {
      busy = false;
      renderInstalled();
    }
  }

  // ---- ContentDB ----
  async function searchCDB(q) {
    const out = $('cdbResults');
    out.innerHTML = '<li class="empty"><span class="spin"></span> Searching ContentDB…</li>';
    try {
      const list = await cdb.search(q);
      const have = new Set(packages.map((p) => p.key));
      out.innerHTML = list.length ? list.slice(0, 40).map((p) => {
        const key = `${p.author}/${p.name}`;
        return `<li><div class="mod-row"><div><a href="${esc(cdb.pageUrl(p.author, p.name))}" target="_blank" rel="noopener"><strong>${esc(p.title)}</strong></a>`
          + ` <span class="sub">by ${esc(p.author)}</span><div class="sub">${esc(p.short_description || '')}</div></div>`
          + (have.has(key) ? '<span class="sub">installed</span>' : `<button class="ghost small" data-install="${esc(key)}">Install</button>`)
          + '</div></li>';
      }).join('') : '<li class="empty">No NodeCore mods match.</li>';
    } catch (e) {
      out.innerHTML = `<li class="empty err">ContentDB could not be reached: ${esc(e.message)}</li>`;
    }
  }

  async function install(key) {
    if (busy) return;
    busy = true;
    const [author, name] = key.split('/');
    try {
      say(`<span class="spin"></span> Looking up ${esc(key)} and what it needs…`);
      const installed = modNames();
      const plan = await cdb.resolve(author, name, (m) => NODECORE_MOD_NAMES.includes(m) || installed.has(m));
      const have = new Set(packages.map((p) => p.key));
      for (const pkg of plan.order) {
        const k = `${pkg.author}/${pkg.name}`;
        if (have.has(k)) continue;
        say(`<span class="spin"></span> Downloading ${esc(k)}…`);
        const got = await downloadPackage(cdb, pkg.author, pkg.name, {
          wanted: codeOnly,
          onProgress: (done, total) => say(`<span class="spin"></span> Downloading ${esc(k)}: ${done} / ${total} files…`),
        });
        // check it opens before keeping it
        openPackage(got.files, { name: pkg.name, title: got.info.title, author: pkg.author });
        await store.put({ key: k, title: got.info.title, author: pkg.author, name: pkg.name, source: got.source, files: got.files });
      }
      busy = false;
      await refresh();
      if (plan.unresolved.length) say(`Installed, but nothing on ContentDB provides ${plan.unresolved.map((u) => esc(u.mod)).join(', ')}.`, 'warn');
      await run();
      searchCDB($('cdbQuery').value);
    } catch (e) {
      busy = false;
      if (e instanceof ManualDownload) {
        say(`${esc(e.message)}. <a href="${esc(e.url)}" target="_blank" rel="noopener">Open its ContentDB page</a>, download the zip, and drop it below.`, 'warn');
      } else say(`Installing ${esc(key)} failed: <code>${esc(e.message)}</code>`, 'error');
    }
  }

  async function addZips(files) {
    if (busy) return;
    for (const file of files) {
      try {
        const contents = await readZip(new Uint8Array(await file.arrayBuffer()));
        const pkg = openPackage(contents);
        const names = pkg.mods.map((m) => m.name);
        await store.put({
          key: `file:${names.join('+')}`, title: pkg.mods.length === 1 ? pkg.mods[0].title : file.name.replace(/\.zip$/i, ''),
          author: pkg.mods[0].author || '', name: names[0], source: { via: 'file', file: file.name }, files: contents,
        });
      } catch (e) {
        say(`${esc(file.name)}: ${esc(e.message)}`, 'error');
        return;
      }
    }
    await refresh();
    await run();
  }

  $('cdbForm').addEventListener('submit', (ev) => { ev.preventDefault(); searchCDB($('cdbQuery').value); });
  panel.addEventListener('click', async (ev) => {
    const ins = ev.target.closest('[data-install]');
    if (ins) { ins.disabled = true; install(ins.dataset.install); return; }
    const rm = ev.target.closest('[data-remove]');
    if (rm && !busy) { await store.delete(rm.dataset.remove); await refresh(); await run(); searchCDB($('cdbQuery').value); return; }
    if (ev.target.closest('[data-recompute]') && !busy) { run({ force: true }); return; }
    const find = ev.target.closest('[data-find]');
    if (find) { $('cdbQuery').value = find.dataset.find; searchCDB(find.dataset.find); }
  });
  $('zipInput').addEventListener('change', (ev) => { addZips([...ev.target.files]); ev.target.value = ''; });
  const zone = $('dropZone');
  zone.addEventListener('dragover', (ev) => { ev.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (ev) => {
    ev.preventDefault();
    zone.classList.remove('over');
    addZips([...ev.dataTransfer.files].filter((f) => /\.zip$/i.test(f.name)));
  });

  say('Showing NodeCore alone.');
  refresh().then(() => { if (packages.length) run(); });
}
