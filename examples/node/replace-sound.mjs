// Replace one sound in a .bars archive with a 16-bit PCM WAV, then grow the
// resource size table so the game loads the bigger archive.
//   node examples/node/replace-sound.mjs Driver_Mario_00.bars.zs Voice_Mario_Jump_00 jump.wav ResourceSizeTable.Product.100.rsizetable.zs
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { replaceBarsSounds, patchRestblFile } from "s2js";

const [barsPath, soundName, wavPath, restblPath] = process.argv.slice(2);
if (!wavPath) throw new Error("usage: replace-sound.mjs <file.bars[.zs]> <sound name> <pcm16.wav> [file.rsizetable[.zs]]");

// Tiny PCM16 WAV reader. Resample to 48 kHz beforehand for best results.
const readWav = (buf) => {
  let p = 12;
  let fmt = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "fmt ") fmt = { channels: buf.readUInt16LE(p + 10), rate: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === "data") {
      if (!fmt || fmt.bits !== 16) throw new Error("Only 16-bit PCM WAV is supported by this example");
      const frames = size / 2 / fmt.channels;
      const planes = Array.from({ length: fmt.channels }, () => new Int16Array(frames));
      for (let i = 0; i < frames; i++) for (let c = 0; c < fmt.channels; c++) planes[c][i] = buf.readInt16LE(p + 8 + (i * fmt.channels + c) * 2);
      return { planes, rate: fmt.rate };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error("No data chunk in WAV");
};

const result = replaceBarsSounds(readFileSync(barsPath), { [soundName]: readWav(readFileSync(wavPath)) });
if (!result.replaced) throw new Error(`No sound called ${soundName} in ${barsPath}`);
writeFileSync(`${barsPath}.new`, result.bytes);
console.log(`Replaced ${result.replaced} sound(s) -> ${barsPath}.new`);

if (restblPath) {
  const romfsPath = `Sound/Resource/${basename(barsPath).replace(/\.zs$/i, "")}`;
  const { bytes, changed } = patchRestblFile(readFileSync(restblPath), { [romfsPath]: result.sizes });
  writeFileSync(`${restblPath}.new`, bytes);
  console.log(changed.length ? `RESTBL: ${romfsPath} ${changed[0].before} -> ${changed[0].after}` : "RESTBL: entry already big enough");
}
