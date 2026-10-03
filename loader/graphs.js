// Turns what the mods registered (extract.js) into trees the viewer draws.
//
// A tree is {kind, title, meta, nodes}. Each node is
//   {id, text, mod, tier, hidden, req, info}
// where `req` says what is needed before it is reachable:
//   {op: 'always'}                         nothing
//   {op: 'and' | 'or', of: [req], label?}  all / any of these
//   {op: 'key', key, providers: [{id, tag?}], free?, note?}
// A key is met once any provider is discovered; a `free` key is met from
// the start (found in the world, or by the bare hand). Tiers are depths
// from the roots: an `and` waits for its slowest part, an `or` for its
// fastest. A provider at the same or a deeper tier than the node it feeds
// is marked `back` (a loop) and left out of the drawing.

const STRIP = /^(?:craft|dig|place|inv|look|punch|hurt|wield|touch|find|witness|pickup|drop)+:/;

const firstLine = (s) => String(s || '').split('\n')[0].trim();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const asObj = (v) => (v && !Array.isArray(v) && typeof v === 'object' ? v : {});

// ---------------------------------------------------------------- tiers

function evalTier(req, tier) {
  switch (req.op) {
    case 'always': return 0;
    case 'key': {
      if (req.free && !req.providers.length) return 0;
      let best = Infinity;
      for (const p of req.providers) best = Math.min(best, tier.get(p.id) + 1);
      return req.free ? Math.min(best, 0) : best;
    }
    case 'and': return req.of.length ? Math.max(...req.of.map((r) => evalTier(r, tier))) : 0;
    case 'or': return req.of.length ? Math.min(...req.of.map((r) => evalTier(r, tier))) : Infinity;
    default: return Infinity;
  }
}

function eachKey(req, fn) {
  if (req.op === 'key') fn(req);
  else if (req.of) req.of.forEach((r) => eachKey(r, fn));
}

/** Fill in tiers (Bellman-Ford style, so loops settle) and mark back links. */
export function settle(nodes) {
  const tier = new Map(nodes.map((n) => [n.id, Infinity]));
  for (let pass = 0, changed = true; changed && pass < nodes.length + 2; pass++) {
    changed = false;
    for (const n of nodes) {
      const t = evalTier(n.req, tier);
      if (t < tier.get(n.id)) { tier.set(n.id, t); changed = true; }
    }
  }
  const finite = [...tier.values()].filter(Number.isFinite);
  const deepest = finite.length ? Math.max(...finite) : 0;
  for (const n of nodes) {
    const t = tier.get(n.id);
    n.unreachable = !Number.isFinite(t) || undefined;
    n.tier = Number.isFinite(t) ? t : deepest + 1;
  }
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) {
    eachKey(n.req, (k) => {
      for (const p of k.providers) {
        const src = byId.get(p.id);
        p.back = !src || src.tier >= n.tier || undefined;
      }
    });
  }
  return nodes;
}

// ---------------------------------------------------------------- hints, from the curated JSON

/** The hand-curated hint tree (data/nodecore-discovery.json) as a tree. */
export function hintTreeFromCurated(data) {
  const cycle = new Set((data.cycle_edges || []).map((e) => `${e.from}>${e.to}`));
  const world = data.world_provided_req_keys || {};
  const into = new Map();
  for (const e of data.edges) {
    if (!into.has(e.to)) into.set(e.to, []);
    into.get(e.to).push(e);
  }
  const nodes = data.nodes.map((n) => {
    const edges = into.get(n.id) || [];
    const keys = n.reqs.keys.map((k) => {
      const all = edges.filter((e) => e.via === k);
      const live = all.filter((e) => !cycle.has(`${e.from}>${e.to}`));
      const req = { op: 'key', key: k, providers: all.map((e) => ({ id: e.from, tag: e.resolved_by === 'implied' ? 'implied' : undefined, back: cycle.has(`${e.from}>${e.to}`) || undefined })) };
      if (!live.length && all.length) { req.free = true; req.note = 'Only reachable through a loop; treated as free.'; }
      if (k in world) { req.free = true; req.note = 'Found just by playing — no hint teaches it.'; }
      if (!all.length && !req.free) req.note = 'No hint grants this directly.';
      return req;
    });
    const req = n.reqs.op === 'always' ? { op: 'always' } : { op: n.reqs.op, of: keys };
    return {
      id: n.id, text: n.text, mod: n.mod, tier: n.tier, hidden: n.hidden, req,
      info: { goal: n.goal, source: n.source },
    };
  });
  // the tiers are recomputed so a tree with mods added and one without agree
  settle(nodes);
  const m = data.meta;
  return {
    kind: 'hints', nodes,
    meta: {
      title: 'Hints', count: nodes.length,
      source: { repo: m.source_repo.replace(/\.git$/, ''), commit: m.source_commit, date: m.source_date },
      notes: notesFrom(data),
    },
  };
}

