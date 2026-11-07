# S2JS

Read and write Nintendo Switch and Switch 2 file formats in plain JavaScript.

- No dependencies, no build step, no WebAssembly. Plain ES modules.
- Runs in the browser and in Node 18+.
- Reads **and writes** game files: replace textures, sounds and meshes, then patch the resource size table so the game loads them.

| Area | Formats | Read | Write |
|---|---|---|---|
| Textures | BNTX (Switch `NX` and Switch 2), BC1-BC7, ASTC, uncompressed RGBA / RG / R | ✅ | ✅ in place (same size, format and mip count) |
| Models | BFRES meshes, materials, skeleton, skeletal animations | ✅ | ✅ add or replace geometry in an existing mesh |
| Audio | BWAV (PCM16, DSP-ADPCM, Opus), BARS archives | ✅ (Opus in browser only) | ✅ DSP-ADPCM |
| Tables | RESTBL / `.rsizetable` | ✅ | ✅ grow entries |
| Compression | Zstandard (`.zs`) | ✅ | ✅ (stored blocks, see below) |
| Images | PNG with 16-bit channels | ✅ | |

## Install

S2JS is not on npm yet. Copy the `src/` folder into your project, or add it as a git dependency:

```sh
npm install github:Spooks4576/S2JS
```

```js
import { decodeBntx, replaceBntxTexture } from "s2js";
// or just the part you need
import { readBfres } from "s2js/model";
```

Without a bundler in the browser, import the files directly: `import { decodeBntx } from "./s2js/src/index.js"`.

## Quick start

Every function takes a `Uint8Array` (a Node `Buffer` works too) or an `ArrayBuffer`. Files that end in `.zs` are decompressed for you, and the writers compress them again when the input was compressed.

> **For Node You May Want to:** pass the `Buffer` from `readFileSync` directly. Do not pass `readFileSync(path).buffer`. Node keeps small files in a shared memory pool, so `.buffer` can contain other data before your file.

### Textures

```js
import { readFileSync, writeFileSync } from "node:fs";
import { decodeBntx, replaceBntxTexture, readPngImage } from "s2js";

// Decode: one RGBA8 image per texture, array layer or cube face.
const { platform, format, images } = decodeBntx(readFileSync("Driver_Mario_Body_Alb.bntx.zs"));
// images[0] = { name, width, height, rgba: Uint8ClampedArray }

// Encode: replace a texture with new pixels. The image is resized if needed
// and all mip levels are rebuilt in the texture's own format (ASTC, BC7, ...).
const png = await readPngImage(readFileSync("skin.png"));
const out = replaceBntxTexture(readFileSync("Driver_Mario_Body_Alb.bntx.zs"), {
  image: png,      // { width, height, data } RGBA, 8 or 16 bits per channel
  texture: 0,      // index or name
  layer: 0,        // array layer / cube face
  effort: 2        // ASTC quality: 1 fast, 2 balanced, 3 best
});
writeFileSync("Driver_Mario_Body_Alb.bntx.zs", out);
```

In the browser, draw an image to a canvas and pass `ctx.getImageData(...)` as `image`.

### Audio

```js
import { openAudio, decodeBwav, writeWav, replaceBarsSounds, encodeBwav } from "s2js";

// List and decode the sounds in a .bars, .bars.zs or .bwav file.
const sounds = openAudio(readFileSync("Driver_Mario_00.bars.zs"), "Driver_Mario_00.bars.zs");
const planes = await decodeBwav(sounds[0].bwav);        // Int16Array per channel
const wavBlob = writeWav(planes, sounds[0].bwav.rate);  // Blob, audio/wav

// Replace sounds by name. Other sounds stay byte for byte, and panning and looping are kept.
const { bytes, replaced, sizes } = replaceBarsSounds(readFileSync("Driver_Mario_00.bars.zs"), {
  Voice_Mario_Jump_00: { planes: [myInt16Pcm], rate: 48000 }
});

// A standalone .bwav for Sound/Resource/Stream/.
const bwav = encodeBwav([left, right], 48000, { loop: false });
```

### Resource size table

When a file gets bigger, the game rejects it unless its RESTBL entry is raised too:

```js
import { patchRestblFile } from "s2js";

const { bytes, changed } = patchRestblFile(readFileSync("ResourceSizeTable.Product.100.rsizetable.zs"), {
  "Sound/Resource/Driver_Mario_00.bars": sizes // [oldSize, newSize] from replaceBarsSounds
});
```

Paths are romfs paths with no leading slash and no `.zs`.

### Models

