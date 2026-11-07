// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// Writes new pixels into an existing BNTX in place (same format, size and mip count).

import { encodeAstc } from "./astc-encode.js";
import { encodeBc } from "./bcn-encode.js";
import { BNTX_FORMATS, GOB_ORDERS } from "./bntx-read.js";

const swizzleBlockLinear = (dst, base, src, width, height, bpp, blockHeight, order) => {
  const gobsWide = Math.ceil((width * bpp) / 64);
  const bits = GOB_ORDERS[order];
  const offset = (x, y) => (bits[0](x, y) << 5) + (bits[1](x, y) << 6) + (bits[2](x, y) << 7) + (bits[3](x, y) << 8);
  const columns = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    const xb = x * bpp;
    columns[x] = Math.floor(xb / 64) * 512 * blockHeight + (xb & 15) + offset(xb, 0);
  }
  for (let y = 0; y < height; y++) {
    const row = base + Math.floor(y / (8 * blockHeight)) * 512 * blockHeight * gobsWide + Math.floor((y % (8 * blockHeight)) / 8) * 512 + (y & 1) * 16 + offset(0, y);
    let o = y * width * bpp;
    for (let x = 0; x < width; x++) {
      const at = row + columns[x];
      if (at + bpp <= dst.length) for (let k = 0; k < bpp; k++) dst[at + k] = src[o + k];
      o += bpp;
    }
  }
};

const bntxTextures = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const platform = String.fromCharCode(...bytes.subarray(0x20, 0x24)) === "NX  " ? "switch" : "switch2";
  const count = view.getUint32(0x24, true);
  const table = Number(view.getBigUint64(0x28, true));
  const decoder = new TextDecoder();
  return Array.from({ length: count }, (_, index) => {
    const info = Number(view.getBigUint64(table + index * 8, true));
    const fmt = view.getUint32(info + 0x1c, true);
    const nameAt = Number(view.getBigUint64(info + 0x60, true));
    const mips = view.getUint16(info + 0x16, true);
    const mipTable = Number(view.getBigUint64(info + 0x70, true));
    const layers = Math.max(1, view.getInt32(info + 0x30, true));
    return {
      index,
      name: decoder.decode(bytes.subarray(nameAt + 2, nameAt + 2 + view.getUint16(nameAt, true))),
      fmt,
      format: BNTX_FORMATS[fmt >> 8],
      type: fmt & 0xff,
      width: view.getInt32(info + 0x24, true),
      height: view.getInt32(info + 0x28, true),
      mips,
      layers,
      tile: view.getUint16(info + 0x12, true),
      layerSize: view.getUint32(info + 0x50, true) / layers,
      blockHeight: view.getInt32(info + 0x34, true) & 7,
      select: [...bytes.subarray(info + 0x58, info + 0x5c)],
      offsets: Array.from({ length: mips }, (_, i) => Number(view.getBigUint64(mipTable + i * 8, true))),
      platform
    };
  });
};

const bntxWritable = (tex) => {
  const f = tex.format;
  if (!f) return "This pixel format is not supported";
  if (tex.tile === 1) return "Linear textures are not supported yet";
  if (tex.type === 5 || tex.type === 10 || f.name === "BC6H" || f.name === "R32G32B32A32") return "HDR float textures are not supported yet";
  if (f.name === "BC2") return "BC2 textures are not supported yet";
  if (tex.type === 2 && !/^BC[45]$/.test(f.name)) return "Signed textures are not supported yet";
  return null;
};

const bntxMipLayout = (tex, level) => {
  const [bw, bh] = tex.format.block;
  const width = Math.max(1, tex.width >> level);
  const height = Math.max(1, tex.height >> level);
  const across = Math.ceil(width / bw);
  const down = Math.ceil(height / bh);
  let log2 = Math.min(5, tex.blockHeight);
  while (level && log2 && down <= (1 << (log2 - 1)) * 8) log2--;
  return { width, height, across, down, blockHeight: 1 << log2 };
};

const unselectChannels = (tex, rgba, count, wide) => {
  const out = wide ? new Uint16Array(count * 4) : new Uint8Array(count * 4);
  const full = wide ? 65535 : 255;
  const source = [0, 1, 2, 3].map((c) => tex.select.indexOf(c + 2));
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 4; c++) out[i * 4 + c] = source[c] >= 0 ? rgba[i * 4 + source[c]] : c === 3 ? full : 0;
  }
  return out;
};

const srgbToLinear = new Float32Array(256).map((_, v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});

const linearToSrgb = (c) => {
  c = c < 0 ? 0 : c > 1 ? 1 : c;
  return Math.round((c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055) * 255);
};

