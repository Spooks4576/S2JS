// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// High level texture helpers built from the BNTX reader and writer.

import { openBntx } from "../texture/bntx-read.js";
import {
  bntxTextures,
  bntxWritable,
  bntxMipLayout,
  bntxMipImages,
  bntxWriteLevel,
  encodeTexels,
  unselectChannels,
  resizeArea
} from "../texture/bntx-write.js";
import { unpackZs, repackLike } from "../util/zs.js";
import { fail } from "../util/errors.js";

/**
 * Decodes every image in a .bntx or .bntx.zs file to RGBA8.
 * Cube maps and arrays give one entry per face or layer.
 * @returns {{ platform: string, format: string, images: { name: string, width: number, height: number, rgba: Uint8ClampedArray }[] }}
 */
const decodeBntx = (input) => {
  const bntx = openBntx(unpackZs(input));
  return {
    platform: bntx.platform,
    format: bntx.format,
    images: bntx.images.map((image) => ({ name: image.name, width: image.width, height: image.height, rgba: bntx.decode(image).data }))
  };
};

/** Resizes an RGBA image (8 or 16 bits per channel) with area averaging. */
const fitImage = (image, width, height) => {
  if (image.width === width && image.height === height) return image;
  const wide = image.data instanceof Uint16Array;
  const full = wide ? 65535 : 255;
  const small = resizeArea(Float32Array.from(image.data, (v) => v / full), image.width, image.height, width, height);
  const data = wide ? new Uint16Array(small.length) : new Uint8Array(small.length);
  for (let i = 0; i < small.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, small[i])) * full);
  return { width, height, data };
};

/**
 * Replaces one texture in a BNTX with new pixels, keeping its format, size and mip count.
 * The image is resized to the texture's size if needed, and every mip level is regenerated.
 *
 * @param input   The original .bntx or .bntx.zs file (Uint8Array or ArrayBuffer).
 * @param options.image   { width, height, data } with RGBA data as Uint8Array / Uint8ClampedArray (or Uint16Array for 16-bit).
 * @param options.texture Texture index or name inside the BNTX. Default 0.
 * @param options.layer   Array layer or cube face. Default 0.
 * @param options.effort  ASTC encoder effort: 1 fast, 2 balanced, 3 best. Default 2.
 * @returns The new file, zstd compressed again if the input was.
 */
const replaceBntxTexture = (input, { image, texture = 0, layer = 0, effort = 2 }) => {
  const bytes = unpackZs(input).slice();
  const list = bntxTextures(bytes);
  const tex = typeof texture === "number" ? list[texture] : list.find((t) => t.name === texture);
  if (!tex) fail(`No texture ${texture} in this BNTX (it has: ${list.map((t) => t.name).join(", ")})`);
  const why = bntxWritable(tex);
  if (why) fail(`${tex.name}: ${why}`);
  if (layer >= tex.layers) fail(`${tex.name} has ${tex.layers} layer(s), asked for layer ${layer}`);

  const fitted = fitImage(image, tex.width, tex.height);
  const wide = fitted.data instanceof Uint16Array;
  const wideFormat = wide && /^R16/.test(tex.format.name);
  let pixels = unselectChannels(tex, fitted.data, tex.width * tex.height, wide);
  if (wide && !wideFormat) pixels = Uint8Array.from(pixels, (v) => v >> 8);

  bntxMipImages(tex, pixels, wideFormat).forEach((level, i) => {
    const { width, height } = bntxMipLayout(tex, i);
    bntxWriteLevel(bytes, tex, layer, i, encodeTexels(tex.fmt, level, width, height, effort));
  });
  return repackLike(bytes, input);
};

export { decodeBntx, replaceBntxTexture, fitImage };
