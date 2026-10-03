// Run the in-page mod loader from Node: NodeCore plus any mod zips given.
//   node tools/extract-cli.mjs [mod.zip ...] > dump.json
// With no zips this regenerates data/nodecore-extract.json, which the page
// uses until mods are added.
import { readFile } from 'node:fs/promises';
import { runPackages } from '../loader/extract.js';
import { readZip } from '../loader/zip.js';

const packages = [];
for (const zip of process.argv.slice(2)) packages.push({ files: await readZip(await readFile(zip)) });
const t = Date.now();
const out = await runPackages(packages);
console.error(`ran ${out.order.length} mods in ${Date.now() - t} ms; ${Object.keys(out.items).length} items, `
  + `${out.nc_recipes.length} nc recipes, ${out.crafts.length} grid crafts, ${out.hints.length} hints`);
for (const m of out.mods) if (!m.ok) console.error(`  ${m.name}: ${m.error.split('\n')[0]}`);
if (Object.keys(out.missing).length) console.error('  missing deps:', JSON.stringify(out.missing));
process.stdout.write(JSON.stringify(out));