const resizeArea = (src, w, h, nw, nh) => {
  const out = new Float32Array(nw * nh * 4);
  const sx = w / nw;
  const sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < nw; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let total = 0;
      const acc = [0, 0, 0, 0];
      for (let yy = Math.floor(y0); yy < Math.ceil(y1); yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        for (let xx = Math.floor(x0); xx < Math.ceil(x1); xx++) {
          const wgt = wy * (Math.min(x1, xx + 1) - Math.max(x0, xx));
          const s = (Math.min(h - 1, yy) * w + Math.min(w - 1, xx)) * 4;
          for (let c = 0; c < 4; c++) acc[c] += src[s + c] * wgt;
          total += wgt;
        }
      }
      for (let c = 0; c < 4; c++) out[(y * nw + x) * 4 + c] = acc[c] / total;
    }
  }
  return out;
};

const bntxMipImages = (tex, pixels, wide) => {
  const srgb = tex.type === 6;
  const full = wide ? 65535 : 255;
  const count = tex.width * tex.height;
  const linear = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const a = pixels[i * 4 + 3] / full;
    for (let c = 0; c < 3; c++) {
      const v = pixels[i * 4 + c];
      linear[i * 4 + c] = (srgb && !wide ? srgbToLinear[v] : v / full) * a;
    }
    linear[i * 4 + 3] = a;
  }
  const levels = [pixels];
  for (let level = 1; level < tex.mips; level++) {
    const { width, height } = bntxMipLayout(tex, level);
    const small = resizeArea(linear, tex.width, tex.height, width, height);
    const out = wide ? new Uint16Array(width * height * 4) : new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) {
      const a = small[i * 4 + 3];
      for (let c = 0; c < 3; c++) {
        const v = a > 1e-6 ? small[i * 4 + c] / a : 0;
        out[i * 4 + c] = srgb && !wide ? linearToSrgb(v) : Math.round(Math.min(1, Math.max(0, v)) * full);
      }
      out[i * 4 + 3] = Math.round(a * full);
    }
    levels.push(out);
  }
  return levels;
};

const encodeTexels = (fmt, pixels, width, height, effort) => {
  const format = BNTX_FORMATS[fmt >> 8];
  const type = fmt & 0xff;
  if (format.astc) return encodeAstc(pixels, width, height, format.block[0], format.block[1], type === 6, effort);
  if (format.bc) return encodeBc(type === 2 ? `${format.bc}S` : format.bc, pixels, width, height);
  const n = width * height;
  const out = new Uint8Array(n * format.bytes);
  const view = new DataView(out.buffer);
  const wide = pixels instanceof Uint16Array;
  const byte = (v) => (wide ? Math.round(v / 257) : v);
  const short = (v) => (wide ? v : v * 257);
  for (let i = 0, p = 0; i < n; i++, p += format.bytes) {
    const s = i * 4;
    const name = format.name;
    if (name === "R8") out[p] = byte(pixels[s]);
    else if (name === "R8G8") {
      out[p] = byte(pixels[s]);
      out[p + 1] = byte(pixels[s + 1]);
    } else if (name === "R16") view.setUint16(p, short(pixels[s]), true);
    else if (name === "R16G16") {
      view.setUint16(p, short(pixels[s]), true);
      view.setUint16(p + 2, short(pixels[s + 1]), true);
    } else if (name === "R16G16B16A16") for (let c = 0; c < 4; c++) view.setUint16(p + c * 2, short(pixels[s + c]), true);
    else if (name === "R8G8B8A8") for (let c = 0; c < 4; c++) out[p + c] = byte(pixels[s + c]);
    else if (name === "B8G8R8A8") {
      out[p] = byte(pixels[s + 2]);
      out[p + 1] = byte(pixels[s + 1]);
      out[p + 2] = byte(pixels[s]);
      out[p + 3] = byte(pixels[s + 3]);
    } else {
      const r = Math.round((byte(pixels[s]) * 31) / 255);
      const g = Math.round((byte(pixels[s + 1]) * 63) / 255);
      const b = Math.round((byte(pixels[s + 2]) * 31) / 255);
      view.setUint16(p, (r << 11) | (g << 5) | b, true);
    }
  }
  return out;
};

const bntxWriteLevel = (bytes, tex, layer, level, blocks) => {
  const { across, down, blockHeight } = bntxMipLayout(tex, level);
  const base = tex.offsets[0] + layer * tex.layerSize + (tex.offsets[level] - tex.offsets[0]);
  swizzleBlockLinear(bytes, base, blocks, across, down, tex.format.bytes, blockHeight, tex.platform);
};

export { bntxTextures, bntxWritable, bntxMipLayout, bntxMipImages, bntxWriteLevel, encodeTexels, unselectChannels, resizeArea, swizzleBlockLinear, srgbToLinear, linearToSrgb };
