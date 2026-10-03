/* NodeCore discovery tree viewer.
 *
 * Two trees over the same game: NodeCore's hints, and its items with the
 * recipes that make them (loader/graphs.js builds both), drawn as a node
 * web (web.js). In spoilers mode only what you have discovered, what that
 * makes available, and "?" placeholders for partly-unlocked nodes are
 * shown; clicking an available node marks it discovered and the web grows
 * out with what it leads to.
 */
import { hintTreeFromCurated, hintTreeFromExtract, recipeTreeFromExtract } from './loader/graphs.js';
import { initMods } from './mods-ui.js';
import { WebView } from './web.js';

const CURATED_URL = 'data/nodecore-discovery.json';
const EXTRACT_URL = 'data/nodecore-extract.json';
const STORE_SPOIL = 'nc-tree:spoilers', STORE_KIND = 'nc-tree:kind';
const storeDisc = (kind) => `nc-tree:discovered:${kind}`;

const TEXT = {
  hints: {
    noun: 'hints', search: 'Search hints…', req: 'Requires', always: 'Nothing — available from the very start.',
    kids: 'Unlocks', none: 'Nothing further — this is an end point.', done: 'Discovered', openHint: 'click to discover',
    mark: "I've done this — mark discovered", unmark: 'Mark as not discovered', count: 'discovered',
  },
  recipes: {
    noun: 'items', search: 'Search items…', req: 'How to get it', always: 'Found in the world — nothing needed.',
    kids: 'Used to make', none: 'Not used in any recipe.', done: 'Obtained', openHint: 'click when you have it',
    mark: 'I have this — mark obtained', unmark: 'Mark as not obtained', count: 'obtained',
  },
};

const $ = (id) => document.getElementById(id);
const viewport = $('viewport'), details = $('details');
let web = null;

// ---------- storage (best effort) ----------
function load(key, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : JSON.parse(v); } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

// ---------- state ----------
const base = { curated: null, extract: null };
const trees = {};
let kind = 'hints';
let T = null;                 // the current tree, indexed (see indexTree)
let spoilers = true;
const discovered = { hints: new Set(), recipes: new Set() };
const view = { hints: { selected: null, focus: null, mod: '' }, recipes: { selected: null, focus: null, mod: '' } };
let visState = {};            // id -> "done" | "open" | "locked" (visible ids only)
const fresh = new Set();

const V = () => view[kind];
const D = () => discovered[kind];
const L = () => TEXT[kind];

// ---------- helpers ----------
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const modName = (m) => String(m || '').replace(/^nc_/, '').replace(/_/g, ' ');
function hue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}
function keyKind(k) {
  if (/^toolcap:/.test(k)) return 'toolcap';
  if (/^group:/.test(k)) return 'group';
  if (/^[a-z0-9_]+:[a-z0-9_]+:/.test(k)) return 'event';
  if (/^[a-z0-9_]+:[a-z0-9_]+$/.test(k)) return 'item';
  if (/:/.test(k)) return 'event';
  return 'craft';
}
function eachKey(req, fn) {
  if (req.op === 'key') fn(req);
  else if (req.of) req.of.forEach((r) => eachKey(r, fn));
}

// ---------- graph logic ----------
function indexTree(tree) {
  const nodes = new Map(tree.nodes.map((n) => [n.id, n]));
  const parents = new Map(), children = new Map();
  for (const n of tree.nodes) { parents.set(n.id, []); children.set(n.id, []); }
  for (const n of tree.nodes) {
    const seen = new Set();
    eachKey(n.req, (k) => {
      for (const p of k.providers) {
        if (!nodes.has(p.id) || seen.has(p.id)) continue;
        seen.add(p.id);
        const e = { from: p.id, to: n.id, via: k.key, back: !!p.back };
        parents.get(n.id).push(e);
        children.get(p.id).push(e);
      }
    });
  }
  // cards with the same name (stone strata, growth stages) also show their item id
  const seen = new Map();
  for (const n of tree.nodes) seen.set(n.text, (seen.get(n.text) || 0) + 1);
  const dupe = new Set(tree.nodes.filter((n) => seen.get(n.text) > 1 && n.info.name).map((n) => n.id));
  return { tree, nodes, parents, children, dupe };
}

