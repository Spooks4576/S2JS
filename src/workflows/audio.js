// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// High level audio helpers built from the BWAV/BARS reader and writer.

import { readBwav, readBars } from "../audio/bwav-read.js";
import { encodeBwavAudio, buildBwav, rebuildBars } from "../audio/bwav-write.js";
import { unpackZs, repackLike } from "../util/zs.js";

/**
 * Encodes PCM audio as a DSP-ADPCM .bwav file.
 * @param planes One Int16Array per channel.
 * @param rate   Sample rate. Switch games expect 48000.
 * @param options.loop Loop the whole sound. Default false.
 */
const encodeBwav = (planes, rate = 48000, { loop = false } = {}) => {
  const total = Math.min(...planes.map((p) => p.length));
  return encodeBwavAudio(planes, rate, { loopStart: loop ? 0 : -1, loopEnd: loop ? total : -1 }).stream;
};

/**
 * Replaces sounds inside a .bars or .bars.zs archive by name.
 * Sounds you do not name are kept byte for byte. Each replacement keeps the original
 * sound's channel panning and loop setting, and prefetch entries stay prefetch entries.
 *
 * @param input  The original archive (Uint8Array or ArrayBuffer).
 * @param sounds Map or object of sound name to { planes: Int16Array[], rate?: number }.
 *               The number of planes should match the original sound's channel count.
 * @returns {{ bytes: Uint8Array, replaced: number, sizes: [number, number] }}
 *          `sizes` is [old, new] uncompressed size, ready for patchRestbl.
 */
const replaceBarsSounds = (input, sounds) => {
  const bytes = unpackZs(input);
  const wanted = sounds instanceof Map ? sounds : new Map(Object.entries(sounds));
  const originals = new Map(readBars(bytes).map((e) => [e.name, readBwav(e.bytes)]));
  const { bytes: out, replaced } = rebuildBars(bytes, (name, blob) => {
    const sound = wanted.get(name);
    if (!sound || String.fromCharCode(...blob.subarray(0, 4)) !== "BWAV") return null;
    const head = readBwav(blob);
    const original = originals.get(name) || head;
    const rate = sound.rate ?? 48000;
    const total = Math.min(...sound.planes.map((p) => p.length));
    const looping = original.loopEnd >= 0;
    const result = encodeBwavAudio(sound.planes, rate, {
      pans: original.channels.length === sound.planes.length ? original.channels.map((c) => c.pan) : undefined,
      loopStart: looping ? (original.loopStart < total ? original.loopStart : 0) : -1,
      loopEnd: looping ? total : -1
    });
    if (!head.prefetch) return result.stream;
    const keep = Math.min(head.channels[0].samples, Math.floor(result.total / 14) * 14);
    return buildBwav({ channels: result.channels, rate, total: result.total, keep, loopStart: result.loopStart, loopEnd: result.loopEnd, crc: result.crc });
  });
  return { bytes: repackLike(out, input), replaced, sizes: [bytes.length, out.length] };
};

export { encodeBwav, replaceBarsSounds };
