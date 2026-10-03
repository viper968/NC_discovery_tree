# NC_discovery_tree
a discovery tree for nodecore (a game on Luanti) which gives you insight into what is required to make something in nodecore.

## The viewer

`index.html` is a static page (no build step) with two trees over the game:

- **Hints**: NodeCore's in-game hints, chained from what each needs to what
  it unlocks (`data/nodecore-discovery.json`).
- **Recipes**: every item, laid out by how many steps it takes to get, with
  every way of making it: NodeCore's in-world recipes (`nc.register_craft`:
  pummel, press, place, cook...), Luanti's grid and furnace crafts, digging
  and the drops it gives, and NodeCore's changes of state (stone digs into
  cobble, glowing lode cools or is quenched, tools wear out...). Tools count
  too: a recipe that needs a choppy level 4 tool needs one of the tools that
  dig that way. This covers mods that add no hints at all.

Both trees share the same controls:

- **Click a card** to see what it needs (every way, with what provides each
  part) and what it leads to.
- **Show the quickest way here** trims the map to the cheapest route to it.
- **Mod filter** shows one mod's cards plus the quickest way to each.
- **Spoilers mode** (on by default) hides everything you haven't reached.
  You start with what's within reach on day one; clicking a card marks it
  done and reveals what it leads to. `???` cards need more first. Progress is
  kept per tree in your browser.
- Search, zoom (buttons or Ctrl+scroll), drag to pan, and links to a card
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

This reuses the mod-installing code from
[nodecore_light_logic_sim](https://github.com/viper968/nodecore_light_logic_sim)
(`claude/nodecore-mods` branch); `loader/README.md` lists what came from where.

### What it can't see

The recipe tree is read from what mods *register*. Things done purely by
game code (ABMs and callbacks: lux charging, drying rushes, trees growing)
aren't recipes, so:

- An item only game code makes sits in the **Out of reach** column.
- Something only ever dug or decayed into being, with no recipe behind it
  (leaves, loose lux cobble), is marked *found in the world (assumed)*.
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