const keyMet = (k) => !!k.free || k.providers.some((p) => D().has(p.id));
function met(req) {
  switch (req.op) {
    case 'always': return true;
    case 'key': return keyMet(req);
    case 'and': return req.of.every(met);
    case 'or': return req.of.some(met);
    default: return false;
  }
}
function stateOf(id) {
  if (D().has(id)) return 'done';
  return met(T.nodes.get(id).req) ? 'open' : 'locked';
}
function computeVisibility() {
  visState = {};
  for (const n of T.tree.nodes) {
    const s = stateOf(n.id);
    if (!spoilers || s !== 'locked') { visState[n.id] = s; continue; }
    if (T.parents.get(n.id).some((e) => D().has(e.from))) visState[n.id] = 'locked';
  }
}
const hiddenName = (id) => spoilers && visState[id] !== 'done' && visState[id] !== 'open';
const tierOf = (id) => T.nodes.get(id).tier;

/** How deep a requirement reaches, by the tiers of what provides it. */
function exprTier(r) {
  switch (r.op) {
    case 'always': return 0;
    case 'key': {
      if (r.free) return 0;
      const ts = r.providers.filter((p) => T.nodes.has(p.id)).map((p) => tierOf(p.id) + 1);
      return ts.length ? Math.min(...ts) : Infinity;
    }
    case 'and': return r.of.length ? Math.max(...r.of.map(exprTier)) : 0;
    case 'or': return r.of.length ? Math.min(...r.of.map(exprTier)) : Infinity;
    default: return Infinity;
  }
}

/** The quickest way to `id`: one cheapest way through every choice. */
function quickest(id) {
  const out = new Set();
  const visit = (nid) => {
    if (out.has(nid)) return;
    out.add(nid);
    walk(T.nodes.get(nid).req);
  };
  const walk = (r) => {
    if (r.op === 'key') {
      if (r.free) return;
      const ps = r.providers.filter((p) => T.nodes.has(p.id));
      const pool = ps.filter((p) => !p.back).length ? ps.filter((p) => !p.back) : ps;
      if (!pool.length) return;
      const best = pool.reduce((a, b) => (tierOf(b.id) < tierOf(a.id) ? b : a));
      if (!best.back) visit(best.id);
    } else if (r.op === 'and') r.of.forEach(walk);
    else if (r.op === 'or' && r.of.length) {
      const best = r.of.reduce((a, b) => (exprTier(b) < exprTier(a) ? b : a));
      walk(best);
    }
  };
  visit(id);
  out.delete(id);
  return out;
}
function descendants(id) {
  const out = new Set(), stack = [id];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of T.children.get(cur)) {
      if (e.back || out.has(e.to)) continue;
      out.add(e.to);
      stack.push(e.to);
    }
  }
  return out;
}

// ---------- rendering ----------
function visibleIds() {
  let ids = Object.keys(visState);
  const v = V();
  if (v.mod) {
    const keep = new Set();
    for (const id of ids) if (T.nodes.get(id).mod === v.mod) { keep.add(id); quickest(id).forEach((a) => keep.add(a)); }
    ids = ids.filter((id) => keep.has(id));
  }
  if (v.focus && visState[v.focus]) {
    const keep = quickest(v.focus);
    keep.add(v.focus);
    ids = ids.filter((id) => keep.has(id));
  } else if (v.focus) v.focus = null;
  return ids;
}

