// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// BNTX texture container reader (Switch "NX  " and Switch 2 platforms).

import { decodeAstc } from "./astc-decode.js";
import { decodeBlocks } from "./bcn-decode.js";
import { zstdDecompress } from "../compression/zstd-decode.js";
import { halfToFloat, toUnit } from "../util/math.js";

const BNTX_ASTC = [[4, 4], [5, 4], [5, 5], [6, 5], [6, 6], [8, 5], [8, 6], [8, 8], [10, 5], [10, 6], [10, 8], [10, 10], [12, 10], [12, 12]];

const BNTX_FORMATS = {
  0x02: { name: "R8", block: [1, 1], bytes: 1 },
  0x07: { name: "R5G6B5", block: [1, 1], bytes: 2 },
  0x09: { name: "R8G8", block: [1, 1], bytes: 2 },
  0x0a: { name: "R16", block: [1, 1], bytes: 2 },
  0x0b: { name: "R8G8B8A8", block: [1, 1], bytes: 4 },
  0x0c: { name: "B8G8R8A8", block: [1, 1], bytes: 4 },
  0x12: { name: "R16G16", block: [1, 1], bytes: 4 },
  0x15: { name: "R16G16B16A16", block: [1, 1], bytes: 8 },
  0x19: { name: "R32G32B32A32", block: [1, 1], bytes: 16 },
  0x1a: { name: "BC1", block: [4, 4], bytes: 8, bc: "PF_DXT1" },
  0x1b: { name: "BC2", block: [4, 4], bytes: 16, bc: "PF_DXT3" },
  0x1c: { name: "BC3", block: [4, 4], bytes: 16, bc: "PF_DXT5" },
  0x1d: { name: "BC4", block: [4, 4], bytes: 8, bc: "PF_BC4" },
  0x1e: { name: "BC5", block: [4, 4], bytes: 16, bc: "PF_BC5" },
  0x1f: { name: "BC6H", block: [4, 4], bytes: 16, bc: "PF_BC6H" },
  0x20: { name: "BC7", block: [4, 4], bytes: 16, bc: "PF_BC7" },
  ...Object.fromEntries(BNTX_ASTC.map(([w, h], i) => [0x2d + i, { name: `ASTC ${w}x${h}`, block: [w, h], bytes: 16, astc: true }]))
};

const bntxFail = (reason) => {
  throw Object.assign(new Error(reason), { reason });
};

const GOB_ORDERS = {
  switch: [(x) => (x >> 4) & 1, (x, y) => (y >> 1) & 1, (x, y) => (y >> 2) & 1, (x) => (x >> 5) & 1],
  switch2: [(x, y) => (y >> 1) & 1, (x) => (x >> 4) & 1, (x, y) => (y >> 2) & 1, (x) => (x >> 5) & 1]
};

const deswizzleBlockLinear = (src, base, width, height, bpp, blockHeight, order) => {
  const out = new Uint8Array(width * height * bpp);
  const gobsWide = Math.ceil((width * bpp) / 64);
  const bits = GOB_ORDERS[order];
  const offset = (x, y) => (bits[0](x, y) << 5) + (bits[1](x, y) << 6) + (bits[2](x, y) << 7) + (bits[3](x, y) << 8);
  const columns = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const xb = x * bpp;
    columns[x] = Math.floor(xb / 64) * 512 * blockHeight + (xb & 15) + offset(xb, 0);
  }
  const end = src.length - bpp;
  for (let y = 0; y < height; y++) {
    const row = base + Math.floor(y / (8 * blockHeight)) * 512 * blockHeight * gobsWide + Math.floor((y % (8 * blockHeight)) / 8) * 512 + (y & 1) * 16 + offset(0, y);
    let o = y * width * bpp;
    for (let x = 0; x < width; x++) {
      const at = row + columns[x];
      if (at <= end) for (let k = 0; k < bpp; k++) out[o + k] = src[at + k];
      else for (let k = 0; k < bpp; k++) out[o + k] = src[at + k] || 0;
      o += bpp;
    }
  }
  return out;
};

const BNTX_TYPES = { 1: "", 2: " SNORM", 3: " UINT", 4: " SINT", 5: " Float", 6: " sRGB", 10: " UFloat" };

