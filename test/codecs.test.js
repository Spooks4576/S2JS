// Self-contained tests: every input is generated here, no game files needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  crc32,
  zstdFrame,
  zstdDecompress,
  isZstd,
  unpackZs,
  repackLike,
  encodeBc,
  decodeBlocks,
  encodeAstc,
  decodeAstc,
  toUnit,
  encodeBwav,
  readBwav,
  decodeBwav,
  writeWav
} from "../src/index.js";

const gradient = (w, h) => {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      px.set([(x * 255) / (w - 1), (y * 255) / (h - 1), ((x + y) * 255) / (w + h - 2), 255], i);
    }
  return px;
};

const meanError = (a, b) => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
};

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zstd frame round trips", () => {
  for (const size of [0, 1, 255, 256, 70000, 300000]) {
    const data = Uint8Array.from({ length: size }, (_, i) => (i * 31) & 255);
    const framed = zstdFrame(data);
    assert.ok(isZstd(framed) || size === 0);
    assert.deepEqual(zstdDecompress(framed), data);
  }
});

test("unpackZs / repackLike keep the wrapper of the original", () => {
  const data = new TextEncoder().encode("hello switch");
  assert.equal(unpackZs(data), data);
  assert.deepEqual(unpackZs(zstdFrame(data)), data);
  assert.ok(isZstd(repackLike(data, zstdFrame(data))));
  assert.equal(repackLike(data, data), data);
});

for (const format of ["PF_DXT1", "PF_DXT5", "PF_BC7"]) {
  test(`${format} encodes and decodes a gradient closely`, () => {
    const px = gradient(32, 32);
    const out = decodeBlocks(format, encodeBc(format, px, 32, 32), 32, 32, toUnit);
    assert.equal(out.length, px.length);
    assert.ok(meanError(px, out) < 6, `mean error ${meanError(px, out)}`);
  });
}

test("ASTC 4x4 encodes and decodes a gradient closely", () => {
  const px = gradient(32, 32);
  const out = decodeAstc(encodeAstc(px, 32, 32, 4, 4, false, 1), 32, 32, 4, 4, false);
  assert.ok(meanError(px, out) < 6, `mean error ${meanError(px, out)}`);
});

test("BWAV DSP-ADPCM round trips a sine wave", async () => {
  const rate = 48000;
  const tone = Int16Array.from({ length: rate / 2 }, (_, i) => Math.round(Math.sin((i / rate) * 440 * 2 * Math.PI) * 12000));
  const file = encodeBwav([tone, tone], rate, { loop: true });
  const bwav = readBwav(file);
  assert.equal(bwav.channels.length, 2);
  assert.equal(bwav.rate, rate);
  assert.equal(bwav.loopEnd, tone.length);
  const [left] = await decodeBwav(bwav);
  assert.equal(left.length, tone.length);
  assert.ok(meanError(tone, left) < 200, `mean error ${meanError(tone, left)}`);
  const wav = writeWav([left], rate);
  assert.equal(wav.size, 44 + left.length * 2);
});
