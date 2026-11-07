// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// BWAV and BARS reader. PCM16 and DSP-ADPCM decode anywhere; Opus needs WebCodecs or Web Audio (browser).

import { zstdDecompress } from "../compression/zstd-decode.js";

const BWAV_CODECS = { 0: "PCM16", 1: "DSP-ADPCM", 2: "Opus" };

const audioFail = (reason) => Object.assign(new Error(reason), { reason });

const readBwav = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 0x10 || view.getUint32(0) !== 0x42574156) throw audioFail("Not a BWAV file");
  const prefetch = view.getUint16(0x0c, true) === 1;
  const count = view.getUint16(0x0e, true);
  if (!count || 0x10 + count * 0x4c > bytes.length) throw audioFail("Broken BWAV header");
  const channels = [];
  for (let i = 0; i < count; i++) {
    const o = 0x10 + i * 0x4c;
    const coefs = new Int16Array(16);
    for (let k = 0; k < 16; k++) coefs[k] = view.getInt16(o + 0x10 + k * 2, true);
    const loopEnd = view.getInt32(o + 0x3c, true);
    channels.push({
      codec: view.getUint16(o, true),
      pan: view.getUint16(o + 2, true),
      rate: view.getUint32(o + 4, true),
      total: view.getUint32(o + 8, true),
      samples: view.getUint32(o + (prefetch ? 0x0c : 0x08), true),
      coefs,
      offset: view.getUint32(o + (prefetch ? 0x34 : 0x30), true),
      loopStart: loopEnd === -1 ? -1 : view.getUint32(o + 0x40, true),
      loopEnd
    });
  }
  const [first] = channels;
  if (channels.some((ch) => ch.codec !== first.codec || ch.rate !== first.rate)) throw audioFail("Mixed channel formats");
  if (!(first.codec in BWAV_CODECS)) throw audioFail(`Unsupported BWAV codec ${first.codec}`);
  return { bytes, prefetch, channels, source: first.codec, codec: prefetch && first.codec === 2 ? 0 : first.codec, rate: first.rate, samples: Math.min(...channels.map((ch) => ch.samples)), loopStart: first.loopStart, loopEnd: first.loopEnd };
};

const decodeDsp = (bytes, ch) => {
  const out = new Int16Array(ch.samples);
  const c = ch.coefs;
  let h1 = 0;
  let h2 = 0;
  let p = ch.offset;
  for (let n = 0; n < out.length && p < bytes.length; p += 8) {
    const head = bytes[p];
    const scale = 1 << (head & 15);
    const c1 = c[(head >> 4) * 2];
    const c2 = c[(head >> 4) * 2 + 1];
    for (let k = 0; k < 14 && n < out.length; k++) {
      const b = bytes[p + 1 + (k >> 1)];
      let nib = k & 1 ? b & 15 : b >> 4;
      if (nib > 7) nib -= 16;
      let s = ((nib * scale) << 11) + 1024 + c1 * h1 + c2 * h2;
      s >>= 11;
      if (s > 32767) s = 32767;
      else if (s < -32768) s = -32768;
      out[n++] = s;
      h2 = h1;
      h1 = s;
    }
  }
  return out;
};

const decodePcm16 = (bytes, ch) => {
  const n = Math.min(ch.samples, (bytes.length - ch.offset) >> 1);
  const out = new Int16Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset + ch.offset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
};

const opusPacketSamples = (packet) => {
  const toc = packet[0];
  const config = toc >> 3;
  const size = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const code = toc & 3;
  return size * (code === 0 ? 1 : code < 3 ? 2 : packet[1] & 63);
};

const readNxOpus = (bytes, ch) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const o = ch.offset;
  if (view.getUint32(o, true) !== 0x80000001) throw audioFail("Unknown Opus header");
  const skip = view.getUint32(o + 0x1c, true);
  let p = o + view.getUint32(o + 0x10, true);
  if (view.getUint32(p, true) !== 0x80000004) throw audioFail("Unknown Opus data chunk");
  const end = Math.min(bytes.length, p + 8 + view.getUint32(p + 4, true));
  p += 8;
  const packets = [];
  while (p + 8 <= end) {
    const size = view.getUint32(p);
    if (!size || p + 8 + size > end) break;
    packets.push(bytes.subarray(p + 8, p + 8 + size));
    p += 8 + size;
  }
  return { skip, packets };
};

const OGG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

