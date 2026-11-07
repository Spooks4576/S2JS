// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// PNG decoder that keeps 16-bit channels. Needs DecompressionStream (browsers, Node 18+).

const readPngImage = async (buffer) => {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x89504e47) return null;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let palette = null;
  let transparency = null;
  const chunks = [];
  for (let p = 8; p + 8 <= bytes.length; ) {
    const length = view.getUint32(p);
    const name = String.fromCharCode(...bytes.subarray(p + 4, p + 8));
    const data = bytes.subarray(p + 8, p + 8 + length);
    if (name === "IHDR") {
      width = view.getUint32(p + 8);
      height = view.getUint32(p + 12);
      depth = bytes[p + 16];
      type = bytes[p + 17];
      if (bytes[p + 20]) return null;
    } else if (name === "PLTE") palette = data;
    else if (name === "tRNS") transparency = data;
    else if (name === "IDAT") chunks.push(data);
    else if (name === "IEND") break;
    p += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[type];
  if (!channels || (depth !== 8 && depth !== 16 && !(type === 3 && depth <= 8)) || (type !== 3 && depth < 8)) return null;
  const stream = new Blob(chunks).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = Math.ceil((width * channels * depth) / 8);
  const pixels = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0, p = 0; y < height; y++) {
    const filter = raw[p++];
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? line[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[p++];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      line[x] = v;
    }
    prev = line;
  }
  const count = width * height;
  const wide = depth === 16;
  const out = wide ? new Uint16Array(count * 4) : new Uint8Array(count * 4);
  const full = wide ? 65535 : 255;
  for (let i = 0; i < count; i++) {
    const sample = (k) => {
      const at = (i * channels + k) * (wide ? 2 : 1);
      return wide ? (pixels[at] << 8) | pixels[at + 1] : pixels[at];
    };
    const o = i * 4;
    if (type === 3) {
      const row = Math.floor(i / width);
      const col = i % width;
      const at = row * stride * 8 + col * depth;
      const index = (pixels[at >> 3] >> (8 - depth - (at & 7))) & ((1 << depth) - 1);
      out[o] = palette[index * 3];
      out[o + 1] = palette[index * 3 + 1];
      out[o + 2] = palette[index * 3 + 2];
      out[o + 3] = transparency && index < transparency.length ? transparency[index] : 255;
    } else if (channels <= 2) {
      out[o] = out[o + 1] = out[o + 2] = sample(0);
      out[o + 3] = channels === 2 ? sample(1) : full;
    } else {
      out[o] = sample(0);
      out[o + 1] = sample(1);
      out[o + 2] = sample(2);
      out[o + 3] = channels === 4 ? sample(3) : full;
    }
  }
  return { width, height, wide, data: out };
};

export { readPngImage };
