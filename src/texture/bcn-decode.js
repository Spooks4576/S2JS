// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// BC1-BC7 block decoder (BC6H included).

import { halfToFloat } from "../util/math.js";
import { formatError } from "../util/errors.js";

const unpackPartitions = (text) => [...text].map((c) => (c < "a" ? Number(c) : 128 + c.charCodeAt(0) - 97));

const PARTITIONS_2 = unpackPartitions("a01100110011001ba00100010001000ba11101110111011ba00100110011011ba00000010001001ba01101110111111ba00100110111111ba00000010011011ba00000000001001ba01101111111111ba00000010111111ba00000000001011ba00101111111111ba00000001111111ba00011111111111ba00000000000111ba00010001110111ba1b1000100000000a0000000b0001110a1b1001100010000a0b1000100000000a0001000b1001110a0000000b0001100a11100110011000ba0b1000100010000a0001000b0001100a1b0011001100110a0b1011001101100a0010111b1101000a0001111b1110000a1b1000110001110a0b1100110011100a10101010101010ba00011110000111ba10110b001011010a0110011b1001100a0b1110000111100a1010101b0101010a11010010110100ba10110101010010ba1b1001111001110a0010011b1001000a0b1001001001100a0b1101111011100a1b0100110010110a01111001100001ba11001101001100ba00001b001100000a10011b001000000a0b0011100100000a00000b001110010a0000100b1100100a11011001001001ba01101101100100ba1b0001110011100a0b1100111000110a11011001100100ba11000110011100ba11111101000000ba00110001110011ba00011110011001ba0b1001111110000a0b0001011101110a10001000111011b");
const PARTITIONS_3 = unpackPartitions("a01b00110221222ca00b0011c2112221a0002001c211221ba22c00220011011ba0000000b122112ca01b00110022002ca02c00221111111ba0110011c211221ba0000000b111222ca0001111b111222ca00011b12222222ca01200b20012001ca11201b20112011ca1220b220122012ca01b01121122122ca01b2001c2002220a00b00110112112ca11b0011c0012200a0001122b122112ca02c00220022111ba11b01110222022ca00b0001c2212221a00000b10122012ca0001100c2b02210a12c0b2200110000a0120012b122222ca11012c1b2210110a00001b012c11221a0221102b102002ca1100b102002222ca011012201c2001ba0002000c211222ba0000002b122122ca22c00220012001ba01b00120022022ca1200b2001c00120a00011b122c20000a1201201c0b20120a1202012bc010120a011220011c2001ba01111c22200001ba10b01012222222ca0000000c121212ba0221b220022112ca02c00110022001ba22012c10220122ba10122c22222010ba0002121c121212ba10b01010101222ca22c01110222011ba0021b120002111ca0002b122112211ca2220b110111022ca0021112b112000ca1100b100110222ca000000021b2211ca1100b102222222ca022001100b1002ca0221122b122002ca000000000002b1ca00c00010002000ba22212220222b22ca10b22222222222ca11b2011c2012220");

const WEIGHTS_2 = [0, 21, 43, 64];
const WEIGHTS_3 = [0, 9, 18, 27, 37, 46, 55, 64];
const WEIGHTS_4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

const blockBits = (src, at) => {
  let pos = 0;
  const bits = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) v |= ((src[at + (pos >> 3)] >> (pos & 7)) & 1) << i;
    return v;
  };
  const rbits = (n) => {
    const v = bits(n);
    let out = 0;
    for (let i = 0; i < n; i++) out |= ((v >> i) & 1) << (n - 1 - i);
    return out;
  };
  return { bits, rbits };
};

const interpolate = (a, b, weights, index) => (a * (64 - weights[index]) + b * weights[index] + 32) >> 6;

const expand5 = (v) => (v << 3) | (v >> 2);
const expand6 = (v) => (v << 2) | (v >> 4);

const colorPalette = new Uint8Array(16);

