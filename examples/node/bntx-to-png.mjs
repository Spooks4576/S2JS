// Decode every image in a BNTX to PNG files.
//   node examples/node/bntx-to-png.mjs Driver_Mario_Body_Alb.bntx.zs out/
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { decodeBntx, crc32 } from "s2js";

const [input, outDir = "."] = process.argv.slice(2);
if (!input) throw new Error("usage: bntx-to-png.mjs <file.bntx[.zs]> [out dir]");

// Minimal RGBA8 PNG writer (S2JS decodes, Node's zlib does the compression).
const png = (width, height, rgba) => {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

const bntx = decodeBntx(readFileSync(input));
console.log(`${bntx.platform} · ${bntx.format} · ${bntx.images.length} image(s)`);
mkdirSync(outDir, { recursive: true });
for (const image of bntx.images) {
  const file = join(outDir, `${image.name}.png`);
  writeFileSync(file, png(image.width, image.height, image.rgba));
  console.log(`  ${file}  ${image.width}x${image.height}`);
}