```js
import { readBfres, bfresPose, unpackZs, bfresLayout, bfresBindable, bfresInject } from "s2js";

const model = readBfres(readFileSync("Driver_Mario.Driver_Mario.bfres.zs"));
// model.meshes[i] = { name, positions, normals, uvs, uvs2, skin, groups: [{ material, indices }] }
// model.skeleton  = { bones: [{ name, parent, local, ... }], inverse }
// model.animations = skeletal clips; bfresPose(model.skeleton, clip, frame) gives skinning matrices

// Add a mesh to an existing shape, bound to a bone.
const bytes = unpackZs(readFileSync("Driver_Mario.Driver_Mario.bfres.zs"));
const layout = bfresLayout(bytes);
const shape = layout.shapes.find((s) => s.name === "Body__Mt_Body");
const bone = bfresBindable(layout, shape).find((b) => b.name === "Head").bone;
const edited = bfresInject(bytes, {
  shape: shape.index,
  mode: "add",              // or "replace"
  bone,
  mesh: { positions, normals, uvs, indices } // Float32Arrays in model space
});
// bfresInject takes native BFRES UVs (v = 0 at the top). OBJ/FBX UVs and the UVs
// readBfres returns have v = 0 at the bottom, so pass 1 - v for those.
```

## Layout

```
src/
  index.js            everything, re-exported
  workflows/          high level helpers (start here)
    texture.js          decodeBntx, replaceBntxTexture
    audio.js            encodeBwav, replaceBarsSounds
    restbl.js           patchRestblFile
  texture/            BNTX container, swizzling and block codecs
    bntx-read.js        openBntx, deswizzleBlockLinear, BNTX_FORMATS
    bntx-write.js       bntxTextures, encodeTexels, bntxWriteLevel, swizzleBlockLinear
    bcn-decode.js       BC1-BC7 (including BC6H) decoder
    bcn-encode.js       BC1, BC3, BC4, BC5, BC7 encoder
    astc-decode.js      ASTC LDR decoder
    astc-encode.js      ASTC LDR encoder
  model/
    bfres-read.js       meshes, materials, skeleton, animations
    bfres-write.js      geometry injection
  audio/
    bwav-read.js        BWAV / BARS reader, DSP / PCM / Opus decode, WAV writer
    bwav-write.js       DSP-ADPCM encoder, BWAV builder, BARS rebuilder
  restbl/restbl.js    RESTBL patcher
  compression/        zstd decoder and frame writer
  image/png-decode.js PNG decoder (keeps 16-bit)
  util/               zstd wrapper helpers, errors, crc32, half floats, mat4
examples/             runnable Node scripts and a browser page
test/                 node:test suites
docs/FORMATS.md       notes on the formats and on the lower level API
```

Each area also has its own entry point: `s2js/texture`, `s2js/model`, `s2js/audio`, `s2js/restbl`, `s2js/compression`, `s2js/image`.

## Errors

Everything throws a normal `Error` with an extra `reason` string written for end users, for example `"BC2 textures are not supported yet"`. Show `error.reason` in your UI.

## Limitations

- **zstd writing** uses stored (uncompressed) blocks. The output is a valid `.zs` that games load, but it is not smaller. If size matters, recompress with a real zstd encoder.
- **Opus** BWAVs decode only where WebCodecs (`AudioDecoder`) or Web Audio exists, which means browsers. Writing produces DSP-ADPCM, which every game accepts.
- **BNTX writing** replaces pixels in place. It cannot change a texture's size, format or mip count. It does not yet write linear textures, BC2, BC6H, R32G32B32A32 or signed formats other than BC4/BC5 (`bntxWritable(tex)` tells you why).
- **BFRES writing** supports shapes whose vertices are in a single buffer.
- Audio writing expects PCM at the game's rate (48000 Hz for Switch titles). Resample first.
- Encoding large ASTC textures is CPU heavy. In a browser, call `encodeTexels` from a Web Worker, as the example in docs/FORMATS.md shows.

## Examples

```sh
node examples/node/bntx-to-png.mjs  Driver_Mario_Body_Alb.bntx.zs out/
node examples/node/png-into-bntx.mjs Driver_Mario_Body_Alb.bntx.zs skin.png out.bntx.zs
node examples/node/bars-to-wav.mjs  Driver_Mario_00.bars.zs out/
node examples/node/replace-sound.mjs Driver_Mario_00.bars.zs Voice_Mario_Jump_00 jump.wav ResourceSizeTable.Product.100.rsizetable.zs
```

`examples/browser/index.html` is a drag-and-drop BNTX viewer. Serve the repo root over http (`npx serve .`) and open `/examples/browser/`.

## Tests

```sh
npm test                                  # self-contained codec tests
S2JS_SAMPLES=/path/to/romfs npm test      # also round trips your own game files
```

No game files ship with this repo. Use files dumped from games you own.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

In short, you can use S2JS in free or commercial projects, but you must give credit:

- Keep the copyright and license headers in the source files you copy.
- Include the contents of [NOTICE](NOTICE) with anything you distribute that contains S2JS, modified or not. If your project shows third-party credits (an about page, a credits screen, docs), S2JS goes there too.
- If you change the files, say so in the files you changed.

## Legal

S2JS is not affiliated with or endorsed by Nintendo. It contains no Nintendo code or assets. It reads and writes file formats so you can mod games you own.