function render() {
  computeVisibility();
  const v = V();
  const ids = visibleIds();
  const bar = [];
  if (v.focus) bar.push(`the quickest way to <strong>${esc(hiddenName(v.focus) ? '???' : cap(T.nodes.get(v.focus).text))}</strong>`);
  if (v.mod) bar.push(`<strong>${esc(modName(v.mod))}</strong> and what it needs`);
  $('focusBar').hidden = !bar.length;
  $('focusText').innerHTML = bar.length ? `Showing ${bar.join(', within ')}` : '';

  const shown = new Set(ids);
  const links = [];
  const drawn = new Set();
  for (const id of ids) {
    const n = T.nodes.get(id);
    eachKey(n.req, (k) => {
      // link the earliest providers of each requirement (all are listed in the panel)
      let ps = k.providers.filter((p) => shown.has(p.id) && (spoilers ? D().has(p.id) : !p.back));
      if (!ps.length) return;
      const best = Math.min(...ps.map((p) => tierOf(p.id)));
      ps = ps.filter((p) => tierOf(p.id) === best).slice(0, 3);
      for (const p of ps) {
        const key = `${p.id}>${id}`;
        if (drawn.has(key) || p.id === id) continue;
        drawn.add(key);
        links.push({ source: p.id, target: id });
      }
    });
  }
  // rings: one per tier present, numbered from the middle out
  const tiers = [...new Set(ids.map(tierOf))].sort((a, b) => a - b);
  const ringOf = new Map(tiers.map((t, i) => [t, i]));
  const deepest = Math.max(0, ...T.tree.nodes.filter((n) => !n.unreachable).map((n) => n.tier));
  const rings = tiers.map((t, i) => ({ ring: i, label: t > deepest ? 'Out of reach' : `Tier ${t}` }));
  const nodes = ids.map((id) => {
    const n = T.nodes.get(id), s = visState[id], hide = hiddenName(id);
    return {
      id, state: s, mystery: hide, ring: ringOf.get(tierOf(id)), fresh: fresh.has(id),
      label: hide ? '???' : cap(n.text),
      sub: hide ? '' : (T.dupe.has(id) ? n.info.name : modName(n.mod)),
      weight: T.children.get(id).filter((e) => !e.back).length,
      hue: hue(String(n.mod)),
    };
  });
  const how = web.update(kind, nodes, links, rings);
  if (how === 'new') web.fit(false);
  fresh.clear();
  if (v.selected && !shown.has(v.selected)) v.selected = null;
  highlight();
  renderDetails();
  $('progress').textContent = `${D().size} / ${T.tree.nodes.length} ${L().count}`;
}

function highlight() {
  const sel = V().selected;
  web.highlight({ selected: sel, anc: sel ? quickest(sel) : new Set(), desc: sel ? descendants(sel) : new Set() });
}

// ---------- details panel ----------
function nodeLink(id, extra = '') {
  const s = visState[id];
  if (!s) return '<span class="nlink locked"><span class="ic">?</span><span class="nt">??? (not yet revealed)</span></span>';
  const hide = hiddenName(id);
  const ic = s === 'done' ? '✓' : s === 'open' ? '●' : hide ? '🔒' : '○';
  return `<button class="nlink ${s}" data-go="${esc(id)}"><span class="ic">${ic}</span>`
    + `<span class="nt">${esc(hide ? '???' : cap(T.nodes.get(id).text))}</span>${extra}</button>`;
}

function keyNote(k) {
  const notes = [];
  const extra = T.tree.meta.notes || {};
  if (extra[k]) notes.push(extra[k]);
  return notes.length ? `<div class="note">${esc(notes.join(' — '))}</div>` : '';
}

/** A requirement, as nested lists. `hide`: the node is still a mystery. */
function renderReq(r, hide, top) {
  if (r.op === 'always') {
    return `<div class="way-always">${esc(r.label || L().always)}${r.note ? `<div class="note">${esc(r.note)}</div>` : ''}</div>`;
  }
  if (r.op === 'key') {
    const isMet = keyMet(r);
    if (hide && !isMet) return '<div class="req-key"><div class="k"><code>???</code></div><div class="note">Needs a discovery you haven\'t made yet.</div></div>';
    const out = [`<div class="req-key"><div class="k">${isMet ? '<span class="met" title="met">✓</span>' : ''}`
      + `<code>${esc(r.label || r.key)}</code>${r.label ? '' : `<span class="kind">${keyKind(r.key)}</span>`}</div>${keyNote(r.key)}`];
    if (r.note) out.push(`<div class="note">${esc(r.note)}</div>`);
    const ps = r.providers.filter((p) => T.nodes.has(p.id));
    if (ps.length) {
      const sorted = [...ps].sort((a, b) => (D().has(b.id) - D().has(a.id)) || tierOf(a.id) - tierOf(b.id));
      const item = (p) => `<li>${nodeLink(p.id, p.tag === 'implied' ? ' <span class="sub">(implied)</span>' : '')}</li>`;
      out.push(`<ul class="providers">${sorted.slice(0, 6).map(item).join('')}</ul>`);
      if (sorted.length > 6) {
        out.push(`<details class="more"><summary>${sorted.length - 6} more</summary><ul class="providers">${sorted.slice(6).map(item).join('')}</ul></details>`);
      }
    }
    out.push('</div>');
    return out.join('');
  }
  const parts = r.of.map((x) => renderReq(x, hide, false));
  if (r.op === 'or' && r.of.some((x) => x.op !== 'key')) {
    // alternatives with their own labels: one card per way
    const ways = r.of.map((x, i) => {
      const label = x.label && !(hide && !met(x)) ? x.label : (x.op === 'key' ? '' : `Way ${i + 1}`);
      return `<div class="way${met(x) ? ' ok' : ''}">${label ? `<div class="way-label">${esc(label)}</div>` : ''}${parts[i]}</div>`;
    });
    return `<p>${r.of.length > 1 ? `<span class="op">Any one</span> of these ${r.of.length} ways:` : ''}</p>${ways.join('')}`;
  }
  const head = r.of.length > 1 ? `<p><span class="op">${r.op === 'and' ? 'All' : 'Any'}</span> of these:</p>` : '';
  const label = !top && r.label ? '' : (top && r.label && !(hide && !met(r)) ? `<div class="way-label">${esc(r.label)}</div>` : '');
  return `${label}${head}${parts.join('')}`;
}

