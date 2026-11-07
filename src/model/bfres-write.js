// S2JS: JavaScript tools for Nintendo Switch and Switch 2 file formats.
// Copyright 2026 Spooks4576. Licensed under the Apache License, Version 2.0. See LICENSE and NOTICE.
// SPDX-License-Identifier: Apache-2.0
// Adds or replaces mesh geometry inside an existing BFRES shape.

import { bfresLocal, bfresAttribReader, BFRES_COMPONENTS } from "./bfres-read.js";
import { mat4 } from "../util/math.js";

const bfresAttribWriter = (format) => {
  const layout = format >> 8;
  const type = format & 0xff;
  if (layout === 0x0e) {
    return (view, at, v) => {
      let out = 0;
      for (let k = 0; k < 3; k++) {
        const c = Math.max(-1, Math.min(1, v[k] ?? 0));
        out |= (type === 2 ? Math.round(c * 511) & 1023 : Math.round(Math.max(0, c) * 1023)) << (10 * k);
      }
      const w = v[3] ?? 0;
      out |= (type === 2 ? (w < 0 ? 2 : w > 0 ? 1 : 0) : Math.round(Math.max(0, Math.min(1, w)) * 3)) << 30;
      view.setUint32(at, out >>> 0, true);
    };
  }
  const spec = BFRES_COMPONENTS[layout];
  if (!spec) return null;
  const [count, size] = spec;
  const one = (view, at, x) => {
    if (size === 1) {
      if (type === 1) view.setUint8(at, Math.round(Math.max(0, Math.min(1, x)) * 255));
      else if (type === 2) view.setInt8(at, Math.round(Math.max(-1, Math.min(1, x)) * 127));
      else if (type === 4) view.setInt8(at, x);
      else view.setUint8(at, x);
    } else if (size === 2) {
      if (type === 5) view.setUint16(at, floatToHalf(x), true);
      else if (type === 1) view.setUint16(at, Math.round(Math.max(0, Math.min(1, x)) * 65535), true);
      else if (type === 2) view.setInt16(at, Math.round(Math.max(-1, Math.min(1, x)) * 32767), true);
      else if (type === 4) view.setInt16(at, x, true);
      else view.setUint16(at, x, true);
    } else if (type === 5) view.setFloat32(at, x, true);
    else if (type === 4) view.setInt32(at, x, true);
    else view.setUint32(at, x, true);
  };
  return (view, at, v) => {
    for (let i = 0; i < count; i++) one(view, at + i * size, v[i] ?? 0);
  };
};

const floatToHalf = (() => {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  return (value) => {
    f32[0] = value;
    const x = u32[0];
    const sign = (x >> 16) & 0x8000;
    let exp = ((x >> 23) & 0xff) - 112;
    let mant = x & 0x7fffff;
    if (exp <= 0) {
      if (exp < -10) return sign;
      mant = (mant | 0x800000) >> (1 - exp);
      return sign | ((mant + 0x1000) >> 13);
    }
    if (exp >= 31) return sign | 0x7c00;
    const half = sign | (exp << 10) | ((mant + 0x1000) >> 13);
    return half;
  };
})();

