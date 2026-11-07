// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// BC1, BC3, BC4, BC5 and BC7 block encoder.

const encodeBc = (() => {
  const W4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64];

  const extents = (px, ch) => {
    const d = ch.length;
    const mean = new Float64Array(d);
    for (let i = 0; i < 16; i++) for (let k = 0; k < d; k++) mean[k] += px[i * 4 + ch[k]] / 16;
    const cov = new Float64Array(d * d);
    for (let i = 0; i < 16; i++) {
      for (let a = 0; a < d; a++) {
        const va = px[i * 4 + ch[a]] - mean[a];
        for (let b = 0; b < d; b++) cov[a * d + b] += va * (px[i * 4 + ch[b]] - mean[b]);
      }
    }
    const axis = new Float64Array(d).fill(1 / Math.sqrt(d));
    const next = new Float64Array(d);
    for (let it = 0; it < 10; it++) {
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
    for (let i = 0; i < 16; i++) {
      let t = 0;
      for (let k = 0; k < d; k++) t += (px[i * 4 + ch[k]] - mean[k]) * axis[k];
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
    const e0 = new Float64Array(4);
    const e1 = new Float64Array(4);
    for (let k = 0; k < d; k++) {
      e0[ch[k]] = Math.min(255, Math.max(0, mean[k] + axis[k] * lo));
      e1[ch[k]] = Math.min(255, Math.max(0, mean[k] + axis[k] * hi));
    }
    return [e0, e1];
  };

  const refit = (px, ch, weights) => {
    let s00 = 0;
    let s01 = 0;
    let s11 = 0;
    for (let i = 0; i < 16; i++) {
      const w = weights[i];
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
      for (let i = 0; i < 16; i++) {
        a += (1 - weights[i]) * px[i * 4 + c];
        b += weights[i] * px[i * 4 + c];
      }
      e0[c] = Math.min(255, Math.max(0, (a * s11 - b * s01) / det));
      e1[c] = Math.min(255, Math.max(0, (b * s00 - a * s01) / det));
    }
    return [e0, e1];
  };

  const pick = (px, ch, palette, count, indices) => {
    let err = 0;
    for (let i = 0; i < 16; i++) {
      let best = 0;
      let bestErr = Infinity;
      for (let p = 0; p < count; p++) {
        let e = 0;
        for (const c of ch) {
          const d = palette[p * 4 + c] - px[i * 4 + c];
          e += d * d;
        }
        if (e < bestErr) {
          bestErr = e;
          best = p;
        }
      }
      indices[i] = best;
      err += bestErr;
    }
    return err;
  };

  const to565 = (e) => (Math.round((e[0] * 31) / 255) << 11) | (Math.round((e[1] * 63) / 255) << 5) | Math.round((e[2] * 31) / 255);
  const from565 = (v, out, at) => {
    const r = (v >> 11) & 31;
    const g = (v >> 5) & 63;
    const b = v & 31;
    out[at] = (r << 3) | (r >> 2);
    out[at + 1] = (g << 2) | (g >> 4);
    out[at + 2] = (b << 3) | (b >> 2);
    out[at + 3] = 255;
  };

  const RGB = [0, 1, 2];
  const BC1_WEIGHT = [0, 1, 1 / 3, 2 / 3];

  const bc1Palette = (c0, c1, palette) => {
    from565(c0, palette, 0);
    from565(c1, palette, 4);
    for (let c = 0; c < 3; c++) {
      palette[8 + c] = ((2 * palette[c] + palette[4 + c]) / 3) | 0;
      palette[12 + c] = ((palette[c] + 2 * palette[4 + c]) / 3) | 0;
    }
    palette[11] = palette[15] = 255;
  };

  const colorBlock = (px, out, at) => {
    const palette = new Int32Array(16);
    const indices = new Uint8Array(16);
    let best = null;
    let [e0, e1] = extents(px, RGB);
    for (let it = 0; it < 3; it++) {
      let c0 = to565(e1);
      let c1 = to565(e0);
      if (c0 < c1) [c0, c1] = [c1, c0];
      bc1Palette(c0, c1, palette);
      const err = pick(px, RGB, palette, c0 === c1 ? 1 : 4, indices);
      if (!best || err < best.err) best = { err, c0, c1, indices: indices.slice() };
      const fit = refit(px, RGB, Array.from(best.indices, (k) => BC1_WEIGHT[k]).map((w, i) => (best.c0 === best.c1 ? 0 : w)));
      if (!fit) break;
      [e1, e0] = fit;
    }
    out[at] = best.c0 & 255;
    out[at + 1] = best.c0 >> 8;
    out[at + 2] = best.c1 & 255;
    out[at + 3] = best.c1 >> 8;
    let bits = 0;
    for (let i = 0; i < 16; i++) bits |= best.indices[i] << (i * 2);
    out[at + 4] = bits & 255;
    out[at + 5] = (bits >> 8) & 255;
    out[at + 6] = (bits >> 16) & 255;
    out[at + 7] = bits >>> 24;
  };

  const smoothPalette = (a0, a1, signed) => {
    const values = [a0, a1];
    if (a0 > a1) for (let i = 1; i < 7; i++) values.push(signed ? ((7 - i) * a0 + i * a1) / 7 : (((7 - i) * a0 + i * a1) / 7) | 0);
    else {
      for (let i = 1; i < 5; i++) values.push(signed ? ((5 - i) * a0 + i * a1) / 5 : (((5 - i) * a0 + i * a1) / 5) | 0);
      values.push(signed ? -127 : 0, signed ? 127 : 255);
    }
    return values;
  };

  const smoothBlock = (values, signed, out, at) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of values) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    const tries = [[hi, lo]];
    if (hi > lo) {
      tries.push([lo, hi]);
      const inner = values.filter((v) => v !== (signed ? -127 : 0) && v !== (signed ? 127 : 255));
      if (inner.length && inner.length < values.length) tries.push([Math.min(...inner), Math.max(...inner)]);
      for (let d = 1; d <= 2; d++) tries.push([hi - d, lo + d]);
    }
    let best = null;
    for (const [a0, a1] of tries) {
      if (a0 < (signed ? -127 : 0) || a1 > (signed ? 127 : 255) || a0 < a1 - 255) continue;
      const palette = smoothPalette(a0, a1, signed);
      const idx = new Uint8Array(16);
      let err = 0;
      values.forEach((v, i) => {
        let k = 0;
        let e = Infinity;
        palette.forEach((p, j) => {
          const d = Math.abs(p - v);
          if (d < e) {
            e = d;
            k = j;
          }
        });
        idx[i] = k;
        err += e * e;
      });
      if (!best || err < best.err) best = { err, a0, a1, idx };
    }
    out[at] = best.a0 & 255;
    out[at + 1] = best.a1 & 255;
    let low = 0;
    let high = 0;
    for (let i = 0; i < 8; i++) low |= best.idx[i] << (i * 3);
    for (let i = 0; i < 8; i++) high |= best.idx[i + 8] << (i * 3);
    out[at + 2] = low & 255;
    out[at + 3] = (low >> 8) & 255;
    out[at + 4] = (low >> 16) & 255;
    out[at + 5] = high & 255;
    out[at + 6] = (high >> 8) & 255;
    out[at + 7] = (high >> 16) & 255;
  };

  const channel = (px, c, signed) => Array.from({ length: 16 }, (_, i) => (signed ? Math.round((px[i * 4 + c] * 254) / 255 - 127) : px[i * 4 + c]));

  const RGBA = [0, 1, 2, 3];

  const bc7Block = (px, out, at) => {
    let opaque = true;
    for (let i = 0; i < 16; i++) if (px[i * 4 + 3] !== 255) opaque = false;
    const ch = opaque ? RGB : RGBA;
    let [e0, e1] = extents(px, ch);
    if (opaque) e0[3] = e1[3] = 255;
    const palette = new Int32Array(64);
    const indices = new Uint8Array(16);
    let best = null;
    for (let it = 0; it < 3; it++) {
      for (let p0 = 0; p0 < 2; p0++) {
        for (let p1 = 0; p1 < 2; p1++) {
          const q0 = Array.from({ length: 4 }, (_, c) => Math.min(127, Math.max(0, Math.round((e0[c] - p0) / 2))));
          const q1 = Array.from({ length: 4 }, (_, c) => Math.min(127, Math.max(0, Math.round((e1[c] - p1) / 2))));
          for (let k = 0; k < 16; k++) {
            for (let c = 0; c < 4; c++) {
              const a = (q0[c] << 1) | p0;
              const b = (q1[c] << 1) | p1;
              palette[k * 4 + c] = (a * (64 - W4[k]) + b * W4[k] + 32) >> 6;
            }
          }
          const err = pick(px, RGBA, palette, 16, indices);
          if (!best || err < best.err) best = { err, q0, q1, p0, p1, indices: indices.slice() };
        }
      }
      const fit = refit(px, ch, Array.from(best.indices, (k) => W4[k] / 64));
      if (!fit) break;
      [e0, e1] = fit;
      if (opaque) e0[3] = e1[3] = 255;
    }
    let { q0, q1, p0, p1, indices: idx } = best;
    if (idx[0] >= 8) {
      [q0, q1] = [q1, q0];
      [p0, p1] = [p1, p0];
      idx = idx.map((k) => 15 - k);
    }
    const words = new Uint32Array(4);
    let pos = 0;
    const put = (v, n) => {
      for (let i = 0; i < n; i++, pos++) if ((v >> i) & 1) words[pos >> 5] |= 1 << (pos & 31);
    };
    put(64, 7);
    for (let c = 0; c < 4; c++) {
      put(q0[c], 7);
      put(q1[c], 7);
    }
    put(p0, 1);
    put(p1, 1);
    put(idx[0], 3);
    for (let i = 1; i < 16; i++) put(idx[i], 4);
    for (let i = 0; i < 4; i++) for (let b = 0; b < 4; b++) out[at + i * 4 + b] = (words[i] >>> (b * 8)) & 255;
  };

  const SIZES = { PF_DXT1: 8, PF_DXT5: 16, PF_BC4: 8, PF_BC4S: 8, PF_BC5: 16, PF_BC5S: 16, PF_BC7: 16 };

  return (format, pixels, width, height) => {
    const size = SIZES[format];
    if (!size) throw Object.assign(new Error(format), { reason: `Writing ${format.replace("PF_", "")} is not supported yet` });
    const across = Math.ceil(width / 4);
    const down = Math.ceil(height / 4);
    const out = new Uint8Array(across * down * size);
    const px = new Uint8Array(64);
    const signed = format.endsWith("S");
    for (let by = 0; by < down; by++) {
      for (let bx = 0; bx < across; bx++) {
        for (let y = 0; y < 4; y++) {
          const sy = Math.min(height - 1, by * 4 + y);
          for (let x = 0; x < 4; x++) {
            const s = (sy * width + Math.min(width - 1, bx * 4 + x)) * 4;
            px.set(pixels.subarray(s, s + 4), (y * 4 + x) * 4);
          }
        }
        const at = (by * across + bx) * size;
        if (format === "PF_DXT1") colorBlock(px, out, at);
        else if (format === "PF_DXT5") {
          smoothBlock(channel(px, 3, false), false, out, at);
          colorBlock(px, out, at + 8);
        } else if (format === "PF_BC4" || format === "PF_BC4S") smoothBlock(channel(px, 0, signed), signed, out, at);
        else if (format === "PF_BC5" || format === "PF_BC5S") {
          smoothBlock(channel(px, 0, signed), signed, out, at);
          smoothBlock(channel(px, 1, signed), signed, out, at + 8);
        } else bc7Block(px, out, at);
      }
    }
    return out;
  };
})();

export { encodeBc };