function renderIntro() {
  const m = T.tree.meta;
  const mods = (m.addons || []).length;
  const src = m.source || (base.curated && hintTreeFromCurated(base.curated).meta.source);
  return `<h2>How to use this</h2>`
    + (kind === 'hints'
      ? '<p>Each dot is one of NodeCore\'s in-game hints, with arrows to the ones it unlocks. Day-one hints drift to the middle and later ones outward; bigger dots unlock more.</p>'
      : '<p>Each dot is an item, with arrows from ingredients and tools to what they help make. What you find in the world drifts to the middle and harder things outward; colour is the mod. This covers every mod, whether or not it adds hints.</p>')
    + (spoilers
      ? `<p><strong>Spoilers mode is on.</strong> You only see what you've ${L().count} and what's within reach next. Click a highlighted dot once you've done it in-game to reveal what it leads to. <code>?</code> dots need more first.</p>`
      : '<p>Click any dot to see what it needs and what it leads to. Drag to pan, scroll to zoom (names appear as you zoom in), and drag dots about. Turn on <strong>Spoilers mode</strong> to hide everything you haven\'t reached yet.</p>')
    + '<h3>Legend</h3><ul class="legend">'
    + `<li><span class="swatch done"></span>${L().done}</li>`
    + '<li><span class="swatch open"></span>Within reach now</li>'
    + '<li><span class="swatch locked"></span>Locked (needs more)</li>'
    + '<li><span class="line anc"></span>The quickest way to the selection</li>'
    + '<li><span class="line desc"></span>What the selection leads to</li></ul>'
    + '<p class="sub">Only the earliest way to each requirement is drawn; the panel lists them all. Steps that loop back to earlier ones are marked <em>(loop)</em>. Bigger dots lead to more things.</p>'
    + '<h3>About the data</h3><ul class="meta-list">'
    + `<li>${m.count} ${L().noun}${m.recipes ? ` · ${m.recipes} ways of making things` : ''}</li>`
    + (src ? `<li>From <a href="${esc(src.repo)}">NodeCore</a> commit <code>${esc(String(src.commit).slice(0, 7))}</code>${src.date ? ` (${esc(src.date)})` : ''}</li>` : '')
    + `<li>${mods ? `With ${mods} added mod${mods > 1 ? 's' : ''}: ${esc(m.addons.join(', '))}` : 'No mods added'} · <button class="linkish" data-open-mods>Mods…</button></li>`
    + `<li><a href="${CURATED_URL}">Hint JSON</a> · <a href="${EXTRACT_URL}">Extracted registry JSON</a></li></ul>`;
}

