# loader/

Runs Luanti mods in the browser and turns what they register into the
page's trees.

| File | What it does | Origin |
| --- | --- | --- |
| `extract.lua` | A stand-in for the Luanti engine API; runs every mod's `init.lua` and returns items, recipes, hints and what the mapgen places, as JSON | Engine stand-in adapted from nodecore_light_logic_sim's `scripts/nodecore/mock.lua`; Lua 5.1 compatibility from its `src/mods/prelude.js` |
| `extract.js` | Loads the Lua VM, gives `extract.lua` the mods' files, orders the mods, runs them | new |
| `worker.js` | Runs `extract.js` off the page's main thread | new |
| `graphs.js` | Builds the hint tree and the recipe tree from an extract | new |
| `contentdb.js` | ContentDB search, releases and dependency resolution | nodecore_light_logic_sim `src/mods/contentdb.js`, as is |
| `sources.js` | Downloads a release from the mod's source repo (GitHub, GitLab, Codeberg) at the commit ContentDB built it from | nodecore_light_logic_sim `src/mods/sources.js`, plus a `wanted` filter so textures are skipped |
| `package.js` | Finds the mod or modpack in an archive, reads `mod.conf`, orders by dependency | nodecore_light_logic_sim `src/mods/package.js`, as is |
| `zip.js` | Zip reader | nodecore_light_logic_sim `src/mods/zip.js`, as is |
| `cache.js` | Mod results cached per combination of mods, keyed on a fingerprint of their files and the loader | new |
| `store.js` | Installed mods in IndexedDB | nodecore_light_logic_sim `src/mods/store.js`, with its own database name |
| `vendor/fengari/` | Fengari, Lua 5.3 in JavaScript (MIT), patched to print floats like LuaJIT | nodecore_light_logic_sim `src/vendor/fengari/` |

Copied from nodecore_light_logic_sim at commit `24335cc`
(branch `claude/nodecore-mods`).

## What the stand-in skips

Mods run once, to register things; there is no world, player or clock.
Engine calls that need one answer with a harmless stand-in. Two NodeCore
helpers that only build run-time lookup tables (`nc.item_matching_index`
and the ABM multiplexer) are turned off after their mods load, which
takes loading from ~20 s to ~3 s and changes nothing that is read back.
Each mod gets a budget of 300 million Lua steps, so one stuck in a loop
is stopped and reported instead of hanging the page.

With `PROBE_ABMS` set, `extract.lua` then probes ABMs and item-stack ABMs
in a pretend world (see the main README); the engine calls they use
(`get_node`, `set_node`, `find_node_near`, `get_meta`, ...) are swapped for
ones backed by that world while it runs, and `ItemStack` is a working
implementation rather than a stub.
