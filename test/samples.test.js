// Tests against real game files. Game files cannot be shipped with this repo, so point
// S2JS_SAMPLES at a folder (a dumped romfs works) and every supported file in it is checked:
//
//   S2JS_SAMPLES=/path/to/romfs npm test
//
// Without S2JS_SAMPLES these tests are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import {
  decodeBntx,
  replaceBntxTexture,
  readBfres,
  bfresLayout,
  bfresBindable,
  bfresInject,
  openAudio,
  decodeBwav,
  replaceBarsSounds,
  patchRestblFile,
  unpackZs
} from "../src/index.js";

const root = process.env.S2JS_SAMPLES;
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const files = root ? walk(root) : [];
const pick = (re, max = 5) => files.filter((f) => re.test(f)).slice(0, max);
const opts = { skip: !root && "set S2JS_SAMPLES to a folder of game files" };

for (const file of pick(/\.bntx(\.zs)?$/i)) {
  test(`BNTX ${basename(file)}: decode, re-encode, decode again`, opts, () => {
    const input = readFileSync(file);
    const before = decodeBntx(input);
    const first = before.images[0];
    assert.equal(first.rgba.length, first.width * first.height * 4);
    const output = replaceBntxTexture(input, { image: { width: first.width, height: first.height, data: first.rgba }, effort: 1 });
    assert.equal(unpackZs(output).length, unpackZs(input).length, "size must not change");
    const after = decodeBntx(output).images[0];
    assert.equal(after.width, first.width);
  });
}

for (const file of pick(/\.bfres(\.zs)?$/i)) {
  test(`BFRES ${basename(file)}: read, inject a triangle, read again`, opts, () => {
    const input = readFileSync(file);
    const model = readBfres(input);
    if (!model.meshes.length) return;
    const bytes = unpackZs(input);
    const layout = bfresLayout(bytes);
    const shape = layout.shapes.find((s) => s.buffers === 1);
    if (!shape) return;
    const bone = bfresBindable(layout, shape)[0].bone;
    const mesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), uvs: new Float32Array(6), indices: [0, 1, 2] };
    const out = bfresInject(bytes, { shape: shape.index, mode: "add", bone, mesh });
    assert.equal(readBfres(out).meshes.length, model.meshes.length);
  });
}

for (const file of pick(/\.(bars|bwav)(\.zs)?$/i)) {
  test(`Audio ${basename(file)}: open and decode`, opts, async () => {
    const sounds = openAudio(readFileSync(file), basename(file));
    const { bwav } = sounds[0];
    if (bwav.codec === 2) return; // Opus needs a browser
    const planes = await decodeBwav(bwav);
    assert.equal(planes.length, bwav.channels.length);
    if (/\.bars/i.test(file)) {
      const result = replaceBarsSounds(readFileSync(file), { [sounds[0].name]: { planes } });
      assert.equal(result.replaced, 1);
      assert.equal(openAudio(result.bytes, basename(file)).length, sounds.length);
    }
  });
}

for (const file of pick(/\.rsizetable(\.zs)?$/i, 2)) {
  test(`RESTBL ${basename(file)}: parse`, opts, () => {
    const { changed } = patchRestblFile(readFileSync(file), { "no/such/file": [0, 1] });
    assert.deepEqual(changed, []);
  });
}

test("samples folder", opts, () => assert.ok(files.length, `no files found in ${root}`));
