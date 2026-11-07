// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// DSP-ADPCM encoder, BWAV builder and BARS archive rebuilder.

import { crc32 } from "../util/crc32.js";

const dspStable = (c1, c2) => {
  c2 = Math.min(0.99, Math.max(-0.99, c2));
  const limit = Math.min(1.98, (1 - c2) * 0.99);
  return [Math.min(limit, Math.max(-limit, c1)), c2];
};

const dspCoefs = (samples) => {
  const rows = [];
  for (let f = 0; f * 14 < samples.length; f++) {
    const from = Math.max(2, f * 14);
    const to = Math.min(samples.length, f * 14 + 14);
    let a11 = 0;
    let a12 = 0;
    let a22 = 0;
    let b1 = 0;
    let b2 = 0;
    let energy = 0;
    for (let i = from; i < to; i++) {
      const x1 = samples[i - 1];
      const x2 = samples[i - 2];
      const y = samples[i];
      a11 += x1 * x1;
      a12 += x1 * x2;
      a22 += x2 * x2;
      b1 += x1 * y;
      b2 += x2 * y;
      energy += y * y;
    }
    const det = a11 * a22 - a12 * a12;
    if (!energy || Math.abs(det) < 1e-6) continue;
    rows.push({ c: dspStable((b1 * a22 - b2 * a12) / det, (b2 * a11 - b1 * a12) / det), w: energy + 1 });
  }
  let centers = [[0, 0], [1, 0], [2, -1], [1.8, -0.83], [1.5, -0.6], [0.9, 0], [1.2, -0.3], [0.5, 0]].map(([a, b]) => dspStable(a, b));
  if (rows.length >= 8) {
    centers = [...rows].sort((a, b) => b.w - a.w).slice(0, 8).map((r) => [...r.c]);
    for (let it = 0; it < 30; it++) {
      const acc = centers.map(() => [0, 0, 0]);
      for (const r of rows) {
        let best = 0;
        let bestD = Infinity;
        centers.forEach((c, k) => {
          const d = (c[0] - r.c[0]) ** 2 + (c[1] - r.c[1]) ** 2;
          if (d < bestD) {
            bestD = d;
            best = k;
          }
        });
        acc[best][0] += r.c[0] * r.w;
        acc[best][1] += r.c[1] * r.w;
        acc[best][2] += r.w;
      }
      centers = centers.map((c, k) => (acc[k][2] ? dspStable(acc[k][0] / acc[k][2], acc[k][1] / acc[k][2]) : c));
    }
  }
  return Int16Array.from(centers.flat(), (v) => Math.round(v * 2048));
};

const encodeDsp = (samples, coefs) => {
  const frames = Math.ceil(samples.length / 14);
  const out = new Uint8Array(frames * 8);
  const combos = 96;
  const c1 = new Int32Array(combos);
  const c2 = new Int32Array(combos);
  const scale = new Int32Array(combos);
  for (let k = 0; k < combos; k++) {
    c1[k] = coefs[Math.floor(k / 12) * 2];
    c2[k] = coefs[Math.floor(k / 12) * 2 + 1];
    scale[k] = 1 << (k % 12);
  }
  const h1 = new Int32Array(combos);
  const h2 = new Int32Array(combos);
  const a1 = new Int32Array(combos);
  const a2 = new Int32Array(combos);
  const err = new Float64Array(combos);
  const nibs = new Int8Array(combos * 14);
  let hist1 = 0;
  let hist2 = 0;
  for (let f = 0; f < frames; f++) {
    for (let k = 0; k < combos; k++) {
      a1[k] = hist1;
      a2[k] = hist2;
      err[k] = 0;
    }
    for (let i = 0; i < 14; i++) {
      const target = f * 14 + i < samples.length ? samples[f * 14 + i] : 0;
      for (let k = 0; k < combos; k++) {
        const pred = (c1[k] * a1[k] + c2[k] * a2[k] + 1024) >> 11;
        let nib = Math.round((target - pred) / scale[k]);
        nib = nib < -8 ? -8 : nib > 7 ? 7 : nib;
        let s = pred + nib * scale[k];
        s = s < -32768 ? -32768 : s > 32767 ? 32767 : s;
        err[k] += (target - s) ** 2;
        nibs[k * 14 + i] = nib;
        a2[k] = a1[k];
        a1[k] = s;
      }
    }
    let best = 0;
    for (let k = 1; k < combos; k++) if (err[k] < err[best]) best = k;
    hist1 = a1[best];
    hist2 = a2[best];
    const p = f * 8;
    out[p] = (Math.floor(best / 12) << 4) | best % 12;
    for (let i = 0; i < 7; i++) out[p + 1 + i] = ((nibs[best * 14 + i * 2] & 15) << 4) | (nibs[best * 14 + i * 2 + 1] & 15);
  }
  return out;
};

