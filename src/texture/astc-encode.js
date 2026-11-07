// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// ASTC LDR encoder. effort: 1 fast, 2 balanced, 3 best.

import { ASTC_CORE } from "./astc-decode.js";

const encodeAstc = (() => {
  const C = ASTC_CORE;

  const nearest = (values, size) => {
    const out = new Uint8Array(size);
    for (let v = 0; v < size; v++) {
      let best = 0;
      let err = Infinity;
      for (let code = 0; code < values.length; code++) {
        const e = Math.abs(values[code] - v);
        if (e < err) {
          err = e;
          best = code;
        }
      }
      out[v] = best;
    }
    return out;
  };

  const colorNearest = C.COLOR_UNQ.map(({ table }) => nearest(table, 256));
  const weightNearest = C.WEIGHT_UNQ.map((table) => nearest(table, 65));

  const TRIT_READ = [3, 12, 16, 96, 128];
  const QUINT_READ = [7, 24, 96];
  const packCache = new Map();
  const packDigits = (digits, n, trits) => {
    const key = `${trits ? "t" : "q"}${n}:${digits.slice(0, n).join("")}`;
    let packed = packCache.get(key);
    if (packed !== undefined) return packed;
    const table = trits ? C.TRITS : C.QUINTS;
    const read = trits ? TRIT_READ : QUINT_READ;
    let unread = 0;
    for (let k = n; k < read.length; k++) unread |= read[k];
    packed = -1;
    for (let T = 0; T < table.length && packed < 0; T++) {
      if (T & unread) continue;
      let ok = true;
      for (let k = 0; k < n; k++) if (table[T][k] !== digits[k]) ok = false;
      if (ok) packed = T;
    }
    packCache.set(key, packed);
    return packed;
  };

  const writeIse = (put, values, count, level) => {
    const [bits, trits, quints] = C.RANGES[level];
    const mask = (1 << bits) - 1;
    if (!trits && !quints) {
      for (let i = 0; i < count; i++) put(values[i], bits);
      return;
    }
    const group = trits ? 5 : 3;
    const parts = trits ? C.TRIT_PARTS : C.QUINT_PARTS;
    const digits = new Array(group).fill(0);
    for (let i = 0; i < count; i += group) {
      const n = Math.min(group, count - i);
      for (let k = 0; k < group; k++) digits[k] = k < n ? values[i + k] >> bits : 0;
      const T = packDigits(digits, n, trits);
      for (let k = 0; k < n; k++) {
        put(values[i + k] & mask, bits);
        put((T >> parts[k * 2]) & ((1 << parts[k * 2 + 1]) - 1), parts[k * 2 + 1]);
      }
    }
  };

  const modeCache = new Map();
  const candidates = (bw, bh, values, partitions) => {
    const key = `${bw}x${bh}:${values}:${partitions}`;
    let list = modeCache.get(key);
    if (list) return list;
    const seen = new Set();
    const colorStart = partitions === 1 ? 17 : 29;
    list = [];
    for (let mode = 0; mode < 2048; mode++) {
      if ((mode & 0x1ff) === 0x1fc) continue;
      const bm = C.readBlockMode(mode);
      if (!bm || bm.dual || bm.x > bw || bm.y > bh) continue;
      const id = `${bm.x},${bm.y},${bm.level}`;
      if (seen.has(id)) continue;
      const colorLevel = C.colorLevel(values * partitions, 128 - colorStart - bm.bits);
      if (colorLevel < 5) continue;
      seen.add(id);
      const grid = C.gridTable(bw, bh, bm.x, bm.y);
      const sum = new Float64Array(bm.count);
      for (let i = 0; i < bw * bh * 4; i++) sum[grid.idx[i]] += grid.wt[i];
      list.push({ mode, ...bm, colorLevel, grid, sum, partitions });
    }
    const byGrid = new Map();
    for (const cand of list) {
      const id = cand.x * 16 + cand.y;
      if (!byGrid.has(id)) byGrid.set(id, []);
      byGrid.get(id).push(cand);
    }
    list = [];
    for (const group of byGrid.values()) list.push(...group.sort((x, y) => y.level - x.level).slice(0, 2));
    modeCache.set(key, list);
    return list;
  };

  const CEM_VALUES = { 0: 2, 4: 4, 8: 6, 12: 8 };
  const CEM_CHANNELS = { 0: [0], 4: [0, 3], 8: [0, 1, 2], 12: [0, 1, 2, 3] };

  const principal = (px, n, ch, part, p) => {
    const d = ch.length;
    const mean = new Float64Array(d);
    let count = 0;
    for (let i = 0; i < n; i++) {
      if (part && part[i] !== p) continue;
      count++;
      for (let k = 0; k < d; k++) mean[k] += px[i * 4 + ch[k]];
    }
    if (!count) return [new Float64Array(4), new Float64Array(4)];
    for (let k = 0; k < d; k++) mean[k] /= count;
    const cov = new Float64Array(d * d);
    for (let i = 0; i < n; i++) {
      if (part && part[i] !== p) continue;
      for (let a = 0; a < d; a++) {
        const va = px[i * 4 + ch[a]] - mean[a];
        for (let b = 0; b < d; b++) cov[a * d + b] += va * (px[i * 4 + ch[b]] - mean[b]);
      }
    }
    const axis = new Float64Array(d).fill(1 / Math.sqrt(d));
    const next = new Float64Array(d);
    for (let it = 0; it < 12; it++) {
      next.fill(0);
      for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) next[a] += cov[a * d + b] * axis[b];
      let len = 0;
      for (let a = 0; a < d; a++) len += next[a] * next[a];
      len = Math.sqrt(len);
      if (len < 1e-9) break;
      for (let a = 0; a < d; a++) axis[a] = next[a] / len;
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < n; i++) {
      if (part && part[i] !== p) continue;
      let t = 0;
      for (let k = 0; k < d; k++) t += (px[i * 4 + ch[k]] - mean[k]) * axis[k];
      if (t < lo) lo = t;
      if (t > hi) hi = t;
    }
    const e0 = new Float64Array(4);
    const e1 = new Float64Array(4);
    for (let k = 0; k < d; k++) {
      e0[ch[k]] = Math.min(255, Math.max(0, mean[k] + axis[k] * lo));
      e1[ch[k]] = Math.min(255, Math.max(0, mean[k] + axis[k] * hi));
    }
    return [e0, e1];
  };

  const quantizeEnds = (cem, e0, e1, level) => {
    const near = colorNearest[level];
    const unq = C.COLOR_UNQ[level].table;
    const ch = CEM_CHANNELS[cem];
    const q0 = new Int32Array(4);
    const q1 = new Int32Array(4);
    for (const c of ch) {
      q0[c] = near[Math.round(e0[c])];
      q1[c] = near[Math.round(e1[c])];
    }
    let flip = false;
    if (cem === 8 || cem === 12) {
      let s0 = 0;
      let s1 = 0;
      for (let c = 0; c < 3; c++) {
        s0 += unq[q0[c]];
        s1 += unq[q1[c]];
      }
      if (s1 < s0) flip = true;
    }
    const a = flip ? q1 : q0;
    const b = flip ? q0 : q1;
    const lo = new Int32Array(4);
    const hi = new Int32Array(4);
    for (let c = 0; c < 4; c++) {
      const src = cem === 0 || cem === 4 ? (c < 3 ? 0 : 3) : c;
      const fixed = c === 3 && (cem === 0 || cem === 8);
      lo[c] = fixed ? 255 : unq[a[src]];
      hi[c] = fixed ? 255 : unq[b[src]];
    }
    const codes = [];
    if (cem === 0) codes.push(a[0], b[0]);
    else if (cem === 4) codes.push(a[0], b[0], a[3], b[3]);
    else if (cem === 8) codes.push(a[0], b[0], a[1], b[1], a[2], b[2]);
    else codes.push(a[0], b[0], a[1], b[1], a[2], b[2], a[3], b[3]);
    return { lo, hi, codes };
  };

  const expand = (v, srgb) => (srgb ? (v << 8) | 0x80 : (v << 8) | v);

  const gw = new Float64Array(64);
  const gq = new Int32Array(64);
  const scratchCodes = new Uint8Array(64);
  const LO = new Int32Array(16);
  const HI = new Int32Array(16);
  const DIR = new Float64Array(16);
  const LEN = new Float64Array(4);

  const RANKS = C.WEIGHT_UNQ.map((table) => {
    const order = [...table.keys()].sort((x, y) => table[x] - table[y]);
    const rank = new Int32Array(table.length);
    order.forEach((code, i) => (rank[code] = i));
    return { order, rank };
  });

  const loadEnds = (ends, srgb) => {
    for (let p = 0; p < ends.length; p++) {
      for (let c = 0; c < 4; c++) {
        LO[p * 4 + c] = expand(ends[p].lo[c], srgb);
        HI[p * 4 + c] = expand(ends[p].hi[c], srgb);
      }
    }
  };

  const codeError = (px, n, cand, part, codes, out, limit = Infinity) => {
    const { grid, count, level } = cand;
    const unq = C.WEIGHT_UNQ[level];
    for (let j = 0; j < count; j++) gq[j] = unq[codes[j]];
    let err = 0;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      const w = (gq[grid.idx[k]] * grid.wt[k] + gq[grid.idx[k + 1]] * grid.wt[k + 1] + gq[grid.idx[k + 2]] * grid.wt[k + 2] + gq[grid.idx[k + 3]] * grid.wt[k + 3] + 8) >> 4;
      if (out) out[i] = w;
      const e = (part ? part[i] : 0) * 4;
      for (let c = 0; c < 4; c++) {
        const v = ((LO[e + c] * (64 - w) + HI[e + c] * w + 32) >> 6) >> 8;
        const diff = v - px[k + c];
        err += diff * diff;
      }
      if (err > limit) return err;
    }
    return err;
  };

  const project = (px, n, cem, cand, ends, part, ideal) => {
    const ch = CEM_CHANNELS[cem];
    const d = ch.length;
    for (let p = 0; p < ends.length; p++) {
      LEN[p] = 0;
      for (let c = 0; c < 4; c++) DIR[p * 4 + c] = ends[p].hi[c] - ends[p].lo[c];
      for (let k = 0; k < d; k++) LEN[p] += DIR[p * 4 + ch[k]] * DIR[p * 4 + ch[k]];
    }
    for (let i = 0; i < n; i++) {
      const p = part ? part[i] : 0;
      const lo = ends[p].lo;
      let t = 0;
      if (LEN[p] > 0) {
        for (let k = 0; k < d; k++) t += (px[i * 4 + ch[k]] - lo[ch[k]]) * DIR[p * 4 + ch[k]];
        t /= LEN[p];
      }
      ideal[i] = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const { grid, sum, count, level } = cand;
    gw.fill(0, 0, count);
    for (let i = 0; i < n * 4; i++) gw[grid.idx[i]] += grid.wt[i] * ideal[i >> 2];
    const near = weightNearest[level];
    for (let j = 0; j < count; j++) scratchCodes[j] = near[Math.round((sum[j] ? gw[j] / sum[j] : 0) * 64)];
  };

  const evaluate = (px, n, cem, cand, ends, part, srgb, ideal, out, limit) => {
    project(px, n, cem, cand, ends, part, ideal);
    loadEnds(ends, srgb);
    return codeError(px, n, cand, part, scratchCodes, out, limit);
  };

  const realign = (px, n, cand, part, codes, err) => {
    const { order, rank } = RANKS[cand.level];
    let improved = true;
    for (let pass = 0; pass < 2 && improved; pass++) {
      improved = false;
      for (let j = 0; j < cand.count; j++) {
        const r = rank[codes[j]];
        const keep = codes[j];
        for (const step of [-1, 1]) {
          if (r + step < 0 || r + step >= order.length) continue;
          codes[j] = order[r + step];
          const e = codeError(px, n, cand, part, codes, null);
          if (e < err) {
            err = e;
            improved = true;
            break;
          }
          codes[j] = keep;
        }
      }
    }
    return err;
  };

  const refit = (px, n, cem, weights, part, p) => {
    const ch = CEM_CHANNELS[cem];
    let s00 = 0;
    let s01 = 0;
    let s11 = 0;
    for (let i = 0; i < n; i++) {
      if (part && part[i] !== p) continue;
      const w = weights[i] / 64;
      s00 += (1 - w) * (1 - w);
      s01 += (1 - w) * w;
      s11 += w * w;
    }
    const det = s00 * s11 - s01 * s01;
    if (Math.abs(det) < 1e-9) return null;
    const e0 = new Float64Array(4);
    const e1 = new Float64Array(4);
    for (const c of ch) {
      let a = 0;
      let b = 0;
      for (let i = 0; i < n; i++) {
        if (part && part[i] !== p) continue;
        const w = weights[i] / 64;
        a += (1 - w) * px[i * 4 + c];
        b += w * px[i * 4 + c];
      }
      e0[c] = Math.min(255, Math.max(0, (a * s11 - b * s01) / det));
      e1[c] = Math.min(255, Math.max(0, (b * s00 - a * s01) / det));
    }
    return [e0, e1];
  };

  const constantBlock = (out, at, r, g, b, a) => {
    out.fill(0, at, at + 16);
    out[at] = 0xfc;
    out[at + 1] = 0xfd;
    for (let i = 2; i < 8; i++) out[at + i] = 0xff;
    [r, g, b, a].forEach((v, c) => {
      out[at + 8 + c * 2] = v;
      out[at + 9 + c * 2] = v;
    });
  };

  const packBlock = (out, at, best, cem) => {
    const { cand, ends, codes, seed } = best;
    const words = new Uint32Array(4);
    let pos = 0;
    const put = (v, n) => {
      for (let i = 0; i < n; i++, pos++) if ((v >> i) & 1) words[pos >> 5] |= 1 << (pos & 31);
    };
    put(cand.mode, 11);
    put(cand.partitions - 1, 2);
    if (cand.partitions === 1) put(cem, 4);
    else {
      put(seed, 10);
      put(cem << 2, 6);
    }
    const colors = [];
    for (const e of ends) colors.push(...e.codes);
    writeIse(put, colors, colors.length, cand.colorLevel);
    const weightWords = new Uint32Array(4);
    pos = 0;
    const putW = (v, n) => {
      for (let i = 0; i < n; i++, pos++) if ((v >> i) & 1) weightWords[pos >> 5] |= 1 << (pos & 31);
    };
    writeIse(putW, codes, cand.count, cand.level);
    for (let i = 0; i < cand.bits; i++) {
      if ((weightWords[i >> 5] >> (i & 31)) & 1) {
        const p = 127 - i;
        words[p >> 5] |= 1 << (p & 31);
      }
    }
    for (let i = 0; i < 4; i++) {
      out[at + i * 4] = words[i] & 255;
      out[at + i * 4 + 1] = (words[i] >> 8) & 255;
      out[at + i * 4 + 2] = (words[i] >> 16) & 255;
      out[at + i * 4 + 3] = words[i] >>> 24;
    }
  };

  const seedCache = new Map();
  const seedMaps = (bw, bh) => {
    const key = bw * 16 + bh;
    let maps = seedCache.get(key);
    if (maps) return maps;
    maps = [];
    for (let seed = 0; seed < 1024; seed++) {
      const map = C.partitionTable(seed, 2, bw, bh);
      let ones = 0;
      for (const v of map) ones += v;
      if (ones && ones < map.length) maps.push({ seed, map });
    }
    seedCache.set(key, maps);
    return maps;
  };

  const cluster = (px, n, ch) => {
    const [e0, e1] = principal(px, n, ch, null, 0);
    const labels = new Uint8Array(n);
    const c0 = Float64Array.from(e0);
    const c1 = Float64Array.from(e1);
    for (let it = 0; it < 6; it++) {
      const s0 = new Float64Array(4);
      const s1 = new Float64Array(4);
      let n0 = 0;
      let n1 = 0;
      for (let i = 0; i < n; i++) {
        let d0 = 0;
        let d1 = 0;
        for (const c of ch) {
          const v = px[i * 4 + c];
          d0 += (v - c0[c]) ** 2;
          d1 += (v - c1[c]) ** 2;
        }
        labels[i] = d1 < d0 ? 1 : 0;
        for (const c of ch) (labels[i] ? s1 : s0)[c] += px[i * 4 + c];
        if (labels[i]) n1++;
        else n0++;
      }
      for (const c of ch) {
        if (n0) c0[c] = s0[c] / n0;
        if (n1) c1[c] = s1[c] / n1;
      }
    }
    return labels;
  };

  const search = (px, n, bw, bh, cem, part, seed, srgb, ideal, weights, effort, best) => {
    const partitions = part ? 2 : 1;
    const ch = CEM_CHANNELS[cem];
    const raw = [];
    for (let p = 0; p < partitions; p++) raw.push(principal(px, n, ch, part, p));
    const top = [];
    for (const cand of candidates(bw, bh, CEM_VALUES[cem], partitions)) {
      const ends = raw.map(([e0, e1]) => quantizeEnds(cem, e0, e1, cand.colorLevel));
      const limit = top.length < effort ? Math.min(Infinity, best.err * 1.5) : top[top.length - 1].err;
      const err = evaluate(px, n, cem, cand, ends, part, srgb, ideal, null, limit);
      if (err < limit && (top.length < effort || err < top[top.length - 1].err)) {
        top.push({ err, cand, ends, codes: scratchCodes.slice(0, cand.count) });
        top.sort((x, y) => x.err - y.err);
        if (top.length > effort) top.pop();
      }
    }
    for (let { err, cand, ends, codes } of top) {
      loadEnds(ends, srgb);
      err = realign(px, n, cand, part, codes, err);
      for (let it = 0; it < effort; it++) {
        loadEnds(ends, srgb);
        codeError(px, n, cand, part, codes, weights);
        const next = [];
        for (let p = 0; p < partitions; p++) {
          const fit = refit(px, n, cem, weights, part, p);
          next.push(fit ? quantizeEnds(cem, fit[0], fit[1], cand.colorLevel) : ends[p]);
        }
        let e = evaluate(px, n, cem, cand, next, part, srgb, ideal, null);
        const nextCodes = scratchCodes.slice(0, cand.count);
        e = realign(px, n, cand, part, nextCodes, e);
        if (e >= err) break;
        err = e;
        ends = next;
        codes = nextCodes;
      }
      if (err < best.err) Object.assign(best, { err, cand, ends, part, seed, codes });
    }
  };

  const encodeBlock = (px, bw, bh, srgb, out, at, effort) => {
    const n = bw * bh;
    let same = true;
    let gray = true;
    let opaque = true;
    for (let i = 0; i < n; i++) {
      const k = i * 4;
      if (px[k] !== px[0] || px[k + 1] !== px[1] || px[k + 2] !== px[2] || px[k + 3] !== px[3]) same = false;
      if (px[k] !== px[k + 1] || px[k] !== px[k + 2]) gray = false;
      if (px[k + 3] !== 255) opaque = false;
    }
    if (same) return constantBlock(out, at, px[0], px[1], px[2], px[3]);
    const cem = gray ? (opaque ? 0 : 4) : opaque ? 8 : 12;
    const ideal = new Float64Array(n);
    const weights = new Int32Array(n);
    const best = { err: Infinity, cand: null };
    search(px, n, bw, bh, cem, null, 0, srgb, ideal, weights, effort, best);
    if (effort > 1 && best.err > n * 4) {
      const labels = cluster(px, n, CEM_CHANNELS[cem]);
      const ranked = seedMaps(bw, bh)
        .map(({ seed, map }) => {
          let same = 0;
          for (let i = 0; i < n; i++) if (map[i] === labels[i]) same++;
          return { seed, map, score: Math.max(same, n - same) };
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, effort);
      for (const { seed, map } of ranked) search(px, n, bw, bh, cem, map, seed, srgb, ideal, weights, effort, best);
    }
    packBlock(out, at, best, cem);
  };

  return (pixels, width, height, bw, bh, srgb, effort = 3) => {
    const across = Math.ceil(width / bw);
    const down = Math.ceil(height / bh);
    const out = new Uint8Array(across * down * 16);
    const px = new Uint8Array(bw * bh * 4);
    for (let by = 0; by < down; by++) {
      for (let bx = 0; bx < across; bx++) {
        for (let y = 0; y < bh; y++) {
          const sy = Math.min(height - 1, by * bh + y);
          for (let x = 0; x < bw; x++) {
            const sx = Math.min(width - 1, bx * bw + x);
            const s = (sy * width + sx) * 4;
            const d = (y * bw + x) * 4;
            px[d] = pixels[s];
            px[d + 1] = pixels[s + 1];
            px[d + 2] = pixels[s + 2];
            px[d + 3] = pixels[s + 3];
          }
        }
        encodeBlock(px, bw, bh, srgb, out, (by * across + bx) * 16, effort);
      }
    }
    return out;
  };
})();

export { encodeAstc };
