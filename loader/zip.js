// A small zip reader: enough for the archives ContentDB serves (stored or
// deflated entries, found through the central directory). Inflating uses
// the DecompressionStream built into browsers and Node 18+, so there is
// nothing to install.

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Read a zip archive. Returns a Map from each file's path (always with
 * forward slashes, directories left out) to its bytes.
 */
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // the end-of-central-directory record sits in the last 64 KiB + 22 bytes
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const utf8 = new TextDecoder();
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== SIG_CENTRAL) throw new Error('broken zip central directory');
    const method = view.getUint16(p + 10, true);
    const csize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen)).replace(/\\/g, '/');
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (view.getUint32(local, true) !== SIG_LOCAL) throw new Error(`broken zip entry ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + csize);
    if (method !== 0 && method !== 8) throw new Error(`zip entry ${name} uses unsupported compression ${method}`);
    entries.push([name, method, raw]);
  }
  // inflate every entry at once: one at a time, a busy page (the editor
  // renders every frame) takes a frame or so per file
  const data = await Promise.all(entries.map(([, method, raw]) => (method === 0 ? raw.slice() : inflateRaw(raw))));
  return new Map(entries.map(([name], i) => [name, data[i]]));
}
