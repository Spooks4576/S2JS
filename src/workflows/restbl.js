// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0

import { patchRestbl } from "../restbl/restbl.js";
import { unpackZs, repackLike } from "../util/zs.js";

/**
 * Grows entries in a resource size table so the game accepts files you made bigger.
 * Entries are only ever raised, never lowered.
 *
 * @param input The .rsizetable or .rsizetable.zs file.
 * @param sizes Map or object of romfs path (no leading slash, no .zs) to [oldSize, newSize],
 *              for example "Sound/Resource/Driver_Mario_00.bars" => [2384864, 2512000].
 * @returns {{ bytes: Uint8Array, changed: { path: string, before: number, after: number }[] }}
 */
const patchRestblFile = (input, sizes) => {
  const map = sizes instanceof Map ? sizes : new Map(Object.entries(sizes));
  const { bytes, changed } = patchRestbl(unpackZs(input), map);
  return { bytes: repackLike(bytes, input), changed };
};

export { patchRestblFile };