const writeOggOpus = ({ skip, packets }, rate) => {
  const pages = [];
  let seq = 0;
  const page = (segments, granule, flags) => {
    const lacing = [];
    segments.forEach((seg) => {
      for (let n = seg.length; ; n -= 255) {
        lacing.push(Math.min(n, 255));
        if (n < 255) break;
      }
    });
    const body = segments.reduce((sum, seg) => sum + seg.length, 0);
    const out = new Uint8Array(27 + lacing.length + body);
    const view = new DataView(out.buffer);
    out.set([0x4f, 0x67, 0x67, 0x53, 0, flags]);
    view.setUint32(6, granule % 0x100000000, true);
    view.setUint32(10, Math.floor(granule / 0x100000000), true);
    view.setUint32(14, 1, true);
    view.setUint32(18, seq++, true);
    out[26] = lacing.length;
    out.set(lacing, 27);
    let p = 27 + lacing.length;
    segments.forEach((seg) => {
      out.set(seg, p);
      p += seg.length;
    });
    let crc = 0;
    for (let i = 0; i < out.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ out[i]) & 255]) >>> 0;
    view.setUint32(22, crc, true);
    pages.push(out);
  };
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 1]);
  hv.setUint16(10, skip, true);
  hv.setUint32(12, rate, true);
  page([head], 0, 2);
  page([new Uint8Array([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73, 0, 0, 0, 0, 0, 0, 0, 0])], 0, 0);
  let granule = 0;
  for (let i = 0; i < packets.length; ) {
    const batch = [];
    let lace = 0;
    while (i < packets.length && lace + Math.floor(packets[i].length / 255) + 1 <= 255) {
      lace += Math.floor(packets[i].length / 255) + 1;
      granule += opusPacketSamples(packets[i]);
      batch.push(packets[i++]);
    }
    page(batch, granule, i === packets.length ? 4 : 0);
  }
  return new Blob(pages, { type: "audio/ogg" });
};

const decodeOpusWebCodecs = async (stream) => {
  const config = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 };
  if (!(await AudioDecoder.isConfigSupported(config)).supported) throw new Error("opus");
  const parts = [];
  let failure = null;
  const decoder = new AudioDecoder({
    output: (data) => {
      const plane = new Float32Array(data.numberOfFrames);
      data.copyTo(plane, { planeIndex: 0, format: "f32-planar" });
      parts.push(plane);
      data.close();
    },
    error: (error) => (failure = error)
  });
  decoder.configure(config);
  let time = 0;
  for (const packet of stream.packets) {
    decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round((time * 1e6) / 48000), data: packet }));
    time += opusPacketSamples(packet);
  }
  await decoder.flush();
  decoder.close();
  if (failure) throw failure;
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Float32Array(total);
  let p = 0;
  parts.forEach((part) => {
    out.set(part, p);
    p += part.length;
  });
  return out.subarray(Math.min(stream.skip, total));
};

const decodeOpusOgg = async (stream) => {
  const Context = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const context = new Context(1, 1, 48000);
  const buffer = await context.decodeAudioData(await writeOggOpus(stream, 48000).arrayBuffer());
  return buffer.getChannelData(0);
};

const toInt16 = (floats, count) => {
  const out = new Int16Array(count);
  const n = Math.min(count, floats.length);
  for (let i = 0; i < n; i++) {
    const v = floats[i] * 32768;
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : Math.round(v);
  }
  return out;
};

const decodeBwav = async (bwav) => {
  const { bytes, channels, codec, samples } = bwav;
  if (codec === 1) return channels.map((ch) => decodeDsp(bytes, ch));
  if (codec === 0) return channels.map((ch) => decodePcm16(bytes, ch));
  const streams = channels.map((ch) => readNxOpus(bytes, ch));
  let floats;
  try {
    if (typeof AudioDecoder === "undefined") throw new Error("opus");
    floats = await Promise.all(streams.map((s) => decodeOpusWebCodecs(s)));
  } catch {
    try {
      floats = await Promise.all(streams.map((s) => decodeOpusOgg(s)));
    } catch {
      throw audioFail("Your browser cannot decode Opus");
    }
  }
  return floats.map((f) => toInt16(f, samples));
};