const bfresLayout = (bytes) => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (o) => view.getUint16(o, true);
  const u32 = (o) => view.getUint32(o, true);
  const u64 = (o) => Number(view.getBigUint64(o, true));
  const text = new TextDecoder();
  const str = (o) => (o ? text.decode(bytes.subarray(o + 2, o + 2 + u16(o))) : "");
  const model = u64(0x28);
  const skel = u64(model + 0x18);
  const boneArray = u64(skel + 0x10);
  const boneCount = u16(skel + 0x38);
  const smooth = u16(skel + 0x3a);
  const rigid = u16(skel + 0x3c);
  const matrixArray = u64(skel + 0x18);
  const matrix = Array.from({ length: smooth + rigid }, (_, i) => u16(matrixArray + i * 2));
  const bones = Array.from({ length: boneCount }, (_, i) => {
    const at = boneArray + i * 0x58;
    const floats = (o, n) => Array.from({ length: n }, (_, k) => view.getFloat32(at + o + k * 4, true));
    const euler = (u32(at + 0x2c) & 0x7000) === 0x1000;
    return { name: str(u64(at)), parent: u16(at + 0x22), local: bfresLocal(floats(0x30, 3), floats(0x3c, 4), floats(0x4c, 3), euler) };
  });
  const worlds = [];
  const world = (i) => {
    if (i >= bones.length) return mat4.identity();
    if (!worlds[i]) worlds[i] = bones[i].parent < bones.length && bones[i].parent !== i ? mat4.mul(world(bones[i].parent), bones[i].local) : bones[i].local;
    return worlds[i];
  };
  const shapeArray = u64(model + 0x28);
  const shapes = Array.from({ length: u16(model + 0x6a) }, (_, k) => {
    const sh = shapeArray + k * 0x60;
    const vb = u64(sh + 0x10);
    const attribs = {};
    for (let a = 0; a < bytes[vb + 0x4c]; a++) {
      const at = u64(vb + 8) + a * 16;
      attribs[str(u64(at))] = { format: u32(at + 8), offset: u16(at + 12), buffer: u16(at + 14) };
    }
    const skinBones = Array.from({ length: u16(sh + 0x58) }, (_, i) => u16(u64(sh + 0x20) + i * 2));
    return {
      index: k,
      at: sh,
      vb,
      name: str(u64(sh + 8)),
      skin: bytes[sh + 0x5a],
      bone: u16(sh + 0x54),
      buffers: bytes[vb + 0x4d],
      vertices: u32(vb + 0x50),
      stride: u32(u64(vb + 0x38)),
      bufferOffset: u32(vb + 0x48),
      attribs,
      skinBones,
      meshes: Array.from({ length: bytes[sh + 0x5b] }, (_, m) => u64(sh + 0x18) + m * 0x38)
    };
  });
  const pool = u64(0xb0);
  return { view, u16, u32, u64, bones, world, matrix, smooth, shapes, pool, dataStart: u64(pool + 8), poolSize: u32(pool + 4) };
};

const bfresBindable = (layout, shape) => {
  const { bones, matrix, smooth } = layout;
  if (shape.skin === 0) return [{ bone: shape.bone, name: bones[shape.bone]?.name || "Root", slot: -1 }];
  const out = [];
  matrix.forEach((bone, slot) => {
    if (shape.skin === 1 ? slot < smooth : slot >= smooth) return;
    if (shape.skinBones.length && !shape.skinBones.includes(bone)) return;
    if (!out.some((b) => b.bone === bone)) out.push({ bone, name: bones[bone]?.name || `Bone ${bone}`, slot });
  });
  return out;
};

const bfresPointerSlots = (bytes, view) => {
  const rlt = view.getUint32(0x18, true);
  const sections = view.getUint32(rlt + 8, true);
  const first = rlt + 0x10 + sections * 0x18;
  let count = 0;
  for (let i = 0; i < sections; i++) count += view.getUint32(rlt + 0x10 + i * 0x18 + 0x14, true);
  const slots = [];
  for (let e = 0; e < count; e++) {
    const at = first + e * 8;
    const offset = view.getUint32(at, true);
    const structs = view.getUint16(at + 4, true);
    const per = bytes[at + 6];
    const pad = bytes[at + 7];
    for (let s = 0; s < structs; s++) for (let k = 0; k < per; k++) slots.push(offset + (s * (per + pad) + k) * 8);
  }
  return slots;
};