function notesFrom(data) {
  const notes = {};
  for (const [g, d] of Object.entries(data.groups || {})) notes[`group:${g}`] = d;
  for (const [k, v] of Object.entries(data.curated_providers || {})) if (v.note) notes[k] = (notes[k] ? `${notes[k]} — ` : '') + v.note;
  return notes;
}

// ---------------------------------------------------------------- the registry, from an extract

function registry(dump) {
  const items = dump.items || {};
  const aliases = dump.aliases || {};
  const resolve = (name) => {
    let n = String(name || '').trim().split(/\s+/)[0].replace(/^:/, '');
    for (let i = 0; i < 10 && aliases[n]; i++) n = aliases[n];
    return n;
  };
  const groupsOf = (name) => asObj(items[name] && items[name].groups);
  const capsOf = (def) => asObj(def && def.toolcaps);
  const memberCache = new Map();
  /** Items carrying every one of `groups`. */
  const members = (groups) => {
    const key = groups.join('+');
    if (!memberCache.has(key)) {
      memberCache.set(key, Object.keys(items).filter((n) => groups.every((g) => groupsOf(n)[g])).sort());
    }
    return memberCache.get(key);
  };
  const toolsFor = (g, lv) => Object.keys(items).filter((n) => (capsOf(items[n])[g] || []).includes(lv)).sort();
  const handDigs = (g, lv) => (asObj(dump.hand)[g] || []).includes(lv);
  return { items, resolve, members, toolsFor, handDigs, groupsOf, capsOf };
}

// item fields NodeCore uses to change one thing into another in the world
// (read by extract.lua): what each means as a way of getting the target
const TRANSFORMS = {
  drop_in_place: { action: 'dig', text: 'dig' },
  drop_as: { action: 'dig', text: 'dig' },
  drop_non_silktouch: { action: 'dig', text: 'dig' },
  silktouch_as: { action: 'dig', text: 'dig carefully (silk touch)' },
  lode_alt_hot: { action: 'heat', text: 'heat', hot: false },
  lode_alt_annealed: { action: 'cool', text: 'let cool', hot: true },
  lode_alt_tempered: { action: 'quench', text: 'quench', hot: true },
  tool_wears_to: { action: 'wear', text: 'wear out' },
  repack_to: { action: 'repack', text: 'repack' },
  alternative_lux_infused: { action: 'infuse', text: 'infuse with lux' },
  flower_wilts_to: { action: 'wilt', text: 'let wilt' },
  soil_degrades_to: { action: 'degrade', text: 'let degrade' },
  leaf_decay_as: { action: 'decay', text: 'let decay' },
  on_ignite: { action: 'ignite', text: 'set fire to' },
};

