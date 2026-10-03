// Runs the mods off the page's main thread: {packages: [{files: Map, meta}]}
// in, {ok, out | error} back.
import { runPackages } from './extract.js';

self.onmessage = async (e) => {
  try {
    self.postMessage({ ok: true, out: await runPackages(e.data.packages) });
  } catch (err) {
    self.postMessage({ ok: false, error: String((err && err.stack) || err) });
  }
};
