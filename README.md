# NC_discovery_tree
a discovery tree for nodecore (a game on Luanti) which gives you insight into what is required to make something in nodecore.

## The viewer

`index.html` is a static page (no build step) that draws the game as a node
web: a force-directed graph ([d3-force](https://d3js.org/d3-force), shipped in
`vendor/d3/` so the page needs no CDN) where each
dot is a hint or an item, arrows run to what it leads to, and early things
drift to the middle. Pan, zoom (names appear as you zoom in), drag dots about.
Bigger dots lead to more things; colour is the mod. There are two trees:

- **Hints**: NodeCore's in-game hints, chained from what each needs to what
  it unlocks (`data/nodecore-discovery.json`).
- **Recipes**: every item, with every way of making it: NodeCore's in-world recipes (`nc.register_craft`:
  pummel, press, place, cook...), Luanti's grid and furnace crafts, digging
  and the drops it gives, and NodeCore's changes of state (stone digs into
  cobble, glowing lode cools or is quenched, tools wear out...). Tools count
  too: a recipe that needs a choppy level 4 tool needs one of the tools that
  dig that way. This covers mods that add no hints at all.

Both trees share the same controls:

- **Click a dot** to see what it needs (every way, with what provides each
  part) and what it leads to.
- **Show the quickest way here** trims the map to the cheapest route to it.
- **Mod filter** shows one mod's dots plus the quickest way to each.
- **Spoilers mode** (on by default) hides everything you haven't reached.
  You start with what's within reach on day one; clicking a dot marks it
  done and the web grows out with what it leads to. `?` dots need more first. Progress is
  kept per tree in your browser.
- Search, and links to a dot
  (`#hints/<id>` or `#recipes/item:<name>`).

## Mods

The **Mods** button adds mods, which run as they do in game: their own
Lua, on top of NodeCore, in your browser (in a Web Worker, with
[Fengari](https://fengari.io/)). What they register goes into both trees.

- **From ContentDB**: search NodeCore mods and press Install. Dependencies
  come with it. The files are read from the mod's source repository at the
  git commit ContentDB built the release from (GitHub, GitLab or Codeberg).
- **From a file**: drop a mod or modpack `.zip`, for anything ContentDB
  can't hand over or that isn't on it.

Installed mods are kept in the browser (IndexedDB) and load again on the
next visit. The panel shows what each added, and any errors or missing
dependencies.

Running mods takes a few seconds, so the result is cached in the browser
too, once per **combination of mods**. It is keyed on a fingerprint of
every installed mod's files (so an update, or a different zip of the
"same" version, counts as a change), the loader's version and Lua, and
NodeCore's bundled code; reloading the page with the same mods, or going
back to a set used before, is instant. A single mod's results can't be
cached alone, because mods run together and change one another (NodeCore's
"flammables ignite" lights NodeCore Light's lanterns). The last six
combinations are kept; **Run again** in the Mods panel ignores the cache.
The trees are rebuilt from the cached extract each time, so changes to how
they are drawn never need a recompute; bump `EXTRACT_VERSION` in
`loader/extract.js` when what an extract holds changes.

This reuses the mod-installing code from
[nodecore_light_logic_sim](https://github.com/viper968/nodecore_light_logic_sim)
(`claude/nodecore-mods` branch); `loader/README.md` lists what came from where.

### Changes made by game code (ABMs)

Much of NodeCore happens without a recipe: concrete wets beside water,
sets and cures; glowing lode cools; torches catch from embers and burn
down; peat composts into humus. These are ABMs (and item-stack ABMs for
things lying in piles or carried), which are Lua functions, not data. So
the loader **probes** them: it puts each block or stack an ABM applies to
in a small pretend world, alone and then beside each neighbour the ABM
asks for (or water, fire, lava, lux or dirt for those that check in code),
runs the ABM's own Lua for a while with the game clock running fast, and
records what the block turns into. Those changes become steps in the
recipe tree, marked *Over time*, with the neighbour as a requirement
("beside it: any of Water…"). For cloudstone that gives crude glass +
ash → spackling → wet spackling (beside water) → pliant cloudstone →
cloudstone.

NodeCore's own ABMs are probed once, into `data/nodecore-extract.json`
(`node tools/extract-cli.mjs --probe-abms`, about 20 s). In the page only
what added mods bring is probed, which adds a few seconds when mods load.

### What it can't see

- Things only a player action starts (carving a pattern into pliant
  concrete with a stylus, right-clicking coal onto aggregate, lighting the
  first fire by rubbing sticks) or that need an arrangement the probe
  doesn't build (lux cobble charging from lux around it, lanterns
  charging). An item only that kind of code makes is marked **Out of reach**.
- When a whole chain only starts from such a thing (fire, say), one item
  in it is marked *Assumed available*, so the rest can be reached. A guess
  is never allowed to make something already reachable come cheaper.
- Hints mods add are linked automatically, by the same key expansion
  NodeCore's `expandkey()` uses. NodeCore's own hints keep the hand-checked
  links from `data/nodecore-discovery.json`.

## Hosting on GitHub Pages

Settings → Pages → *Deploy from a branch* → pick the branch and `/ (root)`.
The `.nojekyll` file makes Pages serve the files as-is.

To try it locally, serve the folder (browsers block `fetch` from `file://`):

```sh
python3 -m http.server
# then open http://localhost:8000
```

## Data

| File | What | Regenerate with |
| --- | --- | --- |
| `data/nodecore-discovery.json` | Curated hint tree | `extract_hints.py` on the `claude/awesome-volta-z0gvqu` branch of [viper968/luanti](https://github.com/viper968/luanti) |
| `data/nodecore-src.zip` | NodeCore's Lua (MIT), run when mods are added | `python3 tools/bundle-nodecore.py /path/to/nodecore` |
| `data/nodecore-extract.json` | What NodeCore registers, for the page without mods | `node tools/extract-cli.mjs > data/nodecore-extract.json` |

`node tools/extract-cli.mjs some-mod.zip ...` runs mods from the command
line the same way the page does. `npm test` checks that every NodeCore
mod loads, that the extracted hints match the curated ones, and the shape
of the recipe tree.