const writeWav = (planes, rate, { pans, loopStart = -1, loopEnd = -1 } = {}) => {
  const count = planes.length;
  const frames = Math.min(...planes.map((p) => p.length));
  const mask = pans && count > 2 && new Set(pans).size === count && pans.every((p) => p < 18) ? pans.reduce((m, p) => m | (1 << p), 0) : 0;
  const fmtSize = mask ? 40 : 16;
  const loop = loopEnd > loopStart && loopStart >= 0;
  const smplSize = loop ? 60 : 0;
  const dataSize = frames * count * 2;
  const size = 12 + 8 + fmtSize + (loop ? 8 + smplSize : 0) + 8 + dataSize;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  const tag = (p, s) => [...s].forEach((c, i) => view.setUint8(p + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, size - 8, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, fmtSize, true);
  view.setUint16(20, mask ? 0xfffe : 1, true);
  view.setUint16(22, count, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * count * 2, true);
  view.setUint16(32, count * 2, true);
  view.setUint16(34, 16, true);
  let p = 36;
  if (mask) {
    view.setUint16(36, 22, true);
    view.setUint16(38, 16, true);
    view.setUint32(40, mask, true);
    [1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71].forEach((b, i) => view.setUint8(44 + i, b));
    p = 60;
  }
  if (loop) {
    tag(p, "smpl");
    view.setUint32(p + 4, smplSize, true);
    view.setUint32(p + 16, Math.round(1e9 / rate), true);
    view.setUint32(p + 20, 60, true);
    view.setUint32(p + 36, 1, true);
    view.setUint32(p + 52, loopStart, true);
    view.setUint32(p + 56, Math.min(loopEnd, frames) - 1, true);
    p += 8 + smplSize;
  }
  tag(p, "data");
  view.setUint32(p + 4, dataSize, true);
  const out = new Int16Array(buffer, p + 8, frames * count);
  for (let c = 0; c < count; c++) {
    const plane = planes[c];
    for (let i = 0, k = c; i < frames; i++, k += count) out[k] = plane[i];
  }
  return new Blob([buffer], { type: "audio/wav" });
};

const readBars = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0) !== 0x42415253) throw audioFail("Not a BARS archive");
  const count = view.getUint32(0x0c, true);
  const table = 0x10 + count * 4;
  if (table + count * 8 > bytes.length) throw audioFail("Broken BARS header");
  const decoder = new TextDecoder();
  const entries = [];
  const bounds = [];
  for (let i = 0; i < count * 2; i++) bounds.push(view.getUint32(table + i * 4, true));
  bounds.push(bytes.length);
  bounds.sort((a, b) => a - b);
  let streamed = 0;
  for (let i = 0; i < count; i++) {
    const amta = view.getUint32(table + i * 8, true);
    const at = view.getUint32(table + i * 8 + 4, true);
    let name = `sound_${i}`;
    if (amta + 0x28 <= bytes.length && view.getUint32(amta) === 0x414d5441) {
      const s = amta + 0x24 + view.getUint32(amta + 0x24, true);
      let e = s;
      while (e < bytes.length && bytes[e]) e++;
      if (e > s && e - s < 256) name = decoder.decode(bytes.subarray(s, e));
    }
    if (at + 0x10 > bytes.length || view.getUint32(at) !== 0x42574156) continue;
    const limit = bounds.find((b) => b > at) - at;
    const head = readBwav(bytes.subarray(at, at + limit));
    if (!head.samples || head.channels.some((ch) => ch.offset >= limit)) {
      streamed++;
      continue;
    }
    entries.push({ name, bytes: bytes.subarray(at, at + limit) });
  }
  return Object.assign(entries, { streamed });
};

const openAudio = (buffer, name) => {
  let bytes = new Uint8Array(buffer);
  if (/\.zs$/i.test(name) || (bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd)) bytes = zstdDecompress(bytes);
  const magic = String.fromCharCode(...bytes.subarray(0, 4));
  if (magic === "BWAV") return [{ name: name.replace(/(\.bwav)?(\.zs)?$/i, ""), bwav: readBwav(bytes) }];
  if (magic === "BARS") {
    const entries = readBars(bytes);
    if (!entries.length) throw audioFail(entries.streamed ? `${entries.streamed} sounds, all streamed from separate .bwav files` : "No sounds in this archive");
    return Object.assign(entries.map((entry) => ({ name: entry.name, bwav: readBwav(entry.bytes) })), { streamed: entries.streamed });
  }
  throw audioFail("Not a BWAV or BARS file");
};

export { readBwav, decodeBwav, readBars, openAudio, writeWav, decodeDsp, decodePcm16, readNxOpus, writeOggOpus, BWAV_CODECS };
