// List the sounds in a .bars / .bwav file and export them as WAV.
//   node examples/node/bars-to-wav.mjs Driver_Mario_00.bars.zs out/
// Opus sounds need WebCodecs, so they are skipped in Node.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { openAudio, decodeBwav, writeWav, BWAV_CODECS } from "s2js";

const [input, outDir = "."] = process.argv.slice(2);
if (!input) throw new Error("usage: bars-to-wav.mjs <file.bars[.zs]|file.bwav> [out dir]");

const sounds = openAudio(readFileSync(input), basename(input));
console.log(`${sounds.length} sound(s)${sounds.streamed ? `, ${sounds.streamed} streamed from separate .bwav files` : ""}`);
mkdirSync(outDir, { recursive: true });
for (const { name, bwav } of sounds) {
  const label = `${name}  ${BWAV_CODECS[bwav.codec]} · ${bwav.channels.length} ch · ${(bwav.samples / bwav.rate).toFixed(2)} s`;
  if (bwav.codec === 2) {
    console.log(`  skip ${label}`);
    continue;
  }
  const planes = await decodeBwav(bwav);
  const wav = writeWav(planes, bwav.rate, { loopStart: bwav.loopStart, loopEnd: bwav.loopEnd });
  writeFileSync(join(outDir, `${name}.wav`), Buffer.from(await wav.arrayBuffer()));
  console.log(`  ${label}`);
}