const colorBlock = (src, at, out, opaque) => {
  const c0 = src[at] | (src[at + 1] << 8);
  const c1 = src[at + 2] | (src[at + 3] << 8);
  const palette = colorPalette;
  palette[0] = expand5((c0 >> 11) & 31);
  palette[1] = expand6((c0 >> 5) & 63);
  palette[2] = expand5(c0 & 31);
  palette[4] = expand5((c1 >> 11) & 31);
  palette[5] = expand6((c1 >> 5) & 63);
  palette[6] = expand5(c1 & 31);
  palette[3] = palette[7] = palette[11] = palette[15] = 255;
  for (let c = 0; c < 3; c++) {
    const a = palette[c];
    const b = palette[4 + c];
    if (c0 > c1 || opaque) {
      palette[8 + c] = ((2 * a + b) / 3) | 0;
      palette[12 + c] = ((a + 2 * b) / 3) | 0;
    } else {
      palette[8 + c] = ((a + b) / 2) | 0;
      palette[12 + c] = 0;
    }
  }
  if (!(c0 > c1 || opaque)) palette[15] = 0;
  const indices = (src[at + 4] | (src[at + 5] << 8) | (src[at + 6] << 16) | (src[at + 7] << 24)) >>> 0;
  for (let i = 0; i < 16; i++) {
    const p = ((indices >>> (i * 2)) & 3) * 4;
    out[i * 4] = palette[p];
    out[i * 4 + 1] = palette[p + 1];
    out[i * 4 + 2] = palette[p + 2];
    out[i * 4 + 3] = palette[p + 3];
  }
};

const smoothBlock = (src, at, out, channel, stride) => {
  const a0 = src[at];
  const a1 = src[at + 1];
  const values = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) values.push((((7 - i) * a0 + i * a1) / 7) | 0);
  else {
    for (let i = 1; i < 5; i++) values.push((((5 - i) * a0 + i * a1) / 5) | 0);
    values.push(0, 255);
  }
  let bitsLow = src[at + 2] | (src[at + 3] << 8) | (src[at + 4] << 16);
  let bitsHigh = src[at + 5] | (src[at + 6] << 8) | (src[at + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const index = i < 8 ? (bitsLow >> (i * 3)) & 7 : (bitsHigh >> ((i - 8) * 3)) & 7;
    out[i * stride + channel] = values[index];
  }
};

const smoothBlockSigned = (src, at, out, channel, stride) => {
  const a0 = src[at] > 127 ? src[at] - 256 : src[at];
  const a1 = src[at + 1] > 127 ? src[at + 1] - 256 : src[at + 1];
  const values = [a0, a1];
  if (a0 > a1) for (let i = 1; i < 7; i++) values.push(((7 - i) * a0 + i * a1) / 7);
  else {
    for (let i = 1; i < 5; i++) values.push(((5 - i) * a0 + i * a1) / 5);
    values.push(-127, 127);
  }
  let bitsLow = src[at + 2] | (src[at + 3] << 8) | (src[at + 4] << 16);
  let bitsHigh = src[at + 5] | (src[at + 6] << 8) | (src[at + 7] << 16);
  for (let i = 0; i < 16; i++) {
    const index = i < 8 ? (bitsLow >> (i * 3)) & 7 : (bitsHigh >> ((i - 8) * 3)) & 7;
    out[i * stride + channel] = Math.round(((Math.max(-127, values[index]) + 127) * 255) / 254);
  }
};

const sharpBlock = (src, at, out) => {
  for (let i = 0; i < 16; i++) {
    const v = (src[at + (i >> 1)] >> ((i & 1) * 4)) & 15;
    out[i * 4 + 3] = v * 17;
  }
};

const BC7_COLOR_BITS = [4, 6, 5, 7, 5, 7, 7, 5];
const BC7_ALPHA_BITS = [0, 0, 0, 0, 6, 8, 7, 5];
const bc7Words = new Uint32Array(5);
const bc7Ends = new Int32Array(24);
const bc7Indices = new Uint8Array(16);