function renderDetails() {
  const sel = V().selected;
  details.classList.toggle('collapsed', !sel);
  if (!sel) { details.innerHTML = renderIntro(); return; }
  const id = sel, n = T.nodes.get(id), s = visState[id] || stateOf(id), hide = hiddenName(id);
  const out = ['<button class="ghost small close" data-close>Close</button>'];
  const label = { done: L().done, open: 'Within reach', locked: 'Locked' }[s];
  const pills = [`<span class="pill ${s}">${label}</span>`, `<span class="pill">${n.unreachable ? 'Out of reach' : `Tier ${n.tier}`}</span>`];
  if (!hide && n.hidden) pills.push('<span class="pill" title="NodeCore never lists this as an upcoming hint">secret</span>');
  if (!hide && n.info.world) pills.push('<span class="pill">found in the world</span>');
  if (!hide && (T.tree.meta.addons || []).includes(n.mod)) pills.push('<span class="pill open">from a mod</span>');
  out.push(`<p>${pills.join('')}</p>`);
  out.push(`<h2>${esc(hide ? '???' : cap(n.text))}</h2>`);
  if (hide) out.push('<p class="sub">You haven\'t unlocked this yet. It needs what\'s below.</p>');
  else {
    const where = [esc(modName(n.mod))];
    if (n.info.source && T.tree.meta.source) {
      const m = /^(.*):(\d+)$/.exec(n.info.source);
      const url = `${T.tree.meta.source.repo}/-/blob/${T.tree.meta.source.commit}/${m ? `${m[1]}#L${m[2]}` : n.info.source}`;
      where.push(`<a href="${esc(url)}" target="_blank" rel="noopener">${esc(n.info.source)}</a>`);
    }
    if (n.info.name) where.push(`<code>${esc(n.info.name)}</code>`);
    out.push(`<div class="sub">${where.join(' · ')}</div>`);
  }

  out.push('<div class="actions">');
  if (s === 'done') out.push(`<button class="ghost" data-toggle>${L().unmark}</button>`);
  else if (s === 'open') out.push(`<button class="primary" data-toggle>${L().mark}</button>`);
  if (!hide) out.push(`<button class="ghost" data-focus>${V().focus === id ? 'Show everything' : 'Show the quickest way here'}</button>`);
  out.push('</div>');

  if (!hide && n.info.goal) {
    const g = n.info.goal;
    out.push(`<h3>Completed by ${g.keys.length > 1 ? `<span class="op">${g.op === 'and' ? 'all' : 'any'}</span> of` : ''}</h3>`);
    out.push(g.keys.map((k) => `<div class="req-key"><div class="k"><code>${esc(k)}</code><span class="kind">${keyKind(k)}</span></div>${keyNote(k)}</div>`).join(''));
  }

  out.push(`<h3>${L().req}</h3>`);
  if (n.req.note && n.req.op === 'always') out.push(`<p>${esc(L().always)}</p><div class="note">${esc(n.req.note)}</div>`);
  else out.push(renderReq(n.req, hide, true));

  if (!hide) {
    const kids = [];
    const seen = new Set();
    for (const e of T.children.get(id)) if (!seen.has(e.to)) { seen.add(e.to); kids.push(e); }
    out.push(`<h3>${L().kids}</h3>`);
    if (!kids.length) out.push(`<p class="sub">${L().none}</p>`);
    else if (spoilers && s !== 'done') out.push('<p class="sub">Discover this to see what it leads to.</p>');
    else {
      kids.sort((a, b) => a.back - b.back || tierOf(a.to) - tierOf(b.to));
      const item = (e) => `<li>${nodeLink(e.to, e.back ? ' <span class="sub">(loop)</span>' : '')}</li>`;
      out.push(`<ul class="providers flat">${kids.slice(0, 12).map(item).join('')}</ul>`);
      if (kids.length > 12) out.push(`<details class="more"><summary>${kids.length - 12} more</summary><ul class="providers flat">${kids.slice(12).map(item).join('')}</ul></details>`);
    }
    if (n.info.groups && Object.keys(n.info.groups).length) {
      out.push('<h3>Groups</h3><p class="chips">');
      out.push(Object.entries(n.info.groups).sort().map(([g, lv]) => `<code title="${esc((T.tree.meta.notes || {})[`group:${g}`] || '')}">${esc(g)}${lv !== 1 ? `=${lv}` : ''}</code>`).join(' '));
      out.push('</p>');
    }
    if (n.info.toolcaps && Object.keys(n.info.toolcaps).length) {
      out.push('<h3>Digs as a tool</h3><p class="chips">');
      out.push(Object.entries(n.info.toolcaps).map(([g, lv]) => `<code>${esc(g)} ${esc(Array.isArray(lv) ? lv.join(',') : '')}</code>`).join(' '));
      out.push('</p>');
    }
  }
  details.innerHTML = out.join('');
  details.scrollTop = 0;
}

