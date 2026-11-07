// Put a PNG into an existing BNTX texture, keeping its format, size and mips.
//   node examples/node/png-into-bntx.mjs Driver_Mario_Body_Alb.bntx.zs my_skin.png Driver_Mario_Body_Alb.bntx.zs.new
import { readFileSync, writeFileSync } from "node:fs";
import { readPngImage, replaceBntxTexture, bntxTextures, unpackZs } from "s2js";

const [bntxPath, pngPath, outPath = `${bntxPath}.new`] = process.argv.slice(2);
if (!pngPath) throw new Error("usage: png-into-bntx.mjs <file.bntx[.zs]> <image.png> [out]");

const original = readFileSync(bntxPath);
const image = await readPngImage(readFileSync(pngPath)); // { width, height, data, wide }
const [target] = bntxTextures(unpackZs(original));
console.log(`Replacing ${target.name} (${target.format.name}, ${target.width}x${target.height}, ${target.mips} mips)`);

const output = replaceBntxTexture(original, { image, texture: 0, effort: 2 });
writeFileSync(outPath, output);
console.log(`Wrote ${outPath} (${output.length} bytes)`);
