// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// Helpers for the `.zs` (Zstandard) wrapper most Switch 2 romfs files use.

import { zstdDecompress } from "../compression/zstd-decode.js";
import { zstdFrame } from "../compression/zstd-encode.js";

const toBytes = (input) => (input instanceof Uint8Array ? input : new Uint8Array(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength));

const isZstd = (bytes) => bytes[0] === 0x28 && bytes[1] === 0xb5 && bytes[2] === 0x2f && bytes[3] === 0xfd;

/** Returns the plain bytes of a file, decompressing it first when it is zstd. */
const unpackZs = (input) => {
  const bytes = toBytes(input);
  return isZstd(bytes) ? zstdDecompress(bytes) : bytes;
};

/** Wraps bytes back in a zstd frame when `like` (the original file) was zstd. */
const repackLike = (bytes, like) => (isZstd(toBytes(like)) ? zstdFrame(bytes) : bytes);

export { toBytes, isZstd, unpackZs, repackLike };