const bc7Block = (src, at, out) => {
  for (let i = 0; i < 4; i++) bc7Words[i] = (src[at + i * 4] | (src[at + i * 4 + 1] << 8) | (src[at + i * 4 + 2] << 16) | (src[at + i * 4 + 3] << 24)) >>> 0;
  let pos = 0;
  const bits = (n) => {
    const w = pos >> 5;
    const sh = pos & 31;
    let v = bc7Words[w] >>> sh;
    if (sh + n > 32) v |= bc7Words[w + 1] << (32 - sh);
    pos += n;
    return v & ((1 << n) - 1);
  };
  let mode = 0;
  while (mode < 8 && bits(1) === 0) mode++;
  if (mode >= 8) {
    out.fill(0);
    return;
  }
  const colorBits = BC7_COLOR_BITS[mode];
  const alphaBits = BC7_ALPHA_BITS[mode];
  const hasPBits = (0b11001011 >> mode) & 1;
  let partition = 0;
  let subsets = 1;
  let rotation = 0;
  let selection = 0;
  if (mode <= 3 || mode === 7) {
    subsets = mode === 0 || mode === 2 ? 3 : 2;
    partition = bits(mode === 0 ? 4 : 6);
  }
  const count = subsets * 2;
  if (mode === 4 || mode === 5) {
    rotation = bits(2);
    if (mode === 4) selection = bits(1);
  }
  const ends = bc7Ends;
  ends.fill(0);
  for (let c = 0; c < 3; c++) for (let e = 0; e < count; e++) ends[e * 4 + c] = bits(colorBits);
  if (alphaBits) for (let e = 0; e < count; e++) ends[e * 4 + 3] = bits(alphaBits);
  if (hasPBits) {
    for (let i = 0; i < count * 4; i++) ends[i] <<= 1;
    if (mode === 1) {
      const p0 = bits(1);
      const p1 = bits(1);
      for (let c = 0; c < 3; c++) {
        ends[c] |= p0;
        ends[4 + c] |= p0;
        ends[8 + c] |= p1;
        ends[12 + c] |= p1;
      }
    } else {
      for (let e = 0; e < count; e++) {
        const p = bits(1);
        for (let c = 0; c < 4; c++) ends[e * 4 + c] |= p;
      }
    }
  }
  const cb = colorBits + hasPBits;
  const ab = alphaBits + hasPBits;
  for (let e = 0; e < count; e++) {
    for (let c = 0; c < 3; c++) {
      const v = ends[e * 4 + c] << (8 - cb);
      ends[e * 4 + c] = v | (v >> cb);
    }
    if (alphaBits) {
      const v = ends[e * 4 + 3] << (8 - ab);
      ends[e * 4 + 3] = v | (v >> ab);
    } else ends[e * 4 + 3] = 255;
  }
  const indexBits = mode === 0 || mode === 1 ? 3 : mode === 6 ? 4 : 2;
  const indexBits2 = mode === 4 ? 3 : mode === 5 ? 2 : 0;
  const weights = indexBits === 2 ? WEIGHTS_2 : indexBits === 3 ? WEIGHTS_3 : WEIGHTS_4;
  const weights2 = indexBits2 === 2 ? WEIGHTS_2 : WEIGHTS_3;
  const table = subsets === 3 ? PARTITIONS_3 : PARTITIONS_2;
  const base = partition * 16;
  for (let i = 0; i < 16; i++) {
    const sub = subsets === 1 ? (i ? 0 : 128) : table[base + i];
    bc7Indices[i] = bits(sub & 0x80 ? indexBits - 1 : indexBits);
  }
  for (let i = 0; i < 16; i++) {
    const e0 = ((subsets === 1 ? 0 : table[base + i]) & 3) * 8;
    const e1 = e0 + 4;
    const o = i * 4;
    if (!indexBits2) {
      const w = weights[bc7Indices[i]];
      for (let c = 0; c < 4; c++) out[o + c] = (ends[e0 + c] * (64 - w) + ends[e1 + c] * w + 32) >> 6;
    } else {
      const index2 = bits(i ? indexBits2 : indexBits2 - 1);
      const cw = selection ? weights2[index2] : weights[bc7Indices[i]];
      const aw = selection ? weights[bc7Indices[i]] : weights2[index2];
      for (let c = 0; c < 3; c++) out[o + c] = (ends[e0 + c] * (64 - cw) + ends[e1 + c] * cw + 32) >> 6;
      out[o + 3] = (ends[e0 + 3] * (64 - aw) + ends[e1 + 3] * aw + 32) >> 6;
    }
    if (rotation) {
      const t = out[o + 3];
      out[o + 3] = out[o + rotation - 1];
      out[o + rotation - 1] = t;
    }
  }
};

