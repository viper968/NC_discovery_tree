# NC_discovery_tree
a discovery tree for nodecore (a game on Luanti) which gives you insight into what is required to make something in nodecore.

## The viewer

`index.html` is a static page (no build step) that draws
`data/nodecore-discovery.json` as an explorable tree: every NodeCore hint is a
card, laid out left to right by tier, with arrows to the hints it unlocks.

- **Click a card** to see what completes it, what it needs (and which hints
  provide each requirement), and what it leads to. Prerequisites light up in
  orange, follow-ons in blue.
- **Show only what's needed** trims the map to one hint plus everything
  required to reach it.
- **Spoilers mode** (on by default) hides everything you haven't unlocked.
  You start with the day-one hints; clicking one marks it discovered and
  reveals what it makes available. Hints that need more than you have show as
  locked `???` cards. Progress is saved in your browser.
- Search, zoom (buttons or Ctrl+scroll), drag to pan, and `#<hint-id>` links
  to a specific hint.

## Hosting on GitHub Pages

Settings → Pages → *Deploy from a branch* → pick the branch and `/ (root)`.
The `.nojekyll` file makes Pages serve the files as-is.

To try it locally, serve the folder (browsers block `fetch` from `file://`):

```sh
python3 -m http.server
# then open http://localhost:8000
```

## Data

`data/nodecore-discovery.json` is copied from `nodecore-discovery/` on the
`claude/awesome-volta-z0gvqu` branch of
[viper968/luanti](https://github.com/viper968/luanti), where
`extract_hints.py` generates it from NodeCore's source (see the README there).
Re-copy it after regenerating to update the site.