const decodeBntxPixels = (format, data, width, height, type) => {
  if (format.astc) return decodeAstc(data, width, height, format.block[0], format.block[1], type === 6);
  if (format.bc) return decodeBlocks(type === 2 && /BC[45]$/.test(format.bc) ? `${format.bc}S` : format.bc, data, width, height, toUnit);
  const out = new Uint8ClampedArray(width * height * 4);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const wide = (at) => (type === 5 ? toUnit(halfToFloat(view.getUint16(at, true))) : Math.round(view.getUint16(at, true) / 257));
  const name = format.name;
  for (let i = 0, p = 0, o = 0; i < width * height; i++, p += format.bytes, o += 4) {
    out[o + 3] = 255;
    if (name === "R8") out[o] = data[p];
    else if (name === "R16") out[o] = Math.round((data[p] | (data[p + 1] << 8)) / 257);
    else if (name === "R8G8") {
      out[o] = data[p];
      out[o + 1] = data[p + 1];
    } else if (name === "R16G16") {
      out[o] = wide(p);
      out[o + 1] = wide(p + 2);
    } else if (name === "R16G16B16A16") for (let c = 0; c < 4; c++) out[o + c] = wide(p + c * 2);
    else if (name === "R32G32B32A32") for (let c = 0; c < 4; c++) out[o + c] = toUnit(view.getFloat32(p + c * 4, true));
    else if (name === "R8G8B8A8") for (let c = 0; c < 4; c++) out[o + c] = data[p + c];
    else if (name === "B8G8R8A8") {
      out[o] = data[p + 2];
      out[o + 1] = data[p + 1];
      out[o + 2] = data[p];
      out[o + 3] = data[p + 3];
    } else {
      const v = data[p] | (data[p + 1] << 8);
      out[o] = Math.round(((v >> 11) * 255) / 31);
      out[o + 1] = Math.round((((v >> 5) & 63) * 255) / 63);
      out[o + 2] = Math.round(((v & 31) * 255) / 31);
    }
  }
  return out;
};

const applyChannelSelect = (pixels, select) => {
  if (select.every((s, i) => s === i + 2)) return pixels;
  const normal = select[2] === 0 && select[0] >= 2 && select[1] >= 2 && select[3] === 1;
  const sources = select.slice(0, 3).filter((s) => s >= 2);
  const gray = sources.length === 1 && select.slice(0, 3).filter((s) => s === sources[0]).length === 1;
  if (gray) {
    const from = sources[0] - 2;
    const alpha = select[3] >= 2 ? select[3] - 2 : -1;
    for (let i = 0; i < pixels.length; i += 4) {
      const v = pixels[i + from];
      pixels[i + 3] = alpha < 0 ? 255 : pixels[i + alpha];
      pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
    }
    return pixels;
  }
  const picks = select.map((s, k) => (k === 3 && s === 0 ? 255 : s === 0 ? 0 : s === 1 ? 255 : -(s - 1)));
  const src = new Uint8Array(4);
  for (let i = 0; i < pixels.length; i += 4) {
    src[0] = pixels[i];
    src[1] = pixels[i + 1];
    src[2] = pixels[i + 2];
    src[3] = pixels[i + 3];
    for (let c = 0; c < 4; c++) pixels[i + c] = picks[c] < 0 ? src[-picks[c] - 1] : picks[c];
    if (normal) {
      const x = pixels[i] / 127.5 - 1;
      const y = pixels[i + 1] / 127.5 - 1;
      pixels[i + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 1) * 127.5);
      pixels[i + 3] = 255;
    }
  }
  return pixels;
};

const bntxDeep = (format, data, width, height, type) => {
  if (type !== 1 || (format.name !== "R16" && format.name !== "R16G16")) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (format.name === "R16") return { channels: 1, data: Uint16Array.from({ length: width * height }, (_, i) => view.getUint16(i * 2, true)) };
  const out = new Uint16Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    out[i * 3] = view.getUint16(i * 4, true);
    out[i * 3 + 1] = view.getUint16(i * 4 + 2, true);
  }
  return { channels: 3, data: out };
};