const BC6_BITS = [
  [10, 7, 11, 11, 11, 9, 8, 8, 8, 6, 10, 11, 12, 16],
  [5, 6, 5, 4, 4, 5, 6, 5, 5, 6, 10, 9, 8, 4],
  [5, 6, 4, 5, 4, 5, 5, 6, 5, 6, 10, 9, 8, 4],
  [5, 6, 4, 4, 5, 5, 5, 5, 6, 6, 10, 9, 8, 4]
];

const extendSign = (v, n) => (v << (32 - n)) >> (32 - n);

const unquantize6 = (v, n, signed) => {
  if (!signed) {
    if (n >= 15) return v;
    if (!v) return 0;
    if (v === (1 << n) - 1) return 0xffff;
    return ((v << 16) + 0x8000) >> n;
  }
  if (n >= 16) return v;
  const neg = v < 0;
  const m = Math.abs(v);
  const out = !m ? 0 : m >= (1 << (n - 1)) - 1 ? 0x7fff : ((m << 15) + 0x4000) >> (n - 1);
  return neg ? -out : out;
};

const finish6 = (v, signed) => {
  if (!signed) return (v * 31) >> 6;
  const s = v < 0 ? -(((-v) * 31) >> 5) : (v * 31) >> 5;
  return s < 0 ? 0x8000 | -s : s;
};

