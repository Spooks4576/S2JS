// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// Resource size table (RESTBL / .rsizetable) patcher.

import { crc32 } from "../util/crc32.js";

const patchRestbl = (bytes, sizes) => {
  const out = bytes.slice();
  const view = new DataView(out.buffer);
  if (String.fromCharCode(...out.subarray(0, 6)) !== "RESTBL") throw Object.assign(new Error("restbl"), { reason: "Not a resource size table" });
  const nameSize = view.getUint32(10, true);
  const crcCount = view.getUint32(14, true);
  const nameCount = view.getUint32(18, true);
  const byCrc = new Map();
  for (let i = 0; i < crcCount; i++) byCrc.set(view.getUint32(0x16 + i * 8, true), 0x16 + i * 8 + 4);
  const byName = new Map();
  const decoder = new TextDecoder();
  let o = 0x16 + crcCount * 8;
  for (let i = 0; i < nameCount; i++) {
    const raw = out.subarray(o, o + nameSize);
    byName.set(decoder.decode(raw.subarray(0, raw.indexOf(0) < 0 ? nameSize : raw.indexOf(0))), o + nameSize);
    o += nameSize + 4;
  }
  const encoder = new TextEncoder();
  const changed = [];
  for (const [path, [before, after]] of sizes) {
    const at = byName.get(path) ?? byCrc.get(crc32(encoder.encode(path)));
    if (at === undefined) continue;
    const current = view.getUint32(at, true);
    const needed = current - before + after;
    if (needed > current) {
      view.setUint32(at, needed, true);
      changed.push({ path, before: current, after: needed });
    }
  }
  return { bytes: out, changed };
};

export { patchRestbl };
