// npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runPackages, mergeProbes } from '../loader/extract.js';
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

test('the bundled extract has NodeCore\'s ABMs probed, and cloudstone has its real chain', () => {
  assert.ok((bundled.abm_changes || []).length > 100);
  const t = byId(recipeTreeFromExtract(bundled));
  const tier = (n) => t.get(`item:${n}`).tier;
  const chain = ['nc_concrete:cloudmix', 'nc_concrete:cloudmix_wet_source', 'nc_concrete:concrete_cloudstone_blank_ply', 'nc_concrete:cloudstone'];
  for (let i = 1; i < chain.length; i++) assert.ok(tier(chain[i - 1]) < tier(chain[i]), `${chain[i - 1]} before ${chain[i]}`);
  const cs = t.get('item:nc_concrete:cloudstone');
  assert.ok(!cs.unreachable && !cs.info.assumed && cs.req.op !== 'always');
  // wetting needs water beside it
  const wet = JSON.stringify(t.get('item:nc_concrete:cloudmix_wet_source').req);
  assert.match(wet, /nc_terrain:water_source/);
});

test('guesses never make something forged come cheaper', () => {
  const t = byId(recipeTreeFromExtract(bundled));
  const tier = (n) => t.get(`item:${n}`).tier;
  assert.ok(tier('nc_lode:prill_hot') > tier('nc_woodwork:plank'));
  assert.ok(tier('nc_lode:tool_pick_tempered') > tier('nc_lode:prill_hot'));
  for (const n of t.values()) {
    if (n.info.assumed) assert.ok(!/tool_|toolhead_/.test(n.info.name), `${n.info.name} assumed`);
  }
});

test('a mod whose only crafting is an ABM shows up in the recipe tree', async () => {
  const enc = new TextEncoder();
  const lua = `
    core.register_node("abmmod:raw", {description = "Raw Thing", groups = {crumbly = 1}})
    core.register_node("abmmod:soaked", {description = "Soaked Thing", groups = {crumbly = 1}})
    nc.register_craft({label = "make raw thing", action = "pummel", toolgroups = {thumpy = 1},
      nodes = {{match = "nc_terrain:sand_loose", replace = "abmmod:raw"}}})
    core.register_abm({label = "soak raw thing", nodenames = {"abmmod:raw"}, neighbors = {"group:water"},
      interval = 1, chance = 1, action = function(pos) core.set_node(pos, {name = "abmmod:soaked"}) end})`;
  const files = new Map([['abmmod/init.lua', enc.encode(lua)], ['abmmod/mod.conf', enc.encode('name = abmmod\ndepends = nc_terrain')]]);
  const out = mergeProbes(await runPackages([{ files }]), bundled);
  const c = out.abm_changes.find((x) => x.from === 'abmmod:raw' && x.to === 'abmmod:soaked');
  assert.ok(c, 'the ABM was probed');
  assert.match(c.with || '', /water/);
  // NodeCore's own probes are merged back in
  assert.ok(out.abm_changes.some((x) => x.to === 'nc_concrete:cloudstone'));
  const t = byId(recipeTreeFromExtract(out));
  const soaked = t.get('item:abmmod:soaked');
  assert.ok(soaked && !soaked.unreachable);
  assert.ok(soaked.tier > t.get('item:abmmod:raw').tier);
});
