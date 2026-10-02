// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPackages } from '../loader/extract.js';
import { hintTreeFromCurated, hintTreeFromExtract, recipeTreeFromExtract } from '../loader/graphs.js';

const json = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));
const curatedData = json('../data/nodecore-discovery.json');
const bundled = json('../data/nodecore-extract.json');
const byId = (tree) => new Map(tree.nodes.map((n) => [n.id, n]));

test('every NodeCore mod loads, and the hints match the curated ones', async () => {
  const out = await runPackages([]);
  assert.equal(out.order.length, 44);
  assert.deepEqual(out.mods.filter((m) => !m.ok).map((m) => m.name), []);
  assert.equal(out.hints.length, curatedData.nodes.length);
  const cur = new Map(curatedData.nodes.map((n) => [n.text, n]));
  for (const h of out.hints) {
    const c = cur.get(h.text);
    assert.ok(c, h.text);
    assert.deepEqual([h.goal.op, [...h.goal.keys].sort()], [c.goal.op, [...c.goal.keys].sort()], h.text);
    assert.deepEqual([h.reqs.op, [...h.reqs.keys].sort()], [c.reqs.op, [...c.reqs.keys].sort()], h.text);
    assert.equal(!!h.hide, c.hidden, h.text);
  }
});

test('the bundled extract is what NodeCore registers now', async () => {
  const out = await runPackages([]);
  assert.deepEqual(Object.keys(out.items).sort(), Object.keys(bundled.items).sort());
  assert.equal(out.nc_recipes.length, bundled.nc_recipes.length);
});

test('a hint tree with no mods agrees with the curated one', () => {
  const curated = hintTreeFromCurated(curatedData);
  const merged = hintTreeFromExtract(bundled, { curated });
  const a = byId(curated), b = byId(merged);
  assert.equal(b.size, a.size);
  for (const [id, n] of a) assert.equal(b.get(id).tier, n.tier, id);
});

test('the recipe tree follows the wood and lode progression', () => {
  const t = byId(recipeTreeFromExtract(bundled));
  const tier = (n) => t.get(`item:${n}`).tier;
  assert.ok(tier('nc_tree:stick') < tier('nc_woodwork:staff'));
  assert.ok(tier('nc_woodwork:staff') < tier('nc_woodwork:adze'));
  assert.ok(tier('nc_woodwork:adze') < tier('nc_woodwork:plank'));
  assert.ok(tier('nc_woodwork:plank') < tier('nc_lode:prill_hot'));
  assert.ok(tier('nc_lode:prill_hot') < tier('nc_lode:tool_pick_tempered'));
  assert.equal(tier('nc_terrain:stone'), 0);
  assert.ok(!t.get('item:nc_lode:adze_hot').info.assumed, 'hot lode is made, not found');
});

test('a mod stuck in a loop is stopped, and the rest still loads', async () => {
  const enc = new TextEncoder();
  const files = new Map([['loopy/init.lua', enc.encode('while true do end')], ['loopy/mod.conf', enc.encode('name = loopy')]]);
  const out = await runPackages([{ files }]);
  const loopy = out.mods.find((m) => m.name === 'loopy');
  assert.equal(loopy.ok, false);
  assert.match(loopy.error, /took too long/);
  assert.equal(out.hints.length, curatedData.nodes.length);
});

test('a mod without hints still adds its recipes', async () => {
  const enc = new TextEncoder();
  const lua = `
    core.register_node("testmod:brick", {description = "Test Brick", groups = {cracky = 1}})
    nc.register_craft({label = "press test brick", action = "pummel", toolgroups = {thumpy = 1},
      nodes = {{match = "nc_terrain:sand_loose", replace = "testmod:brick"}}})`;
  const files = new Map([['testmod/init.lua', enc.encode(lua)], ['testmod/mod.conf', enc.encode('name = testmod\ndepends = nc_terrain')]]);
  const out = await runPackages([{ files }]);
  assert.deepEqual(out.addons, ['testmod']);
  const t = byId(recipeTreeFromExtract(out));
  const brick = t.get('item:testmod:brick');
  assert.ok(brick && !brick.unreachable);
  assert.equal(brick.mod, 'testmod');
  assert.ok(brick.tier >= 1);
});