// ---------- actions ----------
function setHash() {
  const sel = V().selected;
  try { history.replaceState(null, '', sel ? `#${kind}/${encodeURIComponent(sel)}` : `${location.pathname}${location.search}#${kind}`); } catch { /* ignore */ }
}
function select(id, scroll) {
  V().selected = id;
  setHash();
  highlight();
  renderDetails();
  if (id && scroll) scrollToNode(id);
}
function setDiscovered(id, on) {
  if (on) {
    D().add(id);
    const before = new Set(Object.keys(visState));
    computeVisibility();
    for (const k of Object.keys(visState)) if (!before.has(k)) fresh.add(k);
  } else D().delete(id);
  save(storeDisc(kind), [...D()]);
  render();
}
function scrollToNode(id) { web.focusOn(id); }
function clearFilterFor(id) {
  const v = V();
  let changed = false;
  if (v.focus && id !== v.focus && !quickest(v.focus).has(id)) { v.focus = null; changed = true; }
  if (v.mod && T.nodes.get(id).mod !== v.mod && !visibleIds().includes(id)) { v.mod = ''; $('modFilter').value = ''; changed = true; }
  if (changed) render();
}

function setKind(k, { keepScroll } = {}) {
  if (!trees[k]) return;
  kind = k;
  save(STORE_KIND, k);
  T = indexTree(trees[k]);
  document.querySelectorAll('.seg [data-kind]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.kind === k)));
  $('search').placeholder = L().search;
  fillModFilter();
  render();
  setHash();
  if (!keepScroll) web.fit();
}

function fillModFilter() {
  const counts = new Map();
  for (const n of T.tree.nodes) counts.set(n.mod, (counts.get(n.mod) || 0) + 1);
  const addons = new Set(T.tree.meta.addons || []);
  const mods = [...counts.keys()].sort((a, b) => (addons.has(b) - addons.has(a)) || String(a).localeCompare(b));
  const sel = $('modFilter');
  if (!counts.has(V().mod)) V().mod = '';
  sel.innerHTML = `<option value="">All mods</option>${mods.map((m) => `<option value="${esc(m)}">${addons.has(m) ? '★ ' : ''}${esc(modName(m))} (${counts.get(m)})</option>`).join('')}`;
  sel.value = V().mod;
}

/** Rebuild both trees from a registry extract (NodeCore alone, or with mods). */
function setExtract(dump) {
  base.extract = dump;
  const curated = hintTreeFromCurated(base.curated);
  trees.hints = (dump.addons || []).length ? hintTreeFromExtract(dump, { curated }) : curated;
  trees.recipes = recipeTreeFromExtract(dump);
  for (const k of ['hints', 'recipes']) {
    const ids = new Set(trees[k].nodes.map((n) => n.id));
    for (const id of [...discovered[k]]) if (!ids.has(id)) discovered[k].delete(id);
  }
  setKind(kind, { keepScroll: true });
}

// ---------- search ----------
const results = $('results'), search = $('search');
let activeResult = 0, resultIds = [];
function runSearch() {
  const q = search.value.trim().toLowerCase();
  if (!q) { results.hidden = true; return; }
  resultIds = Object.keys(visState).filter((id) => {
    if (hiddenName(id)) return false;
    const n = T.nodes.get(id);
    if (n.text.toLowerCase().includes(q) || String(n.mod).includes(q) || (n.info.name || '').includes(q)) return true;
    return !!(n.info.goal && n.info.goal.keys.some((k) => k.toLowerCase().includes(q)));
  }).sort((a, b) => tierOf(a) - tierOf(b)).slice(0, 15);
  activeResult = 0;
  results.innerHTML = resultIds.length
    ? resultIds.map((id, i) => `<li><button data-go="${esc(id)}"${i === 0 ? ' class="active"' : ''}>${esc(cap(T.nodes.get(id).text))}`
      + `<span class="r-meta">${esc(modName(T.nodes.get(id).mod))} · T${tierOf(id)}</span></button></li>`).join('')
    : `<li class="empty">${spoilers ? "No matches among what you've unlocked" : 'No matches'}</li>`;
  results.hidden = false;
}
function pickResult(id) {
  results.hidden = true;
  search.value = '';
  clearFilterFor(id);
  select(id, true);
}

// ---------- events ----------
function clickNode(id) {
  if (spoilers && visState[id] === 'open') { V().selected = id; setDiscovered(id, true); select(id); return; }
  select(id === V().selected ? null : id);
}

function wire() {
  web = new WebView(viewport, { click: clickNode, background: () => select(null) });
  details.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-go]');
    if (go) { const id = go.getAttribute('data-go'); clearFilterFor(id); select(id, true); return; }
    const sel = V().selected;
    if (ev.target.closest('[data-toggle]')) { setDiscovered(sel, !D().has(sel)); return; }
    if (ev.target.closest('[data-focus]')) { V().focus = V().focus === sel ? null : sel; render(); setTimeout(() => (V().focus ? web.fit() : scrollToNode(sel)), 700); return; }
    if (ev.target.closest('[data-close]')) select(null);
  });
  $('focusClear').addEventListener('click', () => {
    V().focus = null; V().mod = ''; $('modFilter').value = '';
    render();
    if (V().selected) scrollToNode(V().selected);
  });
  $('modFilter').addEventListener('change', (ev) => { V().mod = ev.target.value; V().focus = null; render(); setTimeout(() => web.fit(), 700); });
  document.querySelectorAll('.seg [data-kind]').forEach((b) => b.addEventListener('click', () => setKind(b.dataset.kind)));

  const sp = $('spoilers');
  sp.checked = spoilers;
  sp.addEventListener('change', () => {
    spoilers = sp.checked;
    save(STORE_SPOIL, spoilers);
    render();
    if (V().selected) scrollToNode(V().selected);
  });
  $('reset').addEventListener('click', () => {
    if (!D().size || confirm(`Forget all ${D().size} ${L().noun} you've marked in this tree?`)) {
      D().clear();
      save(storeDisc(kind), []);
      V().selected = null; V().focus = null;
      render();
    }
  });
  $('zoomIn').addEventListener('click', () => web.zoomBy(1.3));
  $('zoomOut').addEventListener('click', () => web.zoomBy(1 / 1.3));
  $('zoomFit').addEventListener('click', () => web.fit());

  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (ev) => {
    const btns = results.querySelectorAll('button');
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (!btns.length) return;
      activeResult = (activeResult + (ev.key === 'ArrowDown' ? 1 : btns.length - 1)) % btns.length;
      btns.forEach((b, i) => b.classList.toggle('active', i === activeResult));
    } else if (ev.key === 'Enter' && resultIds[activeResult]) pickResult(resultIds[activeResult]);
    else if (ev.key === 'Escape') results.hidden = true;
  });
  results.addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-go]');
    if (b) pickResult(b.getAttribute('data-go'));
  });
  document.addEventListener('click', (ev) => { if (!ev.target.closest('.search')) results.hidden = true; });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && document.activeElement !== search && $('modsPanel').hidden) select(null);
  });
}