const bfresInject = (source, { shape: shapeIndex, mode, bone, mesh }) => {
  const bytes = source.slice();
  const L = bfresLayout(bytes);
  const { view, u16, u32 } = L;
  const shape = L.shapes[shapeIndex];
  if (shape.buffers !== 1) throw Object.assign(new Error("buffers"), { reason: "This mesh splits its vertices over several buffers, which is not supported yet" });
  const target = bfresBindable(L, shape).find((b) => b.bone === bone) || bfresBindable(L, shape)[0];
  const stride = shape.stride;
  const vstart = L.dataStart + shape.bufferOffset;
  let templateIndex = 0;
  const uvAttrib = shape.attribs._u0;
  const uvRead = uvAttrib && bfresAttribReader(view, uvAttrib.format);
  if (uvRead && mesh.uvs?.length) {
    let mu = 0;
    let mv = 0;
    for (let i = 0; i < mesh.uvs.length; i += 2) {
      mu += mesh.uvs[i];
      mv += mesh.uvs[i + 1];
    }
    mu /= mesh.uvs.length / 2;
    mv /= mesh.uvs.length / 2;
    let best = Infinity;
    for (let i = 0; i < shape.vertices; i++) {
      const [u, v] = uvRead(vstart + i * stride + uvAttrib.offset);
      const d = (u - mu) ** 2 + (v - mv) ** 2;
      if (d < best) {
        best = d;
        templateIndex = i;
      }
    }
  }
  const template = bytes.slice(vstart + templateIndex * stride, vstart + (templateIndex + 1) * stride);
  const count = mesh.positions.length / 3;
  const inverse = shape.skin <= 1 ? mat4.invert(L.world(target.bone)) : null;
  const normalInverse = inverse ? mat4.normal(inverse) : null;
  const writers = Object.fromEntries(Object.entries(shape.attribs).map(([name, a]) => [name, { ...a, write: bfresAttribWriter(a.format) }]));
  const verts = new Uint8Array(count * stride);
  const vview = new DataView(verts.buffer);
  for (let i = 0; i < count; i++) {
    const base = i * stride;
    verts.set(template, base);
    const put = (name, value) => writers[name]?.write?.(vview, base + writers[name].offset, value);
    let p = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]];
    let n = mesh.normals ? [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]] : [0, 1, 0];
    if (inverse) {
      p = mat4.point(inverse, p[0], p[1], p[2]);
      n = mat4.point(normalInverse, n[0], n[1], n[2]);
    }
    const nl = Math.hypot(n[0], n[1], n[2]) || 1;
    n = n.map((v) => v / nl);
    const t = Math.abs(n[1]) < 0.9 ? [n[2], 0, -n[0]] : [1, 0, 0];
    const tl = Math.hypot(...t) || 1;
    put("_p0", p);
    put("_n0", [...n, 0]);
    put("_t0", [t[0] / tl, t[1] / tl, t[2] / tl, 1]);
    if (mesh.uvs) put("_u0", [mesh.uvs[i * 2], mesh.uvs[i * 2 + 1]]);
    if (mesh.uvs2) put("_u1", [mesh.uvs2[i * 2], mesh.uvs2[i * 2 + 1]]);
    if (mesh.skin && shape.skin > 1) {
      const slots = Array.from(mesh.skin.slots.slice(i * 4, i * 4 + 4));
      const raw = Array.from(mesh.skin.weights.slice(i * 4, i * 4 + 4)).map((w, k) => (k < shape.skin ? w : 0));
      const total = raw.reduce((a, b) => a + b, 0) || 1;
      const bytes8 = raw.map((w) => Math.round((w / total) * 255));
      const top = bytes8.indexOf(Math.max(...bytes8));
      bytes8[top] += 255 - bytes8.reduce((a, b) => a + b, 0);
      put("_i0", slots);
      put("_w0", bytes8.map((b) => b / 255));
      put("_i1", [0, 0, 0, 0]);
      put("_w1", [0, 0, 0, 0]);
    } else if (shape.skin >= 1) {
      put("_i0", [target.slot, 0, 0, 0]);
      put("_w0", [1, 0, 0, 0]);
      put("_i1", [0, 0, 0, 0]);
      put("_w1", [0, 0, 0, 0]);
    }
  }
  const replace = mode === "replace";
  const oldSize = u32(Number(view.getBigUint64(shape.vb + 0x30, true)));
  const oldVerts = shape.vertices;
  const firstNew = replace ? 0 : oldVerts;
  if (firstNew + count > 65535 && shape.meshes.some((me) => u32(me + 0x28) === 1)) throw Object.assign(new Error("count"), { reason: "Too many vertices for this model's 16-bit index buffers" });
  const align = (n, a) => Math.ceil(n / a) * a;
  const chunks = [];
  let length = 0;
  const push = (data) => {
    chunks.push(data);
    length += data.length;
    const pad = align(length, 0x100) - length;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      length += pad;
    }
  };
  const vertexBlock = new Uint8Array((replace ? 0 : oldSize) + verts.length);
  if (!replace) vertexBlock.set(bytes.subarray(vstart, vstart + oldSize));
  vertexBlock.set(verts, replace ? 0 : oldSize);
  push(vertexBlock);
  const faces = [];
  for (const me of shape.meshes) {
    if (u32(me + 0x24) !== 3) throw Object.assign(new Error("prim"), { reason: "Only triangle list meshes are supported" });
    const format = u32(me + 0x28);
    const size = format === 0 ? 1 : format === 1 ? 2 : 4;
    const first = replace ? 0 : u32(me + 0x30);
    const oldCount = replace ? 0 : u32(me + 0x2c);
    const at = L.dataStart + u32(me + 0x20);
    const total = oldCount + mesh.indices.length;
    const data = new Uint8Array(total * size);
    if (!replace) data.set(bytes.subarray(at, at + oldCount * size));
    const dv = new DataView(data.buffer);
    mesh.indices.forEach((v, i) => {
      const value = firstNew + v - first;
      const o = (oldCount + i) * size;
      if (size === 1) dv.setUint8(o, value);
      else if (size === 2) dv.setUint16(o, value, true);
      else dv.setUint32(o, value, true);
    });
    faces.push({ me, offset: length, total, size: data.length, first: replace ? 0 : u32(me + 0x30) });
    push(data);
  }
  const delta = align(length, 0x1000);
  const poolEnd = L.dataStart + L.poolSize;
  for (const slot of bfresPointerSlots(bytes, view)) {
    const value = Number(view.getBigUint64(slot, true));
    if (value >= poolEnd) view.setBigUint64(slot, BigInt(value + delta), true);
  }
  const rlt = u32(0x18);
  for (let i = 0; i < u32(rlt + 8); i++) {
    const sec = rlt + 0x10 + i * 0x18;
    const offset = u32(sec + 8);
    const size = u32(sec + 12);
    if (offset >= poolEnd) view.setUint32(sec + 8, offset + delta, true);
    else if (offset + size === poolEnd) view.setUint32(sec + 12, size + delta, true);
  }
  view.setUint32(rlt + 4, u32(rlt + 4) + delta, true);
  view.setUint32(0x18, rlt + delta, true);
  view.setUint32(0x1c, u32(0x1c) + delta, true);
  view.setUint32(L.pool + 4, L.poolSize + delta, true);
  view.setUint32(shape.vb + 0x48, L.poolSize, true);
  view.setUint32(shape.vb + 0x50, firstNew + count, true);
  view.setUint32(Number(view.getBigUint64(shape.vb + 0x30, true)), vertexBlock.length, true);
  for (const { me, offset, total, size, first } of faces) {
    view.setUint32(me + 0x20, L.poolSize + offset, true);
    view.setUint32(me + 0x2c, total, true);
    view.setUint32(me + 0x30, first, true);
    const subs = Number(view.getBigUint64(me, true));
    const subCount = u16(me + 0x34);
    if (replace) {
      view.setUint32(subs, 0, true);
      view.setUint32(subs + 4, total, true);
      for (let s = 1; s < subCount; s++) {
        view.setUint32(subs + s * 8, 0, true);
        view.setUint32(subs + s * 8 + 4, 0, true);
      }
    } else {
      const last = subs + (subCount - 1) * 8;
      view.setUint32(last + 4, u32(last + 4) + mesh.indices.length, true);
    }
    view.setUint32(Number(view.getBigUint64(me + 0x18, true)), size, true);
  }
  const block = new Uint8Array(delta);
  let p = 0;
  for (const c of chunks) {
    block.set(c, p);
    p += c.length;
  }
  const out = new Uint8Array(bytes.length + delta);
  out.set(bytes.subarray(0, poolEnd));
  out.set(block, poolEnd);
  out.set(bytes.subarray(poolEnd), poolEnd + delta);
  return out;
};

export { bfresLayout, bfresBindable, bfresInject, floatToHalf };