/** Every recipe as {label, action, inputs: [{kind, ...}], outputs: [name], mod}. */
function recipesOf(dump, reg) {
  const out = [];
  const matchInput = (m, role) => {
    if (!m) return null;
    if (m.name) {
      const name = String(m.name);
      if (name.startsWith('group:')) return { kind: 'group', groups: name.slice(6).split(','), role };
      return { kind: 'item', name: reg.resolve(name), role, count: m.count };
    }
    if (m.groups && m.groups.length) return { kind: 'group', groups: [...m.groups].sort(), role, count: m.count };
    return { kind: 'other', role };
  };
  for (const r of dump.nc_recipes || []) {
    const inputs = [];
    const outputs = new Set();
    for (const n of r.nodes || []) {
      const inp = matchInput(n.match, n.x || n.y || n.z ? 'beside' : 'target');
      if (inp) inputs.push(inp);
      if (n.replace && n.replace !== 'air') {
        const rep = reg.resolve(n.replace);
        if (!(inp && inp.kind === 'item' && inp.name === rep)) outputs.add(rep);
      }
    }
    for (const it of r.items || []) outputs.add(reg.resolve(it.name));
    const wield = matchInput(r.wield, 'held');
    if (wield) inputs.push(wield);
    const tools = Object.entries(asObj(r.toolgroups));
    if (tools.length) inputs.push({ kind: 'tool', groups: tools, role: 'tool' });
    outputs.delete('');
    if (!outputs.size) continue;
    out.push({ label: r.label || r.action, action: r.action || 'place', inputs, outputs: [...outputs], mod: r.mod });
  }
  for (const c of dump.crafts || []) {
    if (c.type === 'fuel' || c.type === 'toolrepair') continue;
    const cells = [];
    const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); else if (typeof v === 'string' && v.trim()) cells.push(v); };
    walk(c.recipe);
    const counts = new Map();
    for (const s of cells) counts.set(s, (counts.get(s) || 0) + 1);
    const inputs = [...counts].map(([s, count]) => (s.startsWith('group:')
      ? { kind: 'group', groups: s.slice(6).split(',').map((g) => g.trim()), count }
      : { kind: 'item', name: reg.resolve(s), count }));
    const outputs = new Set();
    if (c.output) outputs.add(reg.resolve(c.output));
    for (const rep of Array.isArray(c.replacements) ? c.replacements : []) if (Array.isArray(rep) && rep[1]) outputs.add(reg.resolve(rep[1]));
    outputs.delete('');
    if (!outputs.size || !inputs.length) continue;
    const kind = c.type === 'cooking' ? 'furnace' : c.type === 'shapeless' ? 'shapeless craft' : 'craft';
    out.push({ label: `${kind}: ${firstLine(reg.items[[...outputs][0]]?.description) || [...outputs][0]}`, action: kind, inputs, outputs: [...outputs], mod: c.mod });
  }
  // what leaves drop as they are dug or decay (nc.register_leaf_drops)
  const byMod = new Map();
  for (const d of dump.leaf_drops || []) {
    const n = reg.resolve(d.name);
    if (!reg.items[n]) continue;
    if (!byMod.has(d.mod)) byMod.set(d.mod, new Set());
    byMod.get(d.mod).add(n);
  }
  for (const [mod, names] of byMod) {
    out.push({ label: 'leaves dropping things as they decay', action: 'decay', inputs: [{ kind: 'group', groups: ['canopy'], role: 'target' }], outputs: [...names], mod });
  }
  // what game code turns things into (ABMs and item-stack ABMs, probed by
  // extract.lua): one way of making `to` per thing it starts from, needing
  // one of the neighbours that brought it about, unless it happens anyway
  const changes = new Map();
  for (const c of dump.abm_changes || []) {
    const from = reg.resolve(c.from), to = reg.resolve(c.to);
    if (!reg.items[from] || !reg.items[to] || from === to || /_flowing$/.test(to)) continue;
    const k = `${c.kind}|${from}|${to}`;
    if (!changes.has(k)) changes.set(k, { kind: c.kind, from, to, labels: new Set(), hoods: new Set(), anyway: false, mod: c.mod });
    const ch = changes.get(k);
    if (c.label) ch.labels.add(c.label);
    if (c.with) ch.hoods.add(reg.resolve(c.with)); else ch.anyway = true;
  }
  for (const ch of changes.values()) {
    const inputs = [{ kind: 'item', name: ch.from, role: ch.kind === 'aism' ? 'stack' : 'target' }];
    if (!ch.anyway && ch.hoods.size) inputs.push({ kind: 'oneof', names: [...ch.hoods].sort(), role: 'beside' });
    out.push({ label: [...ch.labels].join(', ') || 'game code', action: ch.kind, inputs, outputs: [ch.to], mod: ch.mod });
  }
  // what digging a node takes: a tool (or the hand) for one of its dig groups
  const digGroups = new Set(Object.keys(asObj(dump.hand)));
  for (const def of Object.values(reg.items)) for (const g of Object.keys(reg.capsOf(def))) digGroups.add(g);
  const digTool = (name) => {
    const groups = Object.entries(reg.groupsOf(name)).filter(([g, lv]) => digGroups.has(g) && lv > 0);
    return groups.length ? [{ kind: 'tool', groups, role: 'tool' }] : [];
  };
  const desc = (name) => firstLine(reg.items[name] && reg.items[name].description) || name;
  for (const [name, def] of Object.entries(reg.items)) {
    const drops = (def.drop || []).map((d) => reg.resolve(d)).filter((d) => d && d !== name);
    if (drops.length) {
      out.push({ label: `dig ${desc(name)}`, action: 'dig', inputs: [{ kind: 'item', name, role: 'target' }, ...(def.type === 'node' ? digTool(name) : [])],
        outputs: [...new Set(drops)], mod: def.mod });
    }
    const hot = !!reg.groupsOf(name).lode_temper_hot;
    for (const [field, target] of Object.entries(asObj(def.transforms))) {
      const t = TRANSFORMS[field];
      const to = reg.resolve(target);
      if (!t || !to || to === name || !reg.items[to]) continue;
      if (t.hot !== undefined && t.hot !== hot) continue;
      const inputs = [{ kind: 'item', name, role: 'target' }];
      if (t.action === 'dig' && def.type === 'node') inputs.push(...digTool(name));
      out.push({ label: `${t.text} ${desc(name)}`, action: t.action, inputs, outputs: [to], mod: def.mod });
    }
  }
  return out;
}

