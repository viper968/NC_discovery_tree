// What Luanti's main menu does with a downloaded package, after unzipping
// it (builtin/mainmenu/content/pkgmgr.lua): find the folder that is the
// mod, modpack or game, read its .conf, and list the mods inside. Then
// what the server does at start-up (src/content/mods.cpp): order the mods
// so each loads after what it depends on, and gather each mod's media.

/**
 * Luanti's Settings format, as .conf files use it: `key = value` lines,
 * `#` comments, and `key = """` ... `"""` for a value spanning lines.
 */
export function parseConf(text) {
  const out = {};
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value === '"""') {
      const body = [];
      while (++i < lines.length && lines[i].trim() !== '"""') body.push(lines[i]);
      value = body.join('\n');
    }
    out[key] = value;
  }
  return out;
}

/** A comma-separated dependency list from a .conf. */
export function splitList(value) {
  return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/** Directory view over a flat {path: bytes} map. */
function dirOf(files) {
  return {
    has: (path) => files.has(path),
    subdirs(dir) {
      const pre = dir ? `${dir}/` : '';
      const out = new Set();
      for (const p of files.keys()) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length);
        const slash = rest.indexOf('/');
        if (slash > 0) out.add(rest.slice(0, slash));
      }
      return [...out].sort();
    },
  };
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/** pkgmgr.get_folder_type: what kind of content a folder holds, if any. */
export function folderType(files, dir) {
  const d = dirOf(files);
  if (d.has(join(dir, 'init.lua'))) return { type: 'mod', path: dir };
  if (d.has(join(dir, 'modpack.conf')) || d.has(join(dir, 'modpack.txt'))) return { type: 'modpack', path: dir };
  if (d.has(join(dir, 'game.conf'))) return { type: 'game', path: dir };
  if (d.has(join(dir, 'texture_pack.conf'))) return { type: 'txp', path: dir };
  return null;
}

/**
 * pkgmgr.get_base_folder: the archive's top level if it is content,
 * else its only folder (archives usually wrap the mod in one).
 */
export function baseFolder(files) {
  const top = folderType(files, '');
  if (top) return top;
  const subs = dirOf(files).subdirs('');
  if (subs.length === 1) return folderType(files, subs[0]) || { type: 'invalid', path: subs[0] };
  return null;
}

const text = (bytes) => new TextDecoder().decode(bytes);

function readModInfo(files, path, fallbackName) {
  const conf = files.has(join(path, 'mod.conf')) ? parseConf(text(files.get(join(path, 'mod.conf')))) : {};
  let depends = splitList(conf.depends);
  let optional = splitList(conf.optional_depends);
  // the old depends.txt: one per line, optional ones marked with "?"
  if (!conf.depends && !conf.optional_depends && files.has(join(path, 'depends.txt'))) {
    for (const raw of text(files.get(join(path, 'depends.txt'))).split(/\r?\n/)) {
      const s = raw.trim();
      if (!s) continue;
      if (s.endsWith('?')) optional.push(s.slice(0, -1)); else depends.push(s);
    }
  }
  depends = [...new Set(depends)];
  optional = [...new Set(optional)].filter((m) => !depends.includes(m));
  return {
    name: conf.name || fallbackName,
    title: conf.title || conf.name || fallbackName,
    description: conf.description || '',
    author: conf.author || '',
    release: conf.release ? Number(conf.release) : undefined,
    depends,
    optional_depends: optional,
    path,
  };
}

/** Every mod in a mod or modpack folder (core.get_mod_list: modpacks nest). */
function modsIn(files, found) {
  if (found.type === 'mod') {
    const name = found.path.split('/').pop() || 'mod';
    return [readModInfo(files, found.path, name)];
  }
  const out = [];
  for (const sub of dirOf(files).subdirs(found.path)) {
    const t = folderType(files, join(found.path, sub));
    if (t && (t.type === 'mod' || t.type === 'modpack')) out.push(...modsIn(files, t));
  }
  return out;
}

const MEDIA_DIRS = ['textures', 'models', 'sounds', 'media'];

/** A mod's media: file name -> bytes, from its media folders and their subfolders. */
function mediaOf(files, mod) {
  const media = new Map();
  for (const dir of MEDIA_DIRS) {
    const pre = `${join(mod.path, dir)}/`;
    for (const [p, bytes] of files) {
      if (p.startsWith(pre)) media.set(p.split('/').pop(), bytes);
    }
  }
  return media;
}

/**
 * Open an unzipped package the way the main menu installs one. `name`,
 * when given, is the ContentDB package name, which Luanti uses for a
 * single mod whose folder is named differently.
 */
export function openPackage(files, { name, title, author, release } = {}) {
  const found = baseFolder(files);
  if (!found) throw new Error('Unable to find a valid mod, modpack, or game');
  if (found.type === 'game') throw new Error('This is a game, not a mod');
  if (found.type === 'txp') throw new Error('This is a texture pack, not a mod');
  if (found.type === 'invalid') throw new Error(`No init.lua or modpack.conf in ${found.path}/`);
  const mods = modsIn(files, found);
  if (found.type === 'mod' && name && !files.has(join(found.path, 'mod.conf'))) mods[0].name = name;
  // what Luanti writes into mod.conf when it installs from ContentDB
  if (found.type === 'mod') {
    if (title) mods[0].title = title;
    if (author) mods[0].author = author;
    if (release) mods[0].release = release;
  }
  for (const mod of mods) {
    mod.files = new Map();
    const pre = mod.path ? `${mod.path}/` : '';
    for (const [p, bytes] of files) if (p.startsWith(pre)) mod.files.set(p.slice(pre.length), bytes);
    mod.media = mediaOf(files, mod);
  }
  return { type: found.type, mods };
}

/**
 * Load order for a set of mods (ModConfiguration::resolveDependencies):
 * each mod after its dependencies and whichever optional ones are present.
 * `provided` names mods that are already there (the simulator's NodeCore).
 * Returns {order, missing: {mod: [deps]}, cycle: [mods]}.
 */
export function loadOrder(mods, provided = () => false) {
  const byName = new Map(mods.map((m) => [m.name, m]));
  const missing = {};
  const ok = new Set();
  // a mod whose hard dependency is absent cannot load, nor can anything needing it
  let changed = true;
  const usable = new Set(byName.keys());
  while (changed) {
    changed = false;
    for (const name of [...usable]) {
      const lack = byName.get(name).depends.filter((d) => !provided(d) && !usable.has(d));
      if (lack.length) { missing[name] = lack; usable.delete(name); changed = true; }
    }
  }
  const order = [];
  const visiting = new Set();
  const cycle = [];
  const visit = (name) => {
    if (ok.has(name) || !usable.has(name)) return;
    if (visiting.has(name)) { cycle.push(name); return; }
    visiting.add(name);
    const m = byName.get(name);
    for (const d of [...m.depends, ...m.optional_depends]) if (usable.has(d)) visit(d);
    visiting.delete(name);
    ok.add(name);
    order.push(m);
  };
  for (const name of [...usable].sort()) visit(name);
  return { order, missing, cycle };
}
