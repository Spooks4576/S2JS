// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// ASTC LDR decoder for every 2D block size used by BNTX.

const ASTC_CORE = (() => {
  const RANGES = [
    [1, 0, 0], [0, 1, 0], [2, 0, 0], [0, 0, 1], [1, 1, 0], [3, 0, 0], [1, 0, 1], [2, 1, 0], [4, 0, 0], [2, 0, 1], [3, 1, 0],
    [5, 0, 0], [3, 0, 1], [4, 1, 0], [6, 0, 0], [4, 0, 1], [5, 1, 0], [7, 0, 0], [5, 0, 1], [6, 1, 0], [8, 0, 0]
  ];

  const iseBits = (count, level) => {
    const [bits, trits, quints] = RANGES[level];
    return bits * count + (trits ? Math.floor((8 * count + 4) / 5) : 0) + (quints ? Math.floor((7 * count + 2) / 3) : 0);
  };

  const bit = (v, i) => (v >> i) & 1;

  const TRITS = Array.from({ length: 256 }, (_, T) => {
    let C;
    let t4;
    let t3;
    if (((T >> 2) & 7) === 7) {
      C = (((T >> 5) & 7) << 2) | (T & 3);
      t4 = 2;
      t3 = 2;
    } else {
      C = T & 31;
      if (((T >> 5) & 3) === 3) {
        t4 = 2;
        t3 = bit(T, 7);
      } else {
        t4 = bit(T, 7);
        t3 = (T >> 5) & 3;
      }
    }
    let t0;
    let t1;
    let t2;
    if ((C & 3) === 3) {
      t2 = 2;
      t1 = bit(C, 4);
      t0 = (bit(C, 3) << 1) | (bit(C, 2) & ~bit(C, 3) & 1);
    } else if (((C >> 2) & 3) === 3) {
      t2 = 2;
      t1 = 2;
      t0 = C & 3;
    } else {
      t2 = bit(C, 4);
      t1 = (C >> 2) & 3;
      t0 = (bit(C, 1) << 1) | (bit(C, 0) & ~bit(C, 1) & 1);
    }
    return [t0, t1, t2, t3, t4];
  });

  const QUINTS = Array.from({ length: 128 }, (_, Q) => {
    let q0;
    let q1;
    let q2;
    if (((Q >> 1) & 3) === 3 && ((Q >> 5) & 3) === 0) {
      q2 = (bit(Q, 0) << 2) | ((bit(Q, 4) & ~bit(Q, 0) & 1) << 1) | (bit(Q, 3) & ~bit(Q, 0) & 1);
      q1 = 4;
      q0 = 4;
    } else {
      let C;
      if (((Q >> 1) & 3) === 3) {
        q2 = 4;
        C = (((Q >> 3) & 3) << 3) | ((~(Q >> 5) & 3) << 1) | (Q & 1);
      } else {
        q2 = (Q >> 5) & 3;
        C = Q & 31;
      }
      if ((C & 7) === 5) {
        q1 = 4;
        q0 = (C >> 3) & 3;
      } else {
        q1 = (C >> 3) & 3;
        q0 = C & 7;
      }
    }
    return [q0, q1, q2];
  });

  const readIse = (read, count, level, table, out) => {
    const [bits, trits, quints] = RANGES[level];
    const m = iseMantissas;
    if (trits) {
      for (let i = 0; i < count; i += 5) {
        let T = 0;
        for (let k = 0; k < 5; k++) {
          if (i + k >= count) break;
          m[k] = read(bits);
          T |= read(TRIT_PARTS[k * 2 + 1]) << TRIT_PARTS[k * 2];
        }
        const t = TRITS[T];
        for (let k = 0; k < 5 && i + k < count; k++) out[i + k] = table[(t[k] << bits) | m[k]];
      }
    } else if (quints) {
      for (let i = 0; i < count; i += 3) {
        let Q = 0;
        for (let k = 0; k < 3; k++) {
          if (i + k >= count) break;
          m[k] = read(bits);
          Q |= read(QUINT_PARTS[k * 2 + 1]) << QUINT_PARTS[k * 2];
        }
        const q = QUINTS[Q];
        for (let k = 0; k < 3 && i + k < count; k++) out[i + k] = table[(q[k] << bits) | m[k]];
      }
    } else {
      for (let i = 0; i < count; i++) out[i] = table[read(bits)];
    }
  };

  const TRIT_PARTS = [0, 2, 2, 2, 4, 1, 5, 2, 7, 1];
  const QUINT_PARTS = [0, 3, 3, 2, 5, 2];
  const iseMantissas = new Int32Array(5);

  const replicate = (v, from, to) => {
    let out = 0;
    let have = 0;
    while (have < to) {
      out = (out << from) | v;
      have += from;
    }
    return out >> (have - to);
  };

  const pattern = (m, spec) => {
    let out = 0;
    for (const ch of spec) out = (out << 1) | (ch === "0" ? 0 : bit(m, "abcdef".indexOf(ch)));
    return out;
  };

  const COLOR_B = {
    t: [null, ["000000000", 204], ["b000b0bb0", 93], ["cb000cbcb", 44], ["dcb000dcb", 22], ["edcb000ed", 11], ["fedcb000f", 5]],
    q: [null, ["000000000", 113], ["b0000bb00", 54], ["cb0000cbc", 26], ["dcb0000dc", 13], ["edcb0000e", 6]]
  };

  const COLOR_UNQ = RANGES.map(([bits, trits, quints], level) => {
    const levels = (1 << bits) * (trits ? 3 : quints ? 5 : 1);
    const table = new Uint8Array(levels);
    for (let v = 0; v < levels; v++) {
      const d = v >> bits;
      const m = v & ((1 << bits) - 1);
      if (!trits && !quints) table[v] = replicate(m, bits, 8);
      else if (bits === 0) table[v] = trits ? [0, 128, 255][d] : [0, 64, 128, 191, 255][d];
      else {
        const [spec, C] = COLOR_B[trits ? "t" : "q"][bits];
        const A = m & 1 ? 0x1ff : 0;
        let T = d * C + pattern(m, spec);
        T ^= A;
        table[v] = (A & 0x80) | (T >> 2);
      }
    }
    return { table, bits };
  });

  const WEIGHT_B = {
    t: [null, ["0000000", 50], ["b000b0b", 23], ["cb000cb", 11]],
    q: [null, ["0000000", 28], ["b0000b0", 13]]
  };

  const WEIGHT_UNQ = RANGES.slice(0, 12).map(([bits, trits, quints]) => {
    const levels = (1 << bits) * (trits ? 3 : quints ? 5 : 1);
    const table = new Uint8Array(levels);
    for (let v = 0; v < levels; v++) {
      const d = v >> bits;
      const m = v & ((1 << bits) - 1);
      let w;
      if (!trits && !quints) w = replicate(m, bits, 6);
      else if (bits === 0) w = trits ? [0, 32, 63][d] : [0, 16, 32, 47, 63][d];
      else {
        const [spec, C] = WEIGHT_B[trits ? "t" : "q"][bits];
        const A = m & 1 ? 0x7f : 0;
        let T = d * C + pattern(m, spec);
        T ^= A;
        w = (A & 0x20) | (T >> 2);
      }
      table[v] = w > 32 ? w + 1 : w;
    }
    return table;
  });

  const modes = new Array(2048);
  const blockMode = (mode) => {
    if (modes[mode] === undefined) modes[mode] = readBlockMode(mode);
    return modes[mode];
  };

  const levels = new Map();
  const colorLevel = (count, space) => {
    const key = count * 256 + space;
    let level = levels.get(key);
    if (level !== undefined) return level;
    level = -1;
    for (let l = 20; l >= 0; l--) {
      if (iseBits(count, l) <= space) {
        level = l;
        break;
      }
    }
    levels.set(key, level);
    return level;
  };

  const reverse32 = (v) => {
    v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
    v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
    v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
    v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
    return ((v >>> 16) | (v << 16)) >>> 0;
  };

  const words = new Uint32Array(5);
  const reversed = new Uint32Array(5);
  const take = (w, start, n) => {
    const i = start >> 5;
    const sh = start & 31;
    let v = w[i] >>> sh;
    if (sh + n > 32) v |= w[i + 1] << (32 - sh);
    return n >= 32 ? v >>> 0 : v & ((1 << n) - 1);
  };

  const colorValues = new Uint8Array(18);
  const weightValues = new Uint8Array(64);

  const readBlockMode = (mode) => {
    let R = (mode >> 4) & 1;
    let H = (mode >> 9) & 1;
    let D = (mode >> 10) & 1;
    const A = (mode >> 5) & 3;
    let x;
    let y;
    if (mode & 3) {
      R |= (mode & 3) << 1;
      let B = (mode >> 7) & 3;
      switch ((mode >> 2) & 3) {
        case 0:
          x = B + 4;
          y = A + 2;
          break;
        case 1:
          x = B + 8;
          y = A + 2;
          break;
        case 2:
          x = A + 2;
          y = B + 8;
          break;
        default:
          B &= 1;
          if (mode & 0x100) {
            x = B + 2;
            y = A + 2;
          } else {
            x = A + 2;
            y = B + 6;
          }
      }
    } else {
      R |= ((mode >> 2) & 3) << 1;
      if (((mode >> 2) & 3) === 0) return null;
      const B = (mode >> 9) & 3;
      switch ((mode >> 7) & 3) {
        case 0:
          x = 12;
          y = A + 2;
          break;
        case 1:
          x = A + 2;
          y = 12;
          break;
        case 2:
          x = A + 6;
          y = B + 6;
          D = 0;
          H = 0;
          break;
        default:
          if (((mode >> 5) & 3) === 0) {
            x = 6;
            y = 10;
          } else if (((mode >> 5) & 3) === 1) {
            x = 10;
            y = 6;
          } else return null;
      }
    }
    const level = R - 2 + 6 * H;
    const count = x * y * (D + 1);
    if (count > 64) return null;
    const bits = iseBits(count, level);
    if (bits < 24 || bits > 96) return null;
    return { x, y, dual: D, level, count, bits };
  };

  const hash52 = (p) => {
    p = (p ^ (p >>> 15)) >>> 0;
    p = (p - (p << 17)) >>> 0;
    p = (p + (p << 7)) >>> 0;
    p = (p + (p << 4)) >>> 0;
    p = (p ^ (p >>> 5)) >>> 0;
    p = (p + (p << 16)) >>> 0;
    p = (p ^ (p >>> 7)) >>> 0;
    p = (p ^ (p >>> 3)) >>> 0;
    p = (p ^ (p << 6)) >>> 0;
    p = (p ^ (p >>> 17)) >>> 0;
    return p;
  };

  const selectPartition = (seed, x, y, z, count, small) => {
    if (small) {
      x <<= 1;
      y <<= 1;
      z <<= 1;
    }
    seed += (count - 1) * 1024;
    const r = hash52(seed);
    const s = [r, r >>> 4, r >>> 8, r >>> 12, r >>> 16, r >>> 20, r >>> 24, r >>> 28, r >>> 18, r >>> 22, r >>> 26, (r >>> 30) | (r << 2)].map((v) => {
      const n = v & 15;
      return n * n;
    });
    let sh1;
    let sh2;
    if (seed & 1) {
      sh1 = seed & 2 ? 4 : 5;
      sh2 = count === 3 ? 6 : 5;
    } else {
      sh1 = count === 3 ? 6 : 5;
      sh2 = seed & 2 ? 4 : 5;
    }
    const sh3 = seed & 0x10 ? sh1 : sh2;
    const shifts = [sh1, sh2, sh1, sh2, sh1, sh2, sh1, sh2, sh3, sh3, sh3, sh3];
    for (let i = 0; i < 12; i++) s[i] >>= shifts[i];
    const a = (s[0] * x + s[1] * y + s[10] * z + (r >>> 14)) & 63;
    const b = (s[2] * x + s[3] * y + s[11] * z + (r >>> 10)) & 63;
    let c = (s[4] * x + s[5] * y + s[8] * z + (r >>> 6)) & 63;
    let d = (s[6] * x + s[7] * y + s[9] * z + (r >>> 2)) & 63;
    if (count < 4) d = 0;
    if (count < 3) c = 0;
    if (a >= b && a >= c && a >= d) return 0;
    if (b >= c && b >= d) return 1;
    if (c >= d) return 2;
    return 3;
  };

  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

  const bitTransfer = (a, b) => {
    b = (b >> 1) | (a & 0x80);
    a = (a >> 1) & 0x3f;
    if (a & 0x20) a -= 0x40;
    return [a, b];
  };

  const blueContract = (r, g, b, a) => [(r + b) >> 1, (g + b) >> 1, b, a];

  const endpoints = (cem, v) => {
    let e0;
    let e1;
    switch (cem) {
      case 0:
        e0 = [v[0], v[0], v[0], 255];
        e1 = [v[1], v[1], v[1], 255];
        break;
      case 1: {
        const l0 = (v[0] >> 2) | (v[1] & 0xc0);
        const l1 = Math.min(255, l0 + (v[1] & 0x3f));
        e0 = [l0, l0, l0, 255];
        e1 = [l1, l1, l1, 255];
        break;
      }
      case 4:
        e0 = [v[0], v[0], v[0], v[2]];
        e1 = [v[1], v[1], v[1], v[3]];
        break;
      case 5: {
        const [a1, b0] = bitTransfer(v[1], v[0]);
        const [a3, b2] = bitTransfer(v[3], v[2]);
        e0 = [b0, b0, b0, b2];
        e1 = [b0 + a1, b0 + a1, b0 + a1, b2 + a3].map(clamp);
        break;
      }
      case 6:
        e0 = [(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, 255];
        e1 = [v[0], v[1], v[2], 255];
        break;
      case 8:
        if (v[1] + v[3] + v[5] >= v[0] + v[2] + v[4]) {
          e0 = [v[0], v[2], v[4], 255];
          e1 = [v[1], v[3], v[5], 255];
        } else {
          e0 = blueContract(v[1], v[3], v[5], 255);
          e1 = blueContract(v[0], v[2], v[4], 255);
        }
        break;
      case 9: {
        const [a1, b0] = bitTransfer(v[1], v[0]);
        const [a3, b2] = bitTransfer(v[3], v[2]);
        const [a5, b4] = bitTransfer(v[5], v[4]);
        if (a1 + a3 + a5 >= 0) {
          e0 = [b0, b2, b4, 255];
          e1 = [b0 + a1, b2 + a3, b4 + a5, 255].map(clamp);
        } else {
          e0 = blueContract(b0 + a1, b2 + a3, b4 + a5, 255).map(clamp);
          e1 = blueContract(b0, b2, b4, 255);
        }
        break;
      }
      case 10:
        e0 = [(v[0] * v[3]) >> 8, (v[1] * v[3]) >> 8, (v[2] * v[3]) >> 8, v[4]];
        e1 = [v[0], v[1], v[2], v[5]];
        break;
      case 12:
        if (v[1] + v[3] + v[5] >= v[0] + v[2] + v[4]) {
          e0 = [v[0], v[2], v[4], v[6]];
          e1 = [v[1], v[3], v[5], v[7]];
        } else {
          e0 = blueContract(v[1], v[3], v[5], v[7]);
          e1 = blueContract(v[0], v[2], v[4], v[6]);
        }
        break;
      case 13: {
        const [a1, b0] = bitTransfer(v[1], v[0]);
        const [a3, b2] = bitTransfer(v[3], v[2]);
        const [a5, b4] = bitTransfer(v[5], v[4]);
        const [a7, b6] = bitTransfer(v[7], v[6]);
        if (a1 + a3 + a5 >= 0) {
          e0 = [b0, b2, b4, b6];
          e1 = [b0 + a1, b2 + a3, b4 + a5, b6 + a7].map(clamp);
        } else {
          e0 = blueContract(b0 + a1, b2 + a3, b4 + a5, b6 + a7).map(clamp);
          e1 = blueContract(b0, b2, b4, b6);
        }
        break;
      }
      default:
        return null;
    }
    return [e0, e1];
  };

  const ERROR = [255, 0, 255, 255];

  const decodeBlock = (src, at, bw, bh, srgb, out) => {
    for (let i = 0; i < 4; i++) words[i] = (src[at + i * 4] | (src[at + i * 4 + 1] << 8) | (src[at + i * 4 + 2] << 16) | (src[at + i * 4 + 3] << 24)) >>> 0;
    const bitsAt = (start, n) => take(words, start, n);
    const texels = bw * bh;
    const fillError = () => {
      for (let i = 0; i < texels; i++) out.set(ERROR, i * 4);
    };
    const mode = bitsAt(0, 11);
    if ((mode & 0x1ff) === 0x1fc) {
      if (mode & 0x200) return fillError();
      for (let i = 0; i < texels; i++) for (let c = 0; c < 4; c++) out[i * 4 + c] = src[at + 9 + c * 2];
      return;
    }
    const bm = blockMode(mode);
    if (!bm) return fillError();
    const partitions = bitsAt(11, 2) + 1;
    if (partitions === 4 && bm.dual) return fillError();
    let colorStart;
    const cems = [];
    let extraBits = 0;
    if (partitions === 1) {
      cems.push(bitsAt(13, 4));
      colorStart = 17;
    } else {
      colorStart = 29;
      const field = bitsAt(23, 6);
      if ((field & 3) === 0) for (let p = 0; p < partitions; p++) cems.push(field >> 2);
      else {
        extraBits = 3 * partitions - 4;
        const extra = bitsAt(128 - bm.bits - extraBits, extraBits);
        const all = (field >> 2) | (extra << 4);
        const base = (field & 3) - 1;
        for (let p = 0; p < partitions; p++) {
          const c = (all >> p) & 1;
          const m = (all >> (partitions + 2 * p)) & 3;
          cems.push(((base + c) << 2) | m);
        }
      }
    }
    const ccsStart = 128 - bm.bits - extraBits - 2;
    const ccs = bm.dual ? bitsAt(ccsStart, 2) : -1;
    const colorEnd = 128 - bm.bits - extraBits - (bm.dual ? 2 : 0);
    let valueCount = 0;
    for (const c of cems) valueCount += ((c >> 2) + 1) * 2;
    if (valueCount > 18) return fillError();
    const level = colorLevel(valueCount, colorEnd - colorStart);
    if (level < 4) return fillError();
    let pos = colorStart;
    readIse((n) => {
      const v = bitsAt(pos, n);
      pos += n;
      return v;
    }, valueCount, level, COLOR_UNQ[level].table, colorValues);
    for (let i = 0; i < 4; i++) reversed[i] = reverse32(words[3 - i]);
    let wpos = 0;
    readIse((n) => {
      const v = take(reversed, wpos, n);
      wpos += n;
      return v;
    }, bm.count, bm.level, WEIGHT_UNQ[bm.level], weightValues);
    const ends = [];
    let vi = 0;
    for (const cem of cems) {
      const n = ((cem >> 2) + 1) * 2;
      const e = endpoints(cem, colorValues.subarray(vi, vi + n));
      vi += n;
      if (!e) return fillError();
      ends.push(e);
    }
    const planes = bm.dual ? 2 : 1;
    const grid = gridTable(bw, bh, bm.x, bm.y);
    const part = partitions > 1 ? partitionTable(bitsAt(13, 10), partitions, bw, bh) : null;
    const lo = new Int32Array(partitions * 4);
    const hi = new Int32Array(partitions * 4);
    for (let p = 0; p < partitions; p++) {
      for (let c = 0; c < 4; c++) {
        lo[p * 4 + c] = srgb ? (ends[p][0][c] << 8) | 0x80 : (ends[p][0][c] << 8) | ends[p][0][c];
        hi[p * 4 + c] = srgb ? (ends[p][1][c] << 8) | 0x80 : (ends[p][1][c] << 8) | ends[p][1][c];
      }
    }
    const weight = (i, plane) => {
      const k = i * 4;
      return (
        (weightValues[grid.idx[k] * planes + plane] * grid.wt[k] +
          weightValues[grid.idx[k + 1] * planes + plane] * grid.wt[k + 1] +
          weightValues[grid.idx[k + 2] * planes + plane] * grid.wt[k + 2] +
          weightValues[grid.idx[k + 3] * planes + plane] * grid.wt[k + 3] +
          8) >>
        4
      );
    };
    for (let i = 0; i < texels; i++) {
      const e = part ? part[i] * 4 : 0;
      const w0 = weight(i, 0);
      const w1 = bm.dual ? weight(i, 1) : w0;
      const o = i * 4;
      for (let c = 0; c < 4; c++) {
        const w = c === ccs ? w1 : w0;
        out[o + c] = ((lo[e + c] * (64 - w) + hi[e + c] * w + 32) >> 6) >> 8;
      }
    }
  };

  const grids = new Map();
  const gridTable = (bw, bh, N, Mh) => {
    const key = bw | (bh << 4) | (N << 8) | (Mh << 12);
    let table = grids.get(key);
    if (table) return table;
    const texels = bw * bh;
    table = { idx: new Int32Array(texels * 4), wt: new Int32Array(texels * 4) };
    const Ds = Math.floor((1024 + (bw >> 1)) / (bw - 1));
    const Dt = Math.floor((1024 + (bh >> 1)) / (bh - 1));
    for (let t = 0; t < bh; t++) {
      for (let s = 0; s < bw; s++) {
        const gs = (Ds * s * (N - 1) + 32) >> 6;
        const gt = (Dt * t * (Mh - 1) + 32) >> 6;
        const js = gs >> 4;
        const fs = gs & 15;
        const jt = gt >> 4;
        const ft = gt & 15;
        const w11 = (fs * ft + 8) >> 4;
        const taps = [
          [js, jt, 16 - fs - ft + w11],
          [js + 1, jt, fs - w11],
          [js, jt + 1, ft - w11],
          [js + 1, jt + 1, w11]
        ];
        const k = (t * bw + s) * 4;
        taps.forEach(([x, y, w], n) => {
          const inside = x < N && y < Mh;
          table.idx[k + n] = inside ? y * N + x : 0;
          table.wt[k + n] = inside ? w : 0;
        });
      }
    }
    grids.set(key, table);
    return table;
  };

  const partitionMaps = new Map();
  const partitionTable = (seed, partitions, bw, bh) => {
    const key = seed | (partitions << 10) | (bw << 13) | (bh << 17);
    let table = partitionMaps.get(key);
    if (table) return table;
    const small = bw * bh < 31;
    table = new Uint8Array(bw * bh);
    for (let t = 0; t < bh; t++) for (let s = 0; s < bw; s++) table[t * bw + s] = selectPartition(seed, s, t, 0, partitions, small);
    partitionMaps.set(key, table);
    return table;
  };

  const decode = (data, width, height, bw, bh, srgb) => {
    const across = Math.ceil(width / bw);
    const down = Math.ceil(height / bh);
    if (data.length < across * down * 16) throw Object.assign(new Error("ASTC data is smaller than expected"), { reason: "ASTC data is smaller than expected" });
    const out = new Uint8ClampedArray(width * height * 4);
    const block = new Uint8ClampedArray(bw * bh * 4);
    for (let by = 0; by < down; by++) {
      for (let bx = 0; bx < across; bx++) {
        decodeBlock(data, (by * across + bx) * 16, bw, bh, srgb, block);
        const cols = Math.min(bw, width - bx * bw);
        for (let y = 0; y < bh; y++) {
          const py = by * bh + y;
          if (py >= height) break;
          out.set(block.subarray(y * bw * 4, (y * bw + cols) * 4), (py * width + bx * bw) * 4);
        }
      }
    }
    return out;
  };

  return { RANGES, TRITS, QUINTS, TRIT_PARTS, QUINT_PARTS, COLOR_UNQ, WEIGHT_UNQ, iseBits, colorLevel, readBlockMode, gridTable, partitionTable, decodeBlock, decode };
})();

const decodeAstc = ASTC_CORE.decode;

export { ASTC_CORE, decodeAstc };
