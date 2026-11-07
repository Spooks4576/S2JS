# Formats and lower level API

The helpers in `src/workflows/` cover the common jobs. This page is for when you need more control.

## BNTX textures

`openBntx(bytes)` reads the container and returns:

```js
{
  platform: "Switch" | "Switch 2",   // "NX  " platform tag = Switch, anything else = Switch 2
  count, format, cube, layers,       // from the first texture
  images: [{ name, width, height, fmt, tile, layout, platform, select, offset, length }],
  bytes,                             // decompressed file
  decode(image) -> { data: Uint8ClampedArray RGBA8, deep: null | { channels, data: Uint16Array } }
}
```

- `fmt` is the raw BNTX format: `fmt >> 8` indexes `BNTX_FORMATS`, `fmt & 0xff` is the type (1 unorm, 2 snorm, 5 float, 6 sRGB).
- `select` is the channel swizzle, and decoding applies it. `deep` holds the full 16-bit values for R16 / R16G16 unorm textures (height maps), which RGBA8 would truncate.
- Textures are block-linear swizzled. `deswizzleBlockLinear` and `swizzleBlockLinear` convert, and `GOB_ORDERS[platform]` covers the different GOB bit orders of Switch and Switch 2.

### Writing step by step

`replaceBntxTexture` does exactly this:

```js
const bytes = unpackZs(file).slice();
const tex = bntxTextures(bytes)[0];          // name, format, mips, layers, offsets, blockHeight, ...
const why = bntxWritable(tex);               // null, or a reason it cannot be written
let pixels = unselectChannels(tex, rgba, tex.width * tex.height, false); // undo the channel swizzle
const levels = bntxMipImages(tex, pixels, false);                         // gamma correct, alpha weighted mips
levels.forEach((level, i) => {
  const { width, height } = bntxMipLayout(tex, i);
  bntxWriteLevel(bytes, tex, 0, i, encodeTexels(tex.fmt, level, width, height, 2));
});
```

`encodeTexels` is the slow part and it is a pure function of its inputs, so you can run it in a Web Worker. You can also split a level into strips of whole block rows and concatenate the results:

```js
// worker.js
import { encodeTexels } from "s2js/texture";
onmessage = ({ data: { fmt, pixels, width, height, effort } }) => {
  const out = encodeTexels(fmt, pixels, width, height, effort);
  postMessage(out, [out.buffer]);
};
```

### Block codecs

```js
decodeBlocks(name, blocks, width, height, toUnit) // name: PF_DXT1 PF_DXT3 PF_DXT5 PF_BC4(S) PF_BC5(S) PF_BC6H PF_BC7
encodeBc(name, rgba, width, height)               // PF_DXT1 PF_DXT5 PF_BC4(S) PF_BC5(S) PF_BC7
decodeAstc(blocks, width, height, bw, bh, srgb)
encodeAstc(rgba, width, height, bw, bh, srgb, effort)
```

Width and height are in pixels. Partial edge blocks are padded for you.

## BFRES models

`readBfres(bytes)` returns `{ label, meshes, skeleton, animations }`. Positions are in model space. UVs are flipped to v = 0 at the bottom (OBJ / FBX convention). Skinned meshes have `skin.joints` / `skin.weights`, four per vertex, indexing `skeleton.bones`.

- `bfresPose(skeleton, clip, frame)` gives a skinning matrix (bone world × inverse bind) for every bone at a frame. Multiply bind-pose vertices by these to get the animated pose.
- `bfresTrs(skeleton, clip, frame)` gives local translation / rotation / scale.
- `evalBfresCurve(curve, frame)` samples a single animation curve.
- `mat4` (in `util/math.js`) holds the column-major 4x4 helpers used throughout.

For writing, `bfresLayout(bytes)` exposes shapes, bones and the buffer pool. `bfresBindable(layout, shape)` lists the bones a new mesh can be skinned to, and `bfresInject` writes geometry and fixes the relocation table.

## BWAV / BARS audio

`readBwav(bytes)` returns `{ codec, rate, samples, channels: [{ pan, coefs, offset, ... }], prefetch, loopStart, loopEnd, bytes }`. Codecs: 0 PCM16, 1 DSP-ADPCM, 2 Opus (`BWAV_CODECS`).

A **prefetch** BWAV, found inside BARS archives, holds only the start of a sound. The rest streams from `Sound/Resource/Stream/<name>.bwav`. `readBars` skips entries with no samples and reports how many were skipped as `entries.streamed`.

Writing:

- `encodeBwavAudio(planes, rate, { loopStart, loopEnd, pans })` returns `{ stream, channels, crc, total, ... }`. `stream` is a full .bwav.
- `buildBwav({ ..., keep })` writes a prefetch BWAV that holds the first `keep` samples, with the same CRC as the full stream so the game pairs them.
- `rebuildBars(bytes, (name, oldBwav) => newBwav | null)` re-lays out an archive and keeps the 0x40 alignment.

## RESTBL

`patchRestbl(bytes, Map<path, [before, after]>)` looks entries up by name first and then by CRC-32 of the path. It raises an entry by `after - before` and never lowers it.

## Zstandard

`zstdDecompress(bytes)` handles every frame type games use (raw, RLE and compressed blocks, multiple frames, skippable frames). Dictionaries are not supported. `zstdFrame(bytes)` writes raw blocks only.