/**
 * Strongly connected components of `nodes` (by provider links among
 * them) that no other component among them leads into.
 */
function sourceComponents(nodes) {
  const ids = new Map(nodes.map((n, i) => [n.id, i]));
  const deps = nodes.map((n) => {
    const out = new Set();
    eachKey(n.req, (k) => k.providers.forEach((p) => { if (ids.has(p.id)) out.add(ids.get(p.id)); }));
    return [...out];
  });
  // Tarjan, iteratively
  const index = new Array(nodes.length).fill(-1);
  const low = new Array(nodes.length).fill(0);
  const onStack = new Array(nodes.length).fill(false);
  const comp = new Array(nodes.length).fill(-1);
  const stack = [];
  let next = 0, ncomp = 0;
  for (let root = 0; root < nodes.length; root++) {
    if (index[root] >= 0) continue;
    const work = [[root, 0]];
    while (work.length) {
      const top = work[work.length - 1];
      const [v, i] = top;
      if (i === 0) { index[v] = low[v] = next++; stack.push(v); onStack[v] = true; }
      if (i < deps[v].length) {
        top[1]++;
        const w = deps[v][i];
        if (index[w] < 0) work.push([w, 0]);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
        continue;
      }
      if (low[v] === index[v]) {
        let w;
        do { w = stack.pop(); onStack[w] = false; comp[w] = ncomp; } while (w !== v);
        ncomp++;
      }
      work.pop();
      if (work.length) { const u = work[work.length - 1][0]; low[u] = Math.min(low[u], low[v]); }
    }
  }
  const fedFromOutside = new Array(ncomp).fill(false);
  nodes.forEach((n, v) => deps[v].forEach((w) => { if (comp[w] !== comp[v]) fedFromOutside[comp[v]] = true; }));
  const groups = Array.from({ length: ncomp }, () => []);
  nodes.forEach((n, v) => { if (!fedFromOutside[comp[v]]) groups[comp[v]].push(n); });
  return groups.filter((g) => g.length);
}

// ---------------------------------------------------------------- recipes

// ways of getting something that only change a thing already there
const SELF_ACTIONS = new Set(['dig', 'heat', 'cool', 'quench', 'wear', 'repack', 'infuse', 'wilt', 'degrade', 'decay', 'ignite', 'abm', 'aism']);

// of those, the ones the world does by itself or a dig does
const NATURAL_ACTIONS = new Set(['dig', 'repack', 'wilt', 'degrade', 'decay']);