const bc6Block = (src, at, out, signed) => {
  const { bits, rbits } = blockBits(src, at);
  const r = [0, 0, 0, 0];
  const g = [0, 0, 0, 0];
  const b = [0, 0, 0, 0];
  let mode = bits(2);
  if (mode > 1) mode |= bits(3) << 2;
  let partition = 0;
  switch (mode) {
    case 0b00: {
      g[2] |= bits(1) << 4;
      b[2] |= bits(1) << 4;
      b[3] |= bits(1) << 4;
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(5);
      g[3] |= bits(1) << 4;
      g[2] |= bits(4);
      g[1] |= bits(5);
      b[3] |= bits(1);
      g[3] |= bits(4);
      b[1] |= bits(5);
      b[3] |= bits(1) << 1;
      b[2] |= bits(4);
      r[2] |= bits(5);
      b[3] |= bits(1) << 2;
      r[3] |= bits(5);
      b[3] |= bits(1) << 3;
      partition = bits(5);
      mode = 0;
    } break;
    case 0b01: {
      g[2] |= bits(1) << 5;
      g[3] |= bits(1) << 4;
      g[3] |= bits(1) << 5;
      r[0] |= bits(7);
      b[3] |= bits(1);
      b[3] |= bits(1) << 1;
      b[2] |= bits(1) << 4;
      g[0] |= bits(7);
      b[2] |= bits(1) << 5;
      b[3] |= bits(1) << 2;
      g[2] |= bits(1) << 4;
      b[0] |= bits(7);
      b[3] |= bits(1) << 3;
      b[3] |= bits(1) << 5;
      b[3] |= bits(1) << 4;
      r[1] |= bits(6);
      g[2] |= bits(4);
      g[1] |= bits(6);
      g[3] |= bits(4);
      b[1] |= bits(6);
      b[2] |= bits(4);
      r[2] |= bits(6);
      r[3] |= bits(6);
      partition = bits(5);
      mode = 1;
    } break;
    case 0b00010: {
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(5);
      r[0] |= bits(1) << 10;
      g[2] |= bits(4);
      g[1] |= bits(4);
      g[0] |= bits(1) << 10;
      b[3] |= bits(1);
      g[3] |= bits(4);
      b[1] |= bits(4);
      b[0] |= bits(1) << 10;
      b[3] |= bits(1) << 1;
      b[2] |= bits(4);
      r[2] |= bits(5);
      b[3] |= bits(1) << 2;
      r[3] |= bits(5);
      b[3] |= bits(1) << 3;
      partition = bits(5);
      mode = 2;
    } break;
    case 0b00110: {
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(4);
      r[0] |= bits(1) << 10;
      g[3] |= bits(1) << 4;
      g[2] |= bits(4);
      g[1] |= bits(5);
      g[0] |= bits(1) << 10;
      g[3] |= bits(4);
      b[1] |= bits(4);
      b[0] |= bits(1) << 10;
      b[3] |= bits(1) << 1;
      b[2] |= bits(4);
      r[2] |= bits(4);
      b[3] |= bits(1);
      b[3] |= bits(1) << 2;
      r[3] |= bits(4);
      g[2] |= bits(1) << 4;
      b[3] |= bits(1) << 3;
      partition = bits(5);
      mode = 3;
    } break;
    case 0b01010: {
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(4);
      r[0] |= bits(1) << 10;
      b[2] |= bits(1) << 4;
      g[2] |= bits(4);
      g[1] |= bits(4);
      g[0] |= bits(1) << 10;
      b[3] |= bits(1);
      g[3] |= bits(4);
      b[1] |= bits(5);
      b[0] |= bits(1) << 10;
      b[2] |= bits(4);
      r[2] |= bits(4);
      b[3] |= bits(1) << 1;
      b[3] |= bits(1) << 2;
      r[3] |= bits(4);
      b[3] |= bits(1) << 4;
      b[3] |= bits(1) << 3;
      partition = bits(5);
      mode = 4;
    } break;
    case 0b01110: {
      r[0] |= bits(9);
      b[2] |= bits(1) << 4;
      g[0] |= bits(9);
      g[2] |= bits(1) << 4;
      b[0] |= bits(9);
      b[3] |= bits(1) << 4;
      r[1] |= bits(5);
      g[3] |= bits(1) << 4;
      g[2] |= bits(4);
      g[1] |= bits(5);
      b[3] |= bits(1);
      g[3] |= bits(4);
      b[1] |= bits(5);
      b[3] |= bits(1) << 1;
      b[2] |= bits(4);
      r[2] |= bits(5);
      b[3] |= bits(1) << 2;
      r[3] |= bits(5);
      b[3] |= bits(1) << 3;
      partition = bits(5);
      mode = 5;
    } break;
    case 0b10010: {
      r[0] |= bits(8);
      g[3] |= bits(1) << 4;
      b[2] |= bits(1) << 4;
      g[0] |= bits(8);
      b[3] |= bits(1) << 2;
      g[2] |= bits(1) << 4;
      b[0] |= bits(8);
      b[3] |= bits(1) << 3;
      b[3] |= bits(1) << 4;
      r[1] |= bits(6);
      g[2] |= bits(4);
      g[1] |= bits(5);
      b[3] |= bits(1);
      g[3] |= bits(4);
      b[1] |= bits(5);
      b[3] |= bits(1) << 1;
      b[2] |= bits(4);
      r[2] |= bits(6);
      r[3] |= bits(6);
      partition = bits(5);
      mode = 6;
    } break;
    case 0b10110: {
      r[0] |= bits(8);
      b[3] |= bits(1);
      b[2] |= bits(1) << 4;
      g[0] |= bits(8);
      g[2] |= bits(1) << 5;
      g[2] |= bits(1) << 4;
      b[0] |= bits(8);
      g[3] |= bits(1) << 5;
      b[3] |= bits(1) << 4;
      r[1] |= bits(5);
      g[3] |= bits(1) << 4;
      g[2] |= bits(4);
      g[1] |= bits(6);
      g[3] |= bits(4);
      b[1] |= bits(5);
      b[3] |= bits(1) << 1;
      b[2] |= bits(4);
      r[2] |= bits(5);
      b[3] |= bits(1) << 2;
      r[3] |= bits(5);
      b[3] |= bits(1) << 3;
      partition = bits(5);
      mode = 7;
    } break;
    case 0b11010: {
      r[0] |= bits(8);
      b[3] |= bits(1) << 1;
      b[2] |= bits(1) << 4;
      g[0] |= bits(8);
      b[2] |= bits(1) << 5;
      g[2] |= bits(1) << 4;
      b[0] |= bits(8);
      b[3] |= bits(1) << 5;
      b[3] |= bits(1) << 4;
      r[1] |= bits(5);
      g[3] |= bits(1) << 4;
      g[2] |= bits(4);
      g[1] |= bits(5);
      b[3] |= bits(1);
      g[3] |= bits(4);
      b[1] |= bits(6);
      b[2] |= bits(4);
      r[2] |= bits(5);
      b[3] |= bits(1) << 2;
      r[3] |= bits(5);
      b[3] |= bits(1) << 3;
      partition = bits(5);
      mode = 8;
    } break;
    case 0b11110: {
      r[0] |= bits(6);
      g[3] |= bits(1) << 4;
      b[3] |= bits(1);
      b[3] |= bits(1) << 1;
      b[2] |= bits(1) << 4;
      g[0] |= bits(6);
      g[2] |= bits(1) << 5;
      b[2] |= bits(1) << 5;
      b[3] |= bits(1) << 2;
      g[2] |= bits(1) << 4;
      b[0] |= bits(6);
      g[3] |= bits(1) << 5;
      b[3] |= bits(1) << 3;
      b[3] |= bits(1) << 5;
      b[3] |= bits(1) << 4;
      r[1] |= bits(6);
      g[2] |= bits(4);
      g[1] |= bits(6);
      g[3] |= bits(4);
      b[1] |= bits(6);
      b[2] |= bits(4);
      r[2] |= bits(6);
      r[3] |= bits(6);
      partition = bits(5);
      mode = 9;
    } break;
    case 0b00011: {
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(10);
      g[1] |= bits(10);
      b[1] |= bits(10);
      mode = 10;
    } break;
    case 0b00111: {
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(9);
      r[0] |= bits(1) << 10;
      g[1] |= bits(9);
      g[0] |= bits(1) << 10;
      b[1] |= bits(9);
      b[0] |= bits(1) << 10;
      mode = 11;
    } break;
    case 0b01011: {
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(8);
      r[0] |= rbits(2) << 10;
      g[1] |= bits(8);
      g[0] |= rbits(2) << 10;
      b[1] |= bits(8);
      b[0] |= rbits(2) << 10;
      mode = 12;
    } break;
    case 0b01111: {
      r[0] |= bits(10);
      g[0] |= bits(10);
      b[0] |= bits(10);
      r[1] |= bits(4);
      r[0] |= rbits(6) << 10;
      g[1] |= bits(4);
      g[0] |= rbits(6) << 10;
      b[1] |= bits(4);
      b[0] |= rbits(6) << 10;
      mode = 13;
    } break;
    default:
      out.fill(0);
      return;
  }
  const one = mode >= 10;
  const count = one ? 2 : 4;
  const base = BC6_BITS[0][mode];
  if (signed) {
    r[0] = extendSign(r[0], base);
    g[0] = extendSign(g[0], base);
    b[0] = extendSign(b[0], base);
  }
  if ((mode !== 9 && mode !== 10) || signed) {
    for (let i = 1; i < count; i++) {
      r[i] = extendSign(r[i], BC6_BITS[1][mode]);
      g[i] = extendSign(g[i], BC6_BITS[2][mode]);
      b[i] = extendSign(b[i], BC6_BITS[3][mode]);
    }
  }
  if (mode !== 9 && mode !== 10) {
    const inverse = (v, a0) => {
      const t = (v + a0) & ((1 << base) - 1);
      return signed ? extendSign(t, base) : t;
    };
    for (let i = 1; i < count; i++) {
      r[i] = inverse(r[i], r[0]);
      g[i] = inverse(g[i], g[0]);
      b[i] = inverse(b[i], b[0]);
    }
  }
  for (let i = 0; i < count; i++) {
    r[i] = unquantize6(r[i], base, signed);
    g[i] = unquantize6(g[i], base, signed);
    b[i] = unquantize6(b[i], base, signed);
  }
  const weights = one ? WEIGHTS_4 : WEIGHTS_3;
  for (let i = 0; i < 16; i++) {
    let set = one ? (i ? 0 : 128) : PARTITIONS_2[partition * 16 + i];
    const index = bits((one ? 4 : 3) - (set & 0x80 ? 1 : 0));
    const e = (set & 1) * 2;
    out[i * 3] = finish6(interpolate(r[e], r[e + 1], weights, index), signed);
    out[i * 3 + 1] = finish6(interpolate(g[e], g[e + 1], weights, index), signed);
    out[i * 3 + 2] = finish6(interpolate(b[e], b[e + 1], weights, index), signed);
  }
};