const BNTX_FACES = ["px", "nx", "py", "ny", "pz", "nz"];

const decodeBntxImage = (image, bytes, base) => {
  const format = BNTX_FORMATS[image.fmt >> 8];
  const type = image.fmt & 0xff;
  const { width, height } = image;
  const across = Math.ceil(width / format.block[0]);
  const down = Math.ceil(height / format.block[1]);
  const data =
    image.tile === 1
      ? bytes.slice(base, base + across * down * format.bytes)
      : deswizzleBlockLinear(bytes, base, across, down, format.bytes, 1 << Math.min(5, image.layout & 7), image.platform);
  return { data: applyChannelSelect(decodeBntxPixels(format, data, width, height, type), image.select), deep: bntxDeep(format, data, width, height, type) };
};

const openBntx = (buffer) => {
  let bytes = new Uint8Array(buffer);
  let zstd = false;
  if (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd) {
    bytes = zstdDecompress(bytes);
    zstd = true;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x40 || String.fromCharCode(...bytes.subarray(0, 4)) !== "BNTX") bntxFail(zstd ? "This .zs file does not contain a BNTX texture" : "Not a BNTX texture");
  if (view.getUint16(0x0c, true) !== 0xfeff) bntxFail("Big endian BNTX files are not supported");
  const platform = String.fromCharCode(...bytes.subarray(0x20, 0x24)) === "NX  " ? "switch" : "switch2";
  const count = view.getUint32(0x24, true);
  if (!count) bntxFail("This BNTX has no textures");
  const table = Number(view.getBigUint64(0x28, true));
  const decoder = new TextDecoder();
  const images = [];
  let first = null;
  for (let index = 0; index < count; index++) {
    const info = Number(view.getBigUint64(table + index * 8, true));
    if (String.fromCharCode(...bytes.subarray(info, info + 4)) !== "BRTI") bntxFail("BNTX texture info looks corrupt");
    const fmt = view.getUint32(info + 0x1c, true);
    const format = BNTX_FORMATS[fmt >> 8];
    if (!format) bntxFail(`BNTX pixel format 0x${(fmt >> 8).toString(16)} is not supported yet`);
    const nameAt = Number(view.getBigUint64(info + 0x60, true));
    const name = decoder.decode(bytes.subarray(nameAt + 2, nameAt + 2 + view.getUint16(nameAt, true)));
    const layers = Math.max(1, view.getInt32(info + 0x30, true));
    const cube = layers % 6 === 0 && [3, 7].includes(view.getUint32(info + 0x5c, true));
    const width = view.getInt32(info + 0x24, true);
    const height = view.getInt32(info + 0x28, true);
    const tile = view.getUint16(info + 0x12, true);
    const layerSize = view.getUint32(info + 0x50, true) / layers;
    const length = tile === 1 ? Math.ceil(width / format.block[0]) * Math.ceil(height / format.block[1]) * format.bytes : layerSize;
    const mip0 = Number(view.getBigUint64(Number(view.getBigUint64(info + 0x70, true)), true));
    const common = { fmt, tile, width, height, platform, layout: view.getInt32(info + 0x34, true), select: [...bytes.subarray(info + 0x58, info + 0x5c)] };
    first ||= { format: `${format.name}${BNTX_TYPES[fmt & 0xff] ?? ""}`, cube, layers };
    for (let layer = 0; layer < layers; layer++) {
      const suffix = layers === 1 ? "" : cube ? `_${Math.floor(layer / 6) ? `${Math.floor(layer / 6)}_` : ""}${BNTX_FACES[layer % 6]}` : `_${layer}`;
      images.push({ ...common, name: `${name}${suffix}`, offset: mip0 + layer * layerSize, length });
    }
  }
  return {
    platform: platform === "switch" ? "Switch" : "Switch 2",
    count,
    ...first,
    images,
    bytes,
    decode: (image) => decodeBntxImage(image, bytes, image.offset)
  };
};

export { openBntx, decodeBntxImage, decodeBntxPixels, deswizzleBlockLinear, BNTX_FORMATS, BNTX_TYPES, BNTX_FACES, GOB_ORDERS };