const ACTION_TEXT = {
  pummel: 'Pummel', press: 'Press', place: 'Place', cook: 'Cook', stackapply: 'Apply held item',
  dig: 'Dig', heat: 'Heat', cool: 'Cool', quench: 'Quench', wear: 'Wear out', repack: 'Repack', infuse: 'Lux',
  wilt: 'Wilt', degrade: 'Degrade', decay: 'Decay', ignite: 'Burn', abm: 'Over time', aism: 'Over time, in a pile or carried', craft: 'Craft grid', 'shapeless craft': 'Craft grid (any order)', furnace: 'Furnace',
};
const ROLE_TEXT = { target: '', beside: 'beside it: ', held: 'holding ', tool: '', stack: '' };

/** Items as nodes, each needing any one of the recipes that make it. */
export function recipeTreeFromExtract(dump, { title = 'Recipes' } = {}) {
  const reg = registry(dump);
  const recipes = recipesOf(dump, reg);
  const made = new Map();
  const used = new Set();
  for (const r of recipes) {
    for (const o of r.outputs) {
      if (!made.has(o)) made.set(o, []);
      made.get(o).push(r);
    }
    // digging or a change of state alone does not make something an ingredient
    if (!SELF_ACTIONS.has(r.action)) for (const i of r.inputs) if (i.kind === 'item') used.add(i.name);
    // what has to be beside something for it to change (water, fire...) is needed too
    for (const i of r.inputs) if (i.kind === 'oneof') i.names.forEach((n) => used.add(n));
  }
  const world = new Set(dump.world || []);
  // what can be made or found, what recipes call for, and everything an added mod brings
  const addOns = new Set((dump.addons || []));
  const names = Object.keys(reg.items).filter((n) => made.has(n) || used.has(n) || world.has(n) || addOns.has(reg.items[n].mod)).sort();
  const known = new Set(names);
  for (const n of names) {
    // drop ways of making something that start from a thing not in the tree
    if (made.has(n)) made.set(n, made.get(n).filter((r) => r.inputs.every((i) => i.kind !== 'item' || known.has(i.name))));
  }
  const id = (n) => `item:${n}`;

  const keyFor = (inp) => {
    const pre = ROLE_TEXT[inp.role] || '';
    const count = inp.count > 1 ? ` ×${inp.count}` : '';
    if (inp.kind === 'item') {
      const name = firstLine(reg.items[inp.name] && reg.items[inp.name].description) || inp.name;
      return { op: 'key', key: inp.name, label: `${pre}${name}${count}`, providers: known.has(inp.name) ? [{ id: id(inp.name) }] : [],
        note: known.has(inp.name) ? undefined : 'Not registered by any loaded mod.' };
    }
    if (inp.kind === 'group') {
      const key = `group:${inp.groups.join(',')}`;
      const list = reg.members(inp.groups).filter((n) => known.has(n));
      return { op: 'key', key, label: `${pre}any ${inp.groups.join(' + ')}${count}`, providers: list.map((n) => ({ id: id(n) })),
        note: list.length ? undefined : 'No loaded item is in this group.' };
    }
    if (inp.kind === 'oneof') {
      const list = inp.names.filter((n) => known.has(n));
      const names = [...new Set(list.map((n) => firstLine(reg.items[n].description) || n))];
      return { op: 'key', key: `oneof:${inp.names.join('|')}`, label: `${pre}${names.length > 1 ? 'any of ' : ''}${names.slice(0, 4).join(', ')}${names.length > 4 ? ', …' : ''}`,
        providers: list.map((n) => ({ id: id(n) })), note: list.length ? undefined : 'Nothing loaded is like this.' };
    }
    if (inp.kind === 'tool') {
      const of = inp.groups.map(([g, lv]) => {
        const hand = reg.handDigs(g, lv);
        const list = reg.toolsFor(g, lv).filter((n) => known.has(n));
        return { op: 'key', key: `toolcap:${g}:${lv}`, label: `a tool that is ${g} level ${lv}`, providers: list.map((n) => ({ id: id(n) })),
          free: hand || undefined, note: hand ? 'Your bare hand will do.' : undefined };
      });
      return of.length === 1 ? of[0] : { op: 'or', of };
    }
    return { op: 'key', key: '(special)', label: `${pre}something the recipe checks in code`, providers: [], free: true,
      note: 'Matched by a Lua function, which this page cannot read.' };
  };

  const nodes = names.map((n) => {
    const def = reg.items[n];
    const ways = (made.get(n) || []).map((r) => ({
      op: 'and', label: `${ACTION_TEXT[r.action] || r.action}: ${r.label}`,
      of: r.inputs.map(keyFor), info: { action: r.action, mod: r.mod },
    }));
    if (world.has(n)) ways.unshift({ op: 'always', label: 'Found in the world' });
    let req;
    if (ways.length) req = ways.length === 1 ? ways[0] : { op: 'or', of: ways };
    // nothing readable makes it: if a recipe needs it, take it as found;
    // otherwise it is something game code turns other things into
    else if (used.has(n)) req = { op: 'always', note: 'Nothing this page can read makes it: probably found in the world or made by game code. Treated as available.' };
    else req = { op: 'key', key: '(game code)', label: 'made by game code this page cannot read', providers: [], note: 'Probably an ABM or a callback turns something else into it (charging, growing, drying...).' };
    return {
      id: id(n), text: firstLine(def.description) || n, mod: def.mod || n.split(':')[0], req,
      info: { name: n, type: def.type, groups: asObj(def.groups), toolcaps: def.toolcaps, raw: !(made.get(n) || []).length, world: world.has(n) },
    };
  });
  settle(nodes);
  // Something only ever reached by digging or changing another thing
  // (leaves from loose leaves, say) is in practice found in the world -
  // by a tree schematic or game code this page cannot read. Assume so,
  // one upstream thing at a time, so what follows from it (loose leaves,
  // tempered lode) still gets its real way of being made.
  const byName = new Map(nodes.map((n) => [n.info.name, n]));
  const assume = (n, natural) => {
    const before = { req: n.req, info: n.info };
    n.req = { op: 'or', of: [{ op: 'always', label: 'Assumed available',
      note: natural ? 'Nothing this page can read starts it; it is probably found in the world.'
        : 'Nothing this page can read starts it; probably game code does, such as lighting the first fire by rubbing sticks.' },
    ...(n.req.op === 'or' ? n.req.of : [n.req])] };
    n.info = { ...n.info, assumed: natural ? 'world' : 'code' };
    return () => { n.req = before.req; n.info = before.info; };
  };
  const canAssume = (n) => !n.info.assumed && (made.get(n.info.name) || []).length
    && !(made.get(n.info.name) || []).some((r) => !SELF_ACTIONS.has(r.action));
  const natural = (n) => (made.get(n.info.name) || []).every((r) => NATURAL_ACTIONS.has(r.action));
  for (let guard = 0; guard < nodes.length; guard++) {
    // (things only game code makes stay out of reach, and feed nothing here)
    const lost = nodes.filter((n) => n.unreachable && (made.get(n.info.name) || []).length);
    if (!lost.length) break;
    // the unreachable things nothing else unreachable leads to: their
    // strongly connected groups with no way in from outside
    const groups = sourceComponents(lost);
    const waiting = (n) => lost.filter((m) => m.req && JSON.stringify(m.req).includes(`"${n.id}"`)).length;
    let progress = false;
    for (const g of groups) {
      // within a group, the likeliest thing to be lying around first (one only
      // dug, decayed or repacked into being), then the one most is waiting on
      const order = g.filter(canAssume)
        .map((n) => ({ n, nat: natural(n) ? 1 : 0, w: waiting(n) }))
        .sort((x, y) => y.nat - x.nat || y.w - x.w || x.n.id.localeCompare(y.n.id));
      for (const { n, nat } of order) {
        // never accept a guess that makes something already reachable cheaper
        // (that is how a "found" tempered tool would undercut forging one)
        const was = new Map(nodes.filter((m) => !m.unreachable).map((m) => [m.id, m.tier]));
        const undo = assume(n, !!nat);
        settle(nodes);
        if (nodes.some((m) => was.has(m.id) && m.tier < was.get(m.id))) {
          undo();
          settle(nodes);
          continue;
        }
        progress = true;
        break;
      }
    }
    if (!progress) break;
  }
  return { kind: 'recipes', nodes, meta: { title, count: nodes.length, recipes: recipes.length, ...metaOf(dump) } };
}

