// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// Zstandard decompressor (single and multi-frame, no dictionaries).

const zstdDecompress = (() => {
  const zfail = (reason = "Zstandard data looks corrupt") => {
    throw Object.assign(new Error(reason), { reason });
  };

  const LL_BASE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 40, 48, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536];
  const LL_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const ML_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 37, 39, 41, 43, 47, 51, 59, 67, 83, 99, 131, 259, 515, 1027, 2051, 4099, 8195, 16387, 32771, 65539];
  const ML_BITS = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 3, 4, 4, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  const LL_DEFAULT = [4, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 3, 2, 1, 1, 1, 1, 1, -1, -1, -1, -1];
  const ML_DEFAULT = [1, 4, 3, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1, -1, -1];
  const OF_DEFAULT = [1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, -1, -1, -1, -1, -1];

  const backReader = (src, start, end) => {
    if (end <= start) zfail();
    const last = src[end - 1];
    if (!last) zfail();
    let pos = (end - start) * 8 - (8 - (31 - Math.clz32(last)));
    const read = (at, n) => {
      if (at < 0) return at + n <= 0 ? 0 : read(0, n + at) * 2 ** -at;
      if (n > 24) return read(at, 16) + read(at + 16, n - 16) * 65536;
      const i = start + (at >> 3);
      return (((src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> (at & 7)) & ((1 << n) - 1)) >>> 0;
    };
    return {
      bits(n) {
        if (n === 0) return 0;
        pos -= n;
        return read(pos, n);
      },
      get remaining() {
        return pos;
      }
    };
  };

  const buildFse = (norm, accuracy) => {
    const size = 1 << accuracy;
    const symbols = new Uint8Array(size);
    const numBits = new Uint8Array(size);
    const base = new Uint16Array(size);
    let high = size - 1;
    const next = new Array(norm.length);
    norm.forEach((count, s) => {
      if (count === -1) {
        symbols[high--] = s;
        next[s] = 1;
      } else next[s] = count;
    });
    const step = (size >> 1) + (size >> 3) + 3;
    let pos = 0;
    norm.forEach((count, s) => {
      for (let i = 0; i < count; i++) {
        symbols[pos] = s;
        do pos = (pos + step) & (size - 1);
        while (pos > high);
      }
    });
    if (pos !== 0) zfail();
    for (let i = 0; i < size; i++) {
      const s = symbols[i];
      const n = next[s]++;
      const bits = accuracy - (31 - Math.clz32(n));
      numBits[i] = bits;
      base[i] = (n << bits) - size;
    }
    return { accuracy, symbols, numBits, base };
  };

  const readFseTable = (src, at, end, maxSymbol, maxAccuracy) => {
    let bitPos = at * 8;
    const bits = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++, bitPos++) v |= ((src[bitPos >> 3] >> (bitPos & 7)) & 1) << i;
      return v;
    };
    const peek = (n) => {
      let v = 0;
      for (let i = 0; i < n; i++) v |= ((src[(bitPos + i) >> 3] >> ((bitPos + i) & 7)) & 1) << i;
      return v;
    };
    const accuracy = bits(4) + 5;
    if (accuracy > maxAccuracy) zfail();
    let remaining = (1 << accuracy) + 1;
    const norm = [];
    while (remaining > 1 && norm.length <= maxSymbol) {
      const width = 32 - Math.clz32(remaining);
      const lowThreshold = (1 << width) - 1 - remaining;
      let value = peek(width - 1);
      if (value < lowThreshold) bitPos += width - 1;
      else {
        value = peek(width);
        if (value >= 1 << (width - 1)) value -= lowThreshold;
        bitPos += width;
      }
      const count = value - 1;
      remaining -= count < 0 ? -count : count;
      norm.push(count);
      if (count === 0) {
        for (;;) {
          const repeat = bits(2);
          for (let i = 0; i < repeat; i++) norm.push(0);
          if (repeat !== 3) break;
        }
      }
    }
    if (remaining !== 1 || norm.length > maxSymbol + 1) zfail();
    const used = ((bitPos + 7) >> 3) - at;
    if (at + used > end) zfail();
    return { table: buildFse(norm, accuracy), used };
  };

  const buildHuffman = (weights) => {
    let total = 0;
    for (const w of weights) if (w) total += 1 << (w - 1);
    if (!total) zfail();
    const maxBits = 32 - Math.clz32(total);
    const lastWeight = (1 << maxBits) - total;
    if (lastWeight & (lastWeight - 1)) zfail();
    weights.push(31 - Math.clz32(lastWeight) + 1);
    const size = 1 << maxBits;
    const symbols = new Uint8Array(size);
    const lengths = new Uint8Array(size);
    let pos = 0;
    for (let w = 1; w <= maxBits; w++) {
      const span = 1 << (w - 1);
      for (let s = 0; s < weights.length; s++) {
        if (weights[s] !== w) continue;
        symbols.fill(s, pos, pos + span);
        lengths.fill(maxBits + 1 - w, pos, pos + span);
        pos += span;
      }
    }
    return { maxBits, symbols, lengths };
  };

  const readHuffmanTree = (src, at, end) => {
    const header = src[at];
    const weights = [];
    if (header >= 128) {
      const count = header - 127;
      const bytes = (count + 1) >> 1;
      if (at + 1 + bytes > end) zfail();
      for (let i = 0; i < count; i++) {
        const byte = src[at + 1 + (i >> 1)];
        weights.push(i & 1 ? byte & 15 : byte >> 4);
      }
      return { tree: buildHuffman(weights), used: 1 + bytes };
    }
    const streamEnd = at + 1 + header;
    if (streamEnd > end) zfail();
    const { table, used } = readFseTable(src, at + 1, streamEnd, 255, 6);
    const r = backReader(src, at + 1 + used, streamEnd);
    let s1 = r.bits(table.accuracy);
    let s2 = r.bits(table.accuracy);
    for (;;) {
      weights.push(table.symbols[s1]);
      s1 = table.base[s1] + r.bits(table.numBits[s1]);
      if (r.remaining < 0) {
        weights.push(table.symbols[s2]);
        break;
      }
      weights.push(table.symbols[s2]);
      s2 = table.base[s2] + r.bits(table.numBits[s2]);
      if (r.remaining < 0) {
        weights.push(table.symbols[s1]);
        break;
      }
      if (weights.length > 255) zfail();
    }
    return { tree: buildHuffman(weights), used: 1 + header };
  };

  const decodeHuffmanStream = (src, start, end, tree, out, outStart, count) => {
    const r = backReader(src, start, end);
    let state = r.bits(tree.maxBits);
    for (let i = 0; i < count; i++) {
      out[outStart + i] = tree.symbols[state];
      const n = tree.lengths[state];
      state = ((state << n) & ((1 << tree.maxBits) - 1)) | r.bits(n);
    }
    if (r.remaining !== -tree.maxBits) zfail();
  };

  const decodeLiterals = (src, at, end, state) => {
    const b0 = src[at];
    const type = b0 & 3;
    const sizeFormat = (b0 >> 2) & 3;
    let regenerated;
    let compressed = 0;
    let headerSize;
    let streams = 1;
    if (type < 2) {
      if (sizeFormat === 0 || sizeFormat === 2) {
        regenerated = b0 >> 3;
        headerSize = 1;
      } else if (sizeFormat === 1) {
        regenerated = (b0 >> 4) | (src[at + 1] << 4);
        headerSize = 2;
      } else {
        regenerated = (b0 >> 4) | (src[at + 1] << 4) | (src[at + 2] << 12);
        headerSize = 3;
      }
      const out = new Uint8Array(regenerated);
      if (type === 0) {
        if (at + headerSize + regenerated > end) zfail();
        out.set(src.subarray(at + headerSize, at + headerSize + regenerated));
        return { literals: out, used: headerSize + regenerated };
      }
      out.fill(src[at + headerSize]);
      return { literals: out, used: headerSize + 1 };
    }
    const v = ((src[at] | (src[at + 1] << 8) | (src[at + 2] << 16) | (src[at + 3] << 24)) >>> 0) + (src[at + 4] || 0) * 2 ** 32;
    if (sizeFormat < 2) {
      streams = sizeFormat === 0 ? 1 : 4;
      regenerated = (v >>> 4) & 0x3ff;
      compressed = (v >>> 14) & 0x3ff;
      headerSize = 3;
    } else if (sizeFormat === 2) {
      streams = 4;
      regenerated = (v >>> 4) & 0x3fff;
      compressed = Math.floor(v / 2 ** 18) & 0x3fff;
      headerSize = 4;
    } else {
      streams = 4;
      regenerated = (v >>> 4) & 0x3ffff;
      compressed = Math.floor(v / 2 ** 22) & 0x3ffff;
      headerSize = 5;
    }
    let p = at + headerSize;
    const dataEnd = p + compressed;
    if (dataEnd > end) zfail();
    if (type === 2) {
      const t = readHuffmanTree(src, p, dataEnd);
      state.huffman = t.tree;
      p += t.used;
    } else if (!state.huffman) zfail();
    const out = new Uint8Array(regenerated);
    if (streams === 1) decodeHuffmanStream(src, p, dataEnd, state.huffman, out, 0, regenerated);
    else {
      const s1 = src[p] | (src[p + 1] << 8);
      const s2 = src[p + 2] | (src[p + 3] << 8);
      const s3 = src[p + 4] | (src[p + 5] << 8);
      const per = Math.ceil(regenerated / 4);
      let start = p + 6;
      const sizes = [s1, s2, s3, dataEnd - start - s1 - s2 - s3];
      if (sizes[3] < 0) zfail();
      for (let i = 0; i < 4; i++) {
        const count = i < 3 ? per : regenerated - per * 3;
        decodeHuffmanStream(src, start, start + sizes[i], state.huffman, out, i * per, count);
        start += sizes[i];
      }
    }
    return { literals: out, used: headerSize + compressed };
  };

  const DEFAULT_TABLES = {};

  const sequenceTable = (src, at, end, mode, kind, state) => {
    const spec = { ll: [LL_DEFAULT, 6, 35, 9], ml: [ML_DEFAULT, 6, 52, 9], of: [OF_DEFAULT, 5, 31, 8] }[kind];
    if (mode === 0) {
      DEFAULT_TABLES[kind] ||= buildFse(spec[0], spec[1]);
      return { table: DEFAULT_TABLES[kind], used: 0 };
    }
    if (mode === 1) {
      const symbol = src[at];
      if (symbol > spec[2]) zfail();
      return { table: { accuracy: 0, symbols: Uint8Array.of(symbol), numBits: Uint8Array.of(0), base: Uint16Array.of(0) }, used: 1 };
    }
    if (mode === 2) return readFseTable(src, at, end, spec[2], spec[3]);
    if (!state[kind]) zfail();
    return { table: state[kind], used: 0 };
  };

  const decodeBlock = (src, at, end, out, state) => {
    const lit = decodeLiterals(src, at, end, state);
    let p = at + lit.used;
    let count = src[p++];
    if (count >= 128) {
      if (count === 255) {
        count = src[p] + (src[p + 1] << 8) + 0x7f00;
        p += 2;
      } else {
        count = ((count - 128) << 8) + src[p];
        p += 1;
      }
    }
    const literals = lit.literals;
    let litPos = 0;
    if (count === 0) {
      out.push(literals);
      return;
    }
    const modes = src[p++];
    if (modes & 3) zfail();
    const ll = sequenceTable(src, p, end, modes >> 6, "ll", state);
    p += ll.used;
    const of = sequenceTable(src, p, end, (modes >> 4) & 3, "of", state);
    p += of.used;
    const ml = sequenceTable(src, p, end, (modes >> 2) & 3, "ml", state);
    p += ml.used;
    state.ll = ll.table;
    state.of = of.table;
    state.ml = ml.table;
    const r = backReader(src, p, end);
    let sLL = r.bits(ll.table.accuracy);
    let sOF = r.bits(of.table.accuracy);
    let sML = r.bits(ml.table.accuracy);
    const rep = state.rep;
    for (let i = 0; i < count; i++) {
      const ofCode = of.table.symbols[sOF];
      const mlCode = ml.table.symbols[sML];
      const llCode = ll.table.symbols[sLL];
      if (llCode > 35 || mlCode > 52 || ofCode > 31) zfail();
      let offset = 2 ** ofCode + r.bits(ofCode);
      const matchLen = ML_BASE[mlCode] + r.bits(ML_BITS[mlCode]);
      const litLen = LL_BASE[llCode] + r.bits(LL_BITS[llCode]);
      if (offset > 3) {
        offset -= 3;
        rep[2] = rep[1];
        rep[1] = rep[0];
        rep[0] = offset;
      } else {
        let index = offset - 1 + (litLen === 0 ? 1 : 0);
        if (index === 0) offset = rep[0];
        else {
          offset = index === 3 ? rep[0] - 1 : rep[index];
          if (index > 1) rep[2] = rep[1];
          rep[1] = rep[0];
          rep[0] = offset;
        }
      }
      if (litPos + litLen > literals.length) zfail();
      out.push(literals.subarray(litPos, litPos + litLen));
      litPos += litLen;
      out.copyMatch(offset, matchLen);
      if (i + 1 < count) {
        sLL = ll.table.base[sLL] + r.bits(ll.table.numBits[sLL]);
        sML = ml.table.base[sML] + r.bits(ml.table.numBits[sML]);
        sOF = of.table.base[sOF] + r.bits(of.table.numBits[sOF]);
      }
    }
    if (r.remaining !== 0) zfail();
    out.push(literals.subarray(litPos));
  };

  const output = (capacity) => {
    let buf = new Uint8Array(Math.max(capacity, 1 << 16));
    let len = 0;
    const grow = (n) => {
      if (len + n <= buf.length) return;
      const next = new Uint8Array(Math.max(buf.length * 2, len + n));
      next.set(buf.subarray(0, len));
      buf = next;
    };
    return {
      push(bytes) {
        grow(bytes.length);
        buf.set(bytes, len);
        len += bytes.length;
      },
      fill(byte, n) {
        grow(n);
        buf.fill(byte, len, len + n);
        len += n;
      },
      copyMatch(offset, n) {
        if (offset > len || offset < 1) zfail();
        grow(n);
        if (offset >= n) {
          buf.copyWithin(len, len - offset, len - offset + n);
          len += n;
        } else for (let i = 0; i < n; i++, len++) buf[len] = buf[len - offset];
      },
      get length() {
        return len;
      },
      result: () => buf.slice(0, len)
    };
  };

  return (src) => {
    const out = output(src.length * 4);
    let at = 0;
    const u32 = (p) => (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16) | (src[p + 3] << 24)) >>> 0;
    while (at < src.length) {
      const magic = u32(at);
      if (magic >>> 4 === 0x184d2a5) {
        at += 8 + u32(at + 4);
        continue;
      }
      if (magic !== 0xfd2fb528) zfail("Not Zstandard data");
      at += 4;
      const fhd = src[at++];
      const fcsFlag = fhd >> 6;
      const single = (fhd >> 5) & 1;
      const checksum = (fhd >> 2) & 1;
      const dictFlag = fhd & 3;
      if (fhd & 8) zfail();
      if (!single) at++;
      const dictSize = [0, 1, 2, 4][dictFlag];
      if (dictSize && src.subarray(at, at + dictSize).some((b) => b)) zfail("Zstandard dictionaries are not supported");
      at += dictSize;
      at += [single ? 1 : 0, 2, 4, 8][fcsFlag];
      const state = { rep: [1, 4, 8] };
      for (;;) {
        const header = src[at] | (src[at + 1] << 8) | (src[at + 2] << 16);
        at += 3;
        const last = header & 1;
        const type = (header >> 1) & 3;
        const size = header >> 3;
        if (type === 0) {
          if (at + size > src.length) zfail();
          out.push(src.subarray(at, at + size));
          at += size;
        } else if (type === 1) {
          out.fill(src[at], size);
          at += 1;
        } else if (type === 2) {
          if (at + size > src.length) zfail();
          decodeBlock(src, at, at + size, out, state);
          at += size;
        } else zfail();
        if (last) break;
      }
      if (checksum) at += 4;
    }
    return out.result();
  };
})();

export { zstdDecompress };