const BLOCK_FORMATS = {
  PF_DXT1: 8,
  PF_DXT3: 16,
  PF_DXT5: 16,
  PF_BC4: 8,
  PF_BC5: 16,
  PF_BC4S: 8,
  PF_BC5S: 16,
  PF_BC6H: 16,
  PF_BC7: 16
};

const decodeBlocks = (format, src, width, height, toByte) => {
  const size = BLOCK_FORMATS[format];
  const across = Math.ceil(width / 4);
  const down = Math.ceil(height / 4);
  if (src.length < across * down * size) throw formatError("Texture data is smaller than expected");
  const out = new Uint8ClampedArray(width * height * 4);
  const block = new Uint8ClampedArray(64);
  const half = new Uint16Array(48);
  for (let by = 0; by < down; by++) {
    for (let bx = 0; bx < across; bx++) {
      const at = (by * across + bx) * size;
      if (format === "PF_DXT1") colorBlock(src, at, block, false);
      else if (format === "PF_DXT3") {
        colorBlock(src, at + 8, block, true);
        sharpBlock(src, at, block);
      } else if (format === "PF_DXT5") {
        colorBlock(src, at + 8, block, true);
        smoothBlock(src, at, block, 3, 4);
      } else if (format === "PF_BC4" || format === "PF_BC4S") {
        (format === "PF_BC4" ? smoothBlock : smoothBlockSigned)(src, at, block, 0, 4);
        for (let i = 0; i < 16; i++) block.set([block[i * 4], block[i * 4], 255], i * 4 + 1);
      } else if (format === "PF_BC5" || format === "PF_BC5S") {
        const smooth = format === "PF_BC5" ? smoothBlock : smoothBlockSigned;
        smooth(src, at, block, 0, 4);
        smooth(src, at + 8, block, 1, 4);
        for (let i = 0; i < 16; i++) {
          const x = block[i * 4] / 127.5 - 1;
          const y = block[i * 4 + 1] / 127.5 - 1;
          block[i * 4 + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) + 1) * 127.5);
          block[i * 4 + 3] = 255;
        }
      } else if (format === "PF_BC6H") {
        bc6Block(src, at, half, false);
        for (let i = 0; i < 16; i++) {
          for (let c = 0; c < 3; c++) block[i * 4 + c] = toByte(halfToFloat(half[i * 3 + c]));
          block[i * 4 + 3] = 255;
        }
      } else bc7Block(src, at, block);
      const cols = Math.min(4, width - bx * 4);
      for (let y = 0; y < 4; y++) {
        const py = by * 4 + y;
        if (py >= height) break;
        out.set(block.subarray(y * 16, y * 16 + cols * 4), (py * width + bx * 4) * 4);
      }
    }
  }
  return out;
};

export { decodeBlocks, BLOCK_FORMATS };