function metaOf(dump) {
  return { mods: dump.order || [], addons: dump.addons || [], errors: (dump.mods || []).filter((m) => !m.ok), missing: dump.missing || {} };
}

// ---------------------------------------------------------------- hints, from an extract

/**
 * Hints chained goal -> reqs, resolving keys the way nc_api_hints'
 * expandkey() does against the live item registry: an item named in a
 * key also grants its groups and tool capabilities, and every key also
 * counts with its prefixes stripped. A recipe-label goal counts as
 * getting the items that recipe makes.
 */
export function hintTreeFromExtract(dump, { title = 'Hints', curated = null } = {}) {
  const reg = registry(dump);
  const names = Object.keys(reg.items).sort((a, b) => b.length - a.length);
  const cache = new Map();
  const expand = (k) => {
    if (cache.has(k)) return cache.get(k);
    const raw = new Set([k]);
    for (const name of names) {
      if (!k.endsWith(name)) continue;
      const pref = k.slice(0, k.length - name.length);
      for (const g of Object.keys(reg.groupsOf(name))) raw.add(`${pref}group:${g}`);
      for (const [g, lvs] of Object.entries(reg.capsOf(reg.items[name]))) {
        if (!lvs.length) continue;
        raw.add(`${pref}toolcap:${g}`);
        for (const lv of lvs) raw.add(`${pref}toolcap:${g}:${lv}`);
      }
    }
    const out = new Set();
    for (let r of raw) {
      out.add(r);
      while (r.includes(':')) { r = r.replace(/^[^:]*:/, ''); out.add(r); }
    }
    cache.set(k, out);
    return out;
  };
  const byLabel = new Map();
  for (const r of recipesOf(dump, reg)) {
    if (!byLabel.has(r.label)) byLabel.set(r.label, new Set());
    for (const o of r.outputs) byLabel.get(r.label).add(o);
  }

  const hints = dump.hints || [];
  const seen = new Map();
  const ids = hints.map((h) => {
    let base = `${h.mod}/${slug(h.text)}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    return n > 1 ? `${base}-${n}` : base;
  });
  const gives = hints.map((h) => {
    const keys = new Set();
    for (const g of h.goal.keys) {
      for (const k of expand(g)) keys.add(k);
      for (const item of byLabel.get(g) || []) for (const k of expand(item)) keys.add(k);
    }
    return keys;
  });
  const providersOf = (k, self) => {
    const direct = [];
    gives.forEach((keys, i) => { if (i !== self && keys.has(k)) direct.push({ id: ids[i] }); });
    if (direct.length) return direct;
    const bare = k.replace(STRIP, '');
    if (bare === k) return [];
    const implied = [];
    gives.forEach((keys, i) => { if (i !== self && keys.has(bare)) implied.push({ id: ids[i], tag: 'implied' }); });
    return implied;
  };

  const nodes = hints.map((h, i) => {
    let req;
    if (h.reqs.op === 'always') req = { op: 'always' };
    else if (h.reqs.op === 'func') req = { op: 'always', note: 'Its prerequisite is Lua code this page cannot read.' };
    else {
      req = {
        op: h.reqs.op,
        of: h.reqs.keys.map((k) => {
          const providers = providersOf(k, i);
          return providers.length ? { op: 'key', key: k, providers }
            : { op: 'key', key: k, providers, free: true, note: 'No hint leads here; assumed found just by playing.' };
        }),
      };
    }
    return { id: ids[i], text: h.text, mod: h.mod, hidden: !!h.hide, req, info: { goal: h.goal } };
  });
  // NodeCore's own hints keep their hand-checked links (see the README in
  // the luanti repo's nodecore-discovery/); only hints mods add are
  // resolved automatically.
  if (curated) {
    const known = new Map(curated.nodes.map((n) => [n.id, n]));
    for (const n of nodes) {
      const c = known.get(n.id);
      if (!c) continue;
      n.req = JSON.parse(JSON.stringify(c.req));
      n.info = { ...c.info, ...n.info, source: c.info.source };
      n.curated = true;
    }
  }
  settle(nodes);
  return { kind: 'hints', nodes, meta: { title, count: nodes.length, ...metaOf(dump), source: curated && curated.meta.source, notes: curated && curated.meta.notes } };
}