const bwavDataOffset = (channels) => Math.ceil((0x10 + channels * 0x4c) / 0x40) * 0x40;

const buildBwav = ({ channels, rate, total, keep = null, loopStart = -1, loopEnd = -1, crc = null }) => {
  const count = keep ?? total;
  const dataLength = Math.ceil(count / 14) * 8;
  const stride = Math.ceil(dataLength / 0x40) * 0x40;
  const fullStride = Math.ceil((Math.ceil(total / 14) * 8) / 0x40) * 0x40;
  const start = bwavDataOffset(channels.length);
  const out = new Uint8Array(start + stride * (channels.length - 1) + dataLength);
  const view = new DataView(out.buffer);
  out.set([0x42, 0x57, 0x41, 0x56]);
  view.setUint16(4, 0xfeff, true);
  view.setUint16(6, 1, true);
  view.setUint16(0x0c, keep === null ? 0 : 1, true);
  view.setUint16(0x0e, channels.length, true);
  channels.forEach((ch, i) => {
    const o = 0x10 + i * 0x4c;
    const at = start + i * stride;
    out.set(ch.dsp.subarray(0, dataLength), at);
    view.setUint16(o, 1, true);
    view.setUint16(o + 2, ch.pan, true);
    view.setUint32(o + 4, rate, true);
    view.setUint32(o + 8, total, true);
    view.setUint32(o + 0x0c, count, true);
    ch.coefs.forEach((c, k) => view.setInt16(o + 0x10 + k * 2, c, true));
    view.setUint32(o + 0x30, start + i * fullStride, true);
    view.setUint32(o + 0x34, at, true);
    view.setUint32(o + 0x38, 1, true);
    view.setInt32(o + 0x3c, loopEnd, true);
    view.setUint32(o + 0x40, loopStart < 0 ? 0 : loopStart, true);
    view.setUint16(o + 0x44, ch.dsp[0], true);
  });
  view.setUint32(8, crc ?? crc32(out.subarray(start)), true);
  return out;
};

const bwavPan = (channels) => (channels === 1 ? [2] : channels === 2 ? [0, 1] : channels === 4 ? [0, 1, 4, 5] : Array.from({ length: channels }, (_, i) => i));

const encodeBwavAudio = (planes, rate, { loopStart = -1, loopEnd = -1, pans } = {}) => {
  const total = Math.min(...planes.map((p) => p.length));
  const channels = planes.map((plane, i) => {
    const coefs = dspCoefs(plane);
    return { dsp: encodeDsp(plane, coefs), coefs, pan: (pans || bwavPan(planes.length))[i] };
  });
  const stream = buildBwav({ channels, rate, total, loopStart, loopEnd });
  return { channels, rate, total, loopStart, loopEnd, stream, crc: new DataView(stream.buffer).getUint32(8, true) };
};

const barsAmtaName = (bytes, view, amta) => {
  const start = amta + 0x24 + view.getUint32(amta + 0x24, true);
  let end = start;
  while (end < bytes.length && bytes[end]) end++;
  return new TextDecoder().decode(bytes.subarray(start, end));
};

const rebuildBars = (bytes, replace) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(0x0c, true);
  const table = 0x10 + count * 4;
  const entries = Array.from({ length: count }, (_, i) => [view.getUint32(table + i * 8, true), view.getUint32(table + i * 8 + 4, true)]);
  const starts = [...new Set(entries.map(([, b]) => b))].sort((a, b) => a - b);
  const ends = new Map(starts.map((s, i) => [s, starts[i + 1] ?? bytes.length]));
  const parts = [bytes.subarray(0, starts[0])];
  let length = starts[0];
  const moved = new Map();
  let replaced = 0;
  for (const start of starts) {
    const pad = (0x40 - (length % 0x40)) % 0x40;
    if (pad) {
      parts.push(new Uint8Array(pad));
      length += pad;
    }
    moved.set(start, length);
    const blob = bytes.subarray(start, ends.get(start));
    let next = null;
    for (const [a, b] of entries) if (b === start && !next) next = replace(barsAmtaName(bytes, view, a), blob);
    if (next) replaced++;
    parts.push(next || blob);
    length += (next || blob).length;
  }
  const out = new Uint8Array(length);
  let p = 0;
  for (const part of parts) {
    out.set(part, p);
    p += part.length;
  }
  const outView = new DataView(out.buffer);
  entries.forEach(([a, b], i) => {
    outView.setUint32(table + i * 8, a, true);
    outView.setUint32(table + i * 8 + 4, moved.get(b), true);
  });
  outView.setUint32(4, out.length, true);
  return { bytes: out, replaced };
};

export { encodeBwavAudio, buildBwav, rebuildBars, encodeDsp, dspCoefs, bwavPan };
