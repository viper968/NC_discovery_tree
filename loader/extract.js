// Runs NodeCore's own Lua and any added mods in a Lua VM (Fengari, as
// nodecore_light_logic_sim uses) under extract.lua's engine stand-in, and
// returns what they registered: items, recipes and hints.

import { openPackage, loadOrder } from './package.js';
import { readZip } from './zip.js';

let fengari = null;
async function loadFengari() {
  if (fengari) return fengari;
  // the web build is a UMD bundle that hangs itself off `window`
  if (typeof window === 'undefined') globalThis.window = globalThis;
  const mod = await import('./vendor/fengari/fengari-web.js');
  fengari = globalThis.fengari || (mod && mod.default) || window.fengari;
  if (!fengari || !fengari.lua) throw new Error('could not load the Lua VM');
  return fengari;
}

async function readLocal(rel, binary) {
  const url = new URL(rel, import.meta.url);
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(url);
    return binary ? new Uint8Array(buf) : buf.toString('utf8');
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  return binary ? new Uint8Array(await res.arrayBuffer()) : res.text();
}

/** The mods of a game archive's mods/ folder, as openPackage gives them. */
export function gameMods(files) {
  const sub = new Map();
  for (const [p, b] of files) {
    const m = /^(?:[^/]+\/)?mods\/(.+)$/.exec(p);
    if (m) sub.set(m[1], b);
  }
  sub.set('modpack.conf', new Uint8Array(0));
  return openPackage(sub).mods;
}

/** NodeCore's own 44 mods: a dependency on one is met by the bundled game. */
export const NODECORE_MOD_NAMES = ['nc_api', 'nc_api_active', 'nc_api_all', 'nc_api_craft', 'nc_api_ents',
  'nc_api_hints', 'nc_api_hud', 'nc_api_loose', 'nc_api_rotate', 'nc_api_storebox', 'nc_api_visinv', 'nc_concrete',
  'nc_doors', 'nc_envsound', 'nc_fire', 'nc_flora', 'nc_igneous', 'nc_items', 'nc_lantern', 'nc_lode', 'nc_loot',
  'nc_lux', 'nc_nodefall', 'nc_optics', 'nc_player_gui', 'nc_player_hand', 'nc_player_health', 'nc_player_hud',
  'nc_player_model', 'nc_player_names', 'nc_player_pickup', 'nc_player_setup', 'nc_player_sky', 'nc_player_wield',
  'nc_player_yctiwy', 'nc_scaling', 'nc_sponge', 'nc_stonework', 'nc_terrain', 'nc_torch', 'nc_tote', 'nc_tree',
  'nc_woodwork', 'nc_writing'];

let nodecoreCache = null;
/** NodeCore's own mods, from the Lua bundled with the site. */
export async function nodecoreMods() {
  if (!nodecoreCache) nodecoreCache = gameMods(await readZip(await readLocal('../data/nodecore-src.zip', true)));
  return nodecoreCache;
}

/**
 * Run `mods` (objects from openPackage: {name, depends, optional_depends,
 * files: Map}) together. Returns the parsed extract with `order` and
 * `missing` (mods left out for a missing dependency) added.
 */
export async function extract(mods, { probeAbms = false } = {}) {
  const { lua, lauxlib, lualib, to_luastring } = await loadFengari();
  const { order, missing } = loadOrder(mods);
  const fs = new Map();
  const dirs = new Map();
  const addDir = (path) => {
    const cut = path.lastIndexOf('/');
    const parent = path.slice(0, cut) || '/';
    const name = path.slice(cut + 1);
    if (!dirs.has(parent)) dirs.set(parent, { files: new Set(), dirs: new Set() });
    return { parent, name };
  };
  for (const m of order) {
    for (const [rel, bytes] of m.files) {
      const path = `/mods/${m.name}/${rel}`;
      fs.set(path, bytes);
      let { parent, name } = addDir(path);
      dirs.get(parent).files.add(name);
      while (parent !== '/' && parent !== '') {
        const up = addDir(parent);
        dirs.get(up.parent).dirs.add(up.name);
        parent = up.parent;
      }
    }
  }

  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const setGlobalFn = (name, fn) => { lua.lua_pushjsfunction(L, fn); lua.lua_setglobal(L, to_luastring(name)); };
  setGlobalFn('__readfile', (L2) => {
    const bytes = fs.get(lua.lua_tojsstring(L2, 1));
    if (!bytes) { lua.lua_pushnil(L2); return 1; }
    lua.lua_pushlstring(L2, bytes, bytes.length);
    return 1;
  });
  setGlobalFn('__listdir', (L2) => {
    const d = dirs.get(lua.lua_tojsstring(L2, 1).replace(/\/$/, ''));
    const wantDirs = lua.lua_type(L2, 2) === lua.LUA_TBOOLEAN ? lua.lua_toboolean(L2, 2) : null;
    const names = !d ? [] : wantDirs === true ? [...d.dirs] : wantDirs === false ? [...d.files] : [...d.dirs, ...d.files];
    lua.lua_createtable(L2, names.length, 0);
    names.sort().forEach((n, i) => { lua.lua_pushstring(L2, to_luastring(n)); lua.lua_rawseti(L2, -2, i + 1); });
    return 1;
  });
  lua.lua_createtable(L, order.length, 0);
  order.forEach((m, i) => { lua.lua_pushstring(L, to_luastring(m.name)); lua.lua_rawseti(L, -2, i + 1); });
  lua.lua_setglobal(L, to_luastring('MOD_LIST'));
  lua.lua_createtable(L, 0, order.length);
  for (const m of mods) {
    lua.lua_pushstring(L, to_luastring(`/mods/${m.name}`));
    lua.lua_setfield(L, -2, to_luastring(m.name));
  }
  lua.lua_setglobal(L, to_luastring('MOD_PATHS'));
  lua.lua_pushboolean(L, probeAbms);
  lua.lua_setglobal(L, to_luastring('PROBE_ABMS'));

  const src = to_luastring(await readLocal('./extract.lua'));
  if (lauxlib.luaL_loadbufferx(L, src, src.length, to_luastring('=extract'), null) !== 0
    || lua.lua_pcall(L, 0, 1, 0) !== 0) {
    throw new Error(`mod loader failed: ${lua.lua_tojsstring(L, -1)}`);
  }
  const out = JSON.parse(lua.lua_tojsstring(L, -1));
  out.order = order.map((m) => m.name);
  out.missing = missing;
  return out;
}

/**
 * NodeCore plus `packages` ([{files: Map, meta}] - unzipped mods or
 * modpacks, as ContentDB serves them), run together. `addons` in the
 * result names the added mods.
 */
export async function runPackages(packages, opts = {}) {
  const added = [];
  for (const p of packages) added.push(...openPackage(p.files, p.meta || {}).mods);
  const names = new Set(added.map((m) => m.name));
  // a mod named like one of NodeCore's own replaces it, as in Luanti
  const base = (await nodecoreMods()).filter((m) => !names.has(m.name));
  const out = await extract([...base, ...added], opts);
  out.addons = added.map((m) => m.name);
  return out;
}