// ---------- boot ----------
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

(async () => {
  try {
    const [curated, extract] = await Promise.all([getJSON(CURATED_URL), getJSON(EXTRACT_URL)]);
    base.curated = curated;
    for (const k of ['hints', 'recipes']) discovered[k] = new Set(load(storeDisc(k), k === 'hints' ? load('nc-tree:discovered', []) : []));
    spoilers = !!load(STORE_SPOIL, true);
    const m = /^#(hints|recipes)(?:\/(.+))?$/.exec(location.hash);
    const legacy = !m && location.hash.length > 1 ? decodeURIComponent(location.hash.slice(1)) : null;
    kind = m ? m[1] : legacy ? 'hints' : (load(STORE_KIND, 'hints') === 'recipes' ? 'recipes' : 'hints');
    $('loading').remove();
    wire();
    setExtract(extract);
    const want = m && m[2] ? decodeURIComponent(m[2]) : legacy;
    if (want && visState[want]) select(want, true);
    base.extract0 = extract;
    initMods({
      apply: (dump) => setExtract(dump || base.extract0),
      openFromDetails: (fn) => details.addEventListener('click', (ev) => { if (ev.target.closest('[data-open-mods]')) fn(); }),
    });
  } catch (err) {
    const el = $('loading');
    if (!el) { console.error(err); return; }
    el.classList.add('error');
    el.textContent = `Couldn't load the discovery data (${err.message}). `
      + (location.protocol === 'file:' ? 'Browsers block this when opening the file directly — serve the folder, e.g. `python3 -m http.server`.' : '');
  }
})();
