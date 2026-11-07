// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// Wraps bytes in a valid Zstandard frame using raw (stored) blocks. Output is not smaller, but every
// game loader that reads .zs accepts it.

const zstdFrame = (bytes) => {
  const size = bytes.length;
  const fcs = size < 256 ? 0 : size < 65792 ? 1 : size < 2 ** 32 ? 2 : 3;
  const fcsBytes = [1, 2, 4, 8][fcs];
  const blocks = Math.max(1, Math.ceil(size / 131072));
  const out = new Uint8Array(4 + 1 + fcsBytes + blocks * 3 + size);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0xfd2fb528, true);
  out[4] = (fcs << 6) | 0x20;
  let p = 5;
  if (fcs === 0) out[p] = size;
  else if (fcs === 1) view.setUint16(p, size - 256, true);
  else if (fcs === 2) view.setUint32(p, size, true);
  else view.setBigUint64(p, BigInt(size), true);
  p += fcsBytes;
  for (let b = 0; b < blocks; b++) {
    const start = b * 131072;
    const length = Math.min(131072, size - start);
    const header = (length << 3) | (b === blocks - 1 ? 1 : 0);
    out[p] = header & 255;
    out[p + 1] = (header >> 8) & 255;
    out[p + 2] = (header >> 16) & 255;
    out.set(bytes.subarray(start, start + length), p + 3);
    p += 3 + length;
  }
  return out;
};

export { zstdFrame };
